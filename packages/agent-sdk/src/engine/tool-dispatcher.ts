/**
 * tool-dispatcher.ts — the provider-neutral tool DISPATCHER (ring 4c.7).
 *
 * The MECHANISM half of the former product `native-tools.ts`: gate → execute →
 * SINGLE composio post-scan, plus the hook-input builders + the Anthropic tool
 * shape mapper. Moved verbatim from `apps/sandbox/src/harness/native-tools.ts`
 * into the SDK engine — it takes only SDK-typeable params (`RawToolOptions`,
 * `harness:{gateTool}`, `onPause`, `onAuthHalt?`, `execCtx?`) and gates via the
 * passed harness + classifies composio via the SDK policy engine, so it carries
 * no `NativeConfig`/socket/tool-factory coupling.
 *
 * The ASSEMBLER half (`buildNativeToolList`/`buildNativeMcpTools`/`buildOnAuthHalt`)
 * STAYS product-side (wrapped by `NativeToolHost`): it imports the env-injecting
 * tool factories and closes over the product transport/socket.
 *
 * SDK PURITY: this module reads NO `@bash/*` and NO `process.env` (the dispatcher's
 * historic `process.env.SESSION_ID` reads are rebound to a threaded
 * `execCtx.sessionId`; `process.cwd()` STAYS — it is a node runtime primitive, not
 * env config, and rebinding it would change the hook-input `cwd` byte-for-byte).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { classifyComposioToolResult, classifyComposioConnectUnavailable, connectUnavailableTrailer } from '../policy/index.js';
import { guardToolOutput } from './tool-output-guard.js';
import { offloadIfOversized, activeToolOutputTokenBudget, holdToTokenBudget } from './context-offload.js';
import type {
  HookDispatcher,
  HookOutcome,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
} from '../kernel/index.js';
import type { GateResult, ToolCall } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { ContentBlock, ImageMediaType } from '../contract/blocks.js';
import { toToolJsonSchema } from '../contract/tool-json-schema.js';
import type { RawToolOptions, ToolExecuteContext, ToolDispatchResult, OnAuthHalt } from '../tools/tool-types.js';
import { isToolError, fenceUntrustedText, sanitizeUntrustedText, UNTRUSTED_CONTENT_OPEN, UNTRUSTED_CONTENT_CLOSE } from '../tools/tool-types.js';
import { stampToolError, unknownToolText } from '../tools/result-shape.js';
import { coerceStringifiedToolArgs } from './tool-arg-coerce.js';
import { validateToolArgs, formatToolArgIssues } from './tool-arg-validate.js';
import {
  BELT_TIMEOUT_READING,
  INJECTION_SCREEN_BELT_TIMEOUT_MS,
  type InjectionScreenReading,
  type InjectionScreenSeam,
} from '../policy/injection-screen.js';
import { injectionGuardRefusal } from '../policy/injection-guard.js';
import { silentDeathsEnabled } from '../policy/feature-flags.js';
import { withHookContext, withPostToolUseFeedback } from './hook-parity.js';
import { decideToolCall } from './tool-gate-verdict.js';
import { armToolProgressWatchFor, NonProgressCut, type ToolWatchdogEvent } from './tool-progress-watch.js';

/**
 * The product socket-event name a native deny carries. Kept as a literal here
 * (NOT imported from the product `EVENTS` vocabulary) because the SDK contract
 * intentionally stays free of Vestra's socket-event constants — the `raw`
 * HarnessEvent's `event` field is a plain `string` (see contract/events.ts). This
 * literal is byte-identical to `EVENTS.PERMISSION_DENIED` (a conformance assertion
 * in apps/sandbox/src/harness/__tests__/native-tools.test.ts proves it).
 */
const PERMISSION_DENIED_EVENT = 'permission:denied';

// `OnAuthHalt` now lives in tool-types (so the ToolHost port can reference it too).
export type { OnAuthHalt } from '../tools/tool-types.js';

/**
 * Story-spine narration contract (PR-B): every tool the native lane serves
 * carries an optional `narration` param, injected once at this assembly seam
 * (the transport maps EVERY RawToolOptions — MCP included — through
 * toAnthropicTool). The model writes intent here; the server mints it into
 * task_story rows from the wire event; the dispatcher strips it before
 * execution so no tool handler ever sees display material.
 */
export const NARRATION_PARAM = 'narration';
// Description kept to the RULE only — the style examples live once, in the
// activity_narration system layer, not repeated into every tool schema.
const NARRATION_SCHEMA = {
  type: 'string',
  description:
    'One short present-tense sentence, in the user’s words, saying what this call is doing for them. ' +
    'Start with the verb (“Checking your latest mail from Ashish”), never with “I’m” or “I am”; no trailing period. ' +
    'Always include it. No tool jargon, no file paths, no code.',
} as const;

/**
 * Inject the narration param — the ONE injection seam every transport's
 * buildTools maps through. `parameters` arrives as a Zod schema for every
 * built-in tool and as plain JSON Schema for MCP/Composio tools; both are
 * converted to plain JSON first (Zod → draft-2020-12, plain objects pass
 * through, null → the empty-object schema), so the sentence reaches EVERY
 * call. `$schema` is dropped: no provider wants it on a tool. A tool that
 * declares its own `narration` keeps it verbatim. Strict tools get narration
 * appended to `required` (OpenAI constrained decoding demands every property
 * in `required`, which then guarantees the sentence).
 */
export function withNarrationParam(o: RawToolOptions): RawToolOptions {
  const converted = toToolJsonSchema(o.parameters) as {
    $schema?: string; type?: string; properties?: Record<string, unknown>; required?: string[];
  };
  const { $schema: _schema, ...params } = converted;
  if (params.type !== 'object') return { ...o, parameters: params };
  if (params.properties && NARRATION_PARAM in params.properties) return { ...o, parameters: params };
  const schema: typeof params = {
    ...params,
    properties: { ...(params.properties ?? {}), [NARRATION_PARAM]: NARRATION_SCHEMA },
  };
  if (o.strict === true) schema.required = [...(params.required ?? []), NARRATION_PARAM];
  return { ...o, parameters: schema };
}

/**
 * Convert a RawToolOptions into the Anthropic Messages API tool shape.
 * The key difference: Anthropic uses `input_schema` where OpenAI uses `parameters`.
 *
 * `withNarrationParam` (called below) converts `parameters` to plain JSON Schema
 * and drops `$schema` on its way through, so `input_schema` is the real schema —
 * `type`/`properties`/`required`/`enum` plus every `.describe()` doc — with no
 * further mapping. That used to be gated on TOOL_SCHEMA_JSON_V1 and threaded in
 * as a mapper; the flag graduated, and the conversion now lives at the one
 * injection seam every lane shares.
 */
export function toAnthropicTool(o: RawToolOptions, defer = false): Anthropic.Tool {
  const injected = withNarrationParam(o);
  return {
    name: injected.name,
    description: injected.description,
    input_schema: injected.parameters as Anthropic.Tool.InputSchema,
    // TOOL_DEFER_V1. Spread-when-true so a non-deferred tool has NO key at all —
    // `defer_loading: false` would be semantically identical but would change the
    // serialized bytes of every tool on every request, which is exactly what the
    // OFF path must not do. The caller decides; this function reads no flag (see
    // SDK PURITY above — this module reads no env).
    ...(defer ? { defer_loading: true } : {}),
  };
}

/**
 * W4-1 / S6 — the tool's taint declaration for ONE call: a boolean as declared, or a
 * function of the call's input, asked after execute. A declaration that throws answers
 * true: fence on doubt, never fail the call over its label.
 */
function declaresUntrusted(o: RawToolOptions, input: unknown): boolean {
  const declared = o.untrustedContent;
  if (typeof declared !== 'function') return declared === true;
  try {
    return declared(input) === true;
  } catch {
    return true;
  }
}

/** The answer to a call naming no tool in the catalog: the one error shape when the taxonomy is on (T5). */
export function unknownToolResult(toolUseId: string, name: string, taxonomy: boolean | undefined): ToolDispatchResult {
  return { toolUseId, text: unknownToolText(name, taxonomy), isError: true };
}

/**
 * Gate → execute → SINGLE composio-result-scan for one Anthropic tool call (K3-T5).
 * Mirrors openai-tool-wrapper's gate ORDER (allow/deny/needs_human) so the two
 * arms behave identically at the policy layer.
 *
 * onPause fires the pause-for-human interaction (substrate row + INTERACTION_REQUIRED)
 * and returns the PAUSED_HALT sentinel string.
 *
 * Composio auth-halt — ONE step: the kernel runs `classifyComposioToolResult`
 * exactly once after execute returns. On an auth verdict it fires `onAuthHalt`
 * (which registers the substrate row + INTERACTION_REQUIRED, deduped per
 * (task,toolkit)) and returns `{ pausedHalt: true }`. This replaces the old
 * 3-layer arrangement (a scan + auth-fire inside the MCP execute callback, a
 * PAUSED_HALT sentinel check here, AND a defensive fallback scan here) with a
 * single authoritative post-scan. `onAuthHalt` is optional + degrade-safe: when
 * absent OR if it throws, the dispatcher still returns `pausedHalt` (never-throw).
 */
export async function gateAndDispatchTool(
  o: RawToolOptions,
  input: unknown,
  toolUseId: string,
  harness: { gateTool(call: ToolCall): Promise<GateResult> },
  onPause: (call: ToolCall, kind: string) => Promise<string>,
  onAuthHalt?: OnAuthHalt,
  // K5-T7: the mid-turn push channel. The loop passes its AbortSignal and a
  // `pushEvent` that enqueues onto the loop's PushQueue; the loop yields each
  // pushed event LIVE (the loop stays the sole emitter). Omitted → the execute
  // context is bare `{ toolCallId }`, byte-identical to the pre-T7 behavior.
  execCtx?: {
    signal?: AbortSignal;
    pushEvent?: (ev: HarnessEvent) => void;
    // K5 batch-2 (Agent tool): bill a tool's own model cost onto the parent turn.
    addCostUsd?: (usd: number) => void;
    // Agent v2 (Task 1): attributed per-child cost sink (observability only; no behavior change).
    addChildCost?: (rec: import('../contract/child-cost.js').ChildCostRecord) => void;
    // native-redrive (Agent tool): mark THIS dispatch as a pause-for-human halt so
    // the loop's `results.some(r => r.pausedHalt)` check pauses the PARENT turn. The
    // Agent tool calls ctx.markPausedHalt() when its subagent run paused; we surface
    // it onto the returned ToolDispatchResult.pausedHalt below.
    markPausedHalt?: () => void;
    // Follow-up D (Agent tool): mark THIS dispatch as one that started a helper, or as one
    // the tool refused on its own grounds, so `spawnAdmitted` reaches the root wall on the
    // result. Opt-in exactly as markPausedHalt is: present ⇒ the tool gets OUR closure.
    markSpawnAdmitted?: () => void;
    markSpawnRefused?: () => void;
    // Agent v2 (Task 9): the cooperative budget seam for the Agent tool's
    // children[] fan-out — the run's spend cap + a live cumulative-cost reader.
    // Threaded from the loop's baseExecCtx; absent everywhere else.
    maxBudgetUsd?: number;
    getCumulativeCostUsd?: () => number;
    // K6-P2 B2: the per-run HookDispatcher. When present, PreToolUse / PostToolUse /
    // PostToolUseFailure route through the hook surface (the floor wraps gateTool,
    // so floor-only behavior is byte-identical to the direct path below). Absent →
    // the legacy direct `harness.gateTool` path (back-compat for callers/tests).
    dispatcher?: HookDispatcher;
    // K6-P3-C7: the real task/session id (ctx.taskId from the loop) — stamped on
    // the PERMISSION_DENIED event instead of reading the env. Absent (older
    // callers/tests) → falls back to execCtx.sessionId.
    taskId?: string;
    // Phase 3 (§1.5) — the sandbox filesystem root (e.g. `/app/workspace`), so an
    // oversized tool result can be offloaded to
    // `${workingDir}/.kernel-offload/${taskId}/<toolCallId>.txt`. Absent → offload
    // is skipped entirely (byte-identical to today; e.g. tests / callers that
    // don't thread it, and any run with no real sandbox filesystem).
    workingDir?: string;
    // Phase 3 (§1.5) — env-tunable override for the offload threshold (chars).
    // Absent → context-offload.ts's own conservative default applies.
    offloadThresholdChars?: number;
    // Phase 4 (§1.7) — the running model, so a missing offloadThresholdChars
    // derives a window-fraction default from the model's real contextWindowTokens
    // instead of the fixed floor. Absent → context-offload.ts's fixed-floor fallback.
    model?: string;
    // The run's own session id (`HarnessContext.sessionId`, threaded by the engine
    // call sites; never the process-wide env SESSION_ID). Read by the build*Input
    // helpers + the PERMISSION_DENIED taskId fallback. Absent → ''.
    sessionId?: string;
    // code-exec (Task 6): re-enter the tool pipeline for an in-code tool call from
    // INSIDE another tool (execute_code's bridge). Threaded onto ctx so the running
    // tool can route a nested call through the SAME gate->execute->scan->billing path.
    dispatchInProcessTool?: (toolName: string, input: unknown) => Promise<ToolDispatchResult>;
    // T11b (subagent deep-HITL): RE-ENTRY seed for a re-dispatched `Agent` tool — the
    // paused subagent's scope projection. Threaded onto ctx so the Agent tool seeds
    // `runSubagentLoop` (continue from journaled state, no replay). P3.5b adds
    // `continuePending` (Weave node re-entry: the seed may end mid-round; the loop
    // dispatches the trailing journaled calls verbatim). Absent everywhere else.
    resume?: { seedEntries: import('../contract/journal.js').JournalEntry[]; continuePending?: boolean };
    // P3.3 (durable Weave pause): the one-shot leaf decision for a re-dispatched Weave
    // script (see ToolExecuteContext.weaveResume). P3.5b adds the paused node's
    // identity (nodeSpecHash) + journal scope (scopeId) for the byte-stable re-entry.
    weaveResume?: { contentHash: string; decision: 'allow' | 'deny'; nodeSpecHash?: string; scopeId?: string };
    // Hardening-G: gate the tool-error taxonomy mapping. ON → a tool's `toolError()`
    // sentinel return maps to isError:true + a `[error:<code>]` stamp + PostToolUseFailure.
    // Absent/false (default) → the sentinel is unwrapped to its `.message` string and
    // treated EXACTLY as today (isError:false) — byte-identical. Dark-ship kill switch.
    toolErrorTaxonomy?: boolean;
    // W4-2 (shadow injection screen): awaited AFTER the gate allows and BEFORE
    // execute(), with the effective (post-rewrite) call. The provider owns the
    // whole policy (turn-taint collection, side-effect classification, the server
    // ask); the dispatcher only belts the await (timeout + swallow) so a throwing,
    // rejecting, or hung seam is fail-open by construction. Blocks only a reading
    // the provider stamped `block` (S4). Absent → byte-identical dispatch.
    injectionScreen?: InjectionScreenSeam;
    // L5 (TOOL_PROGRESS_WATCHDOG_V1): this path opts in to the non-progress watchdog
    // (tool-progress-watch.ts). Set by the main loop only; absent, nothing is armed.
    // onToolWatchdog: the host's shipped logger for its verdicts (cfg.onToolWatchdog).
    watchProgress?: boolean;
    onToolWatchdog?: (e: ToolWatchdogEvent) => void;
  },
): Promise<ToolDispatchResult> {
  // Model-agnostic normalization: open models (DeepSeek/GLM via Fireworks) send a
  // nested object/array param as a STRINGIFIED JSON value; Anthropic sends an object.
  // Coerce here — the ONE boundary every native tool call flows through — so every
  // tool's execute() sees the object it declared, regardless of which model produced
  // the call. Object-path callers get the same reference back (byte-identical).
  input = coerceStringifiedToolArgs(input, o.parameters);
  // Story spine: the model-authored `narration` param is display material (the
  // server mints it from the wire event, which carries the RAW block args).
  // Strip it before gating/executing — strict handlers must never see it and
  // no tool behavior may depend on it.
  if (input && typeof input === 'object' && !Array.isArray(input) && NARRATION_PARAM in (input as Record<string, unknown>)) {
    const { [NARRATION_PARAM]: _narration, ...rest } = input as Record<string, unknown>;
    input = rest;
  }
  const call: ToolCall = { toolName: o.name, toolInput: input, toolCallId: toolUseId };
  const dispatcher = execCtx?.dispatcher;
  const signal = execCtx?.signal ?? new AbortController().signal;
  const sessionId = execCtx?.sessionId ?? '';

  // Schema gate (ring 4d): a call that violates the tool's declared params never reaches
  // PreToolUse or execute(). Refused with the exact issues (isError:true) so the model
  // corrects itself next round. A valid call passes the SAME input reference through —
  // byte-identical to today (see tool-arg-validate.ts: validate-only, nulls tolerated).
  const validation = validateToolArgs(input, o.parameters);
  if (!validation.ok) {
    const reason = formatToolArgIssues(o.name, validation.issues);
    if (dispatcher) {
      await dispatcher.dispatch(
        'PostToolUseFailure',
        buildPostToolUseFailureInput(o.name, input, toolUseId, reason, sessionId),
        { toolUseId, signal },
      );
    }
    // Guard-then-stamp, like the sentinel path below: the issue path can carry a
    // model-authored key (z.record), so the text is capped BEFORE the stamp the retry
    // consumer parses is appended — the cap can never truncate it.
    const guarded = guardToolOutput(reason);
    const taxonomy = execCtx?.toolErrorTaxonomy === true;
    return { toolUseId, text: taxonomy ? `${guarded} [error:invalid_input]` : guarded, isError: true, refused: true };
  }

  // ── PreToolUse: the hook chain (the floor first) or the legacy direct gate, folded into
  //    one allow/deny/ask verdict + updatedInput (tool-gate-verdict.ts).
  const gated = await decideToolCall(call, harness, dispatcher, { toolUseId, sessionId, signal });
  if ('halt' in gated) return { toolUseId, text: gated.halt, isError: true, pausedHalt: true };
  // X1 (HOOK_PARITY_V1): refused with `interrupt: true` — a refusal like any other (`refused`:
  // the tool never ran, so it bills nothing), and the turn ends after it as `hook_blocked`
  // (hook-parity.ts hookStopOutcome), never as a pause; no later call in the batch starts.
  if ('stop' in gated) {
    execCtx?.pushEvent?.({ kind: 'raw', engine: 'native', event: PERMISSION_DENIED_EVENT, data: { taskId: execCtx?.taskId ?? sessionId, toolName: o.name, toolUseId, reason: gated.stop } });
    return { toolUseId, text: gated.stop, isError: true, refused: true, hookStop: gated.stop };
  }
  const { decision, denyMessage, pauseKind, effInput, denyReasonType, context: preContext } = gated;

  if (decision === 'deny') {
    const text = denyMessage ?? 'Denied.';
    // K6-P3-C7 — emit PERMISSION_DENIED through the loop-owned push channel (the K3
    // single sink does the actual socket emit; the loop yields it). ADDITIVE: the
    // error tool_result below is unchanged. Native-only — this fires solely on the
    // native gate path (the Claude canUseTool deny path never reaches here). Absent
    // pushEvent → no emit, total; the surviving channel-less callers are the in-code
    // `baseExecCtx` re-entry and bare test dispatches with no execCtx. The SUBAGENT
    // dispatch is no longer one of them: it carries a channel, so a tool denied
    // inside a subagent now surfaces a real deny to the user instead of only
    // reaching the model as an error tool_result. The event is a `raw` HarnessEvent
    // the sink forwards verbatim — on the sub path via onEvent → the Agent tool.
    execCtx?.pushEvent?.({
      kind: 'raw',
      engine: 'native',
      event: PERMISSION_DENIED_EVENT,
      data: {
        // K6-P3-C7 Fix 3: thread the real task id from the loop (ctx.taskId), per
        // this file's doc rule. Fall back to the injected sessionId only for older
        // callers that don't supply taskId.
        taskId: execCtx?.taskId ?? sessionId,
        toolName: o.name,
        toolUseId,
        reason: text,
        ...(denyReasonType !== undefined && { reasonType: denyReasonType }),
      },
    });
    // X1 (HOOK_PARITY_V1): a PreToolUse hook's context rides beside the refusal the model reads.
    const modelText = withHookContext(text, preContext) ?? text;
    // T5: the one error shape (result-shape.ts) on the model's copy; the card keeps the words.
    return { toolUseId, text: execCtx?.toolErrorTaxonomy === true ? stampToolError(modelText, 'permission') : modelText, isError: true, refused: true };
  }

  // `defer` deliberately rides this same ask/onPause path: the floor never
  // emits `defer` (only allow/deny/ask), but B5 callbacks may return it as a
  // soft pause; both ask and defer resolve via onPause → PAUSED_HALT.
  if (decision === 'ask' || decision === 'defer') {
    const halt = await onPause(call, pauseKind ?? '');
    // A HITL pause is a TYPED outcome, not an error: pausedHalt is the signal the
    // loop reads (`results.some(r => r.pausedHalt)`). isError:false so downstream
    // (round-engine fold, trace, web) renders "awaiting", never a red error chip.
    return { toolUseId, text: halt, isError: false, pausedHalt: true };
  }

  // allow — honor updatedInput if the gate/hook rewrote args (inlineToolArgRewrite).

  // native-redrive: a tool (the Agent subagent tool) signals a pause-for-human halt
  // on the PARENT turn by calling ctx.markPausedHalt(). We capture it and stamp
  // pausedHalt onto the returned ToolDispatchResult so the loop pauses the turn.
  let toolMarkedPausedHalt = false;
  // Follow-up D: and the same capture for "this call started a helper" / "this call was
  // refused". A CELL, not a bare `let`: nothing between here and the returns reassigns it,
  // so TS would narrow a plain `let` to its initializer and the conditional spread below
  // would stop type-checking. The closures are the only writers.
  //
  // An admission OUTRANKS a refusal, in either order: one `children[]` call runs several
  // children through one tool_use, so a batch that started three and refused a fourth did
  // start helpers. `??=` on the refusal is what makes the order not matter.
  const spawn: { admitted?: boolean } = {};
  const spawnStamp = (): { spawnAdmitted?: boolean } =>
    (spawn.admitted !== undefined ? { spawnAdmitted: spawn.admitted } : {});

  // Build the execute context. Spread signal/pushEvent only when present so the
  // common path is the bare `{ toolCallId }` object (deep-equal back-compat).
  const ctx: ToolExecuteContext = {
    toolCallId: toolUseId,
    ...(execCtx?.signal !== undefined && { signal: execCtx.signal }),
    ...(execCtx?.pushEvent !== undefined && { pushEvent: execCtx.pushEvent }),
    ...(execCtx?.addCostUsd !== undefined && { addCostUsd: execCtx.addCostUsd }),
    ...(execCtx?.addChildCost !== undefined && { addChildCost: execCtx.addChildCost }),
    // native-redrive: thread markPausedHalt so a subagent pause becomes a real
    // PARENT-turn pause. Spread-only-when the loop OPTED IN (supplied its own
    // markPausedHalt) so every other caller/test keeps the bare back-compat ctx
    // (deep-equal). We substitute OUR capturing closure (not the loop's) so the
    // flag is read onto the ToolDispatchResult.pausedHalt below; the loop's own
    // callback is a no-op sentinel whose only job is to opt this path in.
    ...(execCtx?.markPausedHalt !== undefined && { markPausedHalt: () => { toolMarkedPausedHalt = true; } }),
    // Follow-up D: the spawn markers, threaded the same opt-in way — the caller's own
    // callbacks only signal that this path wants them, and OURS are the ones the tool gets,
    // so the verdict is read onto the result below.
    ...(execCtx?.markSpawnAdmitted !== undefined && { markSpawnAdmitted: () => { spawn.admitted = true; } }),
    ...(execCtx?.markSpawnRefused !== undefined && { markSpawnRefused: () => { spawn.admitted ??= false; } }),
    // Agent v2 (Task 9): forward the budget seam so the Agent tool's children[]
    // fan-out can cooperatively cap spend. Spread-only-when-present keeps every
    // other tool's ctx the bare back-compat shape (deep-equal).
    ...(execCtx?.maxBudgetUsd !== undefined && { maxBudgetUsd: execCtx.maxBudgetUsd }),
    ...(execCtx?.getCumulativeCostUsd !== undefined && { getCumulativeCostUsd: execCtx.getCumulativeCostUsd }),
    // K6-P2 B3b: forward the per-run dispatcher so the Agent subagent tool fires
    // SubagentStart/SubagentStop on the PARENT's hooks. Spread-only-when-present so
    // every other tool's ctx stays the bare back-compat shape (deep-equal).
    ...(execCtx?.dispatcher !== undefined && { dispatcher: execCtx.dispatcher }),
    // code-exec (Task 6): thread the in-process re-entry dispatcher so a tool's
    // execute() can route a nested in-code tool call through the same pipeline.
    // Spread-only-when-present so every other tool's ctx stays the bare shape.
    ...(execCtx?.dispatchInProcessTool !== undefined && { dispatchInProcessTool: execCtx.dispatchInProcessTool }),
    // T11b: thread the subagent RE-ENTRY seed so a re-dispatched Agent tool resumes
    // from journaled state instead of replaying (absent on every other dispatch).
    ...(execCtx?.resume !== undefined && { resume: execCtx.resume }),
    // P3.3: thread the Weave one-shot leaf decision (absent on every other dispatch).
    ...(execCtx?.weaveResume !== undefined && { weaveResume: execCtx.weaveResume }),
  };

  // W4-2 — the SHADOW injection screen. Only calls that will actually execute
  // reach this point (post-gate allow, post-validation), so the seam never
  // screens a denied/paused/refused call. Awaited so the screen verdict lands
  // BEFORE the side effect (the ordering ring 3 enforcement will need); belted
  // so it can never stall or stop a turn.
  //
  // The verdict is KEPT: `screen` is the answer, held at the one point where acting
  // on it is still possible, and stamped on every result below as an observation.
  //
  // RING 3 (S4, ruling 2: block and tell) is the ONE branch below. It acts only on a
  // reading the PROVIDER stamped with `block` (INJECTION_SCREEN_V1=block, which asks
  // the flash screen, never Jev alone: see SCREEN_REASONING_EFFORT in
  // apps/server/src/services/injection-screen.service.ts). It never routes to
  // `onPause`: a refusal is a tool result, not a card, so the Relaxed ruling holds.
  // In shadow no reading carries `block`, so a `clean`, an `instructed`, an
  // `unavailable` and an absent seam all dispatch the same call exactly as before.
  let screen: InjectionScreenReading | undefined;
  if (execCtx?.injectionScreen) {
    screen = await screenBeltedNeverThrow(
      execCtx.injectionScreen,
      { toolName: o.name, toolInput: effInput, toolCallId: toolUseId },
      signal,
    );
  }
  const refused = injectionGuardRefusal(toolUseId, screen);
  // T5: the one error shape (result-shape.ts), as for any refused call.
  if (refused) return execCtx?.toolErrorTaxonomy === true ? { ...refused, text: stampToolError(refused.text, 'permission') } : refused;

  // W4-1 — this dispatch's taint verdict, decided by the TOOL's declaration. Read
  // once per call, after execute (S6: a per-call declaration may answer from what
  // execute learned); the three tool-output returns below (throw, error sentinel,
  // success) fence their text and stamp `taint` from it. The pre-execute paths above
  // (validation refusal, deny, HITL pause) stay untouched: those texts are
  // harness-authored, not third-party bytes.
  // C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1) — this model's tool-result budget in tokens. Undefined
  // while the flag is off: both output returns below keep today's char limits, byte-identical.
  const budgetTokens = activeToolOutputTokenBudget(execCtx?.model);

  // L5 (TOOL_PROGRESS_WATCHDOG_V1): a tool is cut only after a long window with NO
  // progress, never on time (tool-progress-watch.ts). The cut rejects into the SAME catch
  // a thrown tool takes. Off, exempt, or not opted in: undefined, the bare call below.
  const watch = armToolProgressWatchFor(o, execCtx);
  let result: unknown;
  try {
    result = watch ? await watch.run(() => o.execute(effInput, watch.wrap(ctx))) : await o.execute(effInput, ctx);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // L5: a watchdog cut is the HARNESS's words, not the tool's bytes: never fenced, never
    // tainted, never fed to the failure hooks (no directive inside the untrusted fence).
    if (err instanceof NonProgressCut) {
      // T5: the one error shape (result-shape.ts); the stamp is ours too, never the tool's.
      const cut = execCtx?.toolErrorTaxonomy === true ? stampToolError(raw, 'timeout') : raw;
      return { toolUseId, text: cut, isError: true, ...spawnStamp(), ...(screen !== undefined && { screen }) };
    }
    // K6-P2 B2: route the thrown error through the PostToolUseFailure surface (the
    // seam the composio-failure classifier uses in B5). Never-throw + degrade-safe:
    // a missing dispatcher or a throwing/empty hook preserves today's {isError:true}.
    // Hooks see the RAW message (their classifiers parse provider error shapes);
    // only the journaled/model-bound text is fenced.
    const failed = dispatcher
      ? await dispatcher.dispatch(
        'PostToolUseFailure',
        buildPostToolUseFailureInput(o.name, effInput, toolUseId, raw, sessionId),
        { toolUseId, signal },
      )
      : undefined;
    // X1 (HOOK_PARITY_V1): the PreToolUse and PostToolUseFailure hooks' context rides beside
    // the error too ("alongside the error"), after any fence, before any stamp.
    const besideError = (body: string): string => withHookContext(withHookContext(body, preContext), failed?.additionalContext) ?? body;
    // W4-1: a declaring tool's error text can embed third-party bytes (an HTTP
    // error body, a redirect target) — fence + taint it like a success result.
    // Follow-up D (L2): the verdict rides EVERY return, not only the success one — a tool
    // that started a child and then threw did start it.
    // T5: with the taxonomy on, a thrown tool reads exactly like one that returned
    // toolError('exec_failed', message): held to the same cap (an unbounded stack or error
    // body used to ride whole), fenced inside, the code stamped outside at the tail.
    if (execCtx?.toolErrorTaxonomy === true) {
      const untrustedErr = declaresUntrusted(o, effInput);
      const held = budgetTokens === undefined
        ? guardToolOutput(raw)
        : await holdToTokenBudget(raw, budgetTokens, toolUseId, execCtx, untrustedErr);
      return {
        toolUseId,
        text: stampToolError(besideError(untrustedErr ? fenceUntrustedText(held) : held), 'exec_failed'),
        isError: true,
        ...(untrustedErr && { taint: 'external' as const }),
        ...spawnStamp(),
        ...(screen !== undefined && { screen }),
      };
    }
    return declaresUntrusted(o, effInput)
      ? { toolUseId, text: besideError(fenceUntrustedText(raw)), isError: true, taint: 'external', ...spawnStamp(), ...(screen !== undefined && { screen }) }
      : { toolUseId, text: besideError(raw), isError: true, ...spawnStamp(), ...(screen !== undefined && { screen }) };
  } finally {
    watch?.dispose();
  }
  const untrusted = declaresUntrusted(o, effInput);

  // Hardening-G: a tool may return a typed error SENTINEL (never-throw) instead of a
  // plain error string. When the taxonomy flag is ON, map it onto the wire `is_error`
  // channel — mirroring the thrown-error catch above: fire PostToolUseFailure, return
  // isError:true, and stamp the code on the text tail (`[error:<code>]`) so the journal
  // schema stays untouched (tool_result carries isError but no code field). When OFF
  // (default), unwrap it to its `.message` string and fall through to the normal
  // encoding path so it is treated EXACTLY as today (isError:false, byte-identical to a
  // tool that returned that plain string — the current behavior of every tool).
  if (isToolError(result)) {
    const { code, message } = result.__toolError;
    if (execCtx?.toolErrorTaxonomy === true) {
      const failed = dispatcher
        ? await dispatcher.dispatch(
          'PostToolUseFailure',
          buildPostToolUseFailureInput(o.name, effInput, toolUseId, message, sessionId),
          { toolUseId, signal },
        )
        : undefined;
      // P2.2 (charter b) — guard-THEN-stamp: this early return used to skip
      // guardToolOutput entirely, so an oversized/binary sentinel message could
      // balloon the request body (the exact class the guard exists for). Guard
      // the MESSAGE first, then append the stamp, so the cap can never truncate
      // the `[error:<code>]` tail the retry consumer parses (stamp-then-guard
      // would cut it off). Normal-sized messages pass the guard untouched —
      // byte-identical to the pre-charter stamp for every non-pathological case.
      // W4-1: on a declaring tool the fence wraps the MESSAGE only — the stamp
      // stays outside, at the tail, so parseToolErrorCode's anchor still holds.
      // C2: flag on, the message is spilled and held to the budget like a result (a failing
      // build's log is what the model reads back next).
      const held = budgetTokens === undefined
        ? guardToolOutput(message)
        : await holdToTokenBudget(message, budgetTokens, toolUseId, execCtx, untrusted);
      // X1 (HOOK_PARITY_V1): the hooks' context beside the error, inside the stamp's tail.
      const fenced = untrusted ? fenceUntrustedText(held) : held;
      const body = withHookContext(withHookContext(fenced, preContext), failed?.additionalContext) ?? fenced;
      return {
        toolUseId,
        text: `${body} [error:${code}]`,
        isError: true,
        ...spawnStamp(),
        ...(untrusted && { taint: 'external' as const }),
        ...(screen !== undefined && { screen }),
      };
    }
    result = message;
  }

  // Tool-result encoding. The `{ content: [...] }` envelope unwrap is OPT-IN via
  // `o.returnsContentBlocks` — set ONLY by the in-process browser-control tools.
  // Every OTHER tool (Composio MCP, whose raw `server.callTool` result is ALSO
  // `{content:[...]}`-shaped, plus all built-ins) keeps TODAY's exact behavior
  // verbatim: flatten to text, `blocks` undefined, success `isError:false`. This
  // guarantees the live Composio shipping path is byte-identical — this gated
  // browser PR must not touch it.
  let text: string;
  let blocks: ContentBlock[] | undefined;
  let report: unknown;
  let resultIsError = false;
  if (o.returnsContentBlocks === true) {
    // Extract a content-block channel so browser-control screenshots survive
    // instead of being flattened to a base64 string. The envelope's own isError
    // is OR-ed into the success isError below. The S2a action report rides the
    // same opt-in extraction (undefined on every other path).
    const extracted = extractContentBlocks(result);
    text = extracted.text;
    blocks = extracted.blocks;
    report = extracted.report;
    resultIsError = extracted.isError;
  } else {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  }
  // S6: the tool's own note about this result, read off the text it returned; appended
  // after the fence below, never inside it. Undeclared: null, nothing appended.
  let trailer = o.resultTrailer?.(effInput, text) ?? null;

  // native-redrive: the Agent subagent tool paused for human-in-the-loop. Surface
  // pausedHalt so the parent loop's `results.some(r => r.pausedHalt)` check pauses
  // THIS turn (bound to the parent Agent tool_use id — the Agent tool already fired
  // the interaction via its rebound onPause). Return BEFORE the Composio post-scan /
  // PostToolUse rewrite: the tool's text is its own pause summary, not a raw result.
  // isError:false + pausedHalt:true — a pause is a TYPED outcome (matches the
  // top-level `ask`/`defer` branch above), so the paused Agent card renders as
  // AWAITING via the round-engine fold, never a red error chip. (The tool_result is
  // withheld from the journal on pause anyway; this governs the LIVE-yielded
  // tool_result block's render state.)
  // R142: the verdict rides this one too. A child that RAN and then paused for a person is a
  // hand-off that happened, and the root wall must read it as one.
  if (toolMarkedPausedHalt) {
    return { toolUseId, text, isError: false, pausedHalt: true, ...spawnStamp(), ...(screen !== undefined && { screen }) };
  }

  // The ONE composio auth post-scan. A verdict → fire the (deduped) auth-halt
  // and stop the turn. Degrade-safe: a missing/throwing onAuthHalt still halts.
  const verdict = classifyComposioToolResult(o.name, effInput, result);
  if (verdict) {
    if (onAuthHalt) {
      try {
        // K5-T2: bind the auth interaction to the REAL tool_use that paused.
        await onAuthHalt(verdict, { toolUseId, toolName: o.name });
      } catch {
        // SILENT_DEATHS_V1 (L5, #3332 b): the Connect card could not be raised, so a pause
        // here would be a "needs you" with nothing to answer, forever. The tool ends with
        // an explicit error the model reads and tells the person about instead. (onAuthHalt
        // throws only when NO card was raised: a card that is up with a failed journal
        // write resolves, so the turn still pauses on the card the person can see. The
        // failure's detail is logged runner-side, never shown to the model.)
        if (silentDeathsEnabled()) {
          // T5: the one error shape (result-shape.ts): the app is not connected, a permission.
          const failed = authCardFailedText(verdict.toolkit);
          const stamped = execCtx?.toolErrorTaxonomy === true ? stampToolError(failed, 'permission') : failed;
          return { toolUseId, text: stamped, isError: true, ...spawnStamp(), ...(screen !== undefined && { screen }) };
        }
        // OFF: never-throw: a failed substrate write still halts the turn (the model
        // ends here) rather than escaping as a tool error.
      }
    }
    return { toolUseId, text, isError: true, pausedHalt: true, ...spawnStamp(), ...(screen !== undefined && { screen }) };
  }

  // K6-P2 B2: PostToolUse surface — apply any `updatedToolOutput` rewrite BEFORE
  // returning (the seam screenshot-prune wires the APPLY into in B5). Floor-only
  // (no PostToolUse callbacks) → the outcome carries no rewrite → text unchanged.
  if (dispatcher) {
    const post = await dispatcher.dispatch(
      'PostToolUse',
      buildPostToolUseInput(o.name, effInput, toolUseId, result, sessionId),
      { toolUseId, signal },
    );
    text = applyPostToolUseRewrite(text, post);
    // X1 (HOOK_PARITY_V1): a block reason rides beside the result, like the trailer, and then
    // what the PreToolUse and PostToolUse hooks added as context ("alongside the tool result").
    trailer = withPostToolUseFeedback(trailer, post);
    trailer = withHookContext(withHookContext(trailer, preContext), post.additionalContext);
  }

  // Phase 3 (§1.5) FS context-offload — AFTER cost is captured (o.execute() above
  // already fired any addCostUsd/addChildCost billing; offload only ever touches
  // the returned TEXT, never the cost path, so metering is byte-identical by
  // construction). Runs BEFORE guardToolOutput's hard cap so the FULL result is
  // preserved to disk rather than hard-truncated in place — offloading shrinks
  // `text` to a small preview, which then sails through the cap as a no-op.
  // Absent workingDir/taskId (tests, journal-less callers) → no-op, unchanged.
  // C2: flag on, holdToTokenBudget below runs this same offload with the budget added.
  if (budgetTokens === undefined && execCtx?.workingDir && execCtx?.taskId) {
    const offload = await offloadIfOversized({
      text, workingDir: execCtx.workingDir, taskId: execCtx.taskId, toolCallId: toolUseId,
      ...(execCtx.offloadThresholdChars !== undefined && { thresholdChars: execCtx.offloadThresholdChars }),
      ...(execCtx.model !== undefined && { model: execCtx.model }),
      // W4-1: a declaring tool's offloaded FILE stores fenced bytes, so the Read
      // the pointer invites returns marker-carrying content — the fence below
      // only wraps the PREVIEW, and the raw file would bypass both rings for
      // exactly the oversized class. The returned preview is unchanged.
      ...(untrusted && { untrusted: true }),
    });
    text = offload.text;
  }

  // Slice-0 safety net: refuse binary (NUL/magic/mojibake) and cap oversized tool
  // output at the single dispatch boundary, so a `Read`/`cat`/`grep` of a binary
  // file can never balloon the request body or crash the jsonb persist.
  // C2: flag on, the offload (with the budget), this same cap, then the budget in tokens.
  text = budgetTokens === undefined
    ? guardToolOutput(text)
    : await holdToTokenBudget(text, budgetTokens, toolUseId, execCtx, untrusted);

  // W4-1 (taint at the mint) — LAST, after the rewrite/offload/guard pipeline, so
  // the closing marker can never be truncated off (guard-then-fence, the same
  // ordering discipline as guard-then-stamp above). The fence rides the RESULT
  // BYTES — the truncation-marker precedent — so every projection, the subagent
  // loop's in-memory history, and every rebuild reproduce it byte-identically
  // with zero per-transport code. Blocks results (browser images) get leading/
  // trailing marker text blocks; their text items are sanitized identically to
  // the flattened text, so blocksToText(blocks) === the fenced text stays true.
  if (untrusted) {
    text = fenceUntrustedText(text);
    if (blocks !== undefined) blocks = fenceUntrustedBlocks(blocks);
  }
  if (trailer !== null) {
    text = `${text}\n${trailer}`;
    if (blocks !== undefined) blocks = [...blocks, { type: 'text', text: trailer }];
  }

  // A connect Composio could mint no flow for (no managed auth, no auth config of
  // ours) gets the harness's own note, appended AFTER the fence closes: it is our
  // instruction, so it never rides inside the third-party bytes.
  const unavailable = classifyComposioConnectUnavailable(o.name, result);
  if (unavailable) {
    const note = connectUnavailableTrailer(unavailable.toolkits);
    text = `${text}\n${note}`;
    if (blocks !== undefined) blocks = [...blocks, { type: 'text', text: note }];
  }

  // Thread `blocks` ONLY onto the success return, and ONLY when ≥1 valid image was
  // extracted (spread-when-present so a text-only success result is deep-equal to
  // today's `{ toolUseId, text, isError: false }`). The envelope's own isError is
  // OR-ed in (an image-bearing error envelope reports isError:true AND carries blocks).
  // S2a: the lifted action report rides the same spread-when-present rule — a
  // report-less result stays key-for-key identical to today.
  return {
    toolUseId,
    text,
    isError: resultIsError,
    ...(blocks !== undefined && { blocks }),
    ...(report !== undefined && { report }),
    ...spawnStamp(),
    ...(untrusted && { taint: 'external' as const }),
    ...(screen !== undefined && { screen }),
  };
}

/**
 * W4-1 — the block-array form of the untrusted-content fence: a leading OPEN and
 * trailing CLOSE text block around the tool-emitted blocks, with every text item
 * sanitized the same way the flattened string is (the markers contain no newline,
 * so a marker literal can never straddle the '\n' join boundary — sanitizing the
 * parts and sanitizing their join are identical). `blocks` is only ever set for
 * image-bearing results, and BOTH wire paths (the journal projection and the live
 * pushToolResult) render those through toolResultContent's ARRAY form built from
 * these blocks — so the fence the model sees is exactly these marker blocks; the
 * fenced flat `text` is the UI/fallback channel.
 */
function fenceUntrustedBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: UNTRUSTED_CONTENT_OPEN },
    ...blocks.map((b) => (b.type === 'text' ? { ...b, text: sanitizeUntrustedText(b.text) } : b)),
    { type: 'text', text: UNTRUSTED_CONTENT_CLOSE },
  ];
}

/**
 * The image media types an `ImageBlock` may carry (mirrors the `ImageMediaType`
 * union in contract/blocks.ts). An envelope image whose `mimeType` is missing,
 * empty, or outside this allowlist degrades to a `'[image]'` TextBlock placeholder
 * — NEVER an ImageBlock with an undefined/empty mediaType.
 */
const ALLOWED_IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function isAllowedImageMediaType(m: unknown): m is ImageMediaType {
  return typeof m === 'string' && ALLOWED_IMAGE_MEDIA_TYPES.has(m as ImageMediaType);
}

/**
 * Structurally extract a content-block channel from a tool result.
 *
 * The ONLY shape that triggers the block path is the ToolResult envelope
 * `{ content: Array<{type:'text',text} | {type:'image',data,mimeType}>, isError? }`
 * (the exact shape from apps/sandbox/src/mcp/computer-use-tools.ts) carrying ≥1
 * VALID image. Everything else returns `{ text, isError:false }` with `blocks`
 * undefined — byte-identical to the historic
 * `typeof result === 'string' ? result : JSON.stringify(result)`.
 *
 * Mapping rules:
 *  - `type:'text'`  → a `TextBlock`; its text joins the flattened `text`.
 *  - `type:'image'` with an allowlisted `mimeType` → an `ImageBlock` (mimeType →
 *    mediaType). An image whose mimeType is missing/empty/not-allowlisted degrades
 *    to a `'[image]'` TextBlock placeholder.
 *  - `blocks` is set ONLY when ≥1 VALID image item is present; else undefined.
 *  - `text` joins the text-bearing blocks with newlines. If the envelope is
 *    image-ONLY (no text item), `text` is the NON-EMPTY fallback `'[screenshot]'`
 *    so the FE result block is never blank.
 *  - `isError` reflects the envelope's own `isError` (defaults false).
 *  - `report` (S2a) lifts the action report riding the envelope as a SIBLING of
 *    `content`, on BOTH envelope returns (a text-only error envelope still
 *    carries its risk report) — dropped when it fails the structural check.
 */
function extractContentBlocks(result: unknown): {
  text: string;
  isError: boolean;
  blocks?: ContentBlock[];
  report?: unknown;
} {
  if (typeof result === 'string') return { text: result, isError: false };

  const envelope = isToolResultEnvelope(result) ? result : null;
  if (!envelope) {
    return { text: JSON.stringify(result), isError: false };
  }

  // S2a: lift the browser action report (`{ content, isError?, report? }` — the
  // sandbox's computer-use tools attach it as a sibling of content). Junk on the
  // field is DROPPED here, never plumbed — as is a report whose JSON exceeds the
  // hard cap (see fitsActionReportCap). Spread-when-present below keeps every
  // report-less envelope byte-identical to today.
  const rawReport = (envelope as { report?: unknown }).report;
  const report =
    isStructurallyActionReport(rawReport) && fitsActionReportCap(rawReport) ? rawReport : undefined;

  const blocks: ContentBlock[] = [];
  const textParts: string[] = [];
  let hasValidImage = false;

  for (const item of envelope.content) {
    if (isEnvelopeText(item)) {
      blocks.push({ type: 'text', text: item.text });
      textParts.push(item.text);
    } else if (isEnvelopeImage(item)) {
      if (isAllowedImageMediaType(item.mimeType)) {
        blocks.push({ type: 'image', data: item.data, mediaType: item.mimeType });
        hasValidImage = true;
      } else {
        // Degrade an image with a missing/empty/non-allowlisted mimeType to a text
        // placeholder — never an ImageBlock with an undefined/empty mediaType.
        blocks.push({ type: 'text', text: '[image]' });
        textParts.push('[image]');
      }
    }
    // Any other content item shape is ignored (defensive; the envelope guard only
    // admits text/image items today).
  }

  const isError = envelope.isError === true;

  // No valid image → fall back to the byte-identical text path (blocks undefined).
  if (!hasValidImage) {
    return {
      text: textParts.length > 0 ? textParts.join('\n') : JSON.stringify(result),
      isError,
      ...(report !== undefined && { report }),
    };
  }

  // ≥1 valid image. Non-empty text fallback for an image-only envelope.
  const text = textParts.length > 0 ? textParts.join('\n') : '[screenshot]';
  return { text, isError, blocks, ...(report !== undefined && { report }) };
}

/**
 * S2a — minimal structural check for the action report riding the ToolResult
 * envelope. @vestra/agent-sdk deliberately does NOT depend on @bash/shared, so
 * the full `isBrowserActionReport` guard (packages/shared/src/computer-use/
 * action-report.ts) cannot run here — it runs at the sandbox boundary
 * (apps/sandbox imports both packages). This layer verifies only the versioned
 * minimum (a plain record with `v === 1` and a string `tool`) so junk on the
 * field is dropped rather than plumbed.
 */
function isStructurallyActionReport(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { v?: unknown }).v === 1 &&
    typeof (v as { tool?: unknown }).tool === 'string'
  );
}

/**
 * Hard cap on the lifted report's stringified JSON — the report-shaped sibling
 * of guardToolOutput's text cap at this same dispatch boundary. The report
 * persists verbatim to the append-only journal and survives compaction, so an
 * oversized one (an honest mint is ~hundreds of bytes; the sandbox builder
 * additionally bounds every page-controlled field) is DROPPED whole rather
 * than truncated — a partially-mangled structured report is worse than an
 * absent one. Defense in depth: holds regardless of mint bugs.
 */
const ACTION_REPORT_MAX_JSON_CHARS = 16_384;

function fitsActionReportCap(report: unknown): boolean {
  try {
    return JSON.stringify(report).length <= ACTION_REPORT_MAX_JSON_CHARS;
  } catch {
    // Unserializable (e.g. circular) — could never persist to the journal; drop.
    return false;
  }
}

type EnvelopeTextItem = { type: 'text'; text: string };
type EnvelopeImageItem = { type: 'image'; data: string; mimeType?: unknown };

function isEnvelopeText(item: unknown): item is EnvelopeTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'text' &&
    typeof (item as { text?: unknown }).text === 'string'
  );
}

function isEnvelopeImage(item: unknown): item is EnvelopeImageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'image' &&
    typeof (item as { data?: unknown }).data === 'string'
  );
}

/** Structurally detect the `{ content: [...] }` ToolResult envelope. */
function isToolResultEnvelope(
  result: unknown,
): result is { content: unknown[]; isError?: boolean } {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  );
}

/**
 * Apply a PostToolUse outcome's `updatedToolOutput` to the tool-result text. The
 * dispatcher folds the rewrite (last-writer-wins) onto the continue outcome; we
 * stringify a non-string rewrite the same way the raw result is stringified.
 */
function applyPostToolUseRewrite(text: string, outcome: HookOutcome): string {
  if (outcome.decision !== 'continue' || outcome.updatedToolOutput === undefined) return text;
  const rewritten = outcome.updatedToolOutput;
  return typeof rewritten === 'string' ? rewritten : JSON.stringify(rewritten);
}

/** Build the PostToolUse hook input (carries the tool response for rewrite hooks). */
function buildPostToolUseInput(
  toolName: string,
  toolInput: unknown,
  toolUseId: string,
  toolResponse: unknown,
  sessionId: string,
): PostToolUseHookInput {
  return {
    session_id: sessionId,
    cwd: process.cwd(),
    transcript_path: '',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
  };
}

/** Build the PostToolUseFailure hook input (carries the thrown error message). */
function buildPostToolUseFailureInput(
  toolName: string,
  toolInput: unknown,
  toolUseId: string,
  error: string,
  sessionId: string,
): PostToolUseFailureHookInput {
  return {
    session_id: sessionId,
    cwd: process.cwd(),
    transcript_path: '',
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    error,
  };
}

/**
 * W4-2 — the dispatcher's belt around one shadow-screen call. The provider owns
 * its real request timeout; this ceiling only guarantees a hung provider can
 * never stall a turn. Never throws: a sync throw, an async rejection, and a hang
 * all resolve to "proceed" (fail-open — a screener that can block a turn is a
 * worse bug than the injection it observes). The late settle of a hung/rejected
 * seam is absorbed by the pre-attached catch (no unhandled rejection).
 *
 * ANSWERS with what it read, and the three no-verdict cases are three different
 * answers rather than one silence:
 *   - the seam answered            → its reading, verbatim.
 *   - the seam threw / rejected    → `undefined`. The provider is contractually
 *     never-throw and accounts for its own faults; a throw is a provider bug,
 *     and inventing a fault code for it here would put a stage in the channel
 *     that no writer owns.
 *   - the belt fired               → `BELT_TIMEOUT_READING`. A screen was wanted
 *     and never answered; that is `unavailable`, never "no screen".
 *   - the round was stopped        → `undefined`. A stop is not a fault, which
 *     is the same rule the seam's own accounting already follows.
 */
async function screenBeltedNeverThrow(
  seam: InjectionScreenSeam,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<InjectionScreenReading | undefined> {
  // A cancelled round has nothing to screen: the step is not going to run, so a
  // verdict about it would bill and banner something the user already stopped.
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Which branch won. Only the TIMER branch is a fault: a settled seam accounts
  // for itself, and an aborted round is a stop, not a failure.
  let belted = false;
  // Written by the seam's own settle, so a LATE settle (after the belt or the
  // abort already released us) writes to a local nobody reads again — the same
  // absorb-and-drop the pre-attached catch does for a late rejection.
  let reading: InjectionScreenReading | undefined;
  try {
    const screened = Promise.resolve(seam.maybeScreen(call, signal)).then(
      (r) => {
        if (r) reading = r;
      },
      () => {},
    );
    await Promise.race([
      screened,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          belted = true;
          resolve();
        }, INJECTION_SCREEN_BELT_TIMEOUT_MS);
      }),
      // Race the abort as well as pass it down: a provider that ignores the
      // signal still cannot hold a cancelled turn open to the full belt.
      new Promise<void>((resolve) => {
        if (!signal) return;
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch {
    // A synchronous maybeScreen throw lands here; the tool proceeds.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
  if (belted) {
    // Belted here, never inside `finally`: the report is the only thing in this
    // function that is allowed to be about the screen rather than about the tool,
    // and a counter that can break a dispatch is worse than an uncounted fault.
    try {
      seam.onBeltTimeout?.(call);
    } catch {
      /* the tool proceeds */
    }
    return BELT_TIMEOUT_READING;
  }
  return reading;
}

/**
 * Back-compat alias kept during the K3-T5 transition. `dispatchTool` was the
 * pre-T5 name; `gateAndDispatchTool` makes the gate+dispatch ownership explicit.
 */
export const dispatchTool = gateAndDispatchTool;

/**
 * SILENT_DEATHS_V1 (L5, #3332 b) — the tool result the model reads when a Composio auth
 * verdict could not become a Connect card. Names the app, the page the person connects it on
 * (the Apps page, headed Connectors) and what to do next, and tells the model not to retry
 * in this reply. No technical detail: that is logged runner-side (buildOnAuthHalt).
 */
export function authCardFailedText(toolkit: string): string {
  return (
    `${toolkit} is not connected yet, and the connect card could not be shown right now. ` +
    `Stop here and ask the user to connect ${toolkit} on the Apps page (Connectors), then send their request again. ` +
    'Do not call this tool again in this reply.'
  );
}
