/**
 * The engine's clock for DURATIONS: milliseconds from a monotonic source, never the wall clock.
 * A wall-clock difference can go negative or huge across an NTP step or a VM restored after
 * hibernate; this cannot. Only differences mean anything (the origin is the process's start), so
 * never compare a reading with Date.now() or send one as a timestamp. One module so a test can
 * drive it (vi.mock this file) without touching the timers its harness runs on.
 */
export function monotonicMs(): number {
  return performance.now();
}
