import { describe, expect, it, vi } from 'vitest';
import { createKeepWarm, KEEP_WARM_FOR_MS } from '../keep-warm.js';

function world(o: { failWake?: string } = {}) {
  let nowMs = Date.parse('2026-10-07T12:00:00Z');
  const wakes: string[] = [];
  const pings: string[] = [];
  const log = { warn: vi.fn() };
  const keeper = createKeepWarm({
    wake: async (tripId) => {
      wakes.push(tripId);
      if (tripId === o.failWake) throw new Error('warm_limit: too many computers are waking');
      return 'waking';
    },
    ping: async (tripId) => {
      pings.push(tripId);
      return 'ready';
    },
    now: () => new Date(nowMs),
    log,
  });
  return { keeper, wakes, pings, log, advance: (ms: number) => { nowMs += ms; } };
}

describe('keeping a computer warm through travel talk', () => {
  it('wakes the box on the first travel line, then pings it every round, for two minutes after the last line', async () => {
    const w = world();
    w.keeper.touch('t_goa');
    w.keeper.touch('t_goa');
    expect(w.wakes).toEqual(['t_goa']);
    await w.keeper.tick();
    expect(w.pings).toEqual(['t_goa']);
    w.advance(90_000);
    // Another travel line: two more minutes from now.
    w.keeper.touch('t_goa');
    w.advance(90_000);
    await w.keeper.tick();
    expect(w.pings).toEqual(['t_goa', 't_goa']);
    w.advance(KEEP_WARM_FOR_MS);
    await w.keeper.tick();
    expect(w.pings).toHaveLength(2);
    expect(w.keeper.kept()).toEqual([]);
    w.keeper.stop();
  });

  it('keeps at most 8 trips at once, and stops keeping one whose wake was refused', async () => {
    const w = world({ failWake: 't_7' });
    for (let i = 0; i < 9; i += 1) w.keeper.touch(`t_${i}`);
    expect(w.wakes).toHaveLength(8);
    await vi.waitFor(() => expect(w.keeper.kept()).not.toContain('t_7'));
    expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_7' }), expect.stringContaining('did not start'));
    // The refused trip's place is free again.
    w.keeper.touch('t_8');
    expect(w.keeper.kept()).toContain('t_8');
    w.keeper.stop();
    expect(w.keeper.kept()).toEqual([]);
  });
});
