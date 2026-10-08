import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripEvent } from '../../door/methods.js';
import { AWAKE_EVERY_MS, AWAKE_KEEP_MS, AWAKE_QUIET_MS, createTripAwake } from '../awake.js';

const MIN = 60_000;

function setup(o: { on?: () => boolean; gone?: string[]; recent?: Array<{ tripId: string; at: Date }>; fail?: boolean } = {}) {
  const holds: Array<{ tripId: string; keepMs: number; at: number }> = [];
  const warn = vi.fn();
  const awake = createTripAwake({
    hold: async (tripId, keepMs) => {
      holds.push({ tripId, keepMs, at: Date.now() });
      if (o.fail) throw new Error('warm_limit: too many computers are waking');
    },
    now: () => new Date(),
    log: { warn },
    on: o.on ?? (() => true),
    gone: async (tripId) => (o.gone ?? []).includes(tripId),
    recent: async () => o.recent ?? [],
  });
  return { awake, holds, warn, of: (tripId: string) => holds.filter((h) => h.tripId === tripId).length };
}

/** A new line in the trip, as the trip log hands it on: a person's, or Go's own. */
const line = (tripId: string, by: 'person' | 'go' = 'person'): TripEvent =>
  ({ type: 'message.created', trip_id: tripId, data: { message: { author: by === 'person' ? { kind: 'person', person_id: 'p_rahul' } : { kind: 'go' } } } }) as unknown as TripEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the trip's computer stays awake while its group talks", () => {
  it('ten lines in a minute make one beat: a hold at once and one 30 s later, each for 60 s, not ten', async () => {
    const s = setup();
    for (let i = 0; i < 10; i += 1) {
      s.awake.onEvent(line('t_goa'));
      await vi.advanceTimersByTimeAsync(5_900);
    }
    expect(s.holds.map((h) => [h.tripId, h.keepMs, h.at - Date.parse('2026-10-08T12:00:00Z')])).toEqual([
      ['t_goa', AWAKE_KEEP_MS, 0],
      ['t_goa', AWAKE_KEEP_MS, AWAKE_EVERY_MS],
    ]);
    // Bash holds a box for keep_ms: each hold outlasts the beat, so a late beat still lands inside the last one.
    expect(AWAKE_KEEP_MS).toBeGreaterThan(AWAKE_EVERY_MS);
    s.awake.stop();
  });

  it('stops after 10 quiet minutes, and the next line holds the box again at once', async () => {
    const s = setup();
    s.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS + AWAKE_EVERY_MS);
    // Every 30 s for the 10 minutes after the last line, then nothing.
    expect(s.of('t_goa')).toBe(AWAKE_QUIET_MS / AWAKE_EVERY_MS);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.of('t_goa')).toBe(AWAKE_QUIET_MS / AWAKE_EVERY_MS);
    s.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.of('t_goa')).toBe(AWAKE_QUIET_MS / AWAKE_EVERY_MS + 1);
    s.awake.stop();
  });

  it("never counts Go's own lines: they neither start the beat nor keep it going", async () => {
    const s = setup();
    s.awake.onEvent(line('t_goa', 'go'));
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(s.holds).toEqual([]);
    s.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(9 * MIN);
    s.awake.onEvent(line('t_goa', 'go'));
    await vi.advanceTimersByTimeAsync(3 * MIN);
    // Ten minutes after the person's line, not after Go's.
    expect(s.of('t_goa')).toBe(AWAKE_QUIET_MS / AWAKE_EVERY_MS);
    // A person's line later on does keep it going: 24 holds in 12 minutes, where one line alone gives 20.
    s.awake.onEvent(line('t_kerala'));
    await vi.advanceTimersByTimeAsync(9 * MIN);
    s.awake.onEvent(line('t_kerala'));
    await vi.advanceTimersByTimeAsync(2 * MIN + 45_000);
    expect(s.of('t_kerala')).toBe((12 * MIN) / AWAKE_EVERY_MS);
    s.awake.stop();
  });

  it('after a restart, picks back up a trip a person posted in 3 minutes ago, for the 7 minutes left, and not one quiet for 11', async () => {
    const s = setup({ recent: [{ tripId: 't_goa', at: new Date(Date.now() - 3 * MIN) }, { tripId: 't_old', at: new Date(Date.now() - 11 * MIN) }] });
    await s.awake.catchUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.holds.map((h) => h.tripId)).toEqual(['t_goa']);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.of('t_goa')).toBe((7 * MIN) / AWAKE_EVERY_MS);
    expect(s.of('t_old')).toBe(0);
    s.awake.stop();
  });

  it('never holds a gone trip, nor any while Go reads no ixigo.com; a failed hold is said once a stretch', async () => {
    const gone = setup({ gone: ['t_gone'] });
    gone.awake.onEvent(line('t_gone'));
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(gone.holds).toEqual([]);
    let on = false;
    const off = setup({ on: () => on });
    off.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(off.holds).toEqual([]);
    // The switch back on: the next line starts it.
    on = true;
    off.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(0);
    expect(off.holds).toHaveLength(1);
    const failing = setup({ fail: true });
    failing.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(failing.holds.length).toBeGreaterThan(5);
    expect(failing.warn).toHaveBeenCalledOnce();
    for (const x of [gone, off, failing]) x.awake.stop();
  });

  it('holds nothing once Go stops', async () => {
    const s = setup();
    s.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(0);
    s.awake.stop();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    s.awake.onEvent(line('t_goa'));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.holds).toHaveLength(1);
  });
});
