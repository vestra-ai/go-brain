import { describe, expect, it, vi } from 'vitest';
import { CARD_LINE } from '../../../composer/rules.js';
import type { DeskItem } from '../../../desk/desk.js';
import type { TravelOption, TravelSearch } from '../../travel.js';
import type { EarlySearch } from '../early.js';
import { EARLY_WAIT_MS, earlyAnswer, earlySearchNow } from '../now.js';
import { searchWakeAnswer } from '../../search-wake.js';
import { msg } from '../../../__tests__/fixtures/goa.js';
import { makeTurnCtx } from '../../../composer/tools.js';
import { goaPack } from '../../../tasks/testing/goa.js';

const flight = (title: string, priceMinor: number, dep: string): TravelOption => ({
  kind: 'flight', title, priceMinor, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=09102026',
  journey: { mode: 'flight', origin: { name: 'New Delhi (DEL)', code: 'DEL' }, destination: { name: 'Goa (GOI)', code: 'GOI' }, depart_at: `2026-10-09T${dep}:00+05:30`, arrive_at: '2026-10-09T23:30:00+05:30', stops: 0 },
});
const FOUND: TravelSearch = { checkedAt: '2026-10-07T12:00:00.000Z', found: 2, results: [flight('IndiGo 6E 5341', 789_600, '18:10'), flight('Air India AI 2981', 809_300, '19:45')] };
const QUERY = { from: 'delhi', to: 'goa', date: '2026-10-09' };
const wakeFor = (messageId: string, seq: number): DeskItem => ({
  id: `msg:t_goa:${messageId}`, tripId: 't_goa', kind: 'message', ref: messageId, dueAt: new Date(), payload: { messageId, seq, namesGo: true },
});

/** A search the test finishes when it likes. */
function later<T>() {
  let settle!: { resolve: (v: T) => void; reject: (e: unknown) => void };
  const p = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { p, ...settle };
}

function world(search: Promise<TravelSearch> | null, allowed: number | null = EARLY_WAIT_MS, live = true) {
  const saved: unknown[] = [];
  const waits: number[] = [];
  const puts: Array<Omit<DeskItem, 'id'> & { id?: string }> = [];
  const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push(item); } };
  const early = { searchFor: (tripId: string, messageId: string): EarlySearch | null => (search && tripId === 't_goa' && messageId === 'm_57' ? { kind: 'flights', query: QUERY, search, live } : null) };
  const results = {
    save: vi.fn(async (s: Record<string, unknown>) => {
      saved.push(s);
      return { ...s, resultsId: 'r_early1' } as never;
    }),
  };
  const travel = { waitMs: async () => allowed };
  const now = earlySearchNow({ early, results, travel, desk, now: () => new Date('2026-10-07T12:00:01Z'), wait: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 5)); } });
  return { now, saved, waits, results, puts };
}

describe('the early search block', () => {
  it("hands the turn its search's answer, so the one call is show_options; the results are data, the instructions are not", async () => {
    const w = world(Promise.resolve(FOUND));
    const block = (await w.now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(w.now).toMatchObject({ name: 'travel search', order: 35 });
    expect(block).toContain('Already searched for #57, checked just now: results_id r_early1, 2 options.');
    expect(block).toContain('show_options');
    // To whoever asked, never "Meher asked for…" (re-drill 4), finished, with no reasoning (re-drill 5).
    expect(block.split('<data')[0]).toContain(CARD_LINE);
    // The live card said "On it." already.
    expect(block).toContain("don't say so again");
    const [before, fenced] = block.split('<data source="search results">');
    expect(before).not.toContain('IndiGo');
    expect(fenced).toContain('2 flights from delhi to goa on 2026-10-09: ₹7,896 to ₹8,093 per person.');
    expect(fenced).toContain('"title":"IndiGo 6E 5341"');
    expect(w.saved).toEqual([expect.objectContaining({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: QUERY })]);
  });

  it('saves one set per message, however often the turn runs', async () => {
    const w = world(Promise.resolve(FOUND));
    await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    expect(w.results.save).toHaveBeenCalledTimes(1);
  });

  it('hands a search still running after its 12 s over itself: its options go up when it finishes, whatever the model says (staging, 8 Oct)', async () => {
    const run = later<TravelSearch>();
    const w = world(run.p);
    const block = await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    expect(w.waits).toEqual([EARLY_WAIT_MS]);
    expect(block).toBe(
      'The search for #57 (flights from delhi to goa on 2026-10-09) is still running, and the live card in the room shows it. ' +
        "Its options go up in the room by themselves when it finishes. Post nothing about it, and don't search for it again.",
    );
    // Never Go's own plumbing in the room ("I'll join the running search").
    expect(block).not.toMatch(/join/i);
    expect(w.puts).toEqual([]);
    // The turn ended with whatever line the model wrote; the run finishes after it, and Go wakes to put the card up.
    run.resolve({ ...FOUND, runId: 'run_57' });
    await vi.waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0]).toMatchObject({
      id: 'search:t_goa:run_57', tripId: 't_goa', kind: 'search', ref: 'flights',
      payload: { source: 'travel_search', count: 2, resultsId: 'r_early1', error: null },
    });
  });

  it('never waits on the agent job, and still hands over a search that already finished', async () => {
    const slow = world(new Promise<TravelSearch>(() => undefined), 0);
    expect(await slow.now.render('t_goa', [wakeFor('m_57', 57)])).toContain('still running');
    expect(slow.waits).toEqual([0]);
    const done = world(Promise.resolve(FOUND), 0);
    expect(await done.now.render('t_goa', [wakeFor('m_57', 57)])).toContain('results_id r_early1');
  });

  it('says nothing for a search that failed, for a message that started none, or for a wake that is not a message', async () => {
    // As the early start keeps it: with its failure already handled (it logs it).
    const rejected = Promise.reject(new Error('ixigo took too long'));
    rejected.catch(() => undefined);
    const failed = world(rejected);
    expect(await failed.now.render('t_goa', [wakeFor('m_57', 57)])).toBeNull();
    const none = world(Promise.resolve(FOUND));
    expect(await none.now.render('t_goa', [wakeFor('m_58', 58)])).toBeNull();
    expect(await none.now.render('t_goa', [{ ...wakeFor('m_57', 57), kind: 'tap' }])).toBeNull();
    expect(none.results.save).not.toHaveBeenCalled();
  });

  it('off ixigo_web, where no live card is in the room, never says one told the room or that the search wakes Go', async () => {
    const done = (await world(Promise.resolve(FOUND), null, false).now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(done).toContain('Already searched for #57, checked just now: results_id r_early1, 2 options.');
    expect(done).toContain('show_options');
    expect(done).not.toContain('live card');
    const slow = world(new Promise<TravelSearch>(() => undefined), null, false);
    // A backend that does not say how long it may take: the block's own 12 s.
    expect(await slow.now.render('t_goa', [wakeFor('m_57', 57)])).toBe(
      'The search for #57 (flights from delhi to goa on 2026-10-09) is still running. Its options go up in the room by themselves when it finishes. ' +
        "Say in one short line that you're still looking and they'll be here in a moment, and don't search for it again.",
    );
    expect(slow.waits).toEqual([EARLY_WAIT_MS]);
  });

  it('lets the model search again when the group meant another day or place than the early read', async () => {
    const block = (await world(Promise.resolve(FOUND)).now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(block.split('<data')[0]).toContain("If they meant another day or place than the summary's (the trip's Friday, not this week's), search for theirs instead.");
  });

  it('says what the summary says when nothing came back', async () => {
    const w = world(Promise.resolve({ checkedAt: '2026-10-07T12:00:00.000Z', found: 0, results: [] }));
    const block = (await w.now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(block).toContain('nothing to show');
    expect(block).toContain('Nothing came back: there are no flights from delhi to goa on 2026-10-09 at all.');
    expect(w.results.save).not.toHaveBeenCalled();
  });
});

describe('the early answer, with no model call', () => {
  // The Goa trip (6 to 9 Nov): "Friday" is the trip's, 6 Nov. Today is 7 Oct.
  const query = { from: 'delhi', to: 'goa', date: '2026-11-06', departAfter: '19:00' };
  const late = (title: string, priceMinor: number, dep: string): TravelOption => ({ ...flight(title, priceMinor, dep), journey: { ...flight(title, priceMinor, dep).journey!, depart_at: `2026-11-06T${dep}:00+05:30` } });
  const found: TravelSearch = { checkedAt: '2026-10-07T12:00:00.000Z', found: 3, results: [late('IndiGo 6E 2134', 420_000, '19:10'), late('Air India AI 2981', 389_000, '20:45'), late('Akasa QP 1846', 450_000, '21:30')] };
  function answer(text: string, search: Promise<TravelSearch> | null = Promise.resolve(found), live = false) {
    const line = msg(57, 'p_rahul', text);
    const pack = { ...goaPack(), messages: [...goaPack().messages, line] };
    const early = { searchFor: (_t: string, id: string): EarlySearch | null => (search && id === line.message_id ? { kind: 'flights', query, search, live } : null) };
    const cards: Array<{ cardId: string }> = [];
    const sets = new Map<string, Record<string, unknown>>();
    const results = {
      save: vi.fn(async (s: Record<string, unknown>) => {
        const set = { ...s, resultsId: 'r_direct1' };
        sets.set('r_direct1', set);
        return set as never;
      }),
      get: vi.fn(async (_t: string, id: string) => (sets.get(id) ?? null) as never),
      saveCard: vi.fn(async (row: { cardId: string }) => { cards.push(row); }),
      card: vi.fn(async () => null),
    };
    const puts: Array<Omit<DeskItem, 'id'> & { id?: string }> = [];
    const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push(item); } };
    const images = { rehostUrl: async (u: string) => u } as never;
    const run = earlyAnswer({
      early, results: results as never, images, travel: { waitMs: async () => null }, today: async () => '2026-10-07',
      now: () => new Date('2026-10-07T12:00:01Z'), desk, wait: async () => undefined,
    });
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d1', link: {} as never, pack, wake: [wakeFor(line.message_id, 57)], signal: new AbortController().signal });
    return { go: () => run({ tripId: 't_goa', wake: ctx.wake, pack, ctx }), ctx, results, puts, pack, images };
  }

  it('answers a plain ask whose early search found options: the card and a line from the data, nothing for the model', async () => {
    const a = answer('@Go flights Delhi to Goa Friday after 7 pm');
    expect(await a.go()).toBe(true);
    expect(a.ctx.lines).toEqual(['Flights Delhi to Goa on Fri 6 Nov, leaving after 7:00 pm, from ₹3,890 per person.']);
    expect(a.ctx.cards).toHaveLength(1);
    expect(a.ctx.cards[0]).toMatchObject({ kind: 'options', title: 'Flights, Delhi to Goa, 6 Nov' });
    // The three cheapest, by departure.
    expect((a.ctx.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['IndiGo 6E 2134', 'Air India AI 2981', 'Akasa QP 1846']);
    expect(a.ctx.answered).toBe(true);
  });

  it('on a card of stays from ixigo.com, puts "See all on ixigo" for the whole list the search read', async () => {
    const line = msg(58, 'p_priya', '@Go villas with a pool in North Goa');
    const pack = { ...goaPack(), messages: [...goaPack().messages, line] };
    const stay = (title: string, priceMinor: number): TravelOption => ({
      kind: 'stay', title, priceMinor, currency: 'INR', priceNote: 'per night, per room', highlights: ['Pool'], facts: { pool: true },
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    const page = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&filters=FL_HF_29';
    const stays: TravelSearch = { checkedAt: '2026-10-07T12:00:00.000Z', found: 4, page, results: [stay('Casa Azul', 980_000), stay('Meritas', 433_400), stay('Vedic Resort', 610_000), stay('HOLITEL', 520_000)] };
    const query = { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool' as const] };
    const saved: Array<Record<string, unknown>> = [];
    const run = earlyAnswer({
      early: { searchFor: (_t: string, id: string): EarlySearch | null => (id === line.message_id ? { kind: 'stays', query, search: Promise.resolve(stays), live: true } : null) },
      results: { save: async (s: Record<string, unknown>) => { saved.push(s); return { ...s, resultsId: 'r_direct2' } as never; }, saveCard: async () => undefined, card: async () => null } as never,
      images: { rehostUrl: async (u: string) => u } as never, travel: { waitMs: async () => null }, today: async () => '2026-10-07',
      now: () => new Date('2026-10-07T12:00:01Z'), wait: async () => undefined,
    });
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d2', link: {} as never, pack, wake: [wakeFor(line.message_id, 58)], signal: new AbortController().signal });
    expect(await run({ tripId: 't_goa', wake: ctx.wake, pack, ctx })).toBe(true);
    expect(saved[0]).toMatchObject({ page });
    expect(ctx.cards[0]).toMatchObject({ kind: 'options', title: 'Pool stays in North Goa, 6 to 9 Nov' });
    expect((ctx.cards[0] as { actions: Array<{ action_id: string }> }).actions.map((x) => x.action_id)).toEqual(['pick', 'vote', 'see_all']);
    // The engine's first three, in its order.
    expect((ctx.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['Casa Azul', 'Meritas', 'Vedic Resort']);
    expect(ctx.lines).toEqual(['Pool stays in North Goa for 6 to 9 Nov, from ₹4,334 a night.']);
  });

  it("5. leaves the turn to the model when nothing fits, the search failed or is still running, or it isn't a plain ask", async () => {
    expect(await answer('@Go flights Delhi to Goa Friday after 7 pm', Promise.resolve({ checkedAt: 'x', found: 4, results: [] })).go()).toBe(false);
    const failed = Promise.reject(new Error('ixigo took too long'));
    failed.catch(() => undefined);
    expect(await answer('@Go flights Delhi to Goa Friday after 7 pm', failed).go()).toBe(false);
    expect(await answer('@Go flights Delhi to Goa Friday after 7 pm', new Promise<TravelSearch>(() => undefined)).go()).toBe(false);
    const question = answer('@Go flights Delhi to Goa Friday after 7 pm, which is the best?');
    expect(await question.go()).toBe(false);
    expect(question.ctx.cards).toEqual([]);
    expect(question.results.save).not.toHaveBeenCalled();
    expect(await answer('@Go flights Delhi to Goa Friday after 7 pm', null).go()).toBe(false);
  });

  it("hands a plain ask's search still running over and says nothing, its live card in the room: one line, the card's, comes when it finishes", async () => {
    const run = later<TravelSearch>();
    const a = answer('@Go flights Delhi to Goa Friday after 7 pm', run.p, true);
    expect(await a.go()).toBe(true);
    // Nothing from this turn: the live card already said "On it.", and no model round can promise anything.
    expect(a.ctx.lines).toEqual([]);
    expect(a.ctx.cards).toEqual([]);
    expect(a.ctx.answered).toBe(true);
    run.resolve({ ...found, runId: 'run_d1' });
    await vi.waitFor(() => expect(a.puts).toHaveLength(1));
    // The wake that follows puts the card up with its line, with no model call.
    const wake = { ...a.puts[0]!, id: a.puts[0]!.id! } as DeskItem;
    const next = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d9', link: {} as never, pack: a.pack, wake: [wake], signal: new AbortController().signal });
    expect(await searchWakeAnswer({ results: a.results as never, images: a.images })({ tripId: 't_goa', wake: [wake], pack: a.pack, ctx: next })).toBe(true);
    expect(next.lines).toEqual(['Flights Delhi to Goa on Fri 6 Nov, leaving after 7:00 pm, from ₹3,890 per person.']);
    expect(next.cards).toHaveLength(1);
    expect((next.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['IndiGo 6E 2134', 'Air India AI 2981', 'Akasa QP 1846']);
  });

  it("on a stays card, says the card's own cheapest, never a cheaper stay the card leaves out (staging pass, 8 Oct)", async () => {
    const line = msg(59, 'p_priya', '@Go hotels in Goa');
    const pack = { ...goaPack(), messages: [...goaPack().messages, line] };
    const stay = (title: string, priceMinor: number): TravelOption => ({
      kind: 'stay', title, priceMinor, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {},
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    // ixigo's popular first: the cheapest of the twenty is fourth, off the card.
    const stays: TravelSearch = { checkedAt: '2026-10-07T12:00:00.000Z', found: 4, results: [stay('Miros', 2_233_300), stay('Saudades Homestays', 529_800), stay('Comfort Inn Elite', 559_600), stay('Budget Inn', 179_000)] };
    const query = { area: 'goa', checkIn: '2026-11-06', checkOut: '2026-11-09' };
    const run = earlyAnswer({
      early: { searchFor: (_t: string, id: string): EarlySearch | null => (id === line.message_id ? { kind: 'stays', query, search: Promise.resolve(stays), live: true } : null) },
      results: { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_direct3' }) as never, saveCard: async () => undefined, card: async () => null } as never,
      images: { rehostUrl: async (u: string) => u } as never, travel: { waitMs: async () => null }, today: async () => '2026-10-07',
      now: () => new Date('2026-10-07T12:00:01Z'), wait: async () => undefined,
    });
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_d3', link: {} as never, pack, wake: [wakeFor(line.message_id, 59)], signal: new AbortController().signal });
    expect(await run({ tripId: 't_goa', wake: ctx.wake, pack, ctx })).toBe(true);
    expect((ctx.cards[0] as { options: Array<{ title: string }> }).options.map((o) => o.title)).toEqual(['Miros', 'Saudades Homestays', 'Comfort Inn Elite']);
    expect(ctx.lines).toEqual(['Stays in Goa for 6 to 9 Nov, from ₹5,298 a night.']);
  });
});

