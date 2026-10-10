import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as C from '@go/contract';
import { SAY_NOTHING, type TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createImages } from '../images.js';
import { createTravelLayer } from '../layer.js';
import { createFakeTravel } from '../mcp-travel.js';
import { createResultsStore } from '../results.js';
import { travelTools } from '../tools.js';
import { budgetNow, budgetTool, budgetWords, createTripBudgets, type TripBudgets } from '../trip-budget.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let budgets: TripBudgets;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  budgets = createTripBudgets({ pool: db.pool, now: lb.clock.now });
  const results = createResultsStore(db.pool);
  const store = new FakeIxigoStore({ now: lb.clock.now });
  const travel = createTravelLayer({ switches: lb.switches, now: lb.clock.now, fake: createFakeTravel({ store, now: lb.clock.now, payRail: () => 'fake' }), ixigo: null, results });
  for (const t of travelTools({ travel, results, images: createImages({ pool: db.pool, publicUrl: 'https://go.test' }), now: lb.clock.now })) lb.tools.register(t);
});
afterAll(async () => {
  await db.drop();
});

/** A trip as the budget reads it: the App's lowest band, or none. */
const tripWith = (lowest: { min_minor: number; max_minor: number | null } | null): Pick<C.TripSnapshot, 'budget'> =>
  ({ budget: { lowest: lowest ? { ...lowest, currency: 'INR' } : null, answered: lowest ? 3 : 0, of: 4 } }) as unknown as Pick<C.TripSnapshot, 'budget'>;
const NO_APP_BAND = tripWith(null);

describe('a decided budget is context for the turn, never a filter in code', () => {
  it('search_stays returns what it finds, over the budget too: Go picks with judgment, nothing is dropped for it', async () => {
    const tripId = 't_goa';
    const ask = { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5 };
    const perNight = (out: any): number[] => out.results.map((r: { price: string }) => Number(r.price.replace(/[^\d]/g, '')));
    const before = (await lb.tools.run('search_stays', ask, lb.ctx({ turnId: 'turn_b0' }))) as any;
    const dearest = Math.max(...perNight(before));
    // A stay budget the dearest of them is over: per person, for 5 people and 3 nights, just under its price a night.
    await budgets.set(tripId, { perPersonMinor: Math.floor(((dearest - 100) * 3 * 100) / 5), covers: 'stay', messageId: 'm_budget' });
    const after = (await lb.tools.run('search_stays', ask, lb.ctx({ turnId: 'turn_b1' }))) as any;
    // The same results, the stay over the budget still among them, and no budget note: the turn reads the budget from
    // "Right now" and picks with judgment.
    expect(after.results.map((r: { title: string }) => r.title)).toEqual(before.results.map((r: { title: string }) => r.title));
    expect(perNight(after)).toContain(dearest);
    expect(after.budget).toBeUndefined();
    await budgets.clear(tripId);
  });
});

describe('the decided budget, kept and read', () => {
  it("is the chat's when the group set one, else the App's lowest band (its top), else none", async () => {
    expect(await budgets.get('t_kept', NO_APP_BAND)).toBeNull();
    const app = tripWith({ min_minor: 1_000_000, max_minor: 1_500_000 });
    expect(await budgets.get('t_kept', app)).toEqual({ perPersonMinor: 1_500_000, covers: 'stay', source: 'app', messageId: null });
    // An open top band ("25k+") caps nothing.
    expect(await budgets.get('t_kept', tripWith({ min_minor: 2_500_000, max_minor: null }))).toBeNull();
    await budgets.set('t_kept', { perPersonMinor: 2_000_000, covers: 'whole_trip', messageId: 'm_9' });
    expect(await budgets.get('t_kept', app)).toEqual({ perPersonMinor: 2_000_000, covers: 'whole_trip', source: 'chat', messageId: 'm_9' });
    // Changed: the new one holds.
    await budgets.set('t_kept', { perPersonMinor: 1_500_000, covers: 'whole_trip', messageId: 'm_12' });
    expect((await budgets.get('t_kept', NO_APP_BAND))?.perPersonMinor).toBe(1_500_000);
    await budgets.clear('t_kept');
    expect(await budgets.get('t_kept', NO_APP_BAND)).toBeNull();
  });

  it('"Right now" says the chat\'s budget holds, and says nothing of the App\'s (its own line already has it)', async () => {
    const now = budgetNow({ budgets, trip: async () => NO_APP_BAND });
    expect(await now.render('t_now', [])).toBeNull();
    await budgets.set('t_now', { perPersonMinor: 2_000_000, covers: 'whole_trip', messageId: 'm_3' });
    expect(await now.render('t_now', [])).toBe(
      "The trip's budget, decided in the chat: up to ₹20,000 per person for the whole trip. Search and pick with it in mind, mostly within it; " +
        'anything you show over it, say so plainly. It holds until the group changes it.',
    );
    expect(budgetWords({ perPersonMinor: 1_500_000, covers: 'stay', source: 'app', messageId: null })).toBe(
      'up to ₹15,000 per person for the stay and food (the lowest band in the App answers, flights separate)',
    );
  });
});

describe('set_budget: the group\'s word only', () => {
  const msg = (id: string, personId: string, reactions: Array<{ person_id: string; emoji: string }> = []) => ({
    message_id: id, author: { kind: 'person', person_id: personId }, reactions, deleted: false, text: 'x',
  });
  const ctxWith = (messages: unknown[]): TurnCtx =>
    ({
      tripId: 't_set',
      pack: {
        trip: { organizer_person_id: 'p_rahul', people: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'].map((person_id) => ({ person_id })) },
        messages,
      },
    }) as unknown as TurnCtx;
  const tool = () => budgetTool({ budgets });

  it("keeps the organizer's word, or two people's (a 👍 counts); one person's alone is their wish", async () => {
    const one = await tool().run({ amount_rupees: 20_000, proof_message_ids: ['m_1'] }, ctxWith([msg('m_1', 'p_priya')]));
    expect(one).toMatchObject({ refused: "one person's wish, not the group's" });
    expect((one as { tell_the_room: string }).tell_the_room).toContain("Don't say it is set.");
    expect(await budgets.get('t_set', NO_APP_BAND)).toBeNull();

    const organizer = await tool().run({ amount_rupees: 20_000, covers: 'whole_trip', proof_message_ids: ['m_2'] }, ctxWith([msg('m_2', 'p_rahul')]));
    expect(organizer).toMatchObject({ saved: 'up to ₹20,000 per person for the whole trip' });
    const two = await tool().run({ amount_rupees: 15_000, covers: 'stay', proof_message_ids: ['m_3'] }, ctxWith([msg('m_3', 'p_priya', [{ person_id: 'p_arjun', emoji: '👍' }])]));
    expect(two).toMatchObject({ saved: 'up to ₹15,000 per person for the stay' });
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ perPersonMinor: 1_500_000, covers: 'stay', source: 'chat', messageId: 'm_3' });
  });

  it('a budget for the whole group is split per person; whole_trip by default; dropped on clear', async () => {
    await tool().run({ amount_rupees: 80_000, per: 'group', proof_message_ids: ['m_4'] }, ctxWith([msg('m_4', 'p_rahul')]));
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ perPersonMinor: 2_000_000, covers: 'whole_trip' });
    expect(await tool().run({ clear: true, proof_message_ids: ['m_5'] }, ctxWith([msg('m_5', 'p_rahul')]))).toMatchObject({ cleared: true });
    expect(await budgets.get('t_set', NO_APP_BAND)).toBeNull();
    // Proof must hold a person's message in the trip.
    expect(await tool().run({ amount_rupees: 1_000, proof_message_ids: ['m_missing'] }, ctxWith([]))).toMatchObject({ tell_the_room: SAY_NOTHING });
    // Go's own estimate cited beside the organizer's yes is passed over, not a refusal (staging drill, 10 Oct).
    const goMsg = { message_id: 'm_go', author: { kind: 'go' }, reactions: [], deleted: false, text: 'about 18k to 26k each' };
    const withGo = await tool().run({ amount_rupees: 26_000, proof_message_ids: ['m_go', 'm_6'] }, ctxWith([goMsg, msg('m_6', 'p_rahul')]));
    expect(withGo).toMatchObject({ saved: 'up to ₹26,000 per person for the whole trip' });
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ messageId: 'm_6' });
    // Go's message alone is no one's word.
    expect(await tool().run({ amount_rupees: 26_000, proof_message_ids: ['m_go'] }, ctxWith([goMsg]))).toMatchObject({ tell_the_room: SAY_NOTHING });
  });
});
