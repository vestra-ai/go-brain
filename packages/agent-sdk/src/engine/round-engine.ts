/**
 * round-engine.ts — the per-round core of the native kernel loop (P2.2, Task 6).
 *
 * STRANGLER EXTRACTION from `native-harness.ts`'s `iterateTurn`: `runOneRound` is
 * the one-model-round unit — the model call (via `startStreamWithRetry`'s bounded
 * retry + fallback-model switch), the normalized stream drive, the cost fold, the
 * settlement-ordered assistant+usage journal appends, and the tool batch (gate →
 * execute → emit → append). Every line of the round body moved here VERBATIM;
 * the transport-baseline conformance goldens are the byte-identity proof.
 *
 * The round body then decomposed along its own phase boundaries (Harness-9 W4),
 * again VERBATIM — one nameable job per unit, no behavior moved with them:
 *
 *   round-stream.ts       the MODEL half — the pre-send reconstruction check, the
 *                         request params, the stream drive, the settlement-ordered
 *                         appends, the per-round usage event.
 *   round-tool-batch.ts   the TOOL half — the media turn-settle lock, the segment
 *                         partition, the concurrent run (admission → PASS 1 →
 *                         PASS 2) and the sequential tool (begin → dispatch →
 *                         finalize), the settle detection.
 *   in-process-dispatcher.ts  the execute_code re-entry seam.
 *
 * `runOneRound` keeps exactly what only IT can do: the two settle-on-abort guards
 * (a subagent's mid-round abort returns a RoundResult; the main caller rethrows),
 * the cost fold's caller split, and the no-tool early return. Symbols the split
 * relocated are re-exported below — they are part of THIS module's contract.
 *
 * What deliberately STAYS OUT of the round engine (loop-level POLICY, not round work):
 * auto-compaction, model / empty-recovery-fallback selection, the empty-completion
 * ladder, the post-batch re-projection, the PostToolBatch hook, the paused-halt break
 * and mid-turn steer. D01 lifted them from `iterateTurn`'s body to native-iterate-round.ts.
 *
 * The caller threads a `RoundState` object that runOneRound mutates IN PLACE —
 * the hoisted D1 accumulators iterateTurn's abort catch reads to seal an
 * in-flight round (mid-stream abort), plus the turn-level stopReason/usage
 * carried across rounds. One RoundState per turn, reset by the caller each round.
 *
 * P3 (bounded drain, PR-3): every tool-dispatch await in the batch is bounded by
 * raceAbortDrain (abort-drain.ts) — the concurrent PASS-1 chain, the sequential
 * main dispatch, and the subagent dispatch. After ctx.signal aborts, an in-flight
 * dispatch gets cfg.drainTimeoutMs (default 5s) to settle; on expiry the MAIN
 * paths seal the tool_use truthfully and throw AbortError to iterateTurn's catch
 * (user_aborted), while the SUB path settles the seal as the tool's result and
 * breaks (settle-on-abort keeps the nested run's accumulated cost).
 */
import type { MemorySpan } from '../contract/instruction-stack.js';
import type { HarnessContext, GateResult, ToolCall } from '../contract/harness.js';
import type { HarnessEvent, RoundKind } from '../contract/events.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { CachePrefixHint } from '../contract/cache-prefix-hint.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import type { HookDispatcher, Journal } from '../kernel/index.js';
import type { NativeConfig } from './native-config.js';
import type { NativeConfigLike } from './native-config-like.js';
import {
  retryWaitMs,
  retryCause,
  causeWaitMs,
  RETRY_CAUSE_POLICY,
  BODYLESS_5XX_SUBTYPE,
  networkWaitMs,
  NETWORK_WAIT_CEILING_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  type RetryCause,
} from './error-authority.js';
import { retryByCauseEnabled, laneFallbackEnabled, networkWaitEnabled } from '../policy/feature-flags.js';
import type { gateAndDispatchTool } from './tool-dispatcher.js';
import type { FrozenElision } from './context-elision.js';
import type { RawToolOptions, ToolDispatchResult, OnAuthHalt } from '../tools/tool-types.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderReplay,
  ProviderTool,
  StreamEvent,
  Transport,
} from './transport.js';
import type { RunContext } from './run-context.js';
import {
  checkRoundReconstruction,
  buildRoundRequest,
  driveRoundStream,
  settleRoundOutput,
  emitRoundUsage,
  roundTiming,
  type CapturedReasoning,
} from './round-stream.js';
import { monotonicMs } from './monotonic-clock.js';
import { runToolBatch } from './round-tool-batch.js';
import { createEarlyStart, type EarlyStart } from './tool-early-start.js';
import { healRejectedHistory } from './history-heal.js';
import { foldModelSpend } from './live-spend.js';

// The partitioner moved to batch-shape.ts (round-engine only ratchets down); it is
// re-exported here because it IS part of this module's contract to its callers.
export { partitionToolBatch, type ToolBatchSegment } from './batch-shape.js';

// The tool batch moved to round-tool-batch.ts and the execute_code re-entry seam to
// in-process-dispatcher.ts (round-engine only ratchets down); their public symbols
// are re-exported here because they ARE part of this module's contract to its
// callers — subagent-runner, offloop-usage, agent-tool and the engine barrel all
// import them from './round-engine.js'.
export {
  MEDIA_TURN_SETTLED_DENIAL,
  MAIN_TURN_BATCH_CONCURRENCY,
  batchPoolKey,
} from './round-tool-batch.js';
export {
  inCodePause,
  makeInProcessDispatcher,
  type InProcessExecCtx,
  type InProcessDispatcherDeps,
} from './in-process-dispatcher.js';
export { deterministicUsageId } from './round-stream.js';

/**
 * Default retry bounds when cfg.retry is partially/un-specified. maxAttempts 4
 * absorbs the provider SDKs' former 2 silent retries per engine attempt, removed
 * when every client went maxRetries: 0 — before that a 529 storm got up to
 * (1+2)×maxAttempts requests, with the SDK's timer honouring Retry-After and the
 * engine's running blind to it (now inverted: only the engine sleeps, and it
 * reads the header itself below).
 */
const DEFAULT_RETRY = { maxAttempts: 4, backoffMs: 750 } as const;

/**
 * The budget for a PICKED lane that answers "model not found" while the registry
 * names a sibling door (`ModelCapabilities.unavailableSibling`). A random
 * per-request flap (Meta's contributor door, 2026-09-05: ~40% of requests 404'd
 * while the model answered every request that got through) is beaten by MORE,
 * FASTER tries — eight in ~8.4 s (300 ms linear) — before the round moves to the
 * sibling. Only `model_unavailable` on the picked lane reads this; every other
 * kind, and the sibling itself, keep DEFAULT_RETRY.
 */
export const SIBLING_LANE_RETRY = { maxAttempts: 8, backoffMs: 300 } as const;

/** The one live line a sibling-lane round shows (thinking rail — never journaled). */
export const SIBLING_LANE_NOTE =
  "This model's discounted lane didn't answer, so this round runs on its standard lane at no extra charge.";

/** One retry wait, as startStreamWithRetry reports it (RETRY_BY_CAUSE_V1): `attempt` is the one about to run. */
export interface RetryWait {
  cause: RetryCause;
  waitMs: number;
  attempt: number;
  cap: number;
  /** LANE_FALLBACK_V1: not a wait; the lane kept failing and the request moved to its second route. */
  switchedLane?: true;
  /** NETWORK_WAIT_V1: the cause's own budget is spent and this is a wait for the network, which no cap ends. */
  waitingForNetwork?: true;
}

const RETRY_WAIT_LEAD: Readonly<Record<RetryCause, string>> = {
  usage_limit: 'Usage limit reached',
  rate_limit: 'Model is busy',
  overload: 'Model is overloaded',
  dropped_connection: 'Connection dropped',
};

/** The live line a retry wait shows (thinking rail, never journaled), so no backoff is silent. */
export function retryWaitLine(w: RetryWait): string {
  if (w.switchedLane === true) return 'The connection to the model kept failing; switched to a backup route for this session';
  const when = w.waitMs < 500 ? 'retrying now' : `retrying in ${Math.max(1, Math.round(w.waitMs / 1000))} s`;
  if (w.waitingForNetwork === true) return `Waiting for the network; ${when}`;
  return `${RETRY_WAIT_LEAD[w.cause]}; ${when} (attempt ${w.attempt} of ${w.cap})`;
}

/**
 * TurnOutcome kinds the retry wraps as genuinely transient — a fresh attempt
 * (or fallback model) plausibly succeeds. Kept DELIBERATELY narrow: these are
 * the only kinds in the @bash/shared TurnOutcome union that represent a
 * recoverable upstream hiccup. `model_error` is excluded (too broad — masks
 * real bugs); `auth_error`/`billing_error`/`context_exceeded`/`refused`/
 * `user_aborted`/limits are all non-transient. Exported (#13) as the ONE
 * transient-classification source: the Agent tool reuses it to decide whether a
 * subagent's terminal failure surfaces as a transient toolError sentinel.
 */
export const RETRYABLE_KINDS = new Set<TurnOutcome['kind']>([
  'rate_limited',
  'network_error',
  'model_unavailable',
]);

/**
 * Sleep for `ms`, resolving EARLY (never rejecting) if `signal` aborts — so an
 * interrupt is not blocked during backoff. The caller re-checks signal.aborted
 * after this returns and throws to route to the never-throw user_aborted path.
 * Exported (deploy-seam ladder 1) — the severed-stream re-issue backoff in
 * iterateTurn shares this ONE abort-respecting sleep discipline.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Task 6: bounded retry around the model call. Returns an AsyncIterable whose
 * FIRST event has already been pulled (to trigger any early error, e.g. a 429
 * that the real transports only surface on the first stream read), then
 * re-yields it so the caller's `for await` switch stays UNCHANGED.
 *
 * RETRY BOUNDARY = callModel + the first normalized event ONLY. Once the first
 * event is yielded we COMMIT to that attempt — a retry after text deltas were
 * emitted to the socket would DOUBLE-EMIT, and a retry after a `done` would
 * DOUBLE-BILL. A FAILED attempt produced no `done` (hence no usage/cost) and no
 * text (the throw fires before any yield), so retrying strictly-before-commit is
 * leak-free.
 *
 * Retries only genuinely-transient kinds (RETRYABLE_KINDS) classified by the
 * transport, bounded by maxAttempts with linear backoff. On exhaustion, one
 * final attempt on fallbackModel if set; else it rethrows so the iterate loop's
 * outer catch classifies it into a terminal turn_end (never-throw preserved).
 * With RETRY_BY_CAUSE_V1 on, the failure's cause (error-authority.ts retryCause) decides
 * instead: whether it is retried, its wait, its budget, and whether it may fall back.
 * Aborts are NEVER retried — they rethrow to the outer catch → user_aborted.
 *
 * Returns the COMMITTED model (may be the fallback) so cost is attributed to it.
 *
 * P2.2 — extracted from the NativeHarness private method VERBATIM (it reads no
 * `this`); `cfg` is narrowed to the one field it consumes so the subagent caller
 * can pass a synthesized `{ retry }` without a full NativeConfig.
 */
export async function startStreamWithRetry(
  params: {
    model: string;
    maxTokens: number;
    system: string;
    tools: ProviderTool[];
    history: ProviderHistory;
    signal?: AbortSignal;
    // K4C-3 D2: the adaptive-cache hint, threaded verbatim to callModel.
    cachePrefixHint?: CachePrefixHint;
    // CACHE_TIERING_V1: fleet-prefix boundary, threaded verbatim to callModel.
    systemFleetPrefixChars?: number;
    // CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1: the memory span, threaded verbatim to callModel.
    systemMemorySpan?: MemorySpan;
    // OpenAI prompt-cache anchor, threaded verbatim to callModel (Anthropic
    // ignores it → byte-identical there). Stable for the task's life.
    cacheKey?: string;
  },
  transport: Transport,
  cfg: Pick<NativeConfig, 'retry'>,
  // RETRY_BY_CAUSE_V1: told of each retry wait before it sleeps (never called with the flag
  // off). `onAttempt`: told just before each attempt is sent, so the round can count its
  // attempts and time the one it commits to (the last). Kept out of `params`, which reach
  // callModel verbatim.
  // NETWORK_WAIT_V1: `waitForNetwork` (the main loop's request only, never a subagent's) lets a
  // dropped connection wait for the network past its bounded schedule.
  hooks: { onRetryWait?: (w: RetryWait) => void; onAttempt?: () => void; waitForNetwork?: boolean } = {},
): Promise<{ stream: AsyncIterable<StreamEvent>; model: string; billedAs?: string }> {
  const maxAttempts = cfg.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const backoffMs = cfg.retry?.backoffMs ?? DEFAULT_RETRY.backoffMs;
  const fallbackModel = cfg.retry?.fallbackModel;
  // The registry-declared sibling door (same weights). Read once; only a
  // `model_unavailable` on the PICKED lane may move the round there.
  const sibling = resolveCapabilities(params.model).unavailableSibling;

  let model = params.model;
  let usedFallback = false;
  let attempt = 0;
  // PR4 — one-time invalid_encrypted_content recovery latch (cross-issuer guard's
  // safety net for an UNSTAMPED legacy reasoning blob the preflight couldn't drop
  // proactively). On the first such 400, disable encrypted-reasoning replay on the
  // transport and retry; the preflight then drops ALL reasoning so the retry succeeds.
  let reasoningReplayDisabled = false;
  // LANE_FALLBACK_V1: the request moved to its second route (at most once).
  let laneSwitched = false;
  // NETWORK_WAIT_V1: how many network waits this request has made (each one doubles the next),
  // and when the first began (the waits end at NETWORK_WAIT_CEILING_MS from it).
  let networkWaits = 0;
  let networkWaitStartedAt: number | undefined;

  for (;;) {
    attempt += 1;
    // Abort guard at the top of every iteration: if the signal aborted during a
    // backoff sleep (abortableSleep resolves early without throwing), do NOT make
    // another model call — throw so the outer catch maps it to user_aborted.
    if (params.signal?.aborted) {
      const abortErr = new Error('Request was aborted.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    try {
      hooks.onAttempt?.();
      const providerStream = transport.callModel({ ...params, model });
      const it = transport.readStream(providerStream)[Symbol.asyncIterator]();
      // Pull event #1 — an early error (callModel's stream surfaces its 429 on
      // the first read) throws HERE, before any socket emit or `done`.
      const first = await it.next();
      // COMMIT: re-yield the buffered first event, then drain the rest. No retry
      // past this point (first event already observable → no double-emit/-bill).
      const stream = (async function* (): AsyncIterable<StreamEvent> {
        if (!first.done) yield first.value;
        let n = await it.next();
        while (!n.done) {
          yield n.value;
          n = await it.next();
        }
      })();
      // Keyed on the model IN HAND, not a latch: a configured fallbackModel that
      // takes over after the sibling is a different model, not a sibling round.
      if (sibling === undefined || model !== sibling) return { stream, model };
      // A sibling-lane round announces itself once, live-only (the thinking rail),
      // and bills at the PICKED model's price — the served model stays the truth.
      const announced = (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: 'thinking_start' };
        yield { kind: 'thinking', text: SIBLING_LANE_NOTE };
        yield* stream;
      })();
      return { stream: announced, model, billedAs: params.model };
    } catch (err) {
      // An abort is a CLEAN stop — never retry. Rethrow so the outer catch maps
      // it to user_aborted (the next user message starts a fresh signal).
      if (params.signal?.aborted) throw err;
      const outcome = transport.classifyError(err);
      const kind = outcome.kind;
      // PR4 — invalid_encrypted_content recovery (one-time). A reasoning blob the
      // current endpoint can't decrypt slipped past the issuer-guard (an unstamped
      // legacy item). Disable encrypted-reasoning replay on the transport and retry:
      // the NEXT callModel's preflight drops ALL reasoning, so the request succeeds
      // (losing only the reasoning carry, not the turn). Guaranteed one extra try —
      // the loop runs the next attempt regardless of the transient-retry budget.
      if (
        outcome.raw?.subtype === 'invalid_encrypted_content' &&
        !reasoningReplayDisabled &&
        transport.disableReasoningReplay
      ) {
        reasoningReplayDisabled = true;
        transport.disableReasoningReplay();
        console.warn(
          `[NativeHarness] invalid_encrypted_content — disabling encrypted-reasoning replay and retrying (model=${model})`,
        );
        continue;
      }
      // RETRY_BY_CAUSE_V1: the cause decides whether to retry, how long to wait, and whether
      // the fallback model may take over (error-authority's RETRY_CAUSE_POLICY). Off, `cause`
      // stays undefined and every decision below is exactly today's.
      const byCause = retryByCauseEnabled();
      const cause = byCause ? retryCause(outcome, err) : undefined;
      const retryable = byCause ? cause !== undefined && RETRY_CAUSE_POLICY[cause].retry : RETRYABLE_KINDS.has(kind);
      // A flapping picked door (a sibling exists, this is "model not found") gets
      // the wider, faster budget; everything else keeps the configured policy.
      const flapping = sibling !== undefined && model === params.model && kind === 'model_unavailable';
      const attemptsCap = flapping
        ? SIBLING_LANE_RETRY.maxAttempts
        : cause === 'rate_limit'
          ? (cfg.retry?.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS)
          : maxAttempts;
      if (retryable && attempt < attemptsCap) {
        // How long to wait, and whether Retry-After stretched it. The policy (the bodyless
        // 5xx schedule, the linear backoff, the header, the cap) lives in error-authority,
        // beside the classification it keys off; this loop only sleeps.
        const linearMs = flapping ? SIBLING_LANE_RETRY.backoffMs : backoffMs;
        const { waitMs, hinted } =
          cause !== undefined
            ? causeWaitMs(cause, err, outcome.raw?.subtype, attempt, linearMs)
            : retryWaitMs(err, outcome.raw?.subtype, attempt, linearMs);
        console.warn(
          `[NativeHarness] retrying model call (model=${model}, attempt=${attempt}/${attemptsCap}, kind=${kind}${cause !== undefined ? `, cause=${cause}` : ''}, waitMs=${waitMs}${hinted !== undefined ? ', retry-after honoured' : ''})`,
        );
        if (cause !== undefined) hooks.onRetryWait?.({ cause, waitMs, attempt: attempt + 1, cap: attemptsCap });
        await abortableSleep(waitMs, params.signal);
        continue;
      }
      // LANE_FALLBACK_V1: the lane failed its whole bounded schedule with a lane fault (a dropped
      // connection, or a bodyless 5xx: an edge answering for a proxy that is briefly gone), not
      // the provider's own error. The transport moves this model's requests to the second route
      // to the same provider, once, and the request gets a fresh budget there (Codex resets its
      // retry count when it falls back from WebSockets to HTTPS).
      const laneFault = retryCause(outcome, err) === 'dropped_connection' || outcome.raw?.subtype === BODYLESS_5XX_SUBTYPE;
      if (!laneSwitched && laneFault && laneFallbackEnabled() && transport.fallBackLane?.(model) === true) {
        laneSwitched = true;
        console.warn(`[NativeHarness] the lane kept failing (model=${model}, kind=${kind}); moved to its second route`);
        hooks.onRetryWait?.({ cause: retryCause(outcome, err) ?? 'dropped_connection', waitMs: 0, attempt: 1, cap: attemptsCap, switchedLane: true });
        attempt = 0;
        continue;
      }
      // NETWORK_WAIT_V1: a dropped connection (nothing answered; error-authority's cause, read
      // even with RETRY_BY_CAUSE_V1 off) whose bounded schedule is spent keeps waiting for the
      // network, the main loop's request only, with no attempt cap: 5 s doubling to 60 s, one
      // live line each, until it answers, the person stops the turn, or the waits would pass
      // NETWORK_WAIT_CEILING_MS; then the request ends as an exhausted one does. The attempt
      // count holds at the cap, so an error of another cause afterwards gets the same.
      if (hooks.waitForNetwork === true && networkWaitEnabled() && retryCause(outcome, err) === 'dropped_connection') {
        const now = Date.now();
        networkWaitStartedAt ??= now;
        const waitMs = networkWaitMs(networkWaits + 1);
        if (now - networkWaitStartedAt + waitMs <= NETWORK_WAIT_CEILING_MS) {
          networkWaits += 1;
          console.warn(`[NativeHarness] waiting for the network (model=${model}, wait=${networkWaits}, waitMs=${waitMs})`);
          hooks.onRetryWait?.({ cause: 'dropped_connection', waitMs, attempt: attempt + 1, cap: attemptsCap, waitingForNetwork: true });
          await abortableSleep(waitMs, params.signal);
          attempt -= 1;
          continue;
        }
        console.warn(`[NativeHarness] no network after ${networkWaits} waits (model=${model}, waitedMs=${now - networkWaitStartedAt}); ending the request`);
      }
      if (flapping) {
        console.warn(
          `[NativeHarness] ${model} answered "model not found" ${attempt}× — serving this round on its sibling lane ${sibling} (billed as ${model})`,
        );
        model = sibling;
        attempt = 0;
        continue;
      }
      if (retryable && fallbackModel && !usedFallback && (cause === undefined || RETRY_CAUSE_POLICY[cause].fallback)) {
        console.warn(
          `[NativeHarness] primary exhausted; falling back (model=${fallbackModel}, kind=${kind})`,
        );
        usedFallback = true;
        model = fallbackModel;
        attempt = 0;
        continue;
      }
      if (cause === 'usage_limit') {
        console.warn(`[NativeHarness] usage limit reached; not retrying (model=${model}, kind=${kind})`);
      }
      // Exhausted (or non-retryable) → rethrow to the iterate loop's outer
      // catch, which classifies it into ONE terminal turn_end (never-throw).
      throw err;
    }
  }
}

type Started = Awaited<ReturnType<typeof startStreamWithRetry>>;

/**
 * SWEEP_PREFIX_PARITY_V1 — the loop's request minus the three parts each request owns: its
 * history, its output cap and its abort signal. Everything left is what a provider keys its
 * prompt cache on besides the history (the system, the tools, the cache routing key, the
 * system split), so a side call that sends this verbatim with its own history rides the
 * prefix the loop just wrote.
 *
 * Derived by rest, never listed. The memory sweep missed the cache for weeks because it
 * rebuilt its request from a hand list that never gained `cacheKey` or the system split;
 * a field the loop learns to send reaches this type without anyone copying it.
 */
export type LoopRequest = Omit<Parameters<typeof startStreamWithRetry>[0], 'history' | 'maxTokens' | 'signal'>;

/** The {@link LoopRequest} of one round's request. */
export function loopRequestOf(request: Parameters<typeof startStreamWithRetry>[0]): LoopRequest {
  const { history: _history, maxTokens: _maxTokens, signal: _signal, ...rest } = request;
  return rest;
}

/**
 * RETRY_BY_CAUSE_V1: run the model call and, WHILE it waits, yield one live-only thinking
 * line per retry wait (retryWaitLine), so the person never watches a silent backoff. The
 * lines are thinking deltas, never journaled, and they land before the stream commits, as
 * the sibling-lane note does. The call's result or error comes out unchanged.
 */
async function* startWithRetryLines(
  run: (onRetryWait: (w: RetryWait) => void) => Promise<Started>,
): AsyncGenerator<HarnessEvent, Started, void> {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  const call = run((w) => {
    lines.push(retryWaitLine(w));
    wake?.();
  }).finally(() => {
    settled = true;
    wake?.();
  });
  call.catch(() => {}); // the error is rethrown by the await below, never dropped
  for (;;) {
    for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
      yield { kind: 'thinking_start' };
      yield { kind: 'block', block: { type: 'thinking', thinking: line } };
    }
    if (settled) return await call;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

/**
 * The turn-scoped state one round mutates IN PLACE (P2.2). These are the D1
 * accumulators `iterateTurn` HOISTS above its round loop so its abort catch can
 * read the IN-FLIGHT round (a mid-stream abort seals `assistantText`/
 * `thinkingBlocks` that never reached the clean-path append), plus the
 * stopReason/usage/model trio the epilogue + turn_end read after the last round.
 * The caller resets the per-round fields at the top of each round; the usage trio
 * deliberately persists across rounds (the LAST round's values win).
 */
export interface RoundState {
  assistantText: string;
  thinkingBlocks: ContentBlock[];
  toolUses: Array<{ id: string; name: string; input: unknown; thoughtSignature?: string }>;
  /** True once this round's assistant text/thinking is durably journaled (double-append guard). */
  roundAppended: boolean;
  /** D2 — abort-phase classifier: true while the tool batch runs ('tools' vs 'streaming'). */
  inToolBatch: boolean;
  stopReason: string | null;
  lastUsage: NormalizedUsage;
  /** Model behind lastUsage (the committed model — may be the retry fallback). */
  lastUsageModel: string;
  /** This round's verbatim provider content, from its `done` event. */
  replay?: ProviderReplay | undefined;
  /**
   * Reconstruction invariant — set once this turn's first mismatch has been logged
   * ('warn' mode dedupes the console line per turn; the sink still sees every one).
   * Absent on a fresh state → the first mismatch logs.
   */
  reconstructionWarned?: boolean;
  /** Set once this turn's history heal has been reported (history-heal.ts: one row per turn). */
  historyHealReported?: boolean;
  /**
   * TOOLS_MIDSTREAM_RW_V1: this round's teardown could not journal the calls that started early
   * (round-engine journalStartedPrefix). The severed-stream re-issue refuses such a round
   * (severed-stream.ts). Cleared at the next round's start.
   */
  salvageFailed?: boolean;
}

/** What one settled round hands back to the loop (loop-level policy reads these). */
export interface RoundResult {
  /** The model that actually produced this round's stream (may be the fallback). */
  committedModel: string;
  roundCostUsd: number;
  /** The tool batch's results, batch-ordered (empty for a no-tool round). */
  results: ToolDispatchResult[];
  /**
   * P2.2 — set ONLY on the subagent path (settle-on-abort): the round's stream
   * aborted mid-flight, nothing was folded, and the nested loop should break
   * cleanly with its already-accumulated cost. Never set for the main caller
   * (its aborts THROW to iterateTurn's catch — the user_aborted sealing path).
   */
  abortedMidStream?: true;
}

/** The settled-round summary handed to the subagent caller's persist seam. */
export interface SettledRound {
  assistantText: string;
  toolUses: Array<{ id: string; name: string; input: unknown; thoughtSignature?: string }>;
  roundCostUsd: number;
  usage: NormalizedUsage;
  committedModel: string;
  /** The round's verbatim provider content — see RoundState.replay. */
  replay?: ProviderReplay;
}

/**
 * P2.2 — the SUBAGENT caller's seams (runSubagentLoop under SUBAGENT_SHARED_LOOP).
 * When `sub` is present on RoundDeps, five behavior gates flip; everything else is
 * the shared core (retry + fallback, stream drive, fold ordering, batch order):
 *
 *  1. SETTLE-ON-ABORT (Weave 2b / AC-2b-3): a mid-round abort returns
 *     `abortedMidStream` instead of throwing, so already-settled rounds keep
 *     their cost. The main caller KEEPS the throw (iterateTurn's catch owns
 *     the user_aborted sealing).
 *  2. Billing folds route through `foldRoundCost` (the subagent's own
 *     costUsd/ownCostUsd/usageAcc) and NEVER touch rc.billing — the Agent tool
 *     folds the returned total via ctx.addCostUsd exactly once; folding here
 *     too would double-bill the parent turn.
 *  3. Round persistence routes through `persistRound` (T10 scope-tagged
 *     assistant entry + the nested in-memory history push + the charter-(c)
 *     source:'subagent' usage entry). The main-journal branches (cfg.journal)
 *     never run for a subagent round — cfg.journal here is the MAIN scope.
 *  4. The per-round usage EVENT (+ rc roundCounter bump) is skipped — the
 *     parent's turn_number sequence and AGENT_USAGE stream belong to the main
 *     loop; subagent token counts surface via SUBAGENT_END (display-only).
 *  5. The tool batch always takes the SEQUENTIAL path and BREAKS at the first
 *     paused tool (native-redrive semantics). The concurrent path's
 *     `:turnbatch` pool is acquired ONLY by the main loop — a subagent
 *     acquiring it could deadlock a slot-holding parent on its own child.
 *
 * Plus two channel guards: `capturedReasoning`/`capturedOrderedBlocks` are NOT
 * read (the subagent may share the parent's transport instance — consuming the
 * per-stream channel here would steal the parent round's reasoning items), and
 * tool_use/tool_result entries journal scope-tagged via `scopedJournal` instead
 * of the main-scope appends. The per-tool AGENT_TOOL_BILLING raw event is NOT
 * skipped: a sub call's fee is yielded on its result (isSubagent), carried up as a
 * `billing` SubagentEvent, and emitted by the Agent tool (its only billing path).
 *
 * ABSENT ⇒ every gate takes the main-loop path — byte-identical by construction.
 */
export interface SubagentRoundSeams {
  /**
   * The nested run's OpenAI prompt-cache anchor (PR5 item 2 — the per-agent-type
   * shard key). Overrides the main loop's sessionId/taskId anchor so a nested
   * run never pollutes the parent task's shard; omitted ⇒ no cacheKey sent
   * (the legacy subagent behavior).
   */
  cacheKey?: string;
  /** Gate 2 — where this round's model cost lands (costUsd/ownCostUsd/usageAcc). */
  foldRoundCost(roundCostUsd: number, usage: NormalizedUsage, committedModel: string): void;
  /** Gate 3 — persist the settled round (scoped entries + nested history push). */
  persistRound(round: SettledRound): Promise<void>;
  /**
   * The subagent's dispatch execCtx (cost sinks, FS offload, in-code dispatcher, a push
   * channel; built once per run) replaces the main loop's per-tool baseExecCtx + PushQueue
   * — the QUEUE, not the channel: its pushEvent routes to onEvent, so tools still emit.
   */
  execCtx: NonNullable<Parameters<typeof gateAndDispatchTool>[6]>;
  /** T10 — scope-tagged tool_use/tool_result appends (absent ⇒ no scoped journaling). */
  scopedJournal?: { j: Journal; path: SubagentPathSegment[] };
}

/** Everything one round needs, threaded by the caller. */
interface RoundDepsBase {
  /**
   * The engine reads only taskId/model + config.runtimeConfig off this (the
   * NativeConfigLike slice) — the main caller passes its full
   * HarnessContext<NativeConfig> (structural superset); the subagent caller
   * synthesizes a minimal one.
   */
  ctx: HarnessContext<NativeConfigLike>;
  /** The slice of NativeConfig the round core reads (all optional fields). */
  cfg: RoundCfg;
  transport: Transport;
  /** The gate every dispatched tool routes through (the harness instance). */
  harness: { gateTool(call: ToolCall): Promise<GateResult> };
  tools: RawToolOptions[];
  providerTools: ProviderTool[];
  system: string;
  onPause: (call: ToolCall, kind: string, subagentPath?: SubagentPathSegment[]) => Promise<string>;
  onAuthHalt: OnAuthHalt | undefined;
  /** Per-round request inputs computed by the caller (loop-level policy owns them). */
  requestedModel: string;
  cachePrefixHint: CachePrefixHint | undefined;
  /**
   * CACHE_TIERING_V1 — the fleet-prefix boundary of `system` (see the Transport
   * callModel doc). Run-constant: the caller reads it off cfg once; absent (flag
   * off / no boundary) ⇒ requests are byte-identical.
   */
  systemFleetPrefixChars?: number;
  /**
   * What kind of round this request serves ('fresh' | 'steer' | 'continuation'),
   * derived by the turn loop (it owns the steer consults + round sequencing).
   * Rides the per-round usage event as `roundKind` → wire `round_kind`, tagging
   * the honest per-request TTFT with its cause. Optional + additive: the
   * subagent caller omits it (its usage never surfaces per-round anyway).
   */
  roundKind?: RoundKind;
  history: ProviderHistory;
  /**
   * The turn's FROZEN elision (CONTEXT_ELISION_V1), threaded so the reconstruction
   * check projects through the SAME `wireMessages` seam the turn head used to build
   * `history`. Absent ⇒ the check projects raw — exact while elision is off; with
   * elision on, every round would read as drift until the caller threads it.
   */
  elision?: FrozenElision | null;
  /** Caller-owned sinks the round appends to (the same objects across rounds). */
  turnBlocks: ContentBlock[];
  pendingTodoBlocks: ContentBlock[];
}

/** The NativeConfig slice the round core consumes (the main caller's full cfg is a superset). */
export type RoundCfg = Pick<NativeConfig,
  | 'signal' | 'retry' | 'journal' | 'toolDisplay' | 'abilities' | 'maxBudgetUsd' | 'liveSpend' | 'workingDir'
  | 'contextOffloadThresholdChars' | 'toolErrorTaxonomy' | 'injectionScreen' | 'sessionFuelTankUsd' | 'globalAdmissionLimit'
  | 'drainTimeoutMs' | 'mediaTurnSettle' | 'promptLayerSizes' | 'reconstructionCheck' | 'onReconstructionMismatch' | 'subagentWalls' | 'subagentBackgroundAdvertised' | 'onSubagentRefused' | 'onSubagentAllowed' | 'onToolWatchdog'
>;

/**
 * The two callers, discriminated on `sub`: the MAIN loop carries the run's
 * RunContext (billing folds mutate it in place) + its HookDispatcher; the
 * SUBAGENT loop carries its seams instead — its folds/persistence never touch
 * rc, and its dispatches run through its own execCtx (no dispatcher).
 */
export type RoundDeps =
  | (RoundDepsBase & { rc: RunContext; dispatcher: HookDispatcher; sub?: undefined })
  | (RoundDepsBase & { rc?: undefined; dispatcher?: undefined; sub: SubagentRoundSeams });

/**
 * ONE model round: call the model (bounded retry + fallback), drive the
 * normalized stream (yielding text/thinking blocks live), fold the round's cost,
 * persist the assistant round + its settlement-ordered usage entry, surface the
 * per-round usage event, then — when the model called tools — run the tool batch
 * partitioned into concurrent Agent-runs + sequential segments (partitionToolBatch).
 *
 * Yields the SAME HarnessEvents the inline body yielded (the caller `yield*`s
 * them up to the K3 sink); returns the round summary for loop-level policy
 * (empty-recovery, PostToolBatch, paused-halt, steer). Mutates `st` in place —
 * see RoundState. Extracted VERBATIM from iterateTurn (P2.2 Task 6), then split
 * along its own phase boundaries into round-stream.ts + round-tool-batch.ts
 * (Harness-9 W4) — same order, same events, same mutations.
 */
export async function* runOneRound(
  deps: RoundDeps,
  st: RoundState,
): AsyncGenerator<HarnessEvent, RoundResult, void> {
  // L1 (TOOLS_MIDSTREAM_V1): the calls this round starts while the model is still streaming
  // (tool-early-start.ts); undefined with the flag off and on a subagent's round. Whatever
  // way the round ends (a failed or aborted stream, a throw, the caller stopping early), a
  // started call the batch never took is cancelled here.
  const early = createEarlyStart(deps);
  if (early === undefined) return yield* runRoundBody(deps, st, undefined, { model: deps.requestedModel });
  // TOOLS_MIDSTREAM_RW_V1: however the round tears down, every started call the batch never
  // took and that may have run is journaled (journalStartedPrefix): live when the round ends
  // on its own (a return or a throw), silently when its consumer closed it (nobody listens).
  const served = { model: deps.requestedModel };
  if (st.salvageFailed === true) delete st.salvageFailed;
  // Set only once a teardown journaling ran to its end: closed in the middle of one (its
  // consumer returned), the finally journals what it had not reached yet (salvage skips taken calls).
  let journaled = false;
  try {
    const result = yield* runRoundBody(deps, st, early, served);
    yield* journalStartedPrefix(deps, st, early, served.model);
    journaled = true;
    return result;
  } catch (err) {
    yield* journalStartedPrefix(deps, st, early, served.model);
    journaled = true;
    throw err;
  } finally {
    if (!journaled) for await (const ev of journalStartedPrefix(deps, st, early, served.model)) void ev;
    early.cancelUntaken();
  }
}

/**
 * TOOLS_MIDSTREAM_RW_V1: the round is tearing down with calls the batch never took, and an
 * exclusive one among them may have run (tool-early-start.ts salvage). Those calls become the
 * round's tool calls: the round's output so far is settled if it was not (its text, its signed
 * thinking), then the batch takes each call in order and journals its tool_use and its result,
 * exactly as a finished round would. On a stream error each call runs to its end, within the
 * drain bound from the salvage, and its real result is journaled (Codex drains its in-flight
 * calls the same way). On a Stop each call already has the abort, as a batch call does, and its
 * interrupted result is journaled within the same bound: Stop waits no longer than it does
 * today. The round's usage is unknown (no `done` arrived): its entry carries zeros and nothing
 * reads it as the provider's count, and the salvaged batch gets a round number of its own.
 * A failure to journal is said, never thrown: the error the round is ending with stays the one.
 */
async function* journalStartedPrefix(
  deps: RoundDeps,
  st: RoundState,
  early: EarlyStart,
  committedModel: string,
): AsyncGenerator<HarnessEvent, void, void> {
  const calls = early.salvage();
  if (calls === undefined) return;
  // A batch that threw stays the phase the abort catch reads (and never a severance to re-issue).
  const wasInBatch = st.inToolBatch;
  try {
    // A call the stream already closed as `tool_use` carries what the batch needs (a Gemini
    // thoughtSignature); the gate's own copy otherwise.
    const streamed = new Map(st.toolUses.map((tu) => [tu.id, tu]));
    st.toolUses = calls.map((c) => streamed.get(c.id) ?? { id: c.id, name: c.name, input: c.input });
    let capturedReasoning: CapturedReasoning = [];
    if (!st.roundAppended) {
      ({ capturedReasoning } = await settleRoundOutput(deps, st, 0, committedModel, { salvaged: true }));
      if (deps.sub === undefined) deps.rc.billing.roundCounter.value += 1;
    }
    yield* runToolBatch(deps, st, capturedReasoning, committedModel, early);
  } catch (err) {
    // A call past its drain bound is sealed interrupted and ends the batch with an abort; any
    // other throw is a journal that would not take the entries. Either way, said, not thrown,
    // and the severed-stream re-issue is refused: it would re-ask without the results of calls
    // that ran, and the model would call them again.
    st.salvageFailed = true;
    console.warn(`[tool-early-start] the batch of calls that started early ended early: ${String(err)}`);
  } finally {
    if (wasInBatch) st.inToolBatch = true;
  }
}

async function* runRoundBody(
  deps: RoundDeps,
  st: RoundState,
  early: EarlyStart | undefined,
  // TOOLS_MIDSTREAM_RW_V1: the model the stream was committed to, for the teardown above.
  served: { model: string },
): AsyncGenerator<HarnessEvent, RoundResult, void> {
  const { cfg, transport, requestedModel } = deps;

  yield* checkRoundReconstruction(deps, st);

  // Task 6: bounded retry around callModel + the first stream event. The
  // helper returns an AsyncIterable whose first event has already been
  // pulled (so an early error — e.g. a 429 surfacing only on first read —
  // is caught and retried), then re-yields it so the drive below is
  // UNCHANGED. `committedModel` is the model that actually produced the
  // committed stream (may be cfg.retry.fallbackModel) → cost is attributed
  // to it, not the originally-requested model.
  //
  // P2.2 gate 1 (settle-on-abort, subagent only): a retry-exhausted abort
  // returns cleanly instead of throwing, so the nested loop settles its
  // already-accumulated cost. The main caller rethrows — its iterateTurn catch
  // owns the user_aborted sealing. Non-abort throws propagate for BOTH.
  let started: { stream: AsyncIterable<StreamEvent>; model: string; billedAs?: string };
  // Honest per-request TTFT anchor: startStreamWithRetry resolves only after the
  // FIRST stream event has been pulled, so (resolve − start) IS request-start →
  // first-token on ONE clock — structurally non-negative, immune to the mid-turn
  // steer re-anchoring that bent the old turn-scoped metric (negative sandbox
  // components / total=7ms rows). Includes transparent retry backoff: the round
  // wanted a model response at `requestStartMs`; that wait is real latency.
  // Durations on the monotonic clock (monotonic-clock.ts), never the wall clock.
  const requestStartMs = monotonicMs();
  // Every attempt this round sends (failed ones, a sibling or fallback, a heal); the last one
  // sent is the one the round commits to, so its time splits the latency (roundTiming).
  const send = { attempts: 0, lastAtMs: requestStartMs };
  const onAttempt = (): void => {
    send.attempts += 1;
    send.lastAtMs = monotonicMs();
  };
  const request = buildRoundRequest(deps);
  try {
    // RETRY_BY_CAUSE_V1 on: the same call, with each retry wait shown live. LANE_FALLBACK_V1 on:
    // a move to the lane's second route is shown live too. NETWORK_WAIT_V1: the main loop's
    // request waits for the network past a dropped connection's schedule, each wait shown live.
    // All off: unchanged.
    const waitForNetwork = deps.sub === undefined && networkWaitEnabled();
    if (retryByCauseEnabled() || laneFallbackEnabled() || waitForNetwork) {
      started = yield* startWithRetryLines((onRetryWait) =>
        startStreamWithRetry(request, transport, cfg, { onRetryWait, onAttempt, ...(waitForNetwork && { waitForNetwork }) }),
      );
    } else {
      started = await startStreamWithRetry(request, transport, cfg, { onAttempt });
    }
  } catch (err) {
    if (deps.sub !== undefined && cfg.signal?.aborted) {
      return { committedModel: requestedModel, roundCostUsd: 0, results: [], abortedMidStream: true };
    }
    // The floor under a rejected history (live 28edef30): ONE retry of this same call on a
    // safe view of the history when the provider rejected it as invalid; any other failure,
    // or a second one, rethrows exactly as before.
    started = yield* healRejectedHistory(deps, st, err, request, (history) =>
      startStreamWithRetry({ ...request, history }, transport, cfg, { onAttempt }),
    );
  }
  const committedModel = started.model;
  served.model = committedModel;
  // The main loop's last request AS SENT, for the turn's memory sweep (SWEEP_PREFIX_PARITY_V1):
  // on the model that served it (a fallback or sibling may have), every other field as sent.
  if (deps.sub === undefined) deps.rc.lastRequest = loopRequestOf({ ...request, model: committedModel });
  // A sibling-lane round bills at the PICKED model; the served model stays the
  // row's truth. Absent on every other round ⇒ byte-identical below.
  const billedAs = started.billedAs;
  const ttftMs = Math.round(monotonicMs() - requestStartMs);

  // P2.2 gate 1 (settle-on-abort, subagent only; Weave 2b §6.3 / AC-2b-3): a
  // user/timeout abort MID-GENERATION makes readStream throw (the provider
  // stream forwards the signal). On the subagent path we settle cleanly and let
  // the nested loop return its accumulated cost — the aborted round's own
  // partial tokens are unavailable (no `done` arrived), an accepted,
  // unmeasurable edge; we never over-count it. A NON-abort throw still
  // propagates unchanged, and the MAIN caller rethrows aborts too (its
  // iterateTurn catch seals the in-flight round off `st`).
  let firstTextAtMs: number | undefined;
  try {
    ({ firstTextAtMs } = yield* driveRoundStream(started.stream, st, early));
  } catch (err) {
    if (deps.sub !== undefined && cfg.signal?.aborted) {
      // Settle BEFORE the fold — the aborted round folds nothing (legacy shape).
      return { committedModel, roundCostUsd: 0, results: [], abortedMidStream: true };
    }
    throw err;
  }
  // The whole model call, request start → last stream event (the usage event's latencyMs),
  // split at the committed send, how many attempts it took, and when the first text showed.
  const timing = roundTiming({ requestStartMs, sentAtMs: send.lastAtMs, firstTextAtMs, endMs: monotonicMs() });

  // Attribute cost to the model that actually produced this round's stream
  // (the committed model — may be the fallback after a primary failure).
  const roundCostUsd = transport.computeCostUsd(st.lastUsage, billedAs ?? committedModel);
  // Live ledger BEFORE the sub/main branch — covers parent AND child rounds, any depth.
  // Priced as the SAME id the cost was computed with, so an estimate is named as one.
  foldModelSpend(cfg.liveSpend, transport, roundCostUsd, billedAs ?? committedModel);
  if (deps.sub !== undefined) {
    // P2.2 gate 2 — the subagent's own accumulators; rc.billing is untouched
    // (the Agent tool folds the returned total exactly once via ctx.addCostUsd).
    deps.sub.foldRoundCost(roundCostUsd, st.lastUsage, committedModel);
  } else {
    deps.rc.billing.cumulativeCostUsd += roundCostUsd;
    // Agent v2 (Task 4): this round is the PARENT's own model call → advance the
    // independent parent-own accumulator in lockstep (the INDEPENDENT measure the
    // per-turn reconciliation invariant checks against; never derived from Σchild).
    deps.rc.billing.parentOwnCostUsd += roundCostUsd;
  }
  // Track the model behind the FINAL round's usage so run()'s billing
  // event attributes lastUsage to the right model (Task 6 fallback).
  st.lastUsageModel = committedModel;

  const { roundEntryUuid, capturedReasoning } = await settleRoundOutput(deps, st, roundCostUsd, committedModel);

  yield* emitRoundUsage(deps, st, { committedModel, ttftMs, ...timing, attempts: send.attempts, roundEntryUuid, ...(billedAs !== undefined && { billedAs }) });

  // No tool calls → the round is complete as-is. The CALLER owns what happens
  // next (PR1 empty-completion recovery / PR9 fallback-model switch / a clean
  // break) — that is loop-level policy, not round work.
  if (st.toolUses.length === 0) {
    return { committedModel, roundCostUsd, results: [] };
  }

  const results = yield* runToolBatch(deps, st, capturedReasoning, committedModel, early);

  return { committedModel, roundCostUsd, results };
}
