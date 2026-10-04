/**
 * stream-stall-guard — turn SILENCE into an ERROR, at every depth.
 *
 * WHY THIS EXISTS (prod task 381d8797, 2026-08-24). A `researcher` subagent at
 * nesting depth 2 completed a WebSearch tool_result cleanly at 08:14:53 and then
 * its next model call never yielded another event. Nothing threw. Nothing
 * aborted. The parent waited on the child, the root waited on the parent, and
 * the whole stack sat silent for **46 minutes** until a server-side stall
 * detector killed the top-level turn. The user got nothing; the turn billed
 * $0.21 for zero output tokens.
 *
 * THE POINT, and it is worth stating precisely. This harness propagates ERRORS
 * extremely well — `agent-tool.ts` catches, maps status to error/interrupted,
 * fires SubagentStop on every exit path, stamps `isError` + `[error:unavailable]`
 * so a parent sees a real tool failure. Every one of those mechanisms is
 * triggered by something HAPPENING. A provider stream that simply stops yielding
 * makes nothing happen, so none of it runs. Errors propagate; silence does not —
 * and silence gets MORE invisible the deeper the stack, which is exactly backwards
 * for a harness whose value is depth.
 *
 * So the cure is not another propagation path. It is to make silence an event.
 * One idle deadline on the round stream converts a hung provider into an ordinary
 * throw, and the propagation machinery that already exists carries it up all
 * seven layers unchanged.
 *
 * WHY HERE. Every nesting depth runs the same native loop, and every round of
 * that loop reads its provider events through `driveRoundStream`. Guarding this
 * one seam covers depth 0 through MAX_SUBAGENT_DEPTH, every transport and every
 * arm, without touching a single call site per depth.
 *
 * WHAT IT IS NOT. This is an IDLE bound, not a total-duration budget: a long,
 * healthy generation that keeps emitting is never interrupted, however long it
 * runs. Only a stream that goes quiet for the whole window trips it.
 */

import type { StreamEvent } from './transport.js';

/** Default idle window. Deliberately generous: a reasoning model can think for a
 *  long time before its first token, and a false stall is worse than a slow turn.
 *  The incident it exists to bound ran 46 MINUTES, so even this converts a hang
 *  into a typed failure ~15x sooner while leaving a wide margin over real TTFT. */
export const DEFAULT_STREAM_STALL_MS = 180_000;

/** Resolve the idle window. `0` (or a negative/garbage value) disables the guard
 *  entirely, which is the byte-identical pre-guard behaviour. */
export function streamStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STREAM_STALL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_STREAM_STALL_MS;
}

/**
 * A provider stream that stopped yielding. Carries the idle window and the last
 * event kind seen, because "stalled after `tool_use`" and "stalled before the
 * first token" are different failures and the message is the only place a human
 * will read the difference.
 */
export class StreamStalledError extends Error {
  readonly code = 'stream_stalled';
  constructor(
    readonly idleMs: number,
    readonly lastEventKind: string | null,
    readonly eventsSeen: number,
  ) {
    super(
      `provider stream produced no event for ${Math.round(idleMs / 1000)}s ` +
        `(${eventsSeen} event(s) seen, last kind: ${lastEventKind ?? 'none — stalled before the first event'})`,
    );
    this.name = 'StreamStalledError';
  }
}

/**
 * Wrap a stream so that going quiet for `stallMs` throws instead of hanging.
 *
 * On a stall the upstream iterator is CLOSED via `return()` before the throw —
 * the pending `next()` is abandoned, and without that the provider socket would
 * leak for as long as the process lived. Best-effort: a `return()` that itself
 * throws must not replace the stall error, which is the one the caller needs.
 */
export async function* withStallGuard(
  stream: AsyncIterable<StreamEvent>,
  opts: {
    stallMs?: number;
    onStall?: (err: StreamStalledError) => void;
    /**
     * 2.13b (agent-runtime.md finding 6) — a thaw subscription. Blaxel freezes the
     * whole container; a wall-clock idle timer that ran out DURING the freeze fires
     * the moment the process thaws and calls a stream that was merely frozen "dead"
     * — and one that had not run out is then that much shorter, so a stream that
     * really died in the freeze is detected late, not promptly. On thaw the pending
     * window is RE-ARMED for its full length from thaw. Absent ⇒ unchanged.
     */
    onThaw?: (cb: () => void) => () => void;
  } = {},
): AsyncIterable<StreamEvent> {
  const stallMs = opts.stallMs ?? streamStallMs();
  if (stallMs <= 0) {
    yield* stream;
    return;
  }

  const it = stream[Symbol.asyncIterator]();
  let lastKind: string | null = null;
  let seen = 0;
  // The window currently armed for the pending next(): re-armed in place on a thaw.
  let armed: { timer: ReturnType<typeof setTimeout>; reject: (err: StreamStalledError) => void } | undefined;
  const arm = (reject: (err: StreamStalledError) => void): void => {
    const timer = setTimeout(() => reject(new StreamStalledError(stallMs, lastKind, seen)), stallMs);
    timer.unref?.();
    armed = { timer, reject };
  };
  const unsubThaw = opts.onThaw?.(() => {
    if (!armed) return;
    clearTimeout(armed.timer);
    arm(armed.reject); // the full window again, counted from thaw
  });

  try {
  for (;;) {
    let res: IteratorResult<StreamEvent>;
    try {
      res = await Promise.race([
        it.next(),
        new Promise<never>((_resolve, reject) => { arm(reject); }),
      ]);
    } catch (err) {
      if (err instanceof StreamStalledError) {
        // Close the upstream WITHOUT awaiting it. A real `async function*` that is
        // suspended on a never-settling await can never process `return()` — the
        // call queues behind the very promise that hung — so awaiting here would
        // hang the guard exactly like the stall it is recovering from. (My own
        // first version did await it, and the first test to use a genuine async
        // generator rather than a hand-rolled iterator timed out.) Fire and forget:
        // the close is best-effort cleanup, never a thing to block on.
        try {
          void Promise.resolve(it.return?.(undefined as never)).catch(() => {});
        } catch {
          /* a synchronous throw from return() is not the error worth reporting */
        }
        opts.onStall?.(err);
      }
      throw err;
    } finally {
      if (armed) clearTimeout(armed.timer);
      armed = undefined;
    }

    if (res.done) return;
    seen += 1;
    lastKind = res.value.kind;
    yield res.value;
  }
  } finally {
    unsubThaw?.();
  }
}
