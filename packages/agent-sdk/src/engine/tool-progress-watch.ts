/**
 * tool-progress-watch.ts — a tool is cut only on PROVEN non-progress, never on time
 * (harness to nine L5, the redo of #3333; TOOL_PROGRESS_WATCHDOG_V1).
 *
 * #3333 put a 600 s wall on every tool. That would have cut a foreground Agent, a Weave or
 * a long build that was still working, which the founder law forbids (22 Sep: a task that
 * is working is never stopped; #3775). This rebuilds the deadline on the one thing that
 * proves a call is stuck: a long window in which it did NOTHING observable.
 *
 * PROGRESS, per tool family (any one of these resets the clock):
 *  · Any tool: an event it pushes (`ctx.pushEvent`), a billed child round
 *    (`ctx.addCostUsd` / `ctx.addChildCost`), an explicit heartbeat (`ctx.noteProgress`).
 *  · Bash (foreground): every stdout/stderr chunk. It is also self-bounded at its 600 s
 *    cap, under the window, so a quiet `sleep 600` or a silent build is ended by Bash's own
 *    declared timeout as before and never by this rail: a live shell is never cut here.
 *  · Foreground Agent and Weave: every event the child pushes up (start, text, tool start
 *    and result, end, billing) and every billed child round. A child still running rounds
 *    is progress; a child silent for the whole window is not.
 *  · execute_code: each in-code tool call, at its start and its end. While one is in
 *    flight the clock is HELD, because that nested call has a watch of its own: the cut
 *    lands on the call that is actually stuck, never on its parent.
 *  · MCP and network tools: response bytes. They read the body whole, so a request with
 *    no answer for the whole window is non-progress; the signal the dispatcher hands the
 *    fetch is what makes the cut actually end it.
 *  · A tool may declare `progressExempt` (Monitor) and is never armed.
 *
 * THE CUT ('true' only): the tool's OWN scope (derived from the round signal, so Stop
 * still reaches it) aborts with the named reason `non_progress` (turn-budget.ts
 * abortReason), and the dispatch settles at once with a plain error result the model
 * reads. The tool's late settle is left unobserved, never awaited. The round and the
 * turn are untouched: the loop reads that one sealed result and goes on.
 * SHADOW logs the would-cut line and cuts nothing. OFF arms nothing.
 *
 * THE LINE: each verdict goes to the host's shipped logger (`cfg.onToolWatchdog`, wired by
 * the sandbox to log_events under the task), so the shadow week can be read off the box.
 * Only with no seam wired (tests, standalone engine) does it fall back to the console.
 *
 * Per-call state only: one watch per dispatch, no module-level state (one runner
 * process serves many sessions).
 *
 * KNOWN EDGES (review of #4091; accepted for the shadow week, follow-ups named):
 *  · A cut foreground Agent: its child sees the aborted scope and ends, but its late
 *    SUBAGENT_END is pushed after the dispatch settled, onto the round's PushQueue that is
 *    already closed (push-queue.ts ignores a push after close). The lane can then look
 *    unfinished in the pane. Follow-up: seal the lane from the cut itself.
 *  · present_output in dial mode PUTs up to 50 MB with no progress until it answers
 *    (output-mcp.ts). Twenty minutes for 50 MB is under 42 KB/s, a link that is stalled in
 *    all but name; the cut ends the PUT through its signal and the model can present again.
 *  · os_wait (os-hands-tools.ts) is not on the native arm; cap it or exempt it if it is
 *    ever registered there.
 */
import type { ToolExecuteContext } from '../tools/tool-types.js';
import { toolProgressWatchdogMode } from '../policy/feature-flags.js';
import { abortReason, deriveAbortScope } from './turn-budget.js';

/** The window: 20 minutes with no progress at all. Above every self-bounded tool cap. */
export const TOOL_PROGRESS_WINDOW_MS = 20 * 60_000;
/** The named abort reason of the cut (turn-budget.ts convention). */
export const NON_PROGRESS = 'non_progress';

/** The text the model reads for a cut tool. Plain words: no dashes, no product names. */
export function nonProgressText(toolName: string, minutes: number): string {
  return `${toolName} stopped: no progress for ${minutes} minutes (no output and no events), so it was cut. ` +
    'The task goes on. Try another way, or run long work in the background.';
}

/**
 * The rejection a cut settles the dispatch with. Its own class, so the dispatcher can tell
 * the harness's words from a tool's thrown error by identity (never by the message): a cut
 * of an untrusted-content tool is NOT third-party bytes, so it is never fenced, never
 * tainted and never fed to the failure hooks.
 */
export class NonProgressCut extends Error {
  constructor(toolName: string, minutes: number) {
    super(nonProgressText(toolName, minutes));
    this.name = 'NonProgressCut';
  }
}

/** One watchdog verdict: what the host's shipped logger receives (`cfg.onToolWatchdog`). */
export interface ToolWatchdogEvent {
  verdict: 'cut' | 'would-cut';
  toolName: string;
  minutes: number;
  taskId?: string;
}

/** The one line a verdict reads as, on the console or in log_events. */
export function toolWatchdogLine(e: ToolWatchdogEvent): string {
  return `[tool-watchdog] ${e.verdict} ${e.toolName} after ${e.minutes} min without progress task=${e.taskId ?? '-'}`;
}

export interface ToolProgressWatch {
  /** The tool's own signal: aborts on the round's abort (its reason) or on the cut. */
  readonly signal: AbortSignal;
  /** The tool's ctx with every progress channel wrapped and the watch's signal. */
  wrap(ctx: ToolExecuteContext): ToolExecuteContext;
  /** Run `execute` under the watch: rejects with the sealed text when cut. */
  run<T>(execute: () => Promise<T> | T): Promise<T>;
  /** Stop the clock and unlink from the round signal. Idempotent. */
  dispose(): void;
}

export interface ToolProgressWatchOptions {
  toolName: string;
  mode: 'shadow' | 'on';
  /** The round signal the tool would otherwise get. */
  parent?: AbortSignal;
  taskId?: string;
  windowMs?: number;
  /** The host's shipped logger. Wired: it alone receives each verdict (no console line). */
  report?: (e: ToolWatchdogEvent) => void;
  /** The fallback line sink when no `report` is wired (console.warn). */
  log?: (line: string) => void;
}

export function armToolProgressWatch(o: ToolProgressWatchOptions): ToolProgressWatch {
  const windowMs = o.windowMs ?? TOOL_PROGRESS_WINDOW_MS;
  const log = o.log ?? ((line: string) => console.warn(line));
  const report = o.report ?? ((e: ToolWatchdogEvent) => log(toolWatchdogLine(e)));
  const scope = o.parent ? deriveAbortScope(o.parent) : { controller: new AbortController(), release: () => {} };
  let last = Date.now();
  let held = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cut: ((err: Error) => void) | undefined;

  const note = (): void => { last = Date.now(); };
  const schedule = (ms: number): void => {
    timer = setTimeout(check, Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
  };
  function check(): void {
    timer = undefined;
    if (disposed || scope.controller.signal.aborted) return;
    const idle = Date.now() - last;
    if (held > 0) return schedule(windowMs);
    if (idle < windowMs) return schedule(windowMs - idle);
    const minutes = Math.round(idle / 60_000);
    report({ verdict: o.mode === 'on' ? 'cut' : 'would-cut', toolName: o.toolName, minutes, ...(o.taskId !== undefined && { taskId: o.taskId }) });
    if (o.mode === 'shadow') return schedule(windowMs);
    scope.controller.abort(abortReason(NON_PROGRESS));
    cut?.(new NonProgressCut(o.toolName, minutes));
  }

  return {
    signal: scope.controller.signal,
    wrap(ctx: ToolExecuteContext): ToolExecuteContext {
      const w: ToolExecuteContext = { ...ctx, signal: scope.controller.signal, noteProgress: note };
      const { pushEvent, addCostUsd, addChildCost, dispatchInProcessTool } = ctx;
      if (pushEvent) w.pushEvent = (ev) => { note(); pushEvent(ev); };
      if (addCostUsd) w.addCostUsd = (usd) => { note(); addCostUsd(usd); };
      if (addChildCost) w.addChildCost = (rec) => { note(); addChildCost(rec); };
      if (dispatchInProcessTool) {
        w.dispatchInProcessTool = async (name, input) => {
          held += 1;
          note();
          try { return await dispatchInProcessTool(name, input); } finally { held -= 1; note(); }
        };
      }
      return w;
    },
    run<T>(execute: () => Promise<T> | T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        cut = reject;
        schedule(windowMs);
        Promise.resolve().then(execute).then(resolve, reject);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      scope.release();
    },
  };
}

/**
 * The dispatcher's one call: a watch for this dispatch, or undefined (nothing armed,
 * byte-identical) when the caller did not opt in, the tool is exempt, or the flag is off.
 * Only the main loop opts in (buildToolExecCtx); a subagent's own dispatches do not,
 * because the Agent call above them is the watched unit.
 */
export function armToolProgressWatchFor(
  o: { name: string; progressExempt?: boolean },
  execCtx: { watchProgress?: boolean; signal?: AbortSignal; taskId?: string; onToolWatchdog?: (e: ToolWatchdogEvent) => void } | undefined,
): ToolProgressWatch | undefined {
  if (execCtx?.watchProgress !== true || o.progressExempt === true) return undefined;
  const mode = toolProgressWatchdogMode();
  if (mode === 'off') return undefined;
  return armToolProgressWatch({
    toolName: o.name,
    mode,
    ...(execCtx.signal !== undefined && { parent: execCtx.signal }),
    ...(execCtx.taskId !== undefined && { taskId: execCtx.taskId }),
    ...(execCtx.onToolWatchdog !== undefined && { report: execCtx.onToolWatchdog }),
  });
}
