import { describe, expect, it, vi } from 'vitest';
import { createKeepWarm, EXTEND_WITHIN_MS, KEEP_MS } from '../keep-warm.js';

function world(o: { fail?: boolean } = {}) {
  let nowMs = Date.parse('2026-10-07T12:00:00Z');
  const warms: Array<{ tripId: string; keepMs: number }> = [];
  const log = { warn: vi.fn() };
  const keeper = createKeepWarm({
    warm: async (tripId, keepMs) => {
      warms.push({ tripId, keepMs });
      if (o.fail) throw new Error('warm_limit: too many computers are waking');
      return 'waking';
    },
    now: () => new Date(nowMs),
    log,
  });
  return { keeper, warms, log, advance: (ms: number) => { nowMs += ms; } };
}

describe('holding a computer awake while the trip talks', () => {
  it('asks Bash to hold the box for two minutes on the first line, and not again while the hold has time left', () => {
    const w = world();
    w.keeper.touch('t_goa');
    w.keeper.touch('t_goa');
    w.advance(KEEP_MS - EXTEND_WITHIN_MS - 1_000);
    w.keeper.touch('t_goa');
    expect(w.warms).toEqual([{ tripId: 't_goa', keepMs: KEEP_MS }]);
  });

  it('extends the hold when the talk goes on into its last 20 s: about one call per 100 s per trip', () => {
    const w = world();
    w.keeper.touch('t_goa');
    w.advance(KEEP_MS - EXTEND_WITHIN_MS + 1_000);
    w.keeper.touch('t_goa');
    expect(w.warms).toHaveLength(2);
    // A quiet trip lets its hold end; the next line holds it again.
    w.advance(10 * 60_000);
    w.keeper.touch('t_goa');
    expect(w.warms).toHaveLength(3);
    w.keeper.touch('t_other');
    expect(w.warms.map((x) => x.tripId)).toEqual(['t_goa', 't_goa', 't_goa', 't_other']);
  });

  it('asks again on the next line when a hold was refused', async () => {
    const w = world({ fail: true });
    w.keeper.touch('t_goa');
    await vi.waitFor(() => expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa' }), expect.stringContaining('did not start')));
    w.keeper.touch('t_goa');
    expect(w.warms).toHaveLength(2);
  });
});
