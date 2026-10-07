import { describe, expect, it, vi } from 'vitest';
import { msg } from '../../../__tests__/fixtures/goa.js';
import { UNSURE_READ, type ReflexRead } from '../../../reflex/reflex.js';
import { FakeSwitches } from '../../../tasks/testing/lane-brain.js';
import { goaPack } from '../../../tasks/testing/goa.js';
import { TravelError } from '../../mcp-travel.js';
import type { Travel, TravelKind, TravelQuery } from '../../travel.js';
import { earlyStart } from '../early.js';

function world(mode = 'ixigo_web', fail = false) {
  const searches: Array<{ kind: TravelKind; q: TravelQuery; tripId: string | undefined }> = [];
  const travel = {
    async search(kind: TravelKind, q: TravelQuery, o?: { tripId?: string }) {
      searches.push({ kind, q, tripId: o?.tripId });
      if (fail) throw new TravelError('unreachable', 'ixigo took too long to answer.');
      return { results: [], checkedAt: '2026-10-07T12:00:00.000Z' };
    },
  } as unknown as Travel;
  const switches = new FakeSwitches();
  void switches.set('TRAVEL_MODE', mode);
  const log = { warn: vi.fn() };
  const hook = earlyStart({ travel: () => travel, switches, today: async () => '2026-10-07', log });
  return { hook, searches, log };
}

const forGo: ReflexRead = { ...UNSURE_READ, forGo: { value: true, sure: true } };

describe('the early start', () => {
  it("starts a whole ask's search on intake, for the trip, and says the turn is due now", async () => {
    const w = world();
    const answer = await w.hook(msg(41, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack());
    expect(answer).toEqual({ dueNow: true });
    expect(w.searches).toEqual([{ kind: 'flights', q: { from: 'delhi', to: 'goa', date: '2026-10-09' }, tripId: 't_goa' }]);
  });

  it('takes an ask the quick read is sure is for Go, even without its name', async () => {
    const w = world();
    expect(await w.hook(msg(42, 'p_kabir', 'can someone check trains from Mumbai on Thursday?'), forGo, goaPack())).toEqual({ dueNow: true });
    expect(w.searches[0]).toMatchObject({ kind: 'trains', q: { from: 'mumbai', to: 'North Goa', date: '2026-10-08' } });
  });

  it('does nothing for chatter, for less than a whole ask, for a place the recipes cannot fill, or off ixigo_web', async () => {
    const w = world();
    expect(await w.hook(msg(43, 'p_kabir', 'can someone check trains from Mumbai on Thursday?'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(await w.hook(msg(44, 'p_rahul', '@Go flights to Goa Friday'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(await w.hook(msg(45, 'p_rahul', '@Go flights Delhi to Shimla Friday'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(w.searches).toEqual([]);
    const fake = world('fake');
    expect(await fake.hook(msg(46, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(fake.searches).toEqual([]);
  });

  it('never fails the message: a search that fails is logged, and the composer searches again', async () => {
    const w = world('ixigo_web', true);
    expect(await w.hook(msg(47, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack())).toEqual({ dueNow: true });
    await vi.waitFor(() => expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa', kind: 'flights' }), expect.stringContaining('early search failed')));
  });
});
