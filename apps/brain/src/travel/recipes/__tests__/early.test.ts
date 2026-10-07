import { describe, expect, it, vi } from 'vitest';
import { msg } from '../../../__tests__/fixtures/goa.js';
import { UNSURE_READ, type ReflexRead } from '../../../reflex/reflex.js';
import { FakeSwitches } from '../../../tasks/testing/lane-brain.js';
import { goaPack } from '../../../tasks/testing/goa.js';
import { TravelError } from '../../mcp-travel.js';
import type { Travel, TravelKind, TravelQuery } from '../../travel.js';
import { createEarlyStart } from '../early.js';

function world(mode = 'ixigo_web', fail = false) {
  const searches: Array<{ kind: TravelKind; q: TravelQuery; tripId: string | undefined }> = [];
  /** The message each search was started for: its live card belongs to that message's turn. */
  const forMessages: Array<string | undefined> = [];
  const travel = {
    async search(kind: TravelKind, q: TravelQuery, o?: { tripId?: string; messageId?: string }) {
      searches.push({ kind, q, tripId: o?.tripId });
      forMessages.push(o?.messageId);
      if (fail) throw new TravelError('unreachable', 'ixigo took too long to answer.');
      return { results: [], checkedAt: '2026-10-07T12:00:00.000Z' };
    },
  } as unknown as Travel;
  const switches = new FakeSwitches();
  void switches.set('TRAVEL_MODE', mode);
  const log = { warn: vi.fn() };
  let nowMs = Date.parse('2026-10-07T12:00:00Z');
  const warmed: string[] = [];
  const early = createEarlyStart({ travel: () => travel, switches, today: async () => '2026-10-07', now: () => new Date(nowMs), log, warmForTravel: (tripId, kind) => warmed.push(`${tripId}:${kind}`) });
  return { hook: (...a: Parameters<typeof early.onRead>) => early.onRead(...a), early, searches, forMessages, log, warmed, advance: (ms: number) => { nowMs += ms; } };
}

const forGo: ReflexRead = { ...UNSURE_READ, forGo: { value: true, sure: true } };

describe('the early start', () => {
  it("starts a whole ask's search on intake, for the trip, and says the turn is due now", async () => {
    const w = world();
    const answer = await w.hook(msg(41, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack());
    expect(answer).toEqual({ dueNow: true });
    expect(w.searches).toEqual([{ kind: 'flights', q: { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '17:00' }, tripId: 't_goa' }]);
    expect(w.forMessages).toEqual(['m_41']);
  });

  it('takes an ask the quick read is sure is for Go, even without its name', async () => {
    const w = world();
    expect(await w.hook(msg(42, 'p_kabir', 'can someone check trains from Mumbai on Thursday?'), forGo, goaPack())).toEqual({ dueNow: true });
    expect(w.searches[0]).toMatchObject({ kind: 'trains', q: { from: 'mumbai', to: 'North Goa', date: '2026-11-05' } });
  });

  it('does nothing for chatter, for less than a whole ask, or for a place the recipes cannot fill', async () => {
    const w = world();
    expect(await w.hook(msg(43, 'p_kabir', 'can someone check trains from Mumbai on Thursday?'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(await w.hook(msg(44, 'p_rahul', '@Go flights to Goa Friday'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(await w.hook(msg(45, 'p_rahul', '@Go flights Delhi to Shimla Friday'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(w.searches).toEqual([]);
  });

  it('starts the search in every travel mode, so a search ask is one model call wherever the list comes from', async () => {
    for (const mode of ['fake', 'ixigo']) {
      const w = world(mode);
      expect(await w.hook(msg(46, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack()), mode).toEqual({ dueNow: true });
      expect(w.searches, mode).toEqual([{ kind: 'flights', q: { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '17:00' }, tripId: 't_goa' }]);
      // No live card there: the right-now block won't say one told the room.
      expect(w.early.searchFor('t_goa', 'm_46'), mode).toMatchObject({ kind: 'flights', live: false });
    }
  });

  it("wakes the trip's computer only for travel intent: Jev sure of a search kind, or a search the hook starts", async () => {
    const w = world();
    // Chatter, and travel talk Jev isn't sure asks for a search: no wake, whatever the mode.
    await w.hook(msg(50, 'p_priya', "I'm veg btw"), UNSURE_READ, goaPack());
    await w.hook(msg(51, 'p_priya', 'trains from Mumbai on Thursday are cheaper I think'), UNSURE_READ, goaPack());
    expect(w.warmed).toEqual([]);
    // Jev sure it asks for trains, though nobody named Go: the box wakes for the search to come, and nothing starts.
    const trains: ReflexRead = { ...UNSURE_READ, recipe: { value: 'trains', sure: true } };
    await w.hook(msg(52, 'p_kabir', 'trains from Mumbai on Thursday are cheaper I think'), trains, goaPack());
    expect(w.warmed).toEqual(['t_goa:trains']);
    expect(w.searches).toEqual([]);
    // Jev sure it is not a search ask: no wake.
    await w.hook(msg(53, 'p_kabir', '@Go is Thursday a holiday?'), { ...UNSURE_READ, recipe: { value: null, sure: true } }, goaPack());
    // A whole ask to Go that the parser reads: the search it starts is the intent, one wake for it.
    await w.hook(msg(54, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack());
    expect(w.warmed).toEqual(['t_goa:trains', 't_goa:flights']);
  });

  it('starts nothing for a kind that answers with a link, but the turn is still due now; off ixigo_web, flights are a search', async () => {
    const searches: string[] = [];
    const travel = { search: async (kind: string) => { searches.push(kind); return { results: [], checkedAt: '' }; } } as unknown as Travel;
    const switches = new FakeSwitches();
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    const early = createEarlyStart({ travel: () => travel, switches, today: async () => '2026-10-07', now: () => new Date(), log: { warn: vi.fn() }, linkOnly: (k) => k === 'flights' });
    expect(await early.onRead(msg(53, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack())).toEqual({ dueNow: true });
    expect(searches).toEqual([]);
    expect(early.searchFor('t_goa', 'm_53')).toBeNull();
    await switches.set('TRAVEL_MODE', 'fake');
    expect(await early.onRead(msg(54, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack())).toEqual({ dueNow: true });
    expect(searches).toEqual(['flights']);
  });

  it("follows Jev's sure pick (question 10): its kind wins, and its none starts nothing; unsure leaves it to the parser", async () => {
    const w = world();
    const jev = (value: 'trains' | null): ReflexRead => ({ ...UNSURE_READ, recipe: { value, sure: true } });
    // No kind word the parser knows; Jev reads it as trains.
    expect(await w.hook(msg(60, 'p_rahul', '@Go Mumbai se Goa kal kuch hai kya'), jev('trains'), goaPack())).toEqual({ dueNow: true });
    expect(w.searches).toEqual([{ kind: 'trains', q: { from: 'mumbai', to: 'goa', date: '2026-10-08' }, tripId: 't_goa' }]);
    // Jev is sure it is no search ask, though the words look like one.
    expect(await w.hook(msg(61, 'p_rahul', '@Go trains from Mumbai on Thursday were always late lol'), jev(null), goaPack())).toBeUndefined();
    expect(w.searches).toHaveLength(1);
  });

  it("on a trip with no dates set, reads the dates the group agreed in its record, and leaves \"Friday\" alone without them", async () => {
    const at = '2026-10-05T03:00:00Z';
    const agreed = { line_id: 'r_dates', kind: 'agreed', text: '6 to 9 Nov, Diwali long weekend', status: 'active', proof: [], person_ids: ['p_rahul'], source: 'go', created_at: at, updated_at: at };
    const undated = (record: unknown[]) => ({ ...goaPack(), trip: { ...goaPack().trip, dates: null, record } }) as never;
    const w = world('fake');
    expect(await w.hook(msg(70, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, undated([agreed]))).toEqual({ dueNow: true });
    expect(await w.hook(msg(71, 'p_rahul', 'Go, find us a villa with a pool in North Goa'), UNSURE_READ, undated([agreed]))).toEqual({ dueNow: true });
    expect(w.searches.map((s) => s.q)).toEqual([
      { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '17:00' },
      { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] },
    ]);
    // No dates anywhere: "Friday" could be this week's or the trip's, so the composer reads the chat.
    expect(await w.hook(msg(72, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, undated([]))).toBeUndefined();
    expect(w.searches).toHaveLength(2);
  });

  it('remembers the search each message started, for ten minutes, for the turn it wakes', async () => {
    const w = world();
    await w.hook(msg(48, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack());
    const started = w.early.searchFor('t_goa', 'm_48');
    expect(started).toMatchObject({ kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-11-06' }, live: true });
    expect(await started!.search).toEqual({ results: [], checkedAt: '2026-10-07T12:00:00.000Z' });
    expect(w.early.searchFor('t_goa', 'm_49')).toBeNull();
    expect(w.early.searchFor('t_other', 'm_48')).toBeNull();
    w.advance(10 * 60_000);
    expect(w.early.searchFor('t_goa', 'm_48')).toBeNull();
  });

  it('never fails the message: a search that fails is logged, and the composer searches again', async () => {
    const w = world('ixigo_web', true);
    expect(await w.hook(msg(47, 'p_rahul', '@Go flights Delhi to Goa Friday evening'), UNSURE_READ, goaPack())).toEqual({ dueNow: true });
    await vi.waitFor(() => expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_goa', kind: 'flights' }), expect.stringContaining('early search failed')));
  });
});
