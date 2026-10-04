import type { ActiveAbility } from '../contract/active-ability.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { HarnessEvent, PromptLayerSize } from '../contract/events.js';
import type { ChildCostRecord } from '../contract/child-cost.js';
import type { InstructionLayer, InstructionSnapshot } from '../contract/instruction-stack.js';
import type { HarnessContext, MessageOrigin } from '../contract/harness.js';
import type { Journal, PruneConfig, HookDispatcher } from '../kernel/index.js';
import type {
  RuntimeConfig,
  InteractionPort,
  PolicyPort,
  ToolDisplayPort,
  ToolHost,
  StatePort,
} from '../ports/index.js';
import type { Transport, ProviderTool } from './transport.js';
import type { RecallSeam } from './recall.js';
import type { InjectionScreenSeam } from '../policy/injection-screen.js';
import type { ReconstructionMismatch } from './reconstruction-invariant.js';
import type { LiveSpendLedger } from './live-spend.js';
import type { SubagentAllowKind, SubagentRefusalKind } from './subagent-walls.js';
import type { TreeStats } from './subagent-pool.js';
import type { ToolWatchdogEvent } from './tool-progress-watch.js';

/**
 * K6 A2b — a `priority:'now'` steer message the loop injects mid-turn. The
 * provider-neutral shape (text + the MESSAGE_PICKED_UP uuid + provenance) the
 * `pollSteer` seam returns. Structurally equal to the stream layer's SteerTurn,
 * declared here so native-config does not depend on the stream module.
 */
export interface SteerTurn {
  text: string;
  /**
   * Batch drain (queued-additions): every 'now'-lane message drained at this
   * boundary, in lane order — the loop frames and appends them as ONE user
   * entry (frameQueuedAdditions). `text` remains the joined form so a single-
   * message consumer (and every pre-batch mock) keeps working; absent ⇒ treat
   * as the one-message batch `[text]`.
   */
  texts?: string[];
  uuid?: string;
  origin?: MessageOrigin;
}

/**
 * NativeConfig — the typed escape hatch carried in HarnessContext<NativeConfig>.
 * Mirror of OpenAIConfig (openai-config.ts) but for the native Anthropic arm.
 * Notable additions over OpenAIConfig:
 *  - journal: first-class K0 history (absent → ephemeral single-process)
 *  - transport: injectable ModelPort (required in run())
 */
export interface NativeConfig {
  /**
   * ring 4c.9a — the live-socket resolver was REMOVED from NativeConfig. The
   * assembler (buildNativeToolList) now receives `getSocket` as a direct
   * parameter, threaded from NativeToolHost's constructor dep (the same source
   * the removed field resolved). The Claude/OpenAI configs keep their own
   * `getSocket`; only the native engine's config no longer carries it.
   */
  /** Fires right after the run handle exists — QueryManager emits AGENT_START etc. here. */
  onAttached: (handle: unknown) => void;
  /** System prompt / instructions (optional; defaults to buildNativeSystemPrompt() in run()). */
  systemPrompt?: string;
  /**
   * K4-T4 instruction snapshot — the per-layer {id, static, hash} + assembledHash
   * describing the assembled InstructionStack (built by the query-manager call site
   * via describeInstructionStack). When present AND the journal is a fresh session
   * (no prior entries), the harness records ONE replay-audit `custom`/`instruction_
   * snapshot` journal entry at session start. Absent → no snapshot (back-compat).
   */
  instructionSnapshot?: InstructionSnapshot;
  /**
   * CACHE_TIERING_V1 — byte offset into `systemPrompt` where the fleet-static
   * prefix ends (from splitInstructionStack at the assembly site). The loop
   * threads it to callModel so the Anthropic transport can split the system into
   * [fleet | session] cache blocks. Absent (flag off / no boundary) ⇒ every
   * request byte-identical to the untiered path.
   */
  systemFleetPrefixChars?: number;
  /**
   * Per-instruction-layer raw sizes (chars) of the assembled system prompt, stamped
   * by the assembly site (run-driver, from assembleNativeLayers) so the engine can
   * attribute the fresh-round prompt_breakdown by layer WITHOUT re-deriving the
   * stack. Observability only; absent → the breakdown carries no per-layer detail.
   */
  promptLayerSizes?: PromptLayerSize[];
  /**
   * CONTEXT_APPEND_V1 — the layers `systemPrompt` was assembled from (the 'native'
   * canonical order). The run open freezes the session's volatile ones in the journal
   * and serves every later run's system prompt from them, telling the model what changed
   * as an appended item (engine/context-append.ts). Absent (or flag off) ⇒ `systemPrompt`
   * is served as given, byte-identical.
   */
  instructionLayers?: readonly InstructionLayer[];
  /**
   * Observability (speed gap 1): called ONCE per run, at the prologue, with the tools
   * array the run's first request carries (the transport's own built array, before
   * callModel's per-request shaping) and the model. The product hashes it into its
   * `[CACHE_TIER]` line, so the fingerprint is of the real wire, not a re-derivation.
   * Must not mutate the array. Absent ⇒ nothing is called; the run is unchanged.
   */
  onWireTools?: (wire: readonly ProviderTool[], model: string) => void;
  /** AbortSignal for interrupt() — threaded into client.messages.stream(). */
  signal?: AbortSignal;
  /**
   * L5 — the turn's owner (turn-budget.ts): the root every signal derives from, the
   * mirrored round/spend counters and the one `end(reason)` every terminal exit reports
   * to. It never aborts anything itself. Minted by the driver for every native run
   * (`signal` above is the round scope over `budget.controller`); absent (tests,
   * subagents) ⇒ every read is a no-op and the loop is byte-identical.
   */
  budget?: import('./turn-budget.js').TurnBudget;
  /**
   * P3 — upper bound (ms) on waiting for an in-flight tool dispatch after
   * `signal` aborts. The WEAVE_DRAIN_TIMEOUT_MS pattern graduated to the main
   * loop (round-engine raceAbortDrain): a dispatch that settles within the bound
   * flows normally; on expiry the engine seals a truthful synthetic tool_result
   * ("Interrupted by user. [aborted after Ns; …]") and finalizes user_aborted.
   * Default 5000 (DRAIN_DEFAULT_MS). Never read unless the signal aborts.
   */
  drainTimeoutMs?: number;
  /**
   * Max tool-use rounds per user turn before the arm yields a max_turns outcome.
   * Read from MAX_TURNS env (default 25); a per-user settings override can be
   * threaded in at the query-manager call site.
   */
  maxTurns: number;
  /**
   * Per-task USD budget cap (credits-derived, same value the other arms get) —
   * the NEW spend this turn may make. Enforced at the turn head (openTurn) AND
   * at every round head inside the turn (turn-ceiling-gate.ts, founder 09-03):
   * once the turn's live spend reaches it, the arm yields a recoverable
   * max_budget turn_end and stops iterating. Undefined = uncapped.
   */
  maxBudgetUsd?: number;
  /** Which constraint minted `maxBudgetUsd` — 'task_limit' (the user's per-task
   *  budget, netted to its remainder server-side) or 'credits' (the balance).
   *  A max_budget outcome carries it as `triggeredBy` so the card names the
   *  right knob (incident 14a935ea: every stop wore the wallet's copy). */
  maxBudgetSource?: 'credits' | 'task_limit';
  /** LIVE budget mint for the CURRENT turn — the freshest frame's
   *  {maxBudgetUsd, maxBudgetSource}, read at each turn head so a WARM run
   *  adopts every message's mint instead of its construction-time snapshot
   *  (the freeze rail keeps runs warm across hibernation, so construction
   *  values otherwise never refresh — drill 3c6f2a73: a turn ran past an
   *  exhausted task limit). Absent, or returning empty, falls back to the
   *  statics above (old wiring / cold resumes are byte-identical). */
  getBudgetMint?: () => { usd?: number; source?: 'credits' | 'task_limit' };
  /**
   * The run's INCLUSIVE live spend ledger, bumped at every per-round price fold
   * (see live-spend.ts). Read it — never `maxBudgetUsd`'s completion-fed
   * counterpart — when a gate must see a child's burn WHILE it burns.
   */
  liveSpend?: LiveSpendLedger;
  /**
   * Per-USER-TURN spend ceiling. Enforced at every LOOP HEAD (parent rounds, both
   * subagent loop bodies, the children[] launch gate) against `liveSpend`'s
   * TURN-scoped reading, so a turn whose children are burning stops before the
   * next model call instead of at a boundary it may never reach — the 2026-08-24
   * $125 burn ran unattended for hours inside ONE turn. The trip is recoverable:
   * a later user message opens a fresh turn with a fresh baseline.
   *
   * DELIBERATELY SEPARATE from `maxBudgetUsd` (the task-lifetime overdraft guard).
   * They answer different questions; never min() them. Needs `liveSpend` to be
   * threaded too — either absent ⇒ no ceiling ⇒ byte-identical.
   */
  turnSpendCeilingUsd?: number;
  /**
   * Weave Floor §1a — the HARD session/task USD fuel-tank ceiling. Distinct from
   * `maxBudgetUsd` (the cooperative turn-boundary cap that ALSO bounds the children[]
   * fan-out): the fuel tank is debited AT ADMISSION by every concurrent subagent node
   * (the :turnbatch path, which has no cooperative gate), so a 12-wide × depth-7 round
   * cannot bill-shock. Once live spend + outstanding reserves would exceed this, the
   * concurrent path STOPS SCHEDULING and returns partial results. Undefined = uncapped
   * (cold/warm byte-identical to pre-1a). Kept SEPARATE from maxBudgetUsd so tuning the
   * hard ceiling never changes fan-out behavior.
   */
  sessionFuelTankUsd?: number;
  /**
   * P4 Task 2 — the AMBIENT (self-initiated) USD ceiling. A SEPARATE bucket from
   * `sessionFuelTankUsd`/`maxBudgetUsd`: only turns whose `origin.kind === 'initiative'`
   * debit it, so a runaway anticipation loop can spend at most this much per process-run
   * WITHOUT touching the user's foreground capability. Checked at the turn head before any
   * model call; exhausted → the initiative turn finalizes `max_budget` +
   * `exitReason:'ambient_fuel_exhausted'` and the next (human) turn runs untouched. Undefined
   * = ambient uncapped (byte-identical to pre-P4; the check requires BOTH an initiative origin
   * AND this knob). Threaded from the query-manager builders (config.ts → AMBIENT_FUEL_TANK_USD).
   */
  ambientFuelTankUsd?: number;
  /**
   * Weave Floor §1a — the process-global admission concurrency cap. Bounds the
   * top-level concurrent `:turnbatch` fan-out ABOVE the per-session pools so no single
   * session breaches the user's aggregate provider rate limits or starves a sibling
   * session in the one-sandbox-per-user process. Undefined = no global cap (the
   * per-session :turnbatch pool of 12 is the only bound — byte-identical to pre-1a).
   */
  globalAdmissionLimit?: number;
  /**
   * P2.5 — the process-global in-flight NODE ceiling: sizes the NON-BLOCKING
   * GlobalNodeCounter (deny-don't-queue) that Weave nodes consult at admission —
   * the depth-safe counterpart to the blocking `globalAdmissionLimit` semaphore
   * above. Threaded to the Weave tool at assembly (native-tools.ts); the SDK
   * reads no env, so the product (config.ts → GLOBAL_NODE_LIMIT, defaulting to
   * GLOBAL_ADMISSION_LIMIT) supplies it. Undefined = no counter (byte-identical).
   */
  globalNodeLimit?: number;
  /**
   * K6-P6 (E6) — run-level structured-output target. When present, the native
   * arm steers the FINAL turn toward this shape (a cache-aware terminal call,
   * spec §3.1) and emits a structured-output block; absent → the arm produces a
   * normal free-text turn (byte-identical to pre-P6). Threaded from the
   * query-manager call site exactly like maxTurns / maxBudgetUsd (a per-task
   * value, NOT an env read). Undefined = no structured-output target.
   */
  outputFormat?: OutputFormat;
  /**
   * K6-P6 (E6) — bounded re-ask budget when the model's structured output fails
   * schema validation: the arm re-prompts up to this many times before yielding
   * a `max_structured_output_retries` terminal turn_end (the contract terminal
   * reason already exists in turn-outcome.ts). DEFAULT 2 when absent AND an
   * `outputFormat` is set; ignored when `outputFormat` is undefined. Threaded
   * from the query-manager call site (a per-task override slot, like maxTurns).
   */
  maxStructuredOutputRetries?: number;
  /**
   * The user's installed abilities, pre-loaded by query-manager._loadAbilityExtras().
   * Consumed by the native harness in Task 9 (tool list assembly). Treat as [] when absent.
   */
  abilities?: ActiveAbility[];
  /**
   * First-class K0 journal (from @bash/kernel). When present, every turn's
   * user/assistant/tool_use/tool_result entries are appended here, enabling
   * resumeSurvivesRestart (the journal survives sandbox recycles). Absent →
   * ephemeral single-process history only (pre-K1 behaviour).
   */
  journal?: Journal;
  /**
   * INJECTABLE ModelPort (the provider seam). The kernel loop drives this and
   * never imports a provider SDK. REQUIRED by run() (native = Anthropic; the
   * product supplies an AnthropicMessagesTransport). Tests inject either an
   * AnthropicMessagesTransport({ client }) or a FakeTransport.
   */
  transport?: Transport;
  /**
   * VIDEO_UNDERSTANDING_V1 — the DESCRIBE lane for the `watch` tool: a
   * video-capable Transport + its model id (Gemini Flash), product-injected
   * (the engine may not import `transports/`, and the model pick is a product
   * decision). Present ⇒ a run whose model cannot take video in natively gains
   * `watch`; absent or flag-off ⇒ byte-identical. See engine/media-watch.ts.
   */
  video?: { transport: Transport; model: string };
  /**
   * Bounded retry around the model call (covers callModel + the first stream
   * event — the real HTTP error, e.g. 429, only surfaces when the first
   * normalized event is read). Retries only transient errors
   * (rate_limited/network_error/model_unavailable) classified by the transport,
   * up to `maxAttempts` tries with `backoffMs` linear backoff (attempt N waits
   * backoffMs*N). On exhaustion, if `fallbackModel` is set the harness switches
   * to it and gives it its OWN full retry budget (a fresh `maxAttempts` tries);
   * if that also exhausts (or no fallback is set), the run finalizes with a
   * terminal classified turn_end (never-throw preserved). Defaults: 2 attempts,
   * 750ms linear backoff, no fallback. A successful first attempt calls the
   * model exactly once.
   */
  retry?: { maxAttempts?: number; backoffMs?: number; fallbackModel?: string };
  /**
   * Follow-up B item 2 — the round at which this turn is told to WRAP UP, for a caller
   * that set `maxTurns` as a real budget rather than a backstop. At that round the loop
   * pushes the wrap-up directive once, as a user-side entry at a round boundary; nothing
   * is refused, so the turn still has rounds to write its report in, and `maxTurns` stays
   * the hard stop for one that ignores it.
   *
   * Set today only for a BACKGROUND HELPER's actor, which runs on this loop rather than
   * through runSubagentLoop and so never saw follow-up A's per-type cap or its nudge
   * (staging task c7612bfd: sixty rounds of search, no nudge, no cap). Absent for every
   * lead and every teammate ⇒ no key ⇒ nothing is ever pushed.
   */
  turnWrapUpAt?: number;
  /**
   * Orchestration Phase 3 (spec 2026-09-05-orchestration-teamwork §4.8, D10) — ONE line
   * the host wants at the head of this turn, in the user channel, for the model alone.
   * Consulted once per turn, right after the person's own entry is journaled and before
   * the first model call; a non-null string is appended as an ENGINE-injected user entry
   * (`appendInjectedUserEntry`, `injected: 'engine'`), so `isRealUserTurn` reads false and
   * the compaction / off-loop / recall rails skip it exactly as they skip every other
   * engine-minted user text. On the journal-less in-memory path it is pushed with
   * `transport.pushUser`, the way the wrap-up nudge above is.
   *
   * THE ENGINE ASKS, THE HOST DECIDES. It knows nothing about rosters or origins: the
   * shipped caller (the sandbox) answers null unless the turn came from a PERSON (typed, or
   * over a channel) and the lead has a live helper, or the box's disk guard has a line to say (the
   * volume at 90% or past it, any task), so every other turn is byte-identical. Async because the one
   * caller reads state it can only rebuild by awaiting, and the append site is already
   * async — a synchronous seam would have forced the host to prepare the string a turn
   * early, which on a warm run means answering with a roster that has since moved.
   *
   * NOT the static prefix, deliberately: the text changes every turn, and putting it in
   * the system block would move the cache prefix on each one. ABSENT (every host but the
   * sandbox's lead path) → nothing is appended → byte-identical.
   */
  turnHeadNote?: () => Promise<string | null>;
  /**
   * Engines T5 (spec 2026-09-28 §6.9) — ONE awaited call per run open, with the run's journal,
   * after the prologue and before the run seeds its round counter or takes its first user turn:
   * the place a host puts into the journal what the run's first model call must see. The shipped
   * host (the sandbox) brings a task's conversation over from the subscription engine it was
   * born on (contract/injected-user-text.ts, the fifth door); for every other task it reads the
   * journal and returns.
   *
   * Journal path only (a run with no journal has nowhere to put anything). Never reached when
   * the prologue failed, so a run that never starts writes nothing. A throw is caught and logged
   * and the run goes on: whatever the host cannot do costs what it would have added, never the
   * run. ABSENT → nothing is called → byte-identical.
   */
  beforeFirstTurn?: (journal: Journal, ctx: HarnessContext<NativeConfig>) => Promise<void>;
  /**
   * Reconstruction invariant (Harness-9 W2) — what the round engine does when the
   * provider history it is about to SEND differs from what the journal re-derives
   * through the canonical projection (`project()` → wireMessages → `historyFromJournal`,
   * the path the turn head and a cold resume take). `'warn'` (default): one
   * structured console.warn per turn, the round proceeds. `'throw'`: the round
   * throws before the model call (tests + keyless replay — never production).
   * `'off'`: no projection, no compare. Checked on the MAIN loop's journal path
   * only — a subagent's nested history lives in its own seam, and the in-memory
   * path has no second derivation to compare against. A value the product sets;
   * the SDK reads no env for it.
   */
  reconstructionCheck?: 'off' | 'warn' | 'throw';
  /**
   * Observability sink for EVERY mismatch the invariant finds, in both `'warn'` and
   * `'throw'` mode (the once-per-turn dedupe applies to the console line only).
   * Absent → console.warn is the only channel.
   */
  onReconstructionMismatch?: (m: ReconstructionMismatch) => void;
  /**
   * K4-T2 auto-compaction config. Checked at the TOP of each iterate round, but
   * ONLY when `journal` is present — the durable journal is the splice target.
   *  - `thresholdPct`: fire the full summarize-Compactor once the projected token
   *    ledger (messages + system + tools) divided by the model's max-context
   *    window crosses this fraction (default 0.8).
   *  - `keepWindowTokens`: the recent-context window the Compactor preserves
   *    uncompacted (~20_000 default; passed to planCompaction).
   *  - `prune`: the cheap context-edit tier — old, large `tool_result` bodies are
   *    stubbed in the IN-MEMORY history before the token-% predicate runs (the
   *    durable journal is untouched). Defaults: 40 entries / 2_000 tokens.
   * ABSENT (or no `journal`, or below threshold) → `maybeCompact` returns null and
   * nothing changes — so the native conformance suite + the Claude/openai arms stay
   * byte-identical.
   */
  compaction?: { thresholdPct?: number; keepWindowTokens?: number; prune?: PruneConfig };
  /**
   * Phase 3 (§1.5) — the sandbox filesystem root (e.g. `/app/workspace`), the
   * SAME root the Read/Write/Bash tools already operate against. Threaded onto
   * `gateAndDispatchTool`'s execCtx so an oversized tool result can be offloaded
   * to `${workingDir}/.kernel-offload/${taskId}/<toolCallId>.txt`, and onto the
   * compaction archive writer (`.kernel-archive/${taskId}/<thread>.md`). Absent
   * → both features no-op (byte-identical to pre-Phase-3 behavior) — e.g. every
   * existing test that constructs a bare NativeConfig.
   */
  workingDir?: string;
  /**
   * Phase 3 (§1.5) — env-tunable emergency override for the FS context-offload
   * threshold (chars). Undefined → `context-offload.ts`'s
   * `DEFAULT_OFFLOAD_THRESHOLD_CHARS` (20_000) applies. Set to a very large
   * number (e.g. via `CONTEXT_OFFLOAD_THRESHOLD_CHARS` on the sandbox) to raise
   * the bar toward the existing `TOOL_OUTPUT_MAX_CHARS` hard cap (256K) as a
   * kill switch for the first production rollout, with no code deploy needed.
   */
  contextOffloadThresholdChars?: number;
  /**
   * Hardening-G — dark kill switch for the tool-error taxonomy. When `true`, a tool's
   * `toolError()` sentinel return is mapped by the dispatcher onto the wire `is_error`
   * channel (isError:true + a `[error:<code>]` stamp + PostToolUseFailure). Absent/false
   * (default) → the sentinel is unwrapped to its `.message` string and treated EXACTLY
   * as today (byte-identical). Threaded onto `gateAndDispatchTool`'s execCtx by the
   * loop; the SDK reads no env, so the product (config.ts → TOOL_ERROR_TAXONOMY) supplies it.
   */
  toolErrorTaxonomy?: boolean;
  /**
   * W4-2 (shadow injection screen) — the injected seam the dispatcher awaits
   * AFTER the gate allows and BEFORE execute(). The product assembles it
   * (apps/sandbox, flag-gated): collect the current turn's tainted spans from
   * the journal, classify the call via the SAME side-effect classifier the gate
   * uses, and ask the server's shadow screener when both conditions hold. The
   * SDK reads no env and does no I/O here; a throwing/hung seam is belted
   * fail-open at the dispatcher. Absent → byte-identical dispatch (every
   * existing caller/test).
   */
  injectionScreen?: InjectionScreenSeam;
  /**
   * Media turn-settle lock (CONTENT_ENGINE_V1 — Studio content engine). When `true`,
   * the round engine arms a per-turn lock the moment a `media` tool call returns a
   * queued job, then DENIES every further tool call for the rest of that turn with a
   * settled-denial result string (queued artifacts deliver themselves — the socket
   * renders the card and a silent push lands next turn, so nothing in-turn can observe
   * or speed them up). Absent/false (default) → the round engine never reads the
   * per-turn flag → byte-identical dispatch. Threaded on the run's RunContext; the SDK
   * reads no env, so the product (native-config-factory → contentEngineEnabled())
   * supplies it — off whenever the `media` tool itself is absent, so the two agree.
   */
  mediaTurnSettle?: boolean;
  /**
   * P2.2 — dark kill switch for the SHARED subagent loop. When `true`, the Agent
   * tool's nested runs (`runSubagentLoop`) drive the SAME per-round core the main
   * loop runs (round-engine's `runOneRound`), inheriting model-call retry + the
   * fallback-model switch and journaling per-round `source:'subagent'` usage
   * entries (agentPath-tagged — the journal-vs-billed parity the P2.1 cost seed
   * depends on). Absent/false (default) → the legacy hand-rolled subagent round
   * body → byte-identical. Threaded to the Agent tool at assembly
   * (native-tools.ts); the SDK reads no env, so the product
   * (config.ts → SUBAGENT_SHARED_LOOP) supplies it.
   */
  subagentSharedLoop?: boolean;
  /**
   * Orchestration walls (spec 2026-09-02-orchestration-design §2) — DARK gate for
   * the physical depth cap, type-owned delegation, the lone-child refusal, tree
   * admission by refusal, the turn-cap wrap-up and partial results on stop.
   * Absent/false (default): depth 7 / protected Agent / serial nested batches —
   * byte-identical. Threaded to the Agent tool at assembly (native-tools.ts) and
   * inherited by every recursive child via the childOpts spread; the SDK reads no
   * env, so the product (config.ts → SUBAGENT_WALLS_V1) supplies it.
   */
  subagentWalls?: boolean;
  /**
   * Background helpers (spec 2026-09-02-orchestration-design §4.7, D9, D11) — DARK
   * gate for the depth-0 spawn that returns immediately and runs as its own actor on
   * the teammate rail. Absent/false (default): every spawn stays in-turn — byte-identical.
   * Rides on top of `subagentWalls`; the SDK reads no env, so the product
   * (config.ts → SUBAGENT_BACKGROUND_V1) supplies it.
   */
  subagentBackground?: boolean;
  /**
   * Root wall (follow-up item 1) — does THIS run's depth-0 Agent tool actually advertise
   * `run_in_background`? The mirror of the tool's own advertise condition, set at the one
   * site that knows both halves (the product's ToolHost, via `advertisesBackground`).
   *
   * The wall needs this rather than `subagentBackground`, because the flag being on does
   * not mean this run's spawns background. A TEAMMATE's own lead runs with the flag on and
   * advertises nothing, so every spawn it makes blocks its turn; reading the bare flag
   * there would exempt those and switch the wall off for a whole class of leads.
   *
   * Absent (default, and for every run that does not advertise) ⇒ every spawn is treated
   * as in-turn, which is the pre-background behaviour.
   */
  subagentBackgroundAdvertised?: boolean;
  /**
   * Orchestration walls — where a refusal the ROUND CORE decides (D3's lone child) is
   * reported, so the spawner that owns the tree can count it. Every other wall is
   * decided in the Agent tool, which counts its own directly. Counting only: nothing
   * downstream gates on it. Absent (default) ⇒ no report ⇒ byte-identical.
   */
  onSubagentRefused?: (kind: SubagentRefusalKind) => void;
  /**
   * Follow-up C — where the root wall's two ALLOW readings are reported: a lone spawn that
   * declared a dependency, and one waved through past the per-turn refusal cap. Counted
   * apart from the refusals because the server sums those into one `spawn_refused` column,
   * and a spawn the wall let through is not one it stopped. Absent (default) ⇒ no report.
   */
  onSubagentAllowed?: (kind: SubagentAllowKind) => void;
  /**
   * Orchestration walls — the turn's spawn/refusal tally, handed over at the turn
   * boundary (`flushTurnRecords`) so the product can ride it on the turn's
   * AGENT_RESULT and the server can column it onto `agent_turns`. Counting only:
   * nothing downstream gates on it, and the tally is RESET per turn, so each turn
   * reports its own spawns rather than a running total. Absent (default) ⇒ nothing
   * reported ⇒ byte-identical.
   */
  onSubagentStats?: (stats: TreeStats) => void;
  /**
   * P2.3 — dark kill switch for Weave step-result replay. When `true`, the Weave
   * tool consults the journal's `step_result` memos before admitting a node (a
   * settled node's outcome replays at $0, no dispatch, no billing) and journals a
   * memo AT THE MOMENT each node settles — so a killed mid-orchestration run
   * resumes re-running ZERO settled nodes. Absent/false (default) → no consult,
   * no memo writes → byte-identical. Threaded to the Weave tool at assembly
   * (native-tools.ts); the SDK reads no env, so the product
   * (config.ts → WEAVE_REPLAY) supplies it.
   */
  weaveReplay?: boolean;
  /**
   * Control-plane P3 — DARK gate for the durable Weave HITL pause/resume. When
   * `true`, a gated Weave node pauses the parent turn durably (capturing
   * weavePause + threaded onPause + one-shot resume + leaf records). Absent/
   * false (default): the pre-P3 fail-closed drop (inCodePause) — byte-identical.
   * Threaded to the Weave tool at assembly (native-tools.ts); the SDK reads no
   * env, so the product (config.ts → WEAVE_HITL_DURABLE) supplies it.
   */
  weaveHitlDurable?: boolean;
  /**
   * #14 (P2.3 follow-up) — dark kill switch for SUBAGENT step-result replay.
   * When `true`, the Agent tool consults the journal's `step_result` memos
   * before dispatching a child (a settled child's text replays at $0 — no
   * SubagentStart, no dispatch, no billing) and journals a memo AT THE MOMENT
   * each child settles, keyed by the durable per-child tool_use id. Separate
   * from `weaveReplay` (different blast radius); both dark. Absent/false
   * (default) → byte-identical. Threaded to the MAIN Agent tool at assembly
   * (native-tools.ts) — deliberately NOT to Weave's private node Agent, whose
   * tool_use ids are randomUUID-minted per dispatch (non-durable scope; Weave
   * nodes have their own WEAVE_REPLAY memo layer). The SDK reads no env, so
   * the product (config.ts → SUBAGENT_STEP_MEMO) supplies it.
   */
  subagentStepMemo?: boolean;
  /**
   * K4-T6 Nami seam (DI). Optional ContextPort the native arm uses for the
   * read/reflect context paths. K4 wires the READ path at the query-manager
   * call site (the frozen layer-7 Nami block is computed once per session and
   * passed in via `systemPrompt`), so this field is the forward-looking seam for
   * P-Nami (e.g. the `context_query` tool + `onPreCompact` reflect wiring in T7).
   * Absent → no port (read = '', reflect = no-op).
   */
  contextPort?: import('../kernel/index.js').ContextPort;
  /**
   * P5 Task 3 (Nami in the loop) — dark kill switch for the in-loop
   * write-on-surprise capture signal. When `true`, run() assesses each settled
   * turn's surprise (capture-signal.ts — pure, composes the kernel salience
   * prefilter + convo-correction, no model call) at finalization, and on a
   * capture-worthy turn journals ONE `custom` entry (key:'nami_capture',
   * CONTEXT_POLICY:false — durable, never replays into context) and yields ONE
   * `raw` NAMI_CAPTURE_SIGNAL event the driver forwards to the server (which
   * routes it to the EXISTING curator + trigger fabric). Requires a journal.
   * Absent/false (default) → the assessor never runs → byte-identical. The SDK
   * reads no env; the product (config.ts → NAMI_CAPTURE_SIGNAL) supplies it.
   */
  captureSignal?: boolean;
  /**
   * P5 Task 2 (Nami in the loop) — the per-round AUTOMATIC memory consult
   * (dark). When present, the round loop deadline-races `readRelevant(query)`
   * at each round head (query = last user text + recent tool names, built off
   * the warm journal projection) and delivers a non-empty result IN-BAND as a
   * FIRST-CLASS user journal entry (the steer discipline) — reproduced
   * byte-identically by every later projection, so within-turn AND cross-turn
   * request prefixes stay cache-stable. Never the SESSION_FROZEN system
   * layers. Deadline-raced (run-signal-aware): a slow/broken `readRelevant`
   * delays a round by at most `deadlineMs` (default 250) and the round
   * proceeds WITHOUT recall; an abort resolves the race immediately. Bounded:
   * at most `maxPerTurn` (default 2) appended fences per turn, each clamped to
   * `maxChars` (default 2000) codepoints, deduped durably against the
   * projection. Requires a journal; absent → zero consults. ABSENT
   * (default) → the engine makes ZERO recall calls → byte-identical. The SDK
   * reads no env: the product (nami-retrieval-flag.ts `namiRetrievalArm() ===
   * 'server'` → the native-config factory's `namiRecallSeamForConfig`)
   * supplies the seam, composed over the EXISTING server recall route
   * (POST /api/internal/nami/recall) — never a second retrieval stack.
   */
  recall?: RecallSeam;
  /**
   * K6 A2b — mid-turn steer seam. Polled (NON-blocking, never awaited) at each
   * tool-round boundary: after the round's tool_results are appended/projected and
   * after the pausedHalt/abort checks, BEFORE the next model call. When it returns
   * a SteerTurn, the loop appends it as a user entry IN PLACE so the next model
   * call in the SAME turn sees it (steering the in-flight turn, not aborting it).
   * The sandbox wires it to messageStream.takeNow(taskId) in the native +
   * openai_responses builders. ABSENT → never steers → byte-identical to today.
   */
  pollSteer?: () => SteerTurn | null;
  /**
   * P3 STEER V2 (LIVE in prod — the INTERRUPT_STEER_V2 flag is RETIRED
   * always-on; the sandbox always wires this seam) — the
   * interrupt-with-queued-message steer drain. Consulted (non-blocking, never
   * awaited) at THREE sites: the
   * round HEAD (before each model call), the SAME tool-round boundary as
   * `pollSteer` (BEFORE it), and the P3.5 round-abort catch. The sandbox arms
   * this on a user ESC that found staged messages AND aborts the in-flight
   * round (a live-scope swap: everything that captured the old cfg.signal dies,
   * the next read sees a fresh scope) — the loop seals the aborted round and
   * pulls this drain instead of finalizing user_aborted: the merged text is
   * appended as a `[User steered mid-task]: …` user entry IN PLACE and the
   * next model call in the SAME turn sees it (continue, don't restart; no
   * re-billed rounds). Returns null when not armed / nothing staged. PULL
   * semantics are load-bearing: the staged messages stay in the lane until the
   * loop actually pulls, so a turn that ends first delivers them as the NEXT
   * turn instead of losing them. ABSENT (tests / non-sandbox hosts) →
   * byte-identical.
   */
  drainSteerText?: () => string | null;
  /**
   * K6-P2 B3/B5 — the registration seam for the per-run HookDispatcher. Called
   * ONCE in buildPrologue right after the dispatcher is created (with the security
   * FLOOR already registered as the first PreToolUse matcher). B5 wires the 11
   * ported callbacks here; tests register lifecycle callbacks (Stop, SessionStart,
   * UserPromptSubmit, …) through it. ABSENT → only the floor is registered → every
   * TURN/SESSION/COMPACTION seam is a no-op → the native arm is byte-identical to
   * the pre-B3 loop (the dispatch points still fire, but an empty chain folds to a
   * no-field `continue` outcome the loop treats as "nothing to do").
   */
  registerHooks?: (dispatcher: HookDispatcher) => void;
  /**
   * K6-P2 B4 — HOOK OBSERVABILITY sink (GATED, default OFF). When present, the
   * per-run HookDispatcher is built with a host observer that maps each hook
   * callback's started/completed/error/cancelled phases to a `hook` HarnessEvent
   * and routes it through THIS closure — the host's wrapper over the ONE K3 sink
   * (`emitHarnessEvent`). The query-manager supplies it ONLY when the
   * `includeHookEvents` flag (INCLUDE_HOOK_EVENTS env) is on; ABSENT (the default)
   * → no observer is wired → the dispatcher makes zero observability calls → the
   * native arm is byte-identical. NOT a new direct socket emit: the observer→sink
   * path is the only route (the arm-no-streaming-emit lint wall stays green).
   */
  emitHookEvent?: (ev: HarnessEvent) => void;
  /**
   * Compaction lifecycle status sink. The engine calls it `('compacting')` once it
   * COMMITS to a compaction (after PreCompact, before the summarize) and `(null)` when
   * the compaction finishes — for BOTH the AUTO trigger (maybeCompact) AND the manual
   * `/compact`. The product wires it to emit AGENT_STATUS so the web's "Optimizing
   * context…" indicator lights up for auto-compaction too (manual is also covered by
   * the web's optimistic set on send). ABSENT → no-op (tests / no-status callers).
   * NOT a behavior change: the compaction output/journal is identical with or without it.
   */
  emitStatus?: (status: string | null) => void;
  /**
   * native-redrive — a cost (USD) already incurred BEFORE this run starts, seeded
   * into the turn's cumulative total so the single turn_end.billing carries it. Used
   * by the CONTINUE path: a subagent (`Agent`) re_execute re-spawns the subagent
   * DURING materialize (before the drive turn) and bills its replay cost via this
   * field, so the drive turn's authoritative AGENT_RESULT cumulative includes it and
   * the server's delta-billing deducts it exactly once. Defaults to 0 (the cold/warm
   * run path is byte-identical — no pre-incurred cost).
   */
  initialCostUsd?: number;
  /**
   * P2.1 (Task 5) — set by the product-plane journal cost seed; carried on
   * `turn_end.billing.journalSeedUsd` so the server can distinguish a seeded
   * resume from a genuine restart. The engine cannot know WHERE `initialCostUsd`
   * came from (the subagent re_execute replay path also writes it), so the product
   * plane sets THIS field only when the value is the journal-derived settled-rounds
   * baseline — never for the replay cost. When present + > 0 the server uses
   * `baseline = prev` UNCONDITIONALLY (no reset-to-0 even when the reported
   * cumulative dips below prev), so already-billed rounds are never re-charged.
   * Absent on cold/warm/non-seeded runs → byte-identical.
   */
  journalSeedUsd?: number;
  /**
   * Agent v2 (Task 6) — the attributed per-child cost records for a re_execute
   * REPLAY that ran BEFORE this run starts. Used by the CONTINUE path alongside
   * `initialCostUsd`: a subagent (`Agent`) re_execute re-spawns the subagent during
   * materialize and collects its replay child records here; the FIRST drive turn
   * SEEDS its per-turn `childUsage` with them (and SUBTRACTS their summed cost from
   * the turn-start cumulative baseline, since that cost is already folded via
   * `initialCostUsd`). This keeps the per-turn invariant
   * `parentOwnCostUsd + Σ(childUsage.costUsd) === turnDeltaUsd` holding ACROSS the
   * resume — without it the replay child vanishes from `childUsage` and the cost is
   * excluded from the delta. Defaults to absent (the cold/warm run path is
   * byte-identical — no pre-incurred child attribution).
   */
  initialChildUsage?: ChildCostRecord[];
  /**
   * ring 4c — the injected per-session RuntimeConfig (the SDK's env-free runtime
   * values port). Populated product-side via `runtimeConfigFromEnv()` at every
   * NativeConfig construction site. Added DORMANT in ring 4c.2: only the relocated
   * native-journal reads `runtimeConfig.userId` (the tenant boundary it stamps as
   * `workspaceId`/`principal.userId`); the remaining engine env reads migrate onto
   * this port in a later ring. `userId` carries the exact value the USER_ID env var
   * had, so the journal's recorded fields stay byte-identical for real inputs. Absent
   * (legacy callers / tests that set no env) → `userId` defaults to `''` at the call
   * sites, reproducing the old USER_ID-defaulting behaviour.
   */
  runtimeConfig?: RuntimeConfig;
  /**
   * ring 4c — the product host ports. ALL OPTIONAL: the engine falls back to the
   * SDK safe defaults (UnconfiguredInteractionPort / AllowAllPolicyPort /
   * NoopToolDisplayPort / EmptyToolHost / InMemoryStatePort) when absent. The
   * product (query-manager) + the test chokepoint (nativeConfig) ALWAYS supply
   * the real adapters.
   *
   * Added DORMANT in ring 4c.4: `interaction`/`toolDisplay`/`state`/`toolHost`
   * are CONSTRUCTED + injected at every NativeConfig site but UNREAD by the
   * engine this ring (it still uses its direct imports). `policy` is added here
   * but left UNPOPULATED until 4c.6, where the byte-identity-critical gate ladder
   * is EXTRACTED (moved, not copied) into NativePolicyPort and cut over atomically.
   * `toolHost` defaults to EmptyToolHost until 4c.7 (the assembler split).
   */
  /** requestInteraction (onPause). requestComposioAuth stays product-side at 4c. */
  interaction?: InteractionPort;
  /** gate() + permissionMode() + seedModeFromEnv() — populated in 4c.6 (the gate fold). */
  policy?: PolicyPort;
  /** enrich() (wraps enrichToolUse). */
  toolDisplay?: ToolDisplayPort;
  /** buildTools(ctx) → the FULL ordered tool list — EmptyToolHost until 4c.7. */
  toolHost?: ToolHost;
  /** refreshConnectedApps (continue path) + the task-stop / capabilities reads. */
  state?: StatePort;
  /**
   * K6-P5 D8 (Amendment A1) — gate the native next-prompt suggestion side-call.
   * When `true`, run() fires `maybeSuggestNextPrompt` AFTER a genuinely completed
   * turn (`outcome.kind === 'completed' && !pausedHalt`, never on user_aborted /
   * max_turns / max_budget / refused / paused-HITL) and yields ONE `PROMPT_SUGGESTION`
   * `raw` HarnessEvent. DEFAULT-OFF (optional, undefined = off) so the ~30 existing
   * native-arm behavior tests keep their exact callModel-count assertions — only the
   * product (query-manager) and the dedicated suggestion tests set it. The suggestion
   * call's billing is fully discarded; a failure/hang never throws (D9).
   */
  suggestNextPrompt?: boolean;
  /**
   * Provider-neutral predicate — true when a NEXT user message is already staged/
   * waiting for this run. When it returns true, run() SKIPS the `suggestNextPrompt`
   * side-call epilogue and loops straight back to await the next turn, so a rapid 2nd
   * message is ingested immediately instead of being deferred up to SUGGESTION_TIMEOUT_MS
   * (~8s on a slow transport) behind the suggestion call. This keeps the next turn's
   * AGENT_START — and the footer's turn-complete handoff — from lagging, and narrows the
   * window in which the web could mis-attribute turn-2 content. The suggestion is moot
   * anyway once the user has provided their actual next message. Wired by the host
   * (query-manager → messageStream.getStagedCount). Optional: when undefined, behavior is
   * unchanged (the ~30 byte-identical native tests leave it unset).
   */
  hasPendingInput?: () => boolean;

  /**
   * POST_TURN_OFF_PATH_V1: a side call cut by the person's next message took longer than
   * SLOW_CUT_SETTLE_MS (post-turn-off-path.ts) to settle after its abort, and the follow-up
   * waited that long. Wired by the host to its shipped logger. Absent: nothing reported.
   */
  onPostTurnCut?: (cut: { lane: 'suggestion' | 'sweep' | 'post_turn_compaction'; settleMs: number }) => void;
  /**
   * POST_TURN_OFF_PATH_V1 / COMPACTION_POST_TURN_V1: hold the box awake while the idle lane runs
   * its side work after AGENT_END (the sweep, a turn-end compaction); the returned function
   * releases it. The host bounds it. Absent: nothing is held (the engine's own behaviour).
   */
  holdForPostTurnWork?: () => () => void;

  /**
   * L5 (TOOL_PROGRESS_WATCHDOG_V1): each `cut` / `would-cut` verdict of the non-progress
   * watchdog (tool-progress-watch.ts). Wired by the host to its shipped logger so the line
   * lands in log_events under the task. Absent: the watch writes it to the console.
   */
  onToolWatchdog?: (e: ToolWatchdogEvent) => void;

  /**
   * Nami P2 phase 1 (spec 2026-08-04-nami-offloop-sweep) — run the end-of-task
   * memory sweep as an OFF-LOOP side call after a completed terminal, instead
   * of the P1 staged `control:'memory'` turn. The side call reuses the loop's
   * byte-identical request prefix (cache hit) and yields parsed FACT lines as
   * raw NAMI_REMEMBER_DEPOSIT events. Skipped when input is pending or the
   * turn's user message was trivial. The HOST must not stage the P1 pass when
   * setting this (double-sweep otherwise). Absent → byte-identical loop.
   */
  namiOffloopSweep?: boolean;
}
