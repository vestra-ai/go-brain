import { describe, expect, it } from 'vitest';
import { createDebouncer, type Timers } from '../schedule.js';

function manualTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => { const id = next++; due.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { due.delete(h as number); },
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { due.delete(id); t.fn(); }
      }
    },
  };
}

describe('createDebouncer', () => {
  it('runs once after the trip goes quiet', () => {
    const t = manualTimers();
    const d = createDebouncer(t.timers, t.now);
    let runs = 0;
    d.after('notes:t1', 20_000, () => { runs += 1; });
    t.advance(10_000);
    d.after('notes:t1', 20_000, () => { runs += 1; });
    t.advance(15_000);
    expect(runs).toBe(0);
    t.advance(5_000);
    expect(runs).toBe(1);
    expect(d.pending('notes:t1')).toBe(false);
  });

  it('never waits longer than the longest wait in a busy chat', () => {
    const t = manualTimers();
    const d = createDebouncer(t.timers, t.now);
    let runs = 0;
    for (let i = 0; i < 10; i += 1) {
      d.after('notes:t2', 20_000, () => { runs += 1; }, 60_000);
      t.advance(10_000);
    }
    expect(runs).toBe(1);
  });

  it('cancels', () => {
    const t = manualTimers();
    const d = createDebouncer(t.timers, t.now);
    let runs = 0;
    d.after('k', 1_000, () => { runs += 1; });
    d.cancel('k');
    t.advance(5_000);
    expect(runs).toBe(0);
  });

  it('cancels every key at once when Go stops', () => {
    const t = manualTimers();
    const d = createDebouncer(t.timers, t.now);
    let runs = 0;
    d.after('notes:t1', 20_000, () => { runs += 1; });
    d.after('fold:t1', 60_000, () => { runs += 1; });
    d.after('notes:t2', 2_000, () => { runs += 1; });
    d.cancelAll();
    t.advance(120_000);
    expect(runs).toBe(0);
    expect(d.pending('notes:t1') || d.pending('fold:t1') || d.pending('notes:t2')).toBe(false);
  });
});
