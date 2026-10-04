/**
 * abort-drain.ts — P3 (PR-3): the bounded drain for in-flight tool dispatches.
 *
 * When ctx.signal aborts while a tool dispatch is in flight, the engine must NOT
 * wait unboundedly for the tool to settle (a signal-ignoring tool would hang the
 * whole turn — the exact hole assertInterruptObserved pins). The Weave-2b drain
 * pattern (weave-tool.ts WEAVE_DRAIN_TIMEOUT_MS: race the settle against an
 * unref'd timer) graduates here to the contract loop: after an abort, the dispatch
 * gets `drainTimeoutMs` to settle on its own; on expiry the caller seals a
 * truthful synthetic tool_result and finalizes user_aborted.
 *
 * Hot-path discipline: with no signal the promise is returned UNTOUCHED, and with
 * a signal that never aborts NO timer is ever created (one abort listener only,
 * removed on settle) — the un-aborted path stays byte-identical, which the
 * happy-path conformance test asserts via vi.getTimerCount().
 */

/** Default upper bound (ms) on waiting for an in-flight tool after an abort. */
export const DRAIN_DEFAULT_MS = 5_000;

/** The sentinel raceAbortDrain resolves with when the grace window expires. */
export interface DrainExpired {
  drainExpired: true;
  /** Wall-clock ms from the abort to the expiry (≈ the grace bound). */
  elapsedMs: number;
}

export function isDrainExpired(v: unknown): v is DrainExpired {
  return typeof v === 'object' && v !== null && (v as { drainExpired?: unknown }).drainExpired === true;
}

/**
 * Await `promise`, bounded by `signal` + `drainTimeoutMs`:
 *  - no signal → the promise itself (plain await, zero overhead);
 *  - signal never aborts → the promise's own settle (zero timers created);
 *  - signal aborts (before or during the await) → the promise races an unref'd
 *    grace timer started AT the abort; settle-within-grace wins (the normal
 *    result flows), expiry resolves the { drainExpired } sentinel — the caller
 *    seals and finalizes; the abandoned dispatch's late settle is discarded
 *    (its rejection, if any, is absorbed by the wrapper's handlers).
 */
export function raceAbortDrain<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  drainTimeoutMs: number,
): Promise<T | DrainExpired> {
  if (signal === undefined) return promise;
  return new Promise<T | DrainExpired>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      if (settled || timer !== undefined) return;
      const abortedAt = Date.now();
      timer = setTimeout(
        () => settle(() => resolve({ drainExpired: true, elapsedMs: Date.now() - abortedAt })),
        drainTimeoutMs,
      );
      // Never hold the process open for a wedged tool (the weave-tool pattern).
      timer.unref?.();
    };
    promise.then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
