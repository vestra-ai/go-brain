/**
 * The native nested-agent engine (K5 batch-2, Agent tool).
 *
 * A provider-neutral, bounded sub-conversation loop: given a Transport (the same
 * ModelPort the parent run uses), a system prompt (the subagent's instructions),
 * a user prompt, and a restricted tool list, it drives model ↔ tools until the
 * model stops calling tools (or maxTurns is hit), then returns the final text +
 * the total cost it incurred.
 *
 * It is the native counterpart of the OpenAI arm's `Agent.asTool()` (which lets
 * the OpenAI SDK run a nested agent). The native arm has no SDK, so we run the
 * loop ourselves — reusing the SAME `gateAndDispatchTool` and `Transport` the
 * parent loop uses, so subagent tool calls are gated through the parent harness
 * exactly like top-level calls.
 *
 * EMISSION: the engine NEVER touches the socket. It calls `onEvent` with neutral
 * SubagentEvents; the caller (the Agent tool) translates those into SUBAGENT_*
 * raw HarnessEvents via the loop's `pushEvent` channel, so the parent loop stays
 * the sole emitter (K3 invariant).
 *
 * BILLING: the engine returns `costUsd` (summed via transport.computeCostUsd over
 * every round). The Agent tool hands this to the parent turn via `ctx.addCostUsd`
 * so the nested tokens are billed EXACTLY ONCE, on the parent's turn_end (the
 * native arm's reportsCostUsd:false billing seam). The engine emits no billable
 * usage event itself — SUBAGENT_END token counts are display-only.
 */

import type { ChildCostRecord } from '../contract/child-cost.js';
import type { HarnessEvent } from '../contract/events.js';
import type { GateResult, HarnessContext, ToolCall } from '../contract/harness.js';
import type { JournalEntry } from '../contract/journal.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import type { OnAuthHalt, RawToolOptions, ToolDispatchResult } from '../tools/tool-types.js';
import type { NormalizedUsage, ProviderReplay, ProviderTool, Transport } from './transport.js';
import { subagentCeilingReached, SUBAGENT_CONTEXT_CEILING_NUDGE } from '../kernel/index.js';
import { compactionV2Enabled } from '../policy/feature-flags.js';
import type { InjectionScreenSeam } from '../policy/injection-screen.js';
import { gateAndDispatchTool, unknownToolResult } from './tool-dispatcher.js';
import { AGENT_TOOL_BILLING_EVENT, toolBillingEvent } from './tool-billing.js';
import {
  createSubagentRunawayWatchdog,
  SUBAGENT_RUNAWAY_DIRECTIVE,
  SUBAGENT_RUNAWAY_GRACE_ROUNDS,
} from './subagent-watchdog.js';
import { makeInProcessDispatcher, inCodePause, runOneRound, type RoundDeps, type RoundResult, type RoundState } from './round-engine.js';
import type { NativeConfigLike } from './native-config-like.js';
import { foldModelSpend, type LiveSpendLedger } from './live-spend.js';
import type { SubagentRefusalKind, SubagentStopReason } from './subagent-walls.js';
import { nestedDrainTimeoutMs, TURN_CAP_DIRECTIVE, wrapUpAtTurn } from './subagent-walls.js';
import { DRAIN_DEFAULT_MS } from './abort-drain.js';
import type { Journal } from '../kernel/index.js';
import type { ContentBlock } from '../contract/blocks.js';
import { appendSubagentRound, sealedPendingRound } from './replay-channels.js';
import { appendSubagentToolUseEntry, appendSubagentToolResultEntry, appendSubagentUsageEntry } from './native-journal.js';
import { subagentStopRail } from './subagent-stop-rail.js';

const ZERO_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * What a ceiling-stopped child appends to its answer. The parent model reads the
 * child's text and nothing else, so an unexplained partial report reads as a lazy
 * child and invites a re-spawn — the exact behavior a spend ceiling exists to stop.
 * Sibling of subagent-pool's launch-gate note ("Skipped: …", never started).
 */
const TURN_CEILING_STOP_NOTE = 'Stopped: turn spend ceiling reached. The work above is partial.';

/**
 * T11b — the synthesized leading user entry for a RE-ENTRY seed. The subagent's user
 * prompt is deliberately NOT journaled (T10), so on re-entry it is rebuilt here from the
 * parent `Agent` tool_use input and prepended to the scope projection — the provider
 * history must lead with a user message. Only `payload` is read by `historyFromJournal`;
 * the header carries neutral placeholders (this entry is never appended to the journal).
 */
function userSeedEntry(text: string): JournalEntry {
  return {
    uuid: '', parentUuid: null, seq: 0, taskId: '', rootTaskId: '', spawnDepth: 0,
    workspaceId: '', agentId: '', principal: { kind: 'user', userId: '' }, timestamp: '',
    payload: { type: 'user', blocks: [{ type: 'text', text }] },
  };
}

/** P3.5b — the split product of a seed whose tail is an unresolved round. */
interface PendingRound {
  /** Everything before the paused round — feeds `historyFromJournal` as usual. */
  resolvedPrefix: JournalEntry[];
  /** The paused round's leading assistant blocks (empty for a tool-only round). */
  leadBlocks: ContentBlock[];
  leadReplay: ProviderReplay | undefined; // its sealed Gemini channel, when journaled
  resolvedResults: ToolDispatchResult[]; // a sealed round's settled results (sealedPendingRound)
  /** The still-unresolved calls, journaled input verbatim, in journal order. */
  pendingToolUses: Array<{ id: string; name: string; input: unknown }>;
}

/**
 * P3.5b (Fix 1) — split the trailing UNRESOLVED round off a re-entry seed.
 *
 * A Weave node's scope after a gated-leaf pause ends with the round's assistant
 * text + the pending tool_use entries and NO tool_result (the loop journals the
 * attempt pre-dispatch and withholds the result on a pause). Two constraints force
 * the split rather than seeding the tail through `historyFromJournal`:
 *  - the request validity floor STRIPS a dangling tool_use (unanswered ⇒ 400), so
 *    the call would vanish from the wire and the model would RE-COMPOSE it — the
 *    exact byte-drift Fix 1 exists to close;
 *  - the round's leading assistant text must ride the SAME re-pushed assistant
 *    message as the tool_use blocks (Anthropic 400s on consecutive assistant
 *    messages; only user turns merge), so it is pulled out of the prefix too.
 *
 * Returns undefined for a resolved-tail seed (the T11b shape) — no behavior change.
 */
function splitTrailingPendingRound(seed: JournalEntry[]): PendingRound | undefined {
  const resultIds = new Set<string>();
  for (const e of seed) if (e.payload.type === 'tool_result') resultIds.add(e.payload.toolUseId);
  // P3.5b IMPORTANT-B — the walk must SKIP entry kinds the history mappers ignore:
  // the P2.2 shared round core journals a scope-tagged `usage` entry BETWEEN the
  // round's assistant text and its tool_use entries ([assistant, usage, tool_use]
  // on a pause), so a contiguity-only walk would break at the usage entry, strand
  // the lead text in the prefix, and the re-pushed tool_use message would land as
  // a CONSECUTIVE assistant message (Anthropic 400s). Ignored entries stay in the
  // prefix (the mappers drop them from the wire); only the CONTEXT kinds below
  // participate in split decisions.
  const isContext = (t: string): boolean =>
    t === 'tool_use' || t === 'tool_result' || t === 'assistant' || t === 'user';
  let i = seed.length - 1;
  const pendingIdx: number[] = [];
  while (i >= 0) {
    const p = seed[i].payload;
    if (!isContext(p.type)) { i -= 1; continue; }
    if (p.type === 'tool_use' && !resultIds.has(p.toolUseId)) { pendingIdx.unshift(i); i -= 1; continue; }
    break;
  }
  if (pendingIdx.length === 0) return undefined;
  // The paused round's leading assistant text: the nearest context entry above the
  // dangling run. It must ride the SAME re-pushed message as the tool_use blocks,
  // so it is EXCLUDED from the prefix.
  const pendingToolUses = pendingIdx.map((idx) => {
    const p = seed[idx].payload as { toolUseId: string; name: string; input?: unknown };
    return { id: p.toolUseId, name: p.name, input: p.input ?? {} };
  });
  const unit = sealedPendingRound(seed, i, pendingToolUses.map((tu) => tu.id));
  if (unit) {
    const out = new Set([...pendingIdx, ...unit.resolvedIdx, unit.leadIdx]);
    const leadBlocks = (seed[unit.leadIdx].payload as { blocks: ContentBlock[] }).blocks;
    return { resolvedPrefix: seed.filter((_, k) => !out.has(k)), leadBlocks, leadReplay: unit.replay, resolvedResults: unit.resolvedResults, pendingToolUses };
  }
  let leadIdx = -1;
  let leadBlocks: ContentBlock[] = [];
  while (i >= 0) {
    const p = seed[i].payload;
    if (!isContext(p.type)) { i -= 1; continue; }
    if (p.type === 'assistant') { leadIdx = i; leadBlocks = p.blocks; }
    break;
  }
  const excluded = new Set(leadIdx >= 0 ? [...pendingIdx, leadIdx] : pendingIdx);
  return { resolvedPrefix: seed.filter((_, idx) => !excluded.has(idx)), leadBlocks, leadReplay: undefined, resolvedResults: [], pendingToolUses };
}

/**
 * T5 (HITL subagent depth) — the structured pause a nested subagent surfaces when a
 * tool inside it trips needs_human. Carries the LEAF inner tool that actually paused
 * (its id + name + the gate's interaction kind) plus the root→leaf `subagentPath` to
 * the subagent that paused (accumulated by the Agent tool's bubbling `onPause`, each
 * level prepending its segment). Additive to the boolean `pausedHalt` — absent ⇒
 * flag-off ⇒ byte-identical to today. `subagentPath` is present only when a path
 * bubbled THROUGH this loop's `onPause` (the loop fires the leaf pause; the Agent
 * levels above it build the path), so at the leaf loop it is typically absent.
 */
export interface SubagentPauseInfo {
  toolUseId: string;
  toolName: string;
  kind: string;
  subagentPath?: SubagentPathSegment[];
}

/** A neutral event the subagent loop surfaces; the Agent tool maps these to SUBAGENT_* wire events. */
/**
 * One warning per unforwarded event kind, process-wide.
 *
 * The subagent drive loop below can only adapt `block` events. Anything else it
 * drops — which is correct, but must never be free: a dropped event with no trace
 * is precisely how a depth-2 subagent stayed invisible while it ran and billed.
 * Keyed by kind (a bounded, tiny set) so a hot loop cannot flood a long-lived
 * sandbox process.
 */
const warnedUnforwardedKinds = new Set<string>();
function noteUnforwardedSubEvent(kind: string): void {
  if (warnedUnforwardedKinds.has(kind)) return;
  warnedUnforwardedKinds.add(kind);
  console.warn(`[NativeHarness] subagent loop dropped an unforwardable event kind=${kind} — it reached no sink`);
}

import type { SubagentEvent } from './subagent-event.js';
export type { SubagentEvent };

export interface SubagentRunResult {
  /** The subagent's final answer (the last round that produced assistant text). */
  text: string;
  /** Total USD cost of the nested run, summed over every round. */
  costUsd: number;
  /** How many tool calls the subagent dispatched. */
  toolUseCount: number;
  /** Aggregate token usage over the nested run (display-only — NOT billed here). */
  usage: NormalizedUsage;
  /**
   * native-redrive — TRUE when a tool INSIDE this subagent tripped the gate's
   * needs_human path (or a Composio auth wall). The nested loop STOPS at the pause
   * (it does NOT push the PAUSED_HALT sentinel back as a tool_result and re-query —
   * that swallowed the pause, the subagent returned empty, and the parent never
   * paused). The Agent tool propagates this to the PARENT turn so the human-in-the-
   * loop pause is a REAL pause bound to the parent Agent tool_use id (resume works).
   */
  pausedHalt?: boolean;
  /**
   * T5 (HITL subagent depth) — the structured pause, set ALONGSIDE `pausedHalt` when a
   * tool inside this subagent paused-for-human. Carries the leaf inner tool + the
   * root→leaf path. Additive: absent ⇒ flag-off ⇒ byte-identical. Captured from the
   * pause this loop fired via its `onPause`. Resume-side consumption lands later (T7/T12).
   */
  pauseInfo?: SubagentPauseInfo;
  /**
   * Agent-v2 billing-attribution: this subagent's OWN-cost record. `costUsd` is
   * only THIS loop's per-round model spend (for a leaf — i.e. today, no recursion
   * — it equals the inclusive `costUsd` scalar above); `usage` is the aggregate
   * nested token usage; `model`/`childId` identify the node for the parent's
   * attributed-debit roll-up (Task 3 emits it via `ctx.addChildCost`).
   */
  childCost: ChildCostRecord;
  /** Why the run ended (orchestration walls result contract, spec §4.4). Always set. */
  stopReason: SubagentStopReason;
  /** Model rounds consumed (the wrap-up round, when it ran, is not counted). */
  turnsUsed: number;
}

export interface SubagentRunOptions {
  transport: Transport;
  model: string;
  /**
   * Agent-v2 billing-attribution: stable id for THIS subagent node, stamped onto
   * the returned `childCost`. The Agent tool passes its own tool_use id (`agentId`)
   * so the parent's attributed-debit roll-up (Task 3) can key the spend per child.
   */
  childId: string;
  /** OPTIONAL parent node id — set once recursion (grandchildren) lands (Task 11). */
  parentChildId?: string;
  /**
   * Task 11 (bounded recursion) — the UPWARD chain for a grandchild's OWN-cost record.
   * When THIS node is an orchestrator, a nested Agent tool inside its loop folds each
   * grandchild's attributed record straight up via this sink (the loop wires its dispatch
   * execCtx `addChildCost` to call it). The Agent tool that spawned THIS node supplies it,
   * forwarding to its OWN `ctx.addChildCost` — so the top-level `childUsage` stays a FLAT
   * list of own-costs (the orchestrator never aggregates a sub-list). Absent for a leaf
   * (no nested Agent tool ever invokes it) → byte-identical to today.
   */
  onChildCost?: (rec: ChildCostRecord) => void;
  /** The subagent's instructions (the agent definition's prompt). */
  system: string;
  /** The task the parent asked the subagent to do. */
  userPrompt: string;
  /** The subagent's restricted toolset (file + Bash + injected extras; never Skill). */
  tools: RawToolOptions[];
  /** Parent harness — nested tool calls gate through it exactly like top-level calls. */
  harness: { gateTool(call: ToolCall): Promise<GateResult> };
  /**
   * Pause-for-human gateway. T5 (HITL subagent depth) — the OPTIONAL third arg carries
   * the root→leaf `subagentPath` accumulated as a pause bubbles up the Agent-tool chain
   * (each level prepends its segment). Absent ⇒ flag-off ⇒ byte-identical to today.
   */
  onPause: (call: ToolCall, kind: string, subagentPath?: SubagentPathSegment[]) => Promise<string>;
  /**
   * Composio auth-halt sink — threaded into the MODEL-DRIVEN
   * dispatches (legacy loop, shared round core, pending-round redrive) so a Composio
   * auth wall inside a subagent fires the SAME deduped auth interaction the top-level
   * loop would, then halts via the existing pausedHalt bubble. Deliberately NOT given
   * to the in-process (in-code) dispatcher: an in-code pause stays side-effect-free.
   * Absent ⇒ the dispatcher still halts on an auth verdict (degrade-safe), it just
   * mints no interaction — byte-identical to today.
   */
  onAuthHalt?: OnAuthHalt;
  signal?: AbortSignal;
  maxTurns: number;
  onEvent: (ev: SubagentEvent) => void;
  /**
   * OPTIONAL OpenAI prompt-cache anchor for the nested run (PR5 item 2). The Agent
   * tool sets this to a DISTINCT per-agent-type key (`${ownerTaskId}:sub:${slug}`)
   * so the subagent's different system prefix routes to its OWN cache shard and
   * never pollutes the parent task's shard. Threaded onto every nested callModel.
   * Anthropic ignores `cacheKey` (its caching is `cache_control`-driven) → absent or
   * present, its request body is byte-identical; omitted entirely ⇒ no
   * `prompt_cache_key` sent on the OpenAI path either.
   */
  cacheKey?: string;
  /**
   * T10 (durable subagent deep-HITL, Phase B) — the PARENT task's per-task Journal.
   * When present together with a non-empty `subagentPath`, the loop durably journals
   * its OWN rounds (assistant text + each tool_use + each tool_result) scope-tagged by
   * the path, so a later task can re-enter this subagent from journaled state instead
   * of replaying its model rounds. Single-writer preserved — every append routes
   * through THIS journal (never `new Journal(...)`). Absent ⇒ no extra journaling ⇒
   * byte-identical to today.
   */
  journal?: Journal;
  /**
   * T10 — the root→leaf path that SCOPES this subagent's journaled entries (its leaf
   * segment's `agentToolUseId` is the `SubagentId`). The Agent tool supplies it when
   * running as an orchestrator; an absent/empty path ⇒ no scoped journaling ⇒
   * byte-identical to today.
   */
  subagentPath?: SubagentPathSegment[];
  /**
   * T11b (durable subagent deep-HITL, Phase B) — RE-ENTER a paused subagent from its
   * journaled scope projection instead of REPLAYING it from the top. When present, the
   * loop SEEDS its provider history from `seedEntries` (the subagent's `projectScope`
   * rounds, already ending with the paused tool's resolved tool_result) PLUS a
   * synthesized leading user message (`userPrompt`, never journaled), then proceeds
   * DIRECTLY to the model loop — so prior model rounds are NEITHER regenerated NOR
   * re-billed (zero replay). New forward rounds bill via the normal sinks, exactly as a
   * fresh subagent would. Absent ⇒ the loop builds `emptyHistory()` + `pushUser` ⇒
   * byte-identical to today.
   */
  resume?: {
    seedEntries: JournalEntry[];
    /**
     * P3.5b (Weave HITL pre-flip, Fix 1) — CONTINUE-AT-DISPATCH. When true, a seed
     * whose tail is an UNRESOLVED round (assistant text + tool_use entries with no
     * tool_result — the shape a Weave node's scope has after a gated-leaf pause) is
     * SPLIT: the resolved prefix seeds the history as usual, the trailing round is
     * re-pushed in-memory as ONE assistant message, and each pending call is
     * DISPATCHED with its journaled input VERBATIM before any model call — so the
     * re-run continues AT the gated leaf and a one-shot approval hash matches by
     * construction (the model never re-composes the call; composed-content drift is
     * structurally impossible). Absent/false (every T11b caller) ⇒ the seed path is
     * byte-identical (a dangling tail is left to the validity floor, as today).
     */
    continuePending?: boolean;
  };
  /**
   * Phase 3 (§1.5) — thread the owner task's id + the sandbox filesystem root
   * so a subagent's OWN oversized tool results get the SAME FS context-offload
   * as the main turn loop (subagents do the heaviest file-reading/searching
   * work, so this is where the win matters most). Absent ⇒ offload no-ops for
   * this subagent's dispatches ⇒ byte-identical to today (guardToolOutput's
   * hard cap remains the backstop).
   */
  taskId?: string;
  workingDir?: string;
  /** Phase 3 (§1.5) — env-tunable offload-threshold override; see native-config.ts. */
  offloadThresholdChars?: number;
  /**
   * W4-2 (shadow injection screen) — the SAME seam the main loop threads
   * (native-config.ts), forwarded by the Agent tool so a subagent's own
   * side-effecting dispatches on a tainted turn are screened too (the
   * researcher-child-reads-hostile-page, parent-or-child-then-sends shape).
   * Absent ⇒ byte-identical dispatch.
   */
  injectionScreen?: InjectionScreenSeam;
  /**
   * P2.2 (SUBAGENT_SHARED_LOOP === '1', config.ts → NativeConfig → the Agent
   * tool) — run this nested loop on the SHARED round core (round-engine's
   * runOneRound, the same per-round unit the main iterateTurn drives) instead
   * of the legacy hand-rolled round body below. The shared core brings the main
   * loop's `startStreamWithRetry` retry + fallback-model switch and appends
   * per-round `source:'subagent'` usage journal entries (agentPath-tagged —
   * charter c, journal-vs-billed parity for the P2.1 cost seed). Absent/false
   * (default) ⇒ the legacy body ⇒ byte-identical.
   */
  sharedLoop?: boolean;
  /**
   * Orchestration walls (SUBAGENT_WALLS_V1) — this run is a DELEGATED helper under
   * the walls. Threaded by the Agent tool from its own heritable `walls`, and set on
   * the nested round's `cfg.subagentWalls` so the shared round core can refuse a lone
   * child (spec D3). Absent/false (default) ⇒ the cfg key is omitted ⇒ byte-identical.
   */
  walls?: boolean;
  /** Walls — the PARENT round's grace (ms); the nested cfg shrinks it so a child seals first. */
  drainTimeoutMs?: number;
  /**
   * Orchestration walls — the spawner's refusal counter, threaded onto this run's
   * nested round cfg so a lone-child refusal decided INSIDE the helper reaches the
   * tree stats the Agent tool owns. Absent ⇒ the cfg key is omitted ⇒ byte-identical.
   */
  onSubagentRefused?: (kind: SubagentRefusalKind) => void;
  /**
   * P2.2 — the retry/fallback policy the shared loop inherits (the parent run's
   * `cfg.retry`, threaded by the Agent tool). Read ONLY when `sharedLoop` is on;
   * absent ⇒ the shared core's DEFAULT_RETRY bounds (4 attempts, no fallback; with
   * RETRY_BY_CAUSE_V1 on, a rate limit gets RATE_LIMIT_MAX_ATTEMPTS = 6).
   */
  retry?: { maxAttempts?: number; backoffMs?: number; fallbackModel?: string };
  /**
   * The run's INCLUSIVE live spend ledger (live-spend.ts), threaded by the Agent
   * tool from the parent's `cfg.liveSpend` exactly like `retry`. Every round THIS
   * node runs folds into it the moment it is priced — on BOTH paths (the shared
   * loop hands it to the round core; the legacy body folds it inline) — so a gate
   * upstream sees a nested burn while it burns, not at completion. Absent ⇒ the
   * folds no-op ⇒ byte-identical.
   */
  liveSpend?: LiveSpendLedger;
  /**
   * The parent turn's PER-TURN spend ceiling, as a closure (the child has no
   * NativeConfig — same reason `liveSpend` rides here). Read at the head of BOTH
   * loop bodies: true ⇒ this child stops BEFORE its next model call and returns
   * what it has, cost and all (money spent is money booked; the total still folds
   * to the parent). Absent ⇒ no head check ⇒ byte-identical.
   *
   * Build it with `turnSpendCeilingReached(cfg)` (live-spend.ts) so every site in
   * the rail asks the same question.
   */
  turnSpendExceeded?: () => boolean;
  /**
   * P2.2 charter (a) / Hardening-G — thread the dark tool-error-taxonomy flag
   * into THIS loop's dispatch execCtx (both the legacy and shared paths), so a
   * sentinel-returning tool INSIDE a subagent maps onto the wire `is_error`
   * channel + the `[error:<code>]` stamp exactly like a main-loop dispatch.
   * Absent/false (default) ⇒ sentinels unwrap to their message ⇒ byte-identical.
   */
  toolErrorTaxonomy?: boolean;
  /** X1: asked when the model stops; text back is the helper's next instruction (subagent-stop-rail.ts). */
  onStop?: (lastText: string) => Promise<string | undefined>;
}

function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  const sum: NormalizedUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  };
  // Anthropic's 5m/1h cache-write split rides only when a round carried it (every other
  // arm leaves both undefined ⇒ the sum's shape is byte-identical).
  for (const k of ['cacheCreation5mInputTokens', 'cacheCreation1hInputTokens'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) sum[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return sum;
}

export async function runSubagentLoop(opts: SubagentRunOptions): Promise<SubagentRunResult> {
  const { transport, model, system, userPrompt, tools, harness, onPause, signal, maxTurns, onEvent, cacheKey } = opts;

  // T10 — durably journal THIS subagent's rounds, scope-tagged by its path, ONLY when
  // BOTH a journal and a non-empty path are present (the path exists only under the
  // recursion flag). Gate on path-PRESENCE, never a fresh env read in the loop. Absent
  // ⇒ `scopedJournal` is undefined ⇒ zero extra appends ⇒ byte-identical to today.
  const scopedJournal: { j: Journal; path: SubagentPathSegment[] } | undefined =
    opts.journal && opts.subagentPath && opts.subagentPath.length > 0
      ? { j: opts.journal, path: opts.subagentPath }
      : undefined;

  const providerTools = transport.buildTools(tools);
  // COMPACTION_V2 — the child lane's context ceiling. A subagent has no journal
  // projection, so the elision seam cannot reach it and compaction is unreachable by
  // construction; what it gets instead is a bounded output contract (see
  // kernel/compaction/subagent-ceiling.ts). Latched: once spent, the child runs its
  // final tool-less round and answers. Flag OFF ⇒ never set ⇒ byte-identical.
  let ceilingSpent = false;
  /** The tools THIS round may use — empty once the ceiling has been spent. */
  const roundTools = (): ProviderTool[] => (ceilingSpent ? [] : providerTools);
  /** Trip the ceiling at a round head, pushing the terminal instruction once. */
  const checkCeiling = (): void => {
    if (ceilingSpent || !compactionV2Enabled()) return;
    if (!subagentCeilingReached(history, model)) return;
    ceilingSpent = true;
    transport.pushUser(history, SUBAGENT_CONTEXT_CEILING_NUDGE);
  };
  // Runaway watchdog (bounded progress, incident 2026-08-20) — per-run instance
  // (closure state; concurrent subagents never share counters). Pure observation
  // until the trip: every settled model-driven dispatch feeds `observe` (legacy
  // body per-dispatch, shared core at round settle); the module warns ONCE and
  // latches. On trip, three things happen on EXISTING seams:
  //  1. every further gate rides `guardedHarness` below and is DENIED with the
  //     terminal directive (never executed) — provider-neutral, unlike the
  //     ceiling's empty-tools contract, which OpenAI-shaped lanes reject;
  //  2. the directive is pushed ONCE as a user message at the round boundary
  //     (the ceiling's steering seam — never mid-batch, so tool_results stay
  //     ahead of user text in the merged message);
  //  3. after SUBAGENT_RUNAWAY_GRACE_ROUNDS post-directive rounds the loop
  //     force-breaks, returning whatever partial `finalText` exists through the
  //     NORMAL return path (the Agent tool's existing report rail).
  const watchdog = createSubagentRunawayWatchdog({ childId: opts.childId, model });
  let runawayDirectivePushed = false;
  let runawayGraceRoundsUsed = 0;
  let wrapUpDirectivePushed = false;
  /** The ONE gate every dispatch in this run rides — pass-through until the trip. */
  const guardedHarness: SubagentRunOptions['harness'] = {
    gateTool: (call: ToolCall): Promise<GateResult> =>
      watchdog.tripped
        ? Promise.resolve({ decision: 'deny', message: SUBAGENT_RUNAWAY_DIRECTIVE })
        : turnCapTripped
          ? Promise.resolve({ decision: 'deny', message: TURN_CAP_DIRECTIVE })
          : harness.gateTool(call),
  };
  /** Round-boundary directive push (once); no-op until the trip. */
  const maybePushRunawayDirective = (): void => {
    if (!watchdog.tripped || runawayDirectivePushed) return;
    runawayDirectivePushed = true;
    transport.pushUser(history, SUBAGENT_RUNAWAY_DIRECTIVE);
  };
  /**
   * Follow-up item 2 — the SAME wrap-up directive, pushed once at 75% of the cap. Asking
   * for the report only in the last round gave a child that had spent every turn on tools
   * one shot at composing one, with tools already refused; at 75% it still has turns to
   * write in. It STEERS, it does not gate: nothing is refused here, and the cap below is
   * the hard backstop for a child that ignores it.
   */
  const maybePushWrapUpDirective = (): void => {
    if (opts.walls !== true || wrapUpDirectivePushed || turnsUsed < wrapUpAtTurn(maxTurns)) return;
    wrapUpDirectivePushed = true;
    transport.pushUser(history, TURN_CAP_DIRECTIVE);
  };
  /** Round-head grace gate: TRUE once the post-directive budget is exhausted. */
  const runawayGraceExhausted = (): boolean => {
    if (!runawayDirectivePushed) return false;
    if (runawayGraceRoundsUsed >= SUBAGENT_RUNAWAY_GRACE_ROUNDS) return true;
    runawayGraceRoundsUsed += 1;
    return false;
  };
  // T11b — RE-ENTRY: seed from the journaled scope projection so the model is invoked
  // ONLY for forward rounds (prior rounds are re-entered, never regenerated/re-billed).
  // The subagent's leading user prompt is NOT journaled (T10), so it is synthesized here
  // and prepended; `seedEntries` already ends with the paused tool's resolved result, so
  // the seeded history is a structurally valid request the model continues from. Absent
  // ⇒ the historic `emptyHistory()` + `pushUser` path ⇒ byte-identical to today.
  // P3.5b (Fix 1) — CONTINUE-AT-DISPATCH: a `continuePending` seed ending mid-round
  // is split; its resolved prefix seeds the history here and the trailing round is
  // re-pushed + dispatched below (see splitTrailingPendingRound). Absent ⇒ undefined
  // ⇒ the whole seed feeds historyFromJournal exactly as before.
  const pendingRound = opts.resume?.continuePending === true
    ? splitTrailingPendingRound(opts.resume.seedEntries)
    : undefined;
  const history = opts.resume
    ? transport.historyFromJournal([
        userSeedEntry(userPrompt),
        ...(pendingRound?.resolvedPrefix ?? opts.resume.seedEntries),
      ])
    : transport.emptyHistory();
  if (!opts.resume) transport.pushUser(history, userPrompt);

  // Model-aware per-round output budget — mirrors the parent loop: read the real
  // cap from the capability registry so a long subagent answer is not guillotined
  // at a flat 8192. Unknown ids resolve to the 8192 fallback (behavior preserved).
  const maxOutputTokens = resolveCapabilities(model).maxOutputTokens;

  let costUsd = 0;
  // OWN-cost accumulator (Agent-v2 attribution) — kept SEPARATE from `costUsd` even
  // though they are equal today: for a leaf subagent (no recursion yet) there are no
  // grandchildren to fold, so own === inclusive. Task 11 folds grandchild cost into
  // the inclusive `costUsd` only, leaving `ownCostUsd` as this node's own model spend.
  let ownCostUsd = 0;
  let toolUseCount = 0;
  let usageAcc: NormalizedUsage = { ...ZERO_USAGE };
  let finalText = '';
  const continueAfterStop = subagentStopRail(opts.onStop, transport, history, scopedJournal, () => finalText, () => !ceilingSpent && !runawayDirectivePushed && !wrapUpDirectivePushed && turnsUsed < maxTurns);
  let pausedHalt = false;
  // Set when the parent turn's spend ceiling stopped this child at a loop head
  // (see TURN_CEILING_STOP_NOTE) — the answer below is partial BY POLICY, and the
  // parent model must be told so instead of reading an unexplained short report
  // and spawning a replacement.
  let turnCeilingStopped = false;
  // Orchestration walls: how the loop left. 'exhausted' = it ran out of turns while
  // the model was still calling tools, i.e. the turn cap.
  let loopExit: 'finished' | 'exhausted' | 'aborted' | 'paused' | 'ceiling' | 'runaway' = 'exhausted';
  let turnsUsed = 0;
  /** Latched at the cap: every further gate is denied with the wrap-up directive. */
  let turnCapTripped = false;
  // T5 (HITL subagent depth) — capture the structured pause this loop's `onPause` fires
  // (the leaf inner tool + kind + any path that bubbled through). Returned as `pauseInfo`
  // alongside the boolean `pausedHalt`. Wrap the real `onPause` so the model-driven
  // dispatch records the pause without changing its behavior.
  let capturedPauseInfo: SubagentPauseInfo | undefined;
  const onPauseCapturing = async (call: ToolCall, kind: string, subagentPath?: SubagentPathSegment[]): Promise<string> => {
    capturedPauseInfo = {
      toolUseId: call.toolCallId,
      toolName: call.toolName,
      kind,
      ...(subagentPath !== undefined && { subagentPath }),
    };
    return onPause(call, kind, subagentPath);
  };

  // code-exec (Slice 2b Task 8, Gap A) — give the subagent's tools the SAME in-process
  // dispatcher the top-level native loop gives (native-harness.ts). A tool dispatched
  // inside the subagent (execute_code) re-enters the gate->execute pipeline via
  // `ctx.dispatchInProcessTool`, scoped to the subagent's OWN `tools` — so an in-code
  // call resolves only the subagent's (narrowed) toolset (a web stub hits "Unknown
  // tool"). The INNER execCtx is `baseExecCtx` (NO dispatchInProcessTool) so a nested
  // tool cannot recurse back into execute_code. The pause is the side-effect-free
  // `inCodePause` (an in-code needs_human verdict cannot pause a subprocess blocked on
  // a synchronous UDS RPC — firing the real onPause would mint a phantom interaction),
  // and there is no onAuthHalt. No `pushEvent` on THIS ctx → nested in-code calls are
  // NOT traced. That stays true and is deliberate: this is the in-code path, kept
  // side-effect-free on purpose (see the pause note above). The model-driven
  // `dispatchExecCtx` below DOES carry a push channel — the two are different cases.
  // Built ONCE: tools/harness/signal are constant across the run.
  // DELIBERATELY carries NO markPausedHalt (unlike dispatchExecCtx below): an in-code
  // pause is the side-effect-free `inCodePause`, so an in-code tool must NOT surface a
  // pausedHalt that would mint a phantom parent interaction.
  const baseExecCtx = { ...(signal !== undefined ? { signal } : {}) };
  const dispatchInProcessTool = makeInProcessDispatcher({
    tools,
    harness: guardedHarness,
    onPause: inCodePause,
    onAuthHalt: undefined,
    execCtx: baseExecCtx,
  });

  // Task 11 (bounded recursion) — the dispatch execCtx the model-driven tool calls run
  // under. For a LEAF subagent (no recursive Agent tool in `tools`) NOTHING ever invokes
  // these sinks → numerically + behaviorally byte-identical to before. For an ORCHESTRATOR
  // (its toolset RE-ADMITS the Agent tool), the nested Agent tool folds a grandchild's:
  //   - INCLUSIVE cost via `addCostUsd` → into THIS node's INCLUSIVE accumulator (`costUsd`,
  //     the returned scalar) so the budget rolls up the chain — it must NOT touch
  //     `ownCostUsd` (that stays this node's OWN model-round spend, which is what the
  //     emitted childCost carries — EXCLUDING grandchildren, so each round is counted once);
  //   - OWN-cost RECORD via `addChildCost` → chained straight UP through `opts.onChildCost`
  //     to the parent's sink, keeping the top-level `childUsage` a single FLAT own-cost list.
  const dispatchExecCtx = {
    ...baseExecCtx,
    dispatchInProcessTool,
    // The push channel for THIS subagent's model-driven tool calls. Without it a
    // nested Agent tool's `ctx.pushEvent?.(...)` optional-chained into nothing and
    // a subagent that spawned a subagent went COMPLETELY silent: no start, no text,
    // no end, while the grandchild ran and billed. The pane rendered an empty run
    // for as long as the work took (prod, since at least 2026-08-24).
    //
    // Routed to `onEvent`, not to a socket: the engine still never emits (the
    // EMISSION contract at the top of this file), it hands the event to the Agent
    // tool, which stays the sole emitter (K3). Verbatim — the inner tool already
    // stamped its own identity and re-stamping would misattribute the lane.
    //
    // DELIBERATELY NOT on `baseExecCtx` (the in-code / execute_code re-entry ctx).
    // That one is inert BY DESIGN and stays that way: it also withholds
    // markPausedHalt because an in-code pause is the side-effect-free `inCodePause`,
    // and giving that path real side effects mints phantom interactions. This ctx is
    // the opposite case — it ALREADY opts in to surfacing depth-N semantics upward
    // (see markPausedHalt below, which exists so a grandchild's pause breaks every
    // ancestor loop). Withholding the event channel here was an accident of the two
    // sharing a name, not a safety property.
    pushEvent: (ev: HarnessEvent) => onEvent({ kind: 'raw', event: ev }),
    addCostUsd: (usd: number) => {
      costUsd += usd;
    },
    addChildCost: (rec: ChildCostRecord) => opts.onChildCost?.(rec),
    // native-redrive (present-as-sentinel) — OPT IN to the pause-surfacing path for
    // THIS subagent's own model-driven tool dispatches, exactly as the main loop's
    // baseExecCtx does (round-engine.ts). tool-dispatcher.ts installs its own
    // pausedHalt-CAPTURING closure onto the tool's execute ctx only when this key is
    // present (any value; this no-op is just the opt-in), then reads it onto the
    // dispatch result's `pausedHalt`. This is what lets a depth-N grandchild's pause
    // bubble break EVERY ancestor loop: a nested Agent tool inside this orchestrator
    // calls `ctx.markPausedHalt?.()` when its subagent paused, that flips this loop's
    // `round.results.some(r => r.pausedHalt)` break, and the pause propagates UP.
    // Omitting it (the pre-fix bug) left `ctx.markPausedHalt` undefined, the call
    // optional-chained into nothing, and the pause was swallowed one level down.
    markPausedHalt: () => {},
    // Phase 3 (§1.5) — FS context-offload for this subagent's own tool dispatches.
    ...(opts.taskId !== undefined && { taskId: opts.taskId }),
    ...(opts.workingDir !== undefined && { workingDir: opts.workingDir }),
    ...(opts.offloadThresholdChars !== undefined && { offloadThresholdChars: opts.offloadThresholdChars }),
    // Phase 4 (§1.7) — this subagent's OWN (possibly routed) model, so an unset
    // threshold above derives a window-fraction default from ITS contextWindowTokens.
    model: opts.model,
    // P2.2 charter (a) / Hardening-G — the dark taxonomy flag; absent → OFF
    // (byte-identical), mirroring the main loop's baseExecCtx threading.
    ...(opts.toolErrorTaxonomy !== undefined && { toolErrorTaxonomy: opts.toolErrorTaxonomy }),
    // W4-2 — the shadow injection screen seam (absent → byte-identical dispatch).
    ...(opts.injectionScreen !== undefined && { injectionScreen: opts.injectionScreen }),
  };

  // ── P3.5b (Fix 1) — dispatch the split-off pending round BEFORE any model call ──
  // Re-push the paused round in-memory as ONE assistant message (its journaled text
  // + tool_use blocks — the exact live-push shape), then dispatch each pending call
  // with its JOURNALED input VERBATIM through the normal gate pipeline: the node
  // continues AT the gated leaf, so a Weave one-shot approval hash matches by
  // construction. A pause here (deny / fresh gate) sets pausedHalt and skips the
  // model loop entirely — nothing journaled, the scope stays dangling for the next
  // cycle. SILENT on onEvent but for the action fee: the original run showed this call's
  // tool_use, and a paused call is billed only when it runs, which is here.
  if (pendingRound !== undefined) {
    // leadReplay: the paused round as the model sent it (Gemini 3 400s it rebuilt unsigned).
    transport.pushAssistant(history, [
      ...pendingRound.leadBlocks,
      ...pendingRound.pendingToolUses.map((tu) => ({
        type: 'tool_use', toolUseId: tu.id, toolName: tu.name, toolInput: tu.input,
      })),
    ] as never, pendingRound.leadReplay);
    for (const r of pendingRound.resolvedResults) transport.pushToolResult(history, r);
    for (const tu of pendingRound.pendingToolUses) {
      const def = tools.find((t) => t.name === tu.name);
      const res = def === undefined ? unknownToolResult(tu.id, tu.name, opts.toolErrorTaxonomy)
        : await gateAndDispatchTool(def, tu.input, tu.id, guardedHarness, onPauseCapturing, opts.onAuthHalt, dispatchExecCtx);
      toolUseCount++;
      if (res.pausedHalt) {
        pausedHalt = true;
        break;
      }
      const fee = def === undefined ? undefined : toolBillingEvent({ taskId: opts.taskId ?? '', toolName: tu.name, toolUseId: tu.id, isSubagent: true }, res);
      if (fee) onEvent({ kind: 'billing', event: fee });
      // The tool_use entry already exists in the scope (journaled pre-dispatch on
      // the original run) — append ONLY the result, completing the pair so the next
      // cycle's projection continues past it (never a duplicate tool_use block).
      if (scopedJournal) {
        await appendSubagentToolResultEntry(scopedJournal.j, scopedJournal.path, {
          toolUseId: res.toolUseId,
          text: res.text,
          isError: res.isError,
          ...((res as { blocks?: ContentBlock[] }).blocks ? { blocks: (res as { blocks?: ContentBlock[] }).blocks } : {}),
          // W4-1: the subagent's scope-tagged entry carries the same taint
          // verdict as a main-scope append (the fence already rides res.text).
          ...((res as { taint?: 'external' }).taint !== undefined && { taint: (res as { taint?: 'external' }).taint }),
        });
      }
      transport.pushToolResult(history, res);
    }
  }

  // ── P2.2 (SUBAGENT_SHARED_LOOP) — the SHARED round core ─────────────────────
  // Drives round-engine.runOneRound (the SAME per-round unit the main iterateTurn runs) instead of the
  // legacy body below, inheriting the main loop's startStreamWithRetry retry + fallback-model switch and
  // journaling per-round source:'subagent' usage entries (charter c). KEEPS from the legacy body: T10 scoped
  // journaling, T11b re-entry seeding (the seeded `history` above), settle-on-abort, first-pause batch
  // break, and the SubagentEvent surface — the adapter below maps the round's block events onto onEvent;
  // thinking deltas are dropped (not surfaced inside a subagent today); of the raw events out of THIS
  // GENERATOR only usage and a call's fee (→ a `billing` SubagentEvent) go up. Raw events are produced on the
  // sub path — a nested tool pushes them through dispatchExecCtx.pushEvent → onEvent, which never touches
  // the round core. (Both loop bodies gate on !pausedHalt: a pending-round pause above must reach the caller
  // without a model call — flag-independent, since pausedHalt is only ever true here via the pendingRound
  // dispatch.)
  if (opts.sharedLoop && !pausedHalt) {
    // A synthesized HarnessContext for the journal-less round core: the sub path
    // never runs the main-journal branches (the persistRound seam owns
    // persistence), so the core reads only taskId/model + the (empty) config.
    const roundCtx: HarnessContext<NativeConfigLike> = {
      taskId: opts.taskId ?? '',
      sessionId: '',
      cwd: opts.workingDir ?? '',
      model,
      config: {},
      // P3 (PR-1): signal is a required spine field — carry the run's signal
      // (the same one the round core's cfg.signal aborts on) else an inert one.
      signal: signal ?? new AbortController().signal,
    };
    const st: RoundState = {
      assistantText: '',
      thinkingBlocks: [],
      toolUses: [],
      roundAppended: false,
      inToolBatch: false,
      stopReason: null,
      lastUsage: { ...ZERO_USAGE },
      lastUsageModel: model,
    };
    // Main-loop-only sinks the shared core writes through — inert for a subagent.
    const droppedTurnBlocks: ContentBlock[] = [];
    const noTodoBlocks: ContentBlock[] = [];
    // The round core's deps, built fresh per call (`roundTools()` is ceiling-sensitive,
    // so it is read at the round head). Lifted so the wrap-up below runs the SAME round.
    const roundDeps = (): RoundDeps => ({
      ctx: roundCtx,
      cfg: {
        ...(signal !== undefined ? { signal } : {}),
        ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
        ...(opts.liveSpend !== undefined ? { liveSpend: opts.liveSpend } : {}),
        ...(opts.walls ? { subagentWalls: true } : {}),
        ...(opts.walls === true ? { drainTimeoutMs: nestedDrainTimeoutMs(opts.drainTimeoutMs ?? DRAIN_DEFAULT_MS) } : {}),
        ...(opts.onSubagentRefused ? { onSubagentRefused: opts.onSubagentRefused } : {}),
        // T5: the round core's own answers (an unknown tool) take the one error shape too.
        ...(opts.toolErrorTaxonomy !== undefined ? { toolErrorTaxonomy: opts.toolErrorTaxonomy } : {}),
      },
      transport,
      harness: guardedHarness,
      tools,
      providerTools: roundTools(),
      system,
      onPause: onPauseCapturing,
      onAuthHalt: opts.onAuthHalt,
      requestedModel: model,
      cachePrefixHint: undefined,
      history,
      turnBlocks: droppedTurnBlocks,
      pendingTodoBlocks: noTodoBlocks,
      sub: {
        ...(cacheKey !== undefined ? { cacheKey } : {}),
        foldRoundCost: (roundCostUsd, usage) => {
          costUsd += roundCostUsd;
          ownCostUsd += roundCostUsd;
          usageAcc = addUsage(usageAcc, usage);
        },
        persistRound: async (round) => {
          if (round.assistantText) finalText = round.assistantText;
          // T10 — the round's assistant entry, scope-tagged: its TEXT (a tool-only
          // round needs none — its tool_use entries fold in on projection) and its
          // sealed Gemini channel (see appendSubagentRound).
          await appendSubagentRound(scopedJournal, round.assistantText, round.replay, model, transport);
          // P2.2 charter (c) — the settled round's usage entry, scope-tagged +
          // source:'subagent', appended AFTER the assistant entry (the same
          // settlement ordering the main loop keeps for the P2.1 seed). The
          // journal→history mappers ignore non-context kinds, so T11b re-entry
          // seeds skip these entries.
          if (scopedJournal) {
            await appendSubagentUsageEntry(scopedJournal.j, scopedJournal.path, {
              costUsd: round.roundCostUsd,
              model: round.committedModel,
              inputTokens: round.usage.inputTokens,
              outputTokens: round.usage.outputTokens,
            });
          }
          // Fold the assistant round into the nested history: the provider's own
          // message when the round carried it (Anthropic), else text + tool_use.
          const assistantBlocks = [
            ...(round.assistantText ? [{ type: 'text', text: round.assistantText }] : []),
            ...round.toolUses.map((tu) => ({
              type: 'tool_use',
              toolUseId: tu.id,
              toolName: tu.name,
              toolInput: tu.input ?? {},
            })),
          ];
          transport.pushAssistant(history, assistantBlocks as never, round.replay);
        },
        execCtx: dispatchExecCtx,
        ...(scopedJournal !== undefined ? { scopedJournal } : {}),
      },
    });
    // Drive ONE round to settlement, adapting its HarnessEvents onto the SubagentEvent
    // surface (K3: the Agent tool stays the emitter via onEvent → pushEvent). Shared by the
    // loop body and the wrap-up so a refused tool still emits tool_use/tool_result.
    const driveRound = async (): Promise<RoundResult> => {
      const gen = runOneRound(roundDeps(), st);
      let n = await gen.next();
      while (!n.done) {
        const ev = n.value;
        if (ev.kind === 'block') {
          const b = ev.block as {
            type: string; text?: string; toolUseId?: string; toolName?: string;
            toolInput?: unknown; content?: string; isError?: boolean;
          };
          if (b.type === 'text') {
            onEvent({ kind: 'text', delta: b.text ?? '' });
          } else if (b.type === 'tool_use') {
            onEvent({ kind: 'tool_use', subToolUseId: b.toolUseId ?? '', toolName: b.toolName ?? '', toolInput: b.toolInput });
          } else if (b.type === 'tool_result') {
            onEvent({ kind: 'tool_result', subToolUseId: b.toolUseId ?? '', result: b.content ?? '', isError: b.isError === true });
          }
          // thinking blocks: not surfaced inside a subagent (legacy behavior).
        } else if (ev.kind === 'usage') {
          // C5 (SUBAGENT_USAGE_LEDGER_V1): this round's usage, on the 'subagent' lane — up the
          // same raw relay a nested tool's events take, so it reaches the sink at any depth.
          onEvent({ kind: 'raw', event: ev });
        } else if (ev.kind === 'raw' && ev.event === AGENT_TOOL_BILLING_EVENT) {
          // A settled call's action fee (finalizeSequentialTool, isSubagent): up to the Agent tool.
          onEvent({ kind: 'billing', event: ev });
        } else {
          // Non-block events are not expected here (billing is forwarded just above;
          // a nested tool's raw events leave via dispatchExecCtx.pushEvent → onEvent, never
          // through this generator). Dropping one is right — but NOT silently: a traceless
          // drop here is how the nested-subagent blackout survived on prod for days.
          noteUnforwardedSubEvent(ev.kind);
        }
        n = await gen.next();
      }
      return n.value;
    };
    for (let step = 0; step < maxTurns; step++) {
      if (signal?.aborted) { loopExit = 'aborted'; break; }
      // Per-turn spend ceiling — stop BEFORE the next model call, settling the
      // accumulated cost through the normal return path below.
      if (opts.turnSpendExceeded?.() === true) {
        turnCeilingStopped = true;
        loopExit = 'ceiling';
        break;
      }
      // D1-style per-round reset. lastUsage resets too (legacy nested shape: a
      // round that never reached `done` folds ZERO, not the prior round's usage).
      st.assistantText = '';
      st.thinkingBlocks = [];
      st.toolUses = [];
      st.roundAppended = false;
      st.lastUsage = { ...ZERO_USAGE };
      checkCeiling();
      // Runaway watchdog — force-finish once the post-directive grace is spent.
      if (runawayGraceExhausted()) { loopExit = 'runaway'; break; }
      // Counted at the model call: a head-gate break above consumed no round.
      turnsUsed += 1;
      const round = await driveRound();
      // Dispatched tools only (R24) — the wrap-up below refuses its calls, so counts none.
      toolUseCount += round.results.length;
      // Settle-on-abort: break cleanly with the accumulated cost (AC-2b-3) AND the text
      // the killed round already streamed (D7 runner half) — round-stream sealed `st`.
      if (round.abortedMidStream) {
        if (opts.walls === true && !finalText && st.assistantText) finalText = st.assistantText;
        loopExit = 'aborted';
        break;
      }
      // native-redrive — the round broke at a paused tool: propagate the pause.
      if (round.results.some((r) => r.pausedHalt)) {
        pausedHalt = true;
        loopExit = 'paused';
        break;
      }
      // Runaway watchdog — feed the settled batch (batch order; a paused batch
      // broke above, and runOneRound already pushed every tool_result into the
      // history, so the round-boundary directive lands behind them).
      for (const r of round.results) {
        const tu = st.toolUses.find((t) => t.id === r.toolUseId);
        if (tu) watchdog.observe(tu.name, tu.input, r.isError);
      }
      maybePushRunawayDirective();
      maybePushWrapUpDirective();
      // No tool calls → the subagent has answered. Stop, unless a SubagentStop hook says go on (X1).
      if (st.toolUses.length === 0 && !(await continueAfterStop())) { loopExit = 'finished'; break; }
    }

    // Orchestration walls (spec D6): the turn cap is a WRAP-UP, not a cliff. The loop ran
    // out of turns mid-tool-call, so it has no report yet. Push the directive as a user turn
    // and run ONE more round with every tool REFUSED at the gate (the same provider-neutral
    // deny the runaway guard uses — the ceiling's empty-tools contract is rejected by
    // OpenAI-shaped lanes). NOT counted in `turnsUsed`: it is not a turn to work in.
    if (opts.walls === true && loopExit === 'exhausted' && !pausedHalt) {
      turnCapTripped = true;
      transport.pushUser(history, TURN_CAP_DIRECTIVE);
      st.assistantText = ''; st.thinkingBlocks = []; st.toolUses = [];
      st.roundAppended = false; st.lastUsage = { ...ZERO_USAGE };
      const round = await driveRound();
      // A Stop DURING the wrap-up is a user stop, not the cap — settle it like the loop body.
      if (round.abortedMidStream) {
        if (opts.walls === true && !finalText && st.assistantText) finalText = st.assistantText;
        loopExit = 'aborted';
      }
    }
  }

  if (!opts.sharedLoop && !pausedHalt) for (let step = 0; step < maxTurns; step++) {
    if (signal?.aborted) { loopExit = 'aborted'; break; }
    // Per-turn spend ceiling — the legacy body's head check, identical to the
    // shared body's above (the two are alternatives on `opts.sharedLoop`, so the
    // ceiling has to be asked in BOTH or half the fleet keeps burning).
    if (opts.turnSpendExceeded?.() === true) {
      turnCeilingStopped = true;
      loopExit = 'ceiling';
      break;
    }
    checkCeiling();
    // Runaway watchdog — force-finish once the post-directive grace is spent.
    if (runawayGraceExhausted()) { loopExit = 'runaway'; break; }
    // Counted at the model call, exactly as the shared body counts it.
    turnsUsed += 1;

    const stream = transport.callModel({
      model,
      system,
      tools: roundTools(),
      history,
      ...(signal !== undefined ? { signal } : {}),
      maxTokens: maxOutputTokens,
      // PR5 item 2 — anchor the nested run to its OWN cache shard. Conditional spread
      // ⇒ omitted when absent ⇒ Anthropic byte-identical (no prompt_cache_key).
      ...(cacheKey !== undefined ? { cacheKey } : {}),
    });

    let roundText = '';
    const toolUses: Array<{ id: string; name: string; input: unknown; thoughtSignature?: string }> = [];
    let usage: NormalizedUsage = { ...ZERO_USAGE }, replay: ProviderReplay | undefined;

    // SETTLE-ON-ABORT (Weave Phase 2b, design §6.3 / AC-2b-3). A user/timeout abort
    // MID-GENERATION makes `readStream` throw (the provider stream forwards the signal,
    // e.g. Anthropic's APIUserAbortError). If we let that throw escape `runSubagentLoop`,
    // the cost of every ALREADY-COMPLETED round is lost — the whole subagent under-bills
    // to $0 (Weave nodes AND main-loop `:turnbatch` nodes). So on an aborted signal we
    // BREAK the loop cleanly and RETURN the accumulated `costUsd`/`childCost`, which the
    // Agent-tool caller folds via `addCostUsd`/`addChildCost` (the same billing path a
    // between-rounds abort already takes). The aborted round's own partial tokens are
    // unavailable — no `done` event arrived — an accepted, unmeasurable edge; we never
    // over-count it. A NON-abort throw still propagates unchanged.
    let abortedMidStream = false;
    try {
      for await (const ev of transport.readStream(stream)) {
        if (ev.kind === 'text') {
          roundText += ev.text;
          onEvent({ kind: 'text', delta: ev.text });
        } else if (ev.kind === 'tool_use') {
          toolUses.push(ev.toolUse);
        } else if (ev.kind === 'done') {
          usage = ev.usage; replay = ev.replay; // replay: the provider's message as sent
        }
        // thinking + rendered_tool are not surfaced inside a subagent (no nested thinking UI).
      }
    } catch (err) {
      if (signal?.aborted) abortedMidStream = true;
      else throw err;
    }
    if (abortedMidStream) { loopExit = 'aborted'; break; }

    const roundCostUsd = transport.computeCostUsd(usage, model);
    // The legacy body prices its own rounds (it never reaches runOneRound), so the
    // live fold belongs here. The two loops are alternatives on `opts.sharedLoop`,
    // so a round folds into the ledger exactly once.
    foldModelSpend(opts.liveSpend, transport, roundCostUsd, model);
    costUsd += roundCostUsd;
    ownCostUsd += roundCostUsd;
    usageAcc = addUsage(usageAcc, usage);
    if (roundText) finalText = roundText;

    // T10 — journal the round's assistant entry scope-tagged (mirrors the main loop:
    // text + the sealed Gemini channel ride it; each tool_use rides its own tool_use
    // entry below and folds in on projection). See appendSubagentRound.
    await appendSubagentRound(scopedJournal, roundText, replay, model, transport);

    // Fold the round into the nested history (the provider's own message when carried).
    const assistantBlocks = [
      ...(roundText ? [{ type: 'text', text: roundText }] : []),
      ...toolUses.map((tu) => ({
        type: 'tool_use',
        toolUseId: tu.id,
        toolName: tu.name,
        toolInput: tu.input ?? {},
      })),
    ];
    transport.pushAssistant(history, assistantBlocks as never, replay);

    // No tool calls → the subagent has answered. Stop, unless a SubagentStop hook says go on (X1).
    if (toolUses.length === 0 && !(await continueAfterStop())) { loopExit = 'finished'; break; }

    for (const tu of toolUses) {
      onEvent({ kind: 'tool_use', subToolUseId: tu.id, toolName: tu.name, toolInput: tu.input });
      // T10 — journal the tool_use BEFORE dispatch (mirrors the main loop), so a tool
      // that pauses still has its attempt recorded for the resume re-entry.
      if (scopedJournal) {
        await appendSubagentToolUseEntry(scopedJournal.j, scopedJournal.path, { ...tu, input: tu.input ?? {} });
      }
      const def = tools.find((t) => t.name === tu.name);
      const res = def === undefined ? unknownToolResult(tu.id, tu.name, opts.toolErrorTaxonomy)
        : await gateAndDispatchTool(def, tu.input, tu.id, guardedHarness, onPauseCapturing, opts.onAuthHalt, dispatchExecCtx);
      toolUseCount++;
      onEvent({ kind: 'tool_result', subToolUseId: tu.id, result: res.text, isError: res.isError });
      // The action fee, on the RESULT (the shared loop's rule, finalizeSequentialTool): a
      // refused, paused or unknown call sends none.
      const billing = def === undefined ? undefined : toolBillingEvent({ taskId: opts.taskId ?? '', toolName: tu.name, toolUseId: tu.id, isSubagent: true }, res);
      if (billing) onEvent({ kind: 'billing', event: billing });

      // native-redrive — a tool that paused-for-human (needs_human / Composio auth)
      // STOPS the nested loop right here. Do NOT push the PAUSED_HALT sentinel as a
      // tool_result and re-query the model: that fed the model "end your turn, do not
      // interpret this result", it produced no text, the subagent returned empty, and
      // the parent never paused (the user got no answer). Instead, propagate the pause
      // to the Agent tool, which surfaces it to the PARENT turn (bound to the parent
      // Agent tool_use id) so the pause is REAL and resume re-drives the parent.
      if (res.pausedHalt) {
        pausedHalt = true;
        loopExit = 'paused';
        break;
      }
      // Runaway watchdog — feed the settled dispatch (paused results broke above;
      // post-trip refusals are ignored by the latched observe).
      watchdog.observe(tu.name, tu.input, res.isError);
      // T10 — journal the real tool_result (scope-tagged). Skipped on a pause (the
      // break above), exactly like the main loop withholds a paused tool's result —
      // the resume materializes it. `res.blocks` (image envelopes) ride through when set.
      if (scopedJournal) {
        await appendSubagentToolResultEntry(scopedJournal.j, scopedJournal.path, {
          toolUseId: res.toolUseId,
          text: res.text,
          isError: res.isError,
          ...((res as { blocks?: ContentBlock[] }).blocks ? { blocks: (res as { blocks?: ContentBlock[] }).blocks } : {}),
          // W4-1: the subagent's scope-tagged entry carries the same taint
          // verdict as a main-scope append (the fence already rides res.text).
          ...((res as { taint?: 'external' }).taint !== undefined && { taint: (res as { taint?: 'external' }).taint }),
        });
      }
      transport.pushToolResult(history, res);
    }
    if (pausedHalt) break;
    // Runaway watchdog — the directive rides the round boundary (after every
    // tool_result of the batch is pushed), so it lands BEHIND the results in the
    // merged user message. No-op until the trip; pushed once.
    maybePushRunawayDirective();
  }

  // A ceiling-stopped child says so in its answer — the cost it already spent is
  // returned unchanged below (the parent folds it exactly once, as always).
  if (turnCeilingStopped) {
    finalText = finalText ? `${finalText}\n\n${TURN_CEILING_STOP_NOTE}` : TURN_CEILING_STOP_NOTE;
  }

  // Agent-v2 attribution: the subagent's OWN-cost record. `usage` (engine
  // NormalizedUsage) is structurally assignable to ChildCostRecord.usage (the
  // contract NormalizedUsage is a superset — same shared fields, extra optionals).
  const childCost: ChildCostRecord = {
    childId: opts.childId,
    ...(opts.parentChildId !== undefined && { parentChildId: opts.parentChildId }),
    model: opts.model,
    usage: usageAcc,
    costUsd: ownCostUsd, // OWN model-round cost only — for a leaf ownCostUsd === costUsd
  };
  // Why this run ended (spec §4.4). `ceiling` and `runaway` report 'completed': both
  // already append their own explanatory note to the text and are not a walls status.
  const stopReason: SubagentStopReason =
    pausedHalt ? 'completed'
      : loopExit === 'aborted' ? 'stopped_by_user'
        : loopExit === 'exhausted' ? 'turn_cap' : 'completed';
  return {
    text: finalText,
    costUsd,
    toolUseCount,
    usage: usageAcc,
    pausedHalt,
    ...(capturedPauseInfo !== undefined && { pauseInfo: capturedPauseInfo }),
    childCost,
    stopReason,
    turnsUsed,
  };
}
