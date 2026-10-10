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

  it("never searches the trip's destination for a stay in a place the tables don't know (the 8 Oct drill: Manali ran Goa)", async () => {
    const w = world();
    // Manali is not Goa: the composer looks it up on ixigo and searches it, and no Goa search runs first.
    expect(await w.hook(msg(57, 'p_meher', '@Go hotels in Manali for our dates'), UNSURE_READ, goaPack())).toBeUndefined();
    expect(w.searches).toEqual([]);
    // With no place named, the trip's destination it is.
    expect(await w.hook(msg(58, 'p_priya', '@Go a villa with a pool for our dates'), UNSURE_READ, goaPack())).toEqual({ dueNow: true });
    expect(w.searches).toEqual([{ kind: 'stays', q: expect.objectContaining({ area: 'North Goa', mustHave: ['pool'] }), tripId: 't_goa' }]);
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

describe('the early start of an ixigo read beyond the searches', () => {
  const BOOK = new Set(['trains.running_status', 'trains.schedule', 'plan.destination', 'offers.list', 'hotels.reviews']);
  const runKeys: string[] = [];
  function readWorld(mode = 'ixigo_web', o: { fail?: boolean; option?: { ref: string; page: string } | null; book?: Set<string> } = {}) {
    const runs: Array<{ id: string; given: Record<string, unknown>; tripId: string }> = [];
    const switches = new FakeSwitches();
    void switches.set('TRAVEL_MODE', mode);
    const log = { warn: vi.fn() };
    const warmed: string[] = [];
    const facts = { as: 'facts' as const, title: 'Train 12051 today', rows: [{ state: 'On time' }], page: 'https://www.ixigo.com/trains/12051/running-status', checkedAt: '2026-10-07T12:00:00.000Z', ms: 900 };
    const early = createEarlyStart({
      travel: () => ({ search: vi.fn() }) as unknown as Travel, switches, today: async () => '2026-10-07', now: () => new Date('2026-10-07T12:00:00Z'), log,
      warmForTravel: (tripId, kind) => warmed.push(`${tripId}:${kind}`),
      recipes: {
        has: (id) => (o.book ?? BOOK).has(id),
        run: async (id, given, r) => {
          runs.push({ id, given, tripId: r.tripId });
          runKeys.push(r.runKey);
          if (o.fail) throw new TravelError('unreachable', 'PNR 4512873690 did not load');
          return facts;
        },
      },
      optionFor: async (_tripId, _text, kind) => (kind === 'stay' ? (o.option ?? null) : null),
    });
    return { early, runs, log, warmed, facts };
  }
  const picked = (value: string): ReflexRead => ({ ...forGo, recipe: { value: value as never, sure: true } });

  it("runs a train's running status at once for a live pick, wakes the computer, and keeps the read for the turn", async () => {
    const w = readWorld();
    expect(await w.early.onRead(msg(60, 'p_arjun', 'Go 12051 abhi kahan chal rahi hai?'), picked('train_status'), goaPack())).toEqual({ dueNow: true });
    expect(w.runs).toEqual([{ id: 'trains.running_status', given: { train: '12051' }, tripId: 't_goa' }]);
    expect(w.warmed).toEqual(['t_goa:null']);
    const read = w.early.readFor('t_goa', 'm_60')!;
    expect(read).toMatchObject({ choice: 'train_status', recipe: 'trains.running_status', asked: { train: '12051' }, runKey: 'early:m_60|trains.running_status' });
    expect(runKeys.at(-1)).toBe('early:m_60|trains.running_status');
    await expect(read.answer).resolves.toBe(w.facts);
  });

  it("gives the tool's call that is the same read the read's card, so one read shows one card", async () => {
    const w = readWorld();
    await w.early.onRead(msg(72, 'p_arjun', 'Go 12051 abhi kahan chal rahi hai?'), picked('train_status'), goaPack());
    // The model's call: the same recipe and train, as a number or as words.
    expect(w.early.joinKey('t_goa', ['m_72'], 'trains.running_status', { train: 12051 })).toBe('early:m_72|trains.running_status');
    expect(w.early.joinKey('t_goa', ['m_71', 'm_72'], 'trains.running_status', { train: ' 12051' })).toBe('early:m_72|trains.running_status');
    // Another train, another recipe, another message, another trip: a read of its own, with its own card.
    expect(w.early.joinKey('t_goa', ['m_72'], 'trains.running_status', { train: '16346' })).toBeNull();
    expect(w.early.joinKey('t_goa', ['m_72'], 'trains.schedule', { train: '12051' })).toBeNull();
    expect(w.early.joinKey('t_goa', ['m_73'], 'trains.running_status', { train: '12051' })).toBeNull();
    expect(w.early.joinKey('t_other', ['m_72'], 'trains.running_status', { train: '12051' })).toBeNull();
  });

  it("reads a guide for the trip's own place, and a shown stay's reviews by its option", async () => {
    const w = readWorld('ixigo_web', { option: { ref: 'r_ab12#2', page: 'https://www.ixigo.com/hotels/palm-grove/details?x=1' } });
    await w.early.onRead(msg(61, 'p_meher', 'Go yahan kya kya ghoomne layak hai?'), picked('guide'), goaPack());
    await w.early.onRead(msg(62, 'p_priya', 'Go Palm Grove ke reviews kaise hain?'), picked('hotel_reviews'), goaPack());
    expect(w.runs.map((r) => [r.id, r.given])).toEqual([
      ['plan.destination', { place: 'North Goa' }],
      ['hotels.reviews', { hotel: 'https://www.ixigo.com/hotels/palm-grove/details?x=1' }],
    ]);
    expect(w.early.readFor('t_goa', 'm_62')!.asked).toEqual({ hotel: 'r_ab12#2' });
  });

  it('starts nothing when the words lack a slot, the book lacks the recipe, Go does not search ixigo.com, or the pick is not live', async () => {
    const w = readWorld();
    // A train by its name only: the composer looks its number up.
    expect(await w.early.onRead(msg(63, 'p_meher', 'Go where is the Konkan Kanya Express right now?'), picked('train_status'), goaPack())).toBeUndefined();
    // The book has no PNR recipe yet.
    expect(await w.early.onRead(msg(64, 'p_kabir', 'Go PNR 4512873690 ka status batao'), picked('pnr'), goaPack())).toBeUndefined();
    // No stay on a card that the line plainly points at.
    expect(await w.early.onRead(msg(65, 'p_priya', 'Go us villa ke reviews?'), picked('hotel_reviews'), goaPack())).toBeUndefined();
    // A watch is the watch tool's, never a read now.
    expect(await w.early.onRead(msg(66, 'p_arjun', 'Go let us know when 12051 is running late'), picked('train_status'), goaPack())).toBeUndefined();
    // Jev's shadow pick acts as none: the live read is sure no search is asked.
    expect(await w.early.onRead(msg(67, 'p_arjun', 'Go 12051 abhi kahan hai?'), { ...forGo, recipe: { value: null, sure: true } }, goaPack())).toBeUndefined();
    expect(w.runs).toEqual([]);
    for (const mode of ['fake', 'ixigo']) {
      const other = readWorld(mode);
      expect(await other.early.onRead(msg(68, 'p_arjun', 'Go 12051 abhi kahan chal rahi hai?'), picked('train_status'), goaPack()), mode).toBeUndefined();
      expect(other.runs, mode).toEqual([]);
    }
  });

  it('never starts a search for an ask beyond the searches, even when its words would read as one', async () => {
    const w = readWorld();
    await w.early.onRead(msg(69, 'p_rahul', 'Go Mumbai se Madgaon 5 Nov ki train mein WL 18 hai, confirm hoga kya?'), picked('confirm_chance'), goaPack());
    expect(w.runs).toEqual([]);
    expect(w.early.searchFor('t_goa', 'm_69')).toBeNull();
  });

  it('logs a failed read with its error, but never a PNR read\'s, and keeps no copy of the number for the tool', async () => {
    const w = readWorld('ixigo_web', { fail: true, book: new Set([...BOOK, 'trains.pnr_status']) });
    await w.early.onRead(msg(70, 'p_arjun', 'Go 12051 abhi kahan chal rahi hai?'), picked('train_status'), goaPack());
    await w.early.onRead(msg(71, 'p_kabir', 'Go PNR 4512873690 ka status batao'), picked('pnr'), goaPack());
    await vi.waitFor(() => expect(w.log.warn).toHaveBeenCalledTimes(2));
    const [[status], [pnr]] = w.log.warn.mock.calls as Array<[Record<string, unknown>, string]>;
    expect(status).toMatchObject({ tripId: 't_goa', recipe: 'trains.running_status', err: expect.any(TravelError) });
    expect(pnr).toEqual({ tripId: 't_goa', recipe: 'trains.pnr_status' });
    expect(w.early.readFor('t_goa', 'm_71')!.asked).toEqual({});
  });
});
