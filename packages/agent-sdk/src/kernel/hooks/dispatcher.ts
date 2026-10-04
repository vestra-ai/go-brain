/**
 * K6-P2 — the provider-neutral HOOK DISPATCHER.
 *
 * Runs a registered chain of {@link HookCallback}s for a {@link HookEvent} and
 * FOLDS the per-callback {@link HookJSONOutput}s into ONE {@link HookOutcome} the
 * native loop (B2/B3) acts on. Mirrors the Claude Agent SDK's chain semantics so
 * the 11 ported callbacks behave identically — but the kernel OWNS the decision
 * folding (no provider involved).
 *
 * KERNEL PURITY: imports only the sibling contract (which imports only
 * `@bash/shared` types). No SDK, no Blaxel, no socket/IO.
 *
 * §ALLOW IS NOT THE LAST WORD. In Vestra the security floor IS a PreToolUse hook
 * (`createNativeHookDispatcher` registers `buildGateFloorHook` first) and
 * `gateFloorToOutput` is TOTAL — every GateResult yields a `permissionDecision`,
 * including `allow` for any plain-safe tool. So short-circuiting on `allow` ends
 * the chain on EVERY call and no later PreToolUse callback can ever run. That made
 * per-ability declared hooks (`registerAbilityHooks`, registered after the floor
 * precisely so they "layer ON TOP of the floor's verdict") unreachable on the only
 * live arm — a silent no-op, not a bug anyone could see. Hence: a floor `allow`
 * means "no objection", not "chain over". Only a RESTRICTIVE decision ends the
 * chain, so the fold is monotone toward restriction — a later callback can turn
 * `allow` into deny/ask, and can never loosen a deny/ask (they never reach it).
 *
 * THE SECURITY INVARIANT (TDD'd first): an empty `{}` return FALLS THROUGH the
 * chain — it is NOT an allow. Treating empty-as-allow would let an ungated tool
 * execute. A throwing or timing-out hook ALSO falls through (it implies neither
 * allow nor deny). Only an explicit `permissionDecision` speaks for the gate; its
 * ABSENCE after the whole chain means "no hook decided" → the loop applies its
 * own default gate.
 *
 * Chain rules:
 *  - groups run in REGISTRATION ORDER; within a group, callbacks run in order.
 *  - a group with no `matcher` always matches; otherwise its regex is tested
 *    against the event's dispatch KEY (tool_name for tool events; `trigger`/
 *    `source` for PreCompact/SessionStart; `agent_type` for Subagent*). X1: with
 *    `claudeCodeMatchers` the documented syntax and keys apply instead (§documentedMatch).
 *  - a RESTRICTIVE PreToolUse `permissionDecision` (deny/ask/defer) SHORT-CIRCUITS;
 *    an `allow` is RECORDED and the chain CONTINUES (see §ALLOW IS NOT THE LAST WORD).
 *  - `continue:false` or `decision:'block'` HALTS (carry the stop reason).
 *  - `updatedInput` merges per-key (later wins); `updatedToolOutput` last-writer
 *    wins; `additionalContext` concatenates (newline-joined) across survivors.
 *  - each callback runs under a per-group timeout (default 600_000ms; 30_000ms
 *    for UserPromptSubmit) RACING the caller's AbortSignal; on timeout/abort the
 *    callback falls through.
 *  - a thrown callback is CAUGHT + logged, never crashes the dispatch.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookDispatcherOptions,
  HookEvent,
  HookExecutionEvent,
  HookInput,
  HookJSONOutput,
  HookOutcome,
  HookPermissionDecision,
  PreToolUseHookSpecificOutput,
  PermissionRequestHookSpecificOutput,
  PostToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from './contract.js';

/** Per-group timeout defaults (ms). UserPromptSubmit is tighter because it sits
 *  in the user's interactive path. Mirrors the SDK's per-event budgets. */
const DEFAULT_TIMEOUT_MS = 600_000;
const EVENT_TIMEOUT_MS: Partial<Record<HookEvent, number>> = {
  UserPromptSubmit: 30_000,
};

/** Sentinel returned by the per-callback race when the hook does not produce a
 *  usable output in time (timeout / abort / throw). Distinct from `{}` only for
 *  internal clarity — both fall through. */
const FALLTHROUGH = Symbol('hook-fallthrough');
type CallbackResult = HookJSONOutput | typeof FALLTHROUGH;

/**
 * The terminal observability phase the per-callback race resolved to (B4). A
 * thrown callback → 'error' (with the message); a timeout/abort → 'cancelled'; a
 * usable output → 'completed'. Kept separate from {@link CallbackResult} so the
 * race can report the OBSERVABILITY outcome WITHOUT changing the existing
 * fall-through decision semantics (a non-'completed' phase still falls through).
 */
interface RaceResult {
  result: CallbackResult;
  phase: 'completed' | 'error' | 'cancelled';
  error?: string;
}

export interface DispatchCtx {
  /** The tool_use id for tool events; undefined for lifecycle events. */
  toolUseId?: string;
  /** Caller abort signal — races every callback. */
  signal: AbortSignal;
}

/** Mutable accumulator folded across the chain into the final HookOutcome. */
interface Accumulator {
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  // K6-P3-C7: structured deny classifier, follows the deciding callback (set in
  // lockstep with permissionDecision so a later overriding decision replaces it).
  permissionDecisionReasonType?: string;
  updatedInput?: Record<string, unknown>;
  updatedToolOutput?: unknown;
  hasUpdatedToolOutput: boolean;
  additionalContext: string[];
  // X1: a PermissionRequest deny that asked to stop the agent (follows the deciding callback).
  interrupt?: true;
}

export class HookDispatcher {
  /** event → ordered list of registered groups. */
  private readonly groups = new Map<HookEvent, HookCallbackMatcher[]>();

  /** B4: the injected observability sink (default undefined → no observability). */
  private readonly onHookExecution?: (ev: HookExecutionEvent) => void;

  /** B4: monotonic per-dispatcher counter for stable hookIds. Clock-free (no
   *  Date.now / crypto) → kernel stays pure. */
  private hookSeq = 0;

  /** X1: match by the Claude Code hooks reference (see HookDispatcherOptions). */
  private readonly claudeCodeMatchers: boolean;

  /** X1: the host's limit on one callback's added context (see HookDispatcherOptions). */
  private readonly spillContext: ((text: string) => string) | undefined;

  /**
   * @param options - B4 observability seam. `new HookDispatcher()` (no args) is the
   *  unchanged default — no observer, zero per-callback observability overhead.
   */
  constructor(options?: HookDispatcherOptions) {
    if (options?.onHookExecution !== undefined) {
      this.onHookExecution = options.onHookExecution;
    }
    this.claudeCodeMatchers = options?.claudeCodeMatchers === true;
    this.spillContext = options?.spillContext;
  }

  /**
   * Register one or more callbacks for an event under a matcher group.
   * `matcher` carries only `{ matcher?, timeout? }` — the callbacks are passed
   * separately (this is the spec's `register(event, matcher, callback)` shape,
   * widened to variadic so a multi-callback group registers in one call).
   */
  register(
    event: HookEvent,
    matcher: Omit<HookCallbackMatcher, 'hooks'>,
    ...callbacks: HookCallback[]
  ): void {
    if (callbacks.length === 0) return;
    const list = this.groups.get(event) ?? [];
    const group: HookCallbackMatcher = { hooks: callbacks };
    if (matcher.matcher !== undefined) group.matcher = matcher.matcher;
    if (matcher.timeout !== undefined) group.timeout = matcher.timeout;
    list.push(group);
    this.groups.set(event, list);
  }

  /**
   * Run the chain for `event` over `input` and fold into one HookOutcome.
   * Never throws (errors in callbacks are isolated).
   */
  async dispatch(event: HookEvent, input: HookInput, ctx: DispatchCtx): Promise<HookOutcome> {
    const acc: Accumulator = { additionalContext: [], hasUpdatedToolOutput: false };
    const key = this.claudeCodeMatchers ? documentedKey(input) : dispatchKey(input);
    const groups = this.groups.get(event) ?? [];

    for (const group of groups) {
      if (!(this.claudeCodeMatchers ? documentedMatch(group.matcher, key) : groupMatches(group, key ?? ''))) continue;
      const timeoutMs = resolveTimeout(event, group);

      for (const cb of group.hooks) {
        // B4: observability around each callback. `started` BEFORE the race so a
        // pre-aborted/timed-out hook still reports it was scheduled; the terminal
        // phase (completed/error/cancelled) follows. A stable per-invocation
        // hookId correlates the pair. Emitting is a no-op when no observer.
        const hookId = this.notifyStart(event, group);
        const race = await runCallback(cb, input, ctx, timeoutMs);
        this.notifyEnd(hookId, event, group, race);
        const result = race.result;
        if (result === FALLTHROUGH) continue; // timeout / abort / throw — fall through
        if (!isSyncOutput(result)) continue; // async-deferred output — fall through

        // Fold this callback's specific output (incl. its own additionalContext)
        // into the accumulator BEFORE deciding halt/short-circuit, so a halt or
        // permission-decision outcome carries the deciding callback's own context.
        mergeSpecificOutput(acc, result);

        // HALT: continue:false OR decision:'block'. Intentionally takes
        // precedence over a same-output permissionDecision — an explicit
        // agent-stop wins over a tool-gate verdict (a deciding callback that
        // sets BOTH should stop the agent, not just deny one tool). Do NOT
        // "fix" this into a gated-deny; none of the 11 callbacks set both today.
        if (result.continue === false || result.decision === 'block') {
          return buildHalt(acc, haltReason(result), result.continue !== false, this.spillContext);
        }

        // SHORT-CIRCUIT: a RESTRICTIVE PreToolUse permission decision ends the chain.
        // `allow` is recorded and the chain CONTINUES — see §ALLOW IS NOT THE LAST
        // WORD in the header for why (the security floor is itself the first hook
        // and allows every safe call, which would otherwise consume the chain).
        if (acc.permissionDecision !== undefined && acc.permissionDecision !== 'allow') {
          return buildContinue(acc, this.spillContext);
        }
      }
    }

    return buildContinue(acc, this.spillContext);
  }

  /**
   * B4: emit the `started` observability event and return the stable hookId that
   * the matching terminal event ({@link notifyEnd}) reuses. Mints the id from a
   * monotonic counter (clock-free). No-op (and still returns the id) when no
   * observer is wired, so the id minting stays cheap + deterministic.
   */
  private notifyStart(event: HookEvent, group: HookCallbackMatcher): string {
    const hookId = `hk_${++this.hookSeq}`;
    if (this.onHookExecution === undefined) return hookId;
    const ev: HookExecutionEvent = { hookId, hookEvent: event, phase: 'started' };
    if (group.matcher !== undefined) ev.matcher = group.matcher;
    this.onHookExecution(ev);
    return hookId;
  }

  /**
   * B4: emit the terminal observability event for a callback invocation. The race
   * already classified the phase (completed / error / cancelled); we forward it
   * with the same hookId. No-op when no observer is wired.
   */
  private notifyEnd(
    hookId: string,
    event: HookEvent,
    group: HookCallbackMatcher,
    race: RaceResult,
  ): void {
    if (this.onHookExecution === undefined) return;
    const ev: HookExecutionEvent = { hookId, hookEvent: event, phase: race.phase };
    if (group.matcher !== undefined) ev.matcher = group.matcher;
    if (race.error !== undefined) ev.error = race.error;
    this.onHookExecution(ev);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The string a group's `matcher` regex is tested against, per event family. */
function dispatchKey(input: HookInput): string {
  switch (input.hook_event_name) {
    case 'PreToolUse':
    case 'PermissionRequest':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return input.tool_name;
    case 'PreCompact':
      return input.trigger;
    case 'SessionStart':
      return input.source;
    case 'SubagentStart':
    case 'SubagentStop':
      return input.agent_type;
    // Events without a meaningful match key: only no-matcher groups apply.
    case 'PostToolBatch':
    case 'Notification':
    case 'Stop':
    case 'PostCompact':
    case 'UserPromptSubmit':
    case 'SessionEnd':
      return '';
    default: {
      // Exhaustiveness: a new HookEvent must extend this switch.
      const _never: never = input;
      return _never;
    }
  }
}

/**
 * X1 — the field the Claude Code hooks reference says a matcher filters on: the legacy key,
 * plus notification_type / reason / trigger for Notification / SessionEnd / PostCompact.
 * undefined for an event with no matcher support (UserPromptSubmit, Stop, PostToolBatch),
 * where a matcher "is silently ignored": the group always runs.
 */
function documentedKey(input: HookInput): string | undefined {
  switch (input.hook_event_name) {
    case 'Notification':
      return input.notification_type;
    case 'SessionEnd':
      return input.reason;
    case 'PostCompact':
      return input.trigger;
    case 'UserPromptSubmit':
    case 'Stop':
    case 'PostToolBatch':
      return undefined;
    default:
      return dispatchKey(input);
  }
}

/** The matcher characters the reference evaluates as an exact name or a list of names. */
const EXACT_MATCHER = /^[A-Za-z0-9_ ,|-]+$/;

/**
 * X1 — a matcher as the reference evaluates it: `*`, empty or omitted matches all; only
 * letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a `|` / `,` list of them
 * (`Bash` no longer matches `BashOutput`); anything else is an unanchored regex (`^Notebook`,
 * `mcp__memory__.*`). An event without matcher support (key undefined) always matches. A
 * malformed regex is NON-matching, as before. Codex makes the same exact/regex split
 * (codex-rs/hooks/src/engine/matcher.rs).
 */
function documentedMatch(matcher: string | undefined, key: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*' || key === undefined) return true;
  if (EXACT_MATCHER.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === key);
  try {
    return new RegExp(matcher).test(key);
  } catch {
    return false;
  }
}

/** A no-matcher group always matches; otherwise regex-test the key. A malformed
 *  regex is treated as NON-matching (never throw out of dispatch). */
function groupMatches(group: HookCallbackMatcher, key: string): boolean {
  if (group.matcher === undefined) return true;
  try {
    return new RegExp(group.matcher).test(key);
  } catch {
    return false;
  }
}

/** Group timeout in ms: explicit group `timeout` (SDK SECONDS) wins, else the
 *  per-event default. */
function resolveTimeout(event: HookEvent, group: HookCallbackMatcher): number {
  if (group.timeout !== undefined) return group.timeout * 1000;
  return EVENT_TIMEOUT_MS[event] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Run one callback racing (a) its result, (b) the per-group timeout, and (c) the
 * caller's abort signal. Returns a {@link RaceResult} that classifies the
 * OBSERVABILITY phase (completed / error / cancelled) ALONGSIDE the fall-through
 * decision: a throw → 'error' (FALLTHROUGH), a timeout/abort → 'cancelled'
 * (FALLTHROUGH), a usable output → 'completed'. The DECISION semantics are
 * unchanged (any non-completed phase still carries FALLTHROUGH and falls through).
 * Never rejects.
 */
async function runCallback(
  cb: HookCallback,
  input: HookInput,
  ctx: DispatchCtx,
  timeoutMs: number,
): Promise<RaceResult> {
  // Fast path: already aborted → fall through without invoking the callback.
  if (ctx.signal.aborted) return { result: FALLTHROUGH, phase: 'cancelled' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutP = new Promise<RaceResult>((resolve) => {
    timer = setTimeout(() => resolve({ result: FALLTHROUGH, phase: 'cancelled' }), timeoutMs);
  });
  const abortP = new Promise<RaceResult>((resolve) => {
    onAbort = () => resolve({ result: FALLTHROUGH, phase: 'cancelled' });
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });

  const callP: Promise<RaceResult> = (async () => {
    try {
      return { result: await cb(input, ctx.toolUseId, { signal: ctx.signal }), phase: 'completed' };
    } catch (err) {
      console.warn('[HookDispatcher] callback threw (isolated, falling through):', err);
      return { result: FALLTHROUGH, phase: 'error', error: errorMessage(err) };
    }
  })();

  try {
    return await Promise.race([callP, timeoutP, abortP]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Best-effort error message extraction (no throw on odd thrown values). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/** True for the synchronous output variant (carries decisions); the async
 *  variant `{ async: true }` is a deferral the dispatcher does not block on. */
function isSyncOutput(out: HookJSONOutput): out is SyncHookJSONOutput {
  return !('async' in out && out.async === true);
}

/** The stop reason carried by a halting output (SDK uses both fields). */
function haltReason(out: SyncHookJSONOutput): string | undefined {
  return out.stopReason ?? out.reason;
}

/** Fold one callback's specific output into the accumulator. */
function mergeSpecificOutput(acc: Accumulator, out: SyncHookJSONOutput): void {
  const so = out.hookSpecificOutput;
  if (so === undefined) return;

  if (isPreToolUseSpecific(so)) {
    if (so.permissionDecision !== undefined) {
      acc.permissionDecision = so.permissionDecision;
      // K6-P3-C7: the deny classifier (and the reason) follow the DECIDING callback.
      // Assigned unconditionally — including to `undefined` — so a later decision
      // can never inherit an earlier one's copy. This mattered the moment `allow`
      // stopped short-circuiting (see dispatch() §SHORT-CIRCUIT): a floor `allow`
      // followed by an ability-hook `deny` must carry the DENY's reason, and a
      // reasonless deny must not wear the allow's.
      if (so.permissionDecisionReason !== undefined) acc.permissionDecisionReason = so.permissionDecisionReason;
      else delete acc.permissionDecisionReason;
      if (so.permissionDecisionReasonType !== undefined) acc.permissionDecisionReasonType = so.permissionDecisionReasonType;
      else delete acc.permissionDecisionReasonType;
    }
    if (so.updatedInput !== undefined) {
      acc.updatedInput = { ...(acc.updatedInput ?? {}), ...so.updatedInput };
    }
    if (typeof so.additionalContext === 'string' && so.additionalContext.length > 0) {
      acc.additionalContext.push(so.additionalContext);
    }
    return;
  }

  if (isPermissionRequestSpecific(so)) {
    // X1: the Claude Code PermissionRequest answer, folded onto the same verdict
    // fields as PreToolUse. `updatedInput` rides `allow` only and `message` rides
    // `deny` only (the documented pairing); a deny ends the chain like any
    // restrictive verdict, an allow is recorded and the chain continues.
    // `interrupt` follows the deciding callback like the reason does; `updatedPermissions`
    // is never folded (a hook answers one card; see PermissionRequestHookSpecificOutput).
    const d = so.decision;
    if (d?.behavior === 'allow') {
      acc.permissionDecision = 'allow';
      delete acc.permissionDecisionReason;
      delete acc.interrupt;
      if (d.updatedInput !== undefined) acc.updatedInput = { ...(acc.updatedInput ?? {}), ...d.updatedInput };
    } else if (d?.behavior === 'deny') {
      acc.permissionDecision = 'deny';
      if (d.message !== undefined) acc.permissionDecisionReason = d.message;
      else delete acc.permissionDecisionReason;
      if (d.interrupt === true) acc.interrupt = true;
      else delete acc.interrupt;
      delete acc.updatedInput;
    }
    delete acc.permissionDecisionReasonType;
    return;
  }

  if (isPostToolUseSpecific(so)) {
    // Prefer updatedToolOutput; accept the MCP-only variant as a fallback.
    if ('updatedToolOutput' in so && so.updatedToolOutput !== undefined) {
      acc.updatedToolOutput = so.updatedToolOutput;
      acc.hasUpdatedToolOutput = true;
    } else if ('updatedMCPToolOutput' in so && so.updatedMCPToolOutput !== undefined) {
      acc.updatedToolOutput = so.updatedMCPToolOutput;
      acc.hasUpdatedToolOutput = true;
    }
    if (typeof so.additionalContext === 'string' && so.additionalContext.length > 0) {
      acc.additionalContext.push(so.additionalContext);
    }
    return;
  }

  // Generic specific output: additionalContext only.
  if (typeof so.additionalContext === 'string' && so.additionalContext.length > 0) {
    acc.additionalContext.push(so.additionalContext);
  }
}

function isPreToolUseSpecific(
  so: NonNullable<SyncHookJSONOutput['hookSpecificOutput']>,
): so is PreToolUseHookSpecificOutput {
  return so.hookEventName === 'PreToolUse';
}

function isPermissionRequestSpecific(
  so: NonNullable<SyncHookJSONOutput['hookSpecificOutput']>,
): so is PermissionRequestHookSpecificOutput {
  return so.hookEventName === 'PermissionRequest';
}

function isPostToolUseSpecific(
  so: NonNullable<SyncHookJSONOutput['hookSpecificOutput']>,
): so is PostToolUseHookSpecificOutput {
  return so.hookEventName === 'PostToolUse';
}

/** Build the `halt` outcome from the accumulator, carrying any merged
 *  additionalContext (incl. the halting callback's own) + the stop reason.
 *  `blocked` marks a `decision:'block'` that did not also say `continue:false`. */
function buildHalt(
  acc: Accumulator,
  stopReason: string | undefined,
  blocked: boolean,
  spill?: (text: string) => string,
): HookOutcome {
  const outcome: Extract<HookOutcome, { decision: 'halt' }> = { decision: 'halt' };
  if (stopReason !== undefined) outcome.stopReason = stopReason;
  if (blocked) outcome.blocked = true;
  if (acc.additionalContext.length > 0) {
    outcome.additionalContext = joinContext(acc.additionalContext, spill);
  }
  return outcome;
}

/** Every surviving callback's added context, each passed through the host's limit first (X1). */
function joinContext(contexts: string[], spill?: (text: string) => string): string {
  return (spill ? contexts.map(spill) : contexts).join('\n');
}

/** Build the `continue` outcome from the accumulator, omitting absent fields so
 *  the loop can cheaply test for presence (exactOptionalPropertyTypes-friendly). */
function buildContinue(acc: Accumulator, spill?: (text: string) => string): HookOutcome {
  const outcome: Extract<HookOutcome, { decision: 'continue' }> = { decision: 'continue' };
  if (acc.permissionDecision !== undefined) outcome.permissionDecision = acc.permissionDecision;
  if (acc.permissionDecisionReason !== undefined) {
    outcome.permissionDecisionReason = acc.permissionDecisionReason;
  }
  // K6-P3-C7: carry the structured deny classifier onto the outcome (observability).
  if (acc.permissionDecisionReasonType !== undefined) {
    outcome.permissionDecisionReasonType = acc.permissionDecisionReasonType;
  }
  if (acc.updatedInput !== undefined) outcome.updatedInput = acc.updatedInput;
  if (acc.hasUpdatedToolOutput) outcome.updatedToolOutput = acc.updatedToolOutput;
  if (acc.additionalContext.length > 0) {
    outcome.additionalContext = joinContext(acc.additionalContext, spill);
  }
  if (acc.interrupt === true) outcome.interrupt = true;
  return outcome;
}
