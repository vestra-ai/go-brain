/**
 * InstructionStack — the named-layer system-prompt assembler (K4 §4).
 *
 * Collapses the three independently-evolved, divergently-ordered flat-string
 * system-prompt builders (executor.ts buildQueryOptions, native-system-prompt.ts,
 * openai-system-prompt.ts) into ONE assembler over 8 named layers.
 *
 * Pure, no I/O (the volume CLAUDE.md read stays in the per-arm wrappers). All
 * builders pass their pieces as `InstructionLayer[]`; the assembler renders them
 * in the canonical layer order, filtering empty text and joining with a blank
 * line — byte-identical to the legacy builders when the new layers (Nami,
 * snapshot) are empty (proved by the merge-order conformance golden, exit gate 2).
 *
 * BYTE-IDENTITY CAVEAT (Claude prod): the Claude arm's grandfathered prod prompt
 * order is `[soul, agentPrompt, claudeMdAppend]` (agentPrompt BEFORE the ability
 * catalog) and OMITS the volume CLAUDE.md (the SDK auto-loads it via
 * settingSources:['project']). To keep that prompt byte-identical,
 * `assembleInstructionStack` renders in INPUT order for `harnessId === 'claude'`
 * and the canonical `INSTRUCTION_LAYER_ORDER` for every other arm. Native/openai
 * get the normalized canonical order.
 */
import { createHash } from 'node:crypto';
import type { HarnessId } from './ids.js';

/** The 12 named instruction layers, in canonical render order (1 → 12). */
export type InstructionLayerId =
  | 'soul' //              1 — cross-user static identity (= AGENT_SYSTEM_PROMPT). cacheable.
  | 'task_progress' //     2 — progress-tracking block. ARM-SPLIT: Claude=TaskCreate/TaskUpdate, native/openai=TodoCreate/TodoUpdate. cacheable.
  | 'activity_narration' //3 — the model authors the live status line (`narration` on every tool call). STATIC per deploy.
  | 'environment' //       3.5 — placement/environment facts (local Mac vs cloud sandbox, workspace root, path rules). CONSTANT per process → static, cache-prefix safe.
  | 'local_computer_control' // 3.6 — OS-ladder guidance (verbs → snapshot → takeover). STATIC per process, present IFF the os_* tools register (dial mode AND OS_HANDS_V1); absent otherwise → byte-identical.
  | 'identity' //          3.7 — who the agent works for (name/email/timezone, account ground truth fetched at boot; the 08-04 wrong-signature incident is why this is a layer, not a Nami fact). CONSTANT per process (one process = one user) → static, cache-prefix safe. Absent when the boot fetch failed or VESTRA_IDENTITY_LAYER='0' → byte-identical.
  | 'tool_search' //       3.8 — TOOL_SEARCH_V1 index: the deferred tools' names + one-line summaries, so the model can NAME a capability it cannot yet call. Bytes are a pure function of the deferred SET (never the loaded set, never per-turn state) → STATIC within a session. Deliberately PAST the fleet-static prefix: the set is per-user (flags, dial mode, connected servers), so it must never land inside the fleet-shared block. Absent when the client rail is inactive → byte-identical.
  | 'operational' //       4 — volume CLAUDE.md (per-workspace).
  | 'ability_fragments' // 5 — per-ability CLAUDE.md fragments (concatClaudeMdFragments).
  | 'ability_catalog' //   5 — abilitiesCatalogFragment() + grouped catalog. Flag-branched on ABILITY_IMPORT_V1 → STATIC per deploy.
  | 'agent_mode' //        agentPrompt (agent-mode steering). DYNAMIC but SESSION-FROZEN (see SESSION_FROZEN_LAYER_IDS). Renders in the session-frozen TAIL (before situation/nami), NOT mid-stack — keeps the static prefix byte-identical across tasks (see INSTRUCTION_LAYER_ORDER).
  | 'connected_accounts' // 11.4 — multi-account roster + ask-once guidance (design §7). DYNAMIC, SESSION-FROZEN like situation/nami: rendered at query construction from the runner's roster state; present ONLY when some toolkit has ≥2 ACTIVE accounts (single-account users and legacy mode are byte-identical). Sits in the session-frozen tail so the static prefix never moves.
  | 'arm_steering' //      7 — per-arm disclosure costume (Codex .agents/skills note etc.).
  | 'teams' //             8 — P5 teams-delegation doctrine (teammate-vs-subagent elicitation). STATIC per deploy, flag-gated (AGENT_TEAMS='1').
  | 'app_preview' //     8.5 — Apps surface doctrine: the reserved app-preview port + announce_preview, so a running app reaches the user's Apps tab instead of launch instructions. STATIC per deploy, flag-gated (APP_PREVIEW_V1='true'); absent otherwise → byte-identical.
  | 'nami_pull' //         9 — standing pull-affordance line: the pushed memory block is a summary, `context_query` reaches the whole store behind it. STATIC per deploy, flag-gated to the SERVER retrieval arm (NAMI_RETRIEVAL_ENABLED='server'); the P2 'ledger' arm that first used this slot is deleted.
  | 'nami_wiki' //        11 — Vestrapedia wiki-nav pointer block (read-loop teaching). STATIC per deploy, double-gated (NAMI_WIKI_NAV='true' AND wiki index present on the volume).
  | 'situation' //       11.5 — the server-rendered memory/situation.md push block. DYNAMIC but SESSION-FROZEN (see SESSION_FROZEN_LAYER_IDS). CURRENTLY UNPRODUCED: its only producer (the native builder's situation layer) retired with Pulse in Nami Phase 2 task E5, so every arm now reads situation.md as a FILE off the volume. The id stays because it is part of this rendered contract and of the journaled instruction snapshots older sessions resume from.
  | 'nami'; //             12 — frozen-snapshot memory push block. DYNAMIC but SESSION-FROZEN (see SESSION_FROZEN_LAYER_IDS).

export interface InstructionLayer {
  id: InstructionLayerId;
  text: string;
  /** Static layers are hash-guarded for cache stability; dynamic ones are not. */
  static: boolean;
  /**
   * Set FALSE on a FLEET_STATIC layer whose bytes are per-user after all — the
   * `soul` layer when the user has edited `.forge/SOUL.md` (the loader's
   * 'user-owned' state). Such a layer is excluded from the fleet tier, and
   * because that tier is a byte PREFIX, everything from it onward rides the
   * session tier too (see splitInstructionStack). Absent/undefined = shared,
   * so every existing caller is byte-identical.
   */
  fleetShared?: boolean;
  /**
   * CONTEXT_APPEND_V1 — the bytes that decide whether this layer CHANGED between two runs of
   * a session, when they are not `text`: the layer's producer tags the clock-only part at the
   * mint (the memory block's "last refreshed N hours ago" line), so the engine compares the
   * rest and never re-sends an unchanged block because an hour passed. Absent ⇒ `text`.
   * Never rendered.
   */
  stableText?: string;
}

/**
 * SESSION-FROZEN dynamic layers — the four `static:false` layers that the
 * single-system-breakpoint cache design depends on being CONSTANT for the life of
 * a run/session, even though they are not cross-session static.
 *
 *  - 6 `agent_mode` — the agentPrompt is server-authoritative and selected once at
 *    launch; the native system prompt is built ONCE per `run()` and reused every
 *    round, so agent_mode never varies mid-run.
 *  - `connected_accounts` — the multi-account roster block is rendered from the
 *    runner's roster snapshot at query construction and reused every round. A real
 *    account change mid-session (a human finishing OAuth) does move these bytes;
 *    that drift is a TRUE cache-bust signal and the warn is accepted as such.
 *  - `situation` — the server-rendered memory/situation.md push block was computed
 *    ONCE per session by the run-driver READ path alongside `nami`; it did not change
 *    per turn. Nothing produces it since task E5 (see the id's own note above), so it
 *    is inert here rather than removed — a resumed session's journaled snapshot can
 *    still carry its hash.
 *  - 10 `nami` — the frozen-snapshot memory push block is computed ONCE per session
 *    by the ContextPort READ path (query-manager); it does not change per turn.
 *
 * WHY THIS MATTERS: `assembleInstructionStack` flattens all layers into ONE system
 * string carrying ONE prefix-cache breakpoint. If either of these layers were to
 * vary per turn (e.g. a future K7 per-step routing rebuilding the system prompt
 * mid-run with a different agent_mode), the whole system cache would bust every
 * turn — silently halving the hit-rate. That invariant used to be COMMENT-ONLY and
 * these layers were EXCLUDED from the cache-stability guard. The opt-in
 * `hashSessionFrozenLayers` / `assertSessionFrozenLayerHashes` pair below converts
 * it into an ENFORCED, OBSERVABLE, TESTED contract: a regression warns LOUD instead
 * of degrading caching silently. The default `hashStaticLayers` / `assertLayerHashes`
 * still ignore 6/8 (the Claude prod caller's behavior is unchanged).
 */
export const SESSION_FROZEN_LAYER_IDS: readonly InstructionLayerId[] = ['agent_mode', 'connected_accounts', 'situation', 'nami'];

/**
 * Context-persistence instruction for the NATIVE arms (native + openai_responses).
 *
 * WHY: context-aware models receive an automatic token-budget signal and may
 * naturally try to wrap up work as they approach the context limit UNLESS the
 * harness adds guidance telling them not to. The Claude SDK arm already ships this
 * (its preset includes the equivalent), but our hand-rolled native/openai arms do
 * K4 server-side / journal compaction WITHOUT telling the model — so the model
 * self-truncates (the "let me compose it" → ends without writing the report bug).
 * This text closes that gap.
 *
 * CACHE-SAFETY: this is a CONSTANT string — no timestamps, no per-turn values, no
 * ids. It is placed in the STATIC `arm_steering` layer (7), which is part of the
 * stable cached prefix and is the SAME bytes every turn for a given config. It does
 * NOT touch the hash-guarded `soul` (layer 1) cache prefix. The Claude SDK arm never
 * builds an `arm_steering` layer, so this never reaches the prod Claude prompt.
 *
 * STYLE: user-adjacent system content — NO em dashes, and never names the provider.
 */
export const NATIVE_PERSISTENCE_INSTRUCTION =
  'Your context window is automatically compacted as it approaches its limit, so ' +
  'you can keep working from where you left off. Do not stop a task early due to ' +
  'token-budget concerns. Be persistent and autonomous: complete tasks fully even ' +
  'if you are approaching the end of your context, and never artificially wrap up ' +
  'while work remains. If you are running low on context, record your current ' +
  'progress and state before continuing.';

/**
 * Canonical render order. Dynamic-but-session-frozen = agent_mode,
 * connected_accounts, situation, nami; the rest are static.
 *
 * PREFIX-CACHE INVARIANT (instantaneous program, Lane 3): every session-frozen
 * layer sits LAST, as one contiguous tail (agent_mode → connected_accounts →
 * situation → nami). This is
 * load-bearing for prompt-cache reuse on the native/openai arms. `agent_mode` is the
 * per-task agentPrompt — present for custom-agent tasks, EMPTY (dropped) for
 * default-mode tasks. When it sat in the MIDDLE of the static layers (before
 * arm_steering/teams/nami_pull/nami_wiki), a default task and a custom-agent task
 * produced DIFFERENT byte offsets for that otherwise-identical static suffix, so the
 * static harness prefix could not be reused across tasks (0% cache hit on every fresh
 * task, ~65k cache_create tokens). Keeping every volatile/session-frozen layer at the
 * tail makes the static prefix byte-identical across tasks of the same user → the
 * prefix is reused. Never reinsert a per-task/session-frozen layer ahead of a static
 * one; the cross-task byte-identity test is the regression net.
 */
export const INSTRUCTION_LAYER_ORDER: InstructionLayerId[] = [
  'soul',
  'task_progress',
  'activity_narration',
  'environment',
  'local_computer_control',
  'identity',
  // Past the fleet-static prefix — see the `tool_search` id comment. Placing it
  // any EARLIER would put per-user bytes inside the deploy-shared block, and
  // `splitInstructionStack`'s startsWith check would silently collapse the whole
  // stack back to one tier. It sits after `identity` so that layer keeps its
  // documented role as the first per-user layer.
  'tool_search',
  'operational',
  'ability_fragments',
  'ability_catalog',
  'arm_steering',
  'teams',
  'app_preview',
  'nami_pull',
  'nami_wiki',
  // ── session-frozen tail (all `static:false`) — must stay LAST and contiguous ──
  'agent_mode',
  'connected_accounts',
  'situation',
  'nami',
];

/**
 * Render the layers into a single system-prompt string.
 *
 *  - `harnessId === 'claude'` → INPUT order, and legacy NO-TRIM semantics: a layer
 *    is kept IFF `layer.text` is truthy (matches the legacy
 *    `[soul, agentPrompt, claudeMdAppend].filter(Boolean)` — keeps even
 *    whitespace-only strings, drops only `''`) and the RAW `layer.text` is joined
 *    with `'\n\n'` (NO per-layer `.trim()`). This is byte-for-byte the
 *    grandfathered prod assembly, so any Claude input (incl. an `agentDef.prompt`
 *    that ends in `\n`) produces an identical prompt → prefix caching unaffected.
 *  - any other arm → canonical `INSTRUCTION_LAYER_ORDER` + normalization
 *    (filter-empty-after-trim, trim each kept layer). That normalization is
 *    intended K4 behavior.
 *
 * Layers are joined with a blank line. Never throws.
 */
export function assembleInstructionStack(layers: InstructionLayer[], harnessId: HarnessId): string {
  const order: InstructionLayerId[] =
    harnessId === 'claude' ? layers.map((l) => l.id) : INSTRUCTION_LAYER_ORDER;
  const byId = new Map<InstructionLayerId, InstructionLayer>();
  for (const l of layers) byId.set(l.id, l);
  const isClaude = harnessId === 'claude';
  const parts: string[] = [];
  for (const id of order) {
    const layer = byId.get(id);
    if (!layer) continue;
    if (isClaude) {
      // Legacy filter(Boolean).join('\n\n') — RAW text, no trim. Keep any truthy
      // string (whitespace-only included); drop only '' (falsy).
      if (layer.text) parts.push(layer.text);
    } else {
      const text = layer.text.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/**
 * The FLEET-STATIC prefix of the canonical order — the layers whose bytes are
 * identical for EVERY user and task of a given deploy (soul + task_progress +
 * activity_narration + environment + local_computer_control). They sit first in
 * `INSTRUCTION_LAYER_ORDER`, so their rendered text is a byte-stable PREFIX of
 * the assembled system string: the T0 cache tier the whole fleet's traffic can
 * share. Layers 6+ (volume CLAUDE.md, ability fragments/catalog, …) are
 * per-user or later and are NOT in this set even where their bytes are static
 * per deploy — position, not cadence, decides prefix membership.
 */
export const FLEET_STATIC_LAYER_IDS: readonly InstructionLayerId[] = [
  'soul',
  'task_progress',
  'activity_narration',
  'environment',
  'local_computer_control',
];

/**
 * A two-tier split of the assembled system prompt. INVARIANT (tested):
 * `fleet + session === assembleInstructionStack(layers, harnessId)` — the split
 * never changes a byte of what the model reads, only where a provider transport
 * may place cache breakpoints. `fleet` is EXACTLY the standalone render of the
 * fleet-static prefix layers (so its bytes match across all users/tasks of a
 * deploy); `session` is the remainder and starts with the '\n\n' joiner when
 * both parts are non-empty. Either side may be '' (no split worth making).
 */
export interface TieredSystemPrompt {
  fleet: string;
  session: string;
}

/**
 * Split the assembled stack at the fleet-static / per-user boundary.
 *
 * The fleet side is the LONGEST fleet-static prefix whose bytes are actually
 * deploy-wide: the walk runs `FLEET_STATIC_LAYER_IDS` in canonical order and
 * STOPS at the first present layer marked `fleetShared: false`. That is what
 * keeps the `fleet` block's name honest — a user who edited their soul has no
 * deploy-shared prefix at all (soul is layer 1), so the walk stops immediately
 * and the whole stack rides the session tier, exactly as with the flag off.
 * Without the stop, that user's private bytes would ship in a block the rail
 * (and its [CACHE_TIER] log) calls fleet-shared, spending a breakpoint on a
 * prefix no one else can ever read.
 *
 * Total (never throws) and conservative: any shape where the fleet render is
 * not a byte-prefix of the full render — the input-order `claude` arm, an
 * empty fleet set, duplicate ids — degrades to `{ fleet: '', session: full }`,
 * which callers treat as "send one block, exactly today's behavior". Wrong
 * bytes are impossible by construction; the only failure mode is fewer tiers.
 */
export function splitInstructionStack(
  layers: InstructionLayer[],
  harnessId: HarnessId,
): TieredSystemPrompt {
  const full = assembleInstructionStack(layers, harnessId);
  if (harnessId === 'claude') return { fleet: '', session: full }; // input-order arm: never tier
  const byId = new Map<InstructionLayerId, InstructionLayer>();
  for (const l of layers) byId.set(l.id, l);
  const fleetLayers: InstructionLayer[] = [];
  for (const id of FLEET_STATIC_LAYER_IDS) {
    const layer = byId.get(id);
    if (!layer) continue; // absent layer: nothing to render, the prefix continues
    if (layer.fleetShared === false) break; // per-user bytes end the shared prefix
    fleetLayers.push(layer);
  }
  const fleet = assembleInstructionStack(fleetLayers, harnessId);
  if (!fleet || !full.startsWith(fleet)) return { fleet: '', session: full };
  return { fleet, session: full.slice(fleet.length) };
}

/**
 * The memory push blocks, the last two layers of the session-frozen tail: the only layers whose
 * bytes differ between two of a person's tasks (staging, 2026-10-04: two tasks' journaled layer
 * hashes matched everywhere but `nami`, whose week view gains the task before). Data about the
 * person, never instructions, so a transport may move them out of the system role.
 */
export const MEMORY_TAIL_LAYER_IDS: readonly InstructionLayerId[] = ['situation', 'nami'];

/** Where the memory blocks sit in a system prompt: [start, end), `start` at the joiner before them. */
export interface MemorySpan {
  start: number;
  end: number;
}

/**
 * CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1 — where the memory blocks
 * (MEMORY_TAIL_LAYER_IDS) sit in `system`, given the layers `system` was rendered from. The
 * bytes before them are what a person's tasks share; the memory is where two of their tasks
 * first differ; anything after it (the deferred-tool index) is theirs again. agent_mode and
 * connected_accounts stay in front: they are instructions, and same-agent tasks share them.
 *
 * Pass the layers the prompt was actually BUILT from: for a held base (context-append.ts
 * holdSession) those carry the base's own texts, so every run of a session cuts the same bytes
 * whatever the live layers say now. Undefined unless `system` starts with the head render, the
 * joiner and the memory render, and the memory ends the prompt or a joiner follows it (a
 * prepended SessionStart context, no memory at all).
 */
export function memorySpan(system: string, layers: readonly InstructionLayer[]): MemorySpan | undefined {
  const isMemory = (l: InstructionLayer) => MEMORY_TAIL_LAYER_IDS.includes(l.id);
  const head = assembleInstructionStack(layers.filter((l) => !isMemory(l)), 'native');
  const memory = assembleInstructionStack(layers.filter(isMemory), 'native');
  if (!head || !memory || !system.startsWith(`${head}\n\n${memory}`)) return undefined;
  const end = head.length + 2 + memory.length;
  return end === system.length || system.startsWith('\n\n', end) ? { start: head.length, end } : undefined;
}

/**
 * `system` with the memory span cut out (the joiner before it dropped, so the rest reads as the
 * same layers without it) and the memory itself. Undefined for an absent or malformed span, and
 * the caller sends `system` whole.
 */
export function cutMemorySpan(system: string, span: MemorySpan | undefined): { rest: string; memory: string } | undefined {
  if (!span || span.start <= 0 || span.end > system.length || span.end <= span.start + 2) return undefined;
  if (!system.startsWith('\n\n', span.start)) return undefined;
  return { rest: system.slice(0, span.start) + system.slice(span.end), memory: system.slice(span.start + 2, span.end) };
}

/** A 12-char sha256 prefix per `static:true` layer, keyed by layer id. */
export type LayerHashes = Partial<Record<InstructionLayerId, string>>;

/**
 * A 12-hex sha256 prefix: the layer-drift baseline here, and the cache-prefix fingerprint
 * the product logs on its `[CACHE_TIER]` lines. A fingerprint only, never the text.
 */
export function hash12(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Hash the layers selected by `include` once (cache-stability baseline). */
function hashLayers(
  layers: InstructionLayer[],
  include: (l: InstructionLayer) => boolean,
): LayerHashes {
  const out: LayerHashes = {};
  for (const l of layers) {
    if (include(l)) out[l.id] = hash12(l.text);
  }
  return out;
}

/** One drifted layer, as the warn callback receives it beside its line (structured, so a caller
 *  can say each drift once without reading the words). */
export interface LayerDrift {
  layer: InstructionLayerId;
  expected: string;
  actual: string;
}

/** Re-hash the selected layers and warn (LOUD, non-fatal) on any drift from `prev`. */
function assertLayerHashesWith(
  prev: LayerHashes,
  layers: InstructionLayer[],
  include: (l: InstructionLayer) => boolean,
  warn: (msg: string, drift: LayerDrift) => void,
): void {
  const next = hashLayers(layers, include);
  for (const id of Object.keys(next) as InstructionLayerId[]) {
    const before = prev[id];
    const after = next[id];
    if (before !== undefined && before !== after) {
      warn(
        `[CACHE_PROMPT_MUTATED] layer=${id} expected=${before} actual=${after}. ` +
          `An instruction layer changed between session start and assembly. ` +
          `Prompt caching WILL break until this is fixed.`,
        { layer: id, expected: before, actual: after ?? '' },
      );
    }
  }
}

/** Hash each static layer once (cache-stability baseline). Dynamic layers are excluded. */
export function hashStaticLayers(layers: InstructionLayer[]): LayerHashes {
  return hashLayers(layers, (l) => l.static);
}

/**
 * Re-hash the static layers and warn (LOUD, non-fatal) on any drift from `prev`.
 * NEVER throws — drift is a prefix-cache regression signal, not a hard error.
 * `warn` receives one `[CACHE_PROMPT_MUTATED] layer=<id> …` line per drifted layer.
 *
 * This is the DEFAULT guard (the Claude `executor.ts` caller). It covers ONLY
 * `static:true` layers — the session-frozen dynamic layers 6/8 are intentionally
 * EXCLUDED here. Use `assertSessionFrozenLayerHashes` to additionally cover 6/8.
 */
export function assertLayerHashes(
  prev: LayerHashes,
  layers: InstructionLayer[],
  warn: (msg: string) => void,
): void {
  assertLayerHashesWith(prev, layers, (l) => l.static, warn);
}

/** A layer is covered by the session-frozen guard if it is static OR session-frozen. */
function isSessionFrozen(l: InstructionLayer): boolean {
  return l.static || SESSION_FROZEN_LAYER_IDS.includes(l.id);
}

/**
 * Hash each STATIC layer AND each SESSION-FROZEN dynamic layer (agent_mode,
 * situation, nami) once — the session-freeze cache-stability baseline. Superset of
 * `hashStaticLayers`. OPT-IN: callers that need the stronger contract use this in
 * place of `hashStaticLayers`; the default guard is unaffected. See
 * `SESSION_FROZEN_LAYER_IDS` for the rationale.
 */
export function hashSessionFrozenLayers(layers: InstructionLayer[]): LayerHashes {
  return hashLayers(layers, isSessionFrozen);
}

/**
 * Re-hash the static + session-frozen layers and warn (LOUD, non-fatal) on any
 * drift from `prev`. Same `[CACHE_PROMPT_MUTATED] layer=<id> …` shape as
 * `assertLayerHashes`, but additionally catches a per-turn change to the
 * session-frozen dynamic layers 6/8 — the silent cache-buster the default guard
 * misses. NEVER throws (warn-only). OPT-IN: not wired into the default caller.
 */
export function assertSessionFrozenLayerHashes(
  prev: LayerHashes,
  layers: InstructionLayer[],
  warn: (msg: string, drift: LayerDrift) => void,
): void {
  assertLayerHashesWith(prev, layers, isSessionFrozen, warn);
}

/** The instruction-snapshot data recorded once per session (reuses the `custom`
 *  journal payload kind — NO schema change). See native-harness.ts session start. */
export interface InstructionSnapshot {
  harnessId: HarnessId;
  layers: { id: InstructionLayerId; static: boolean; hash: string }[];
  assembledHash: string;
}

/**
 * Build the replay-audit snapshot of an assembled stack: per-layer {id, static,
 * hash} plus the hash of the assembled string. Pure; never throws.
 */
export function describeInstructionStack(
  layers: InstructionLayer[],
  harnessId: HarnessId,
): InstructionSnapshot {
  return {
    harnessId,
    layers: layers.map((l) => ({ id: l.id, static: l.static, hash: hash12(l.text) })),
    assembledHash: hash12(assembleInstructionStack(layers, harnessId)),
  };
}
