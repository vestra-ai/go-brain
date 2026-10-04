/**
 * Runaway watchdog (bounded-progress guard) — unit tests for the counter core.
 *
 * Incident class (2026-08-20 Researcher livelock): a subagent spun WebSearch
 * ~5x/sec for 45+ minutes against a billing-dead vendor — every call identical,
 * every result an error — and the parent had zero visibility until maxTurns.
 * The watchdog trips on OBSERVED behavior (consecutive identical failures /
 * consecutive failures of any shape), never on wall-clock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSubagentRunawayWatchdog,
  createParentRunawayWatchdog,
  SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
  SUBAGENT_RUNAWAY_FAILURE_LIMIT,
} from '../subagent-watchdog.js';

const make = (limits?: { identicalFailureLimit?: number; consecutiveFailureLimit?: number }) =>
  createSubagentRunawayWatchdog({ childId: 'child-1', model: 'm', ...limits });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSubagentRunawayWatchdog — identical-call ceiling', () => {
  it('trips after N identical consecutive failures (default limit), exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make();
    let trip = null;
    for (let i = 0; i < SUBAGENT_RUNAWAY_IDENTICAL_LIMIT - 1; i++) {
      trip = wd.observe('web_probe', { q: 'x' }, true);
      expect(trip).toBeNull();
      expect(wd.tripped).toBe(false);
    }
    trip = wd.observe('web_probe', { q: 'x' }, true);
    expect(trip).toEqual({
      reason: 'identical_failures',
      toolName: 'web_probe',
      consecutiveIdenticalFailures: SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
      consecutiveFailures: SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
    });
    expect(wd.tripped).toBe(true);
    // Latched: further observations never re-trip and never re-warn.
    expect(wd.observe('web_probe', { q: 'x' }, true)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('normalizes args: object key order does not defeat identity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 4 });
    expect(wd.observe('t', { a: 1, b: { c: 2, d: 3 } }, true)).toBeNull();
    expect(wd.observe('t', { b: { d: 3, c: 2 }, a: 1 }, true)).toBeNull();
    expect(wd.observe('t', { a: 1, b: { c: 2, d: 3 } }, true)).toBeNull();
    const trip = wd.observe('t', { b: { c: 2, d: 3 }, a: 1 }, true);
    expect(trip?.reason).toBe('identical_failures');
  });

  it('a different-args failure resets the identical window (but not the total budget)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 3, consecutiveFailureLimit: 100 });
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t', { q: 'b' }, true)).toBeNull(); // window resets to 1
    expect(wd.observe('t', { q: 'b' }, true)).toBeNull();
    const trip = wd.observe('t', { q: 'b' }, true);
    expect(trip?.reason).toBe('identical_failures');
    expect(trip?.consecutiveFailures).toBe(5);
  });

  it('a different TOOL with the same args also resets the identical window', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 3, consecutiveFailureLimit: 100 });
    expect(wd.observe('t1', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t1', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t2', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t2', { q: 'a' }, true)).toBeNull();
    expect(wd.tripped).toBe(false);
  });
});

describe('createSubagentRunawayWatchdog — consecutive-failure budget', () => {
  it('trips after M consecutive failures regardless of identity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 1000 });
    let trip = null;
    for (let i = 0; i < SUBAGENT_RUNAWAY_FAILURE_LIMIT - 1; i++) {
      trip = wd.observe('t', { q: `distinct-${i}` }, true);
      expect(trip).toBeNull();
    }
    trip = wd.observe('t', { q: 'last' }, true);
    expect(trip?.reason).toBe('consecutive_failures');
    expect(trip?.consecutiveFailures).toBe(SUBAGENT_RUNAWAY_FAILURE_LIMIT);
  });

  it('any success resets BOTH counters', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 3, consecutiveFailureLimit: 5 });
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t', { q: 'ok' }, false)).toBeNull(); // success resets
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.observe('t', { q: 'a' }, true)).toBeNull();
    expect(wd.tripped).toBe(false);
  });

  it('identical SUCCESSFUL results never trip (polling a status tool is legitimate)', () => {
    // DECISION (pinned): repeated identical successes are NOT progress-free to the
    // guard — the loop has no progress signal for successful results, polling is a
    // legitimate pattern, and maxTurns already bounds the run. Only FAILURES count.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = make({ identicalFailureLimit: 2, consecutiveFailureLimit: 3 });
    for (let i = 0; i < 50; i++) {
      expect(wd.observe('poll_status', { job: 'j1' }, false)).toBeNull();
    }
    expect(wd.tripped).toBe(false);
  });
});

describe('createSubagentRunawayWatchdog — instance isolation and logging', () => {
  it('two instances never share counters', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = make({ identicalFailureLimit: 4 });
    const b = make({ identicalFailureLimit: 4 });
    for (let i = 0; i < 3; i++) expect(a.observe('t', { q: 'x' }, true)).toBeNull();
    // b saw nothing — its first observation starts from zero.
    expect(b.observe('t', { q: 'x' }, true)).toBeNull();
    expect(b.tripped).toBe(false);
    expect(a.observe('t', { q: 'x' }, true)).not.toBeNull();
    expect(b.tripped).toBe(false);
  });

  it('emits ONE structured WARN at trip carrying id, tool, and counts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = createSubagentRunawayWatchdog({
      childId: 'child-42',
      model: 'model-z',
      identicalFailureLimit: 2,
    });
    wd.observe('web_probe', { q: 'x' }, true);
    wd.observe('web_probe', { q: 'x' }, true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('runaway');
    expect(line).toContain('reason=identical_failures');
    expect(line).toContain('tool=web_probe');
    expect(line).toContain('consecutiveIdenticalFailures=2');
    expect(line).toContain('childId=child-42');
    expect(line).toContain('model=model-z');
  });
});

describe('createParentRunawayWatchdog — the W3-3 parent-loop factory (shared core)', () => {
  it('shares the counting core: default limits, latch-once trip, success reset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = createParentRunawayWatchdog({ taskId: 'task-7', model: 'm' });
    for (let i = 0; i < SUBAGENT_RUNAWAY_IDENTICAL_LIMIT - 1; i++) {
      expect(wd.observe('web_probe', { q: 'x' }, true)).toBeNull();
    }
    // A success resets both windows — the same rule as the subagent guard.
    expect(wd.observe('web_probe', { q: 'x' }, false)).toBeNull();
    for (let i = 0; i < SUBAGENT_RUNAWAY_IDENTICAL_LIMIT - 1; i++) {
      expect(wd.observe('web_probe', { q: 'x' }, true)).toBeNull();
    }
    const trip = wd.observe('web_probe', { q: 'x' }, true);
    expect(trip?.reason).toBe('identical_failures');
    expect(wd.tripped).toBe(true);
    // Latched — never re-trips, never re-warns.
    expect(wd.observe('web_probe', { q: 'x' }, true)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('emits ONE structured WARN at trip on the parent line, carrying taskId', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wd = createParentRunawayWatchdog({ taskId: 'task-42', model: 'model-z', identicalFailureLimit: 2 });
    wd.observe('web_probe', { q: 'x' }, true);
    wd.observe('web_probe', { q: 'x' }, true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('[NativeHarness][runaway-watchdog]');
    expect(line).toContain('reason=identical_failures');
    expect(line).toContain('tool=web_probe');
    expect(line).toContain('taskId=task-42');
    expect(line).toContain('model=model-z');
  });
});
