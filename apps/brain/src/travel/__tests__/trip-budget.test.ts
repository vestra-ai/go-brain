import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as C from '@go/contract';
import { SAY_NOTHING, type TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { FakeLink, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createImages } from '../images.js';
import { createTravelLayer } from '../layer.js';
import { createFakeTravel } from '../mcp-travel.js';
import { createResultsStore } from '../results.js';
import { travelTools } from '../tools.js';
import { WEIGH, budgetNow, budgetTool, budgetWords, createTripBudgets, stayCap, type TripBudgets } from '../trip-budget.js';

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
/** 1.1 (GO-TEAM-ASKS-REV4 A3): the group's one budget per person, as read_trip carries it. */
const groupOf = (minor: number): Pick<C.TripSnapshot, 'budget'> =>
  ({ budget: { lowest: { min_minor: minor, max_minor: minor, currency: 'INR' }, answered: 4, of: 4, per_person_minor: minor } }) as unknown as Pick<C.TripSnapshot, 'budget'>;

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

  // The Server team, 10 Oct (GO-TEAM-ASKS-REV4 A3): a trip has one budget per person, the group's, which the App holds.
  it("is the group's in the App (1.1) over an older band, yields a whole-trip chat budget to it, and never one for the stay", async () => {
    const group = groupOf(2_000_000);
    expect(await budgets.get('t_group', group)).toEqual({ perPersonMinor: 2_000_000, covers: 'whole_trip', source: 'group', messageId: null });
    // A whole-trip budget Go kept itself (its Server was before 1.1) yields: the App holds the trip's budget now.
    await budgets.set('t_group', { perPersonMinor: 1_500_000, covers: 'whole_trip', messageId: 'm_4' });
    expect(await budgets.get('t_group', group)).toMatchObject({ perPersonMinor: 2_000_000, source: 'group' });
    // One for the stay only is the chat's, beside the group's.
    await budgets.set('t_group', { perPersonMinor: 900_000, covers: 'stay', messageId: 'm_5' });
    expect(await budgets.get('t_group', group)).toMatchObject({ perPersonMinor: 900_000, covers: 'stay', source: 'chat' });
    await budgets.clear('t_group');
  });

  // As before 1.1 (#332): a stay budget from the chat, or the App's, picks ixigo's price bands for a stays search; a
  // whole-trip or travel one from the chat picks none. The budget is context, never Go's filter (Keshav, 9 Oct).
  it("picks ixigo's price bands with the App's budget or a stay budget from the chat, never a whole-trip or travel one from the chat", () => {
    const chat = (covers: 'stay' | 'travel' | 'whole_trip') => ({ perPersonMinor: 900_000, covers, source: 'chat' as const, messageId: 'm_1' });
    expect(stayCap(chat('stay'))).toBe(900_000);
    expect(stayCap(chat('whole_trip'))).toBeNull();
    expect(stayCap(chat('travel'))).toBeNull();
    expect(stayCap({ perPersonMinor: 2_000_000, covers: 'whole_trip', source: 'group', messageId: null })).toBe(2_000_000);
    expect(stayCap({ perPersonMinor: 1_500_000, covers: 'stay', source: 'app', messageId: null })).toBe(1_500_000);
    expect(stayCap(null)).toBeNull();
  });

  it('"Right now" says the chat\'s budget holds, and says nothing of the App\'s (its own line already has it)', async () => {
    const now = budgetNow({ budgets, trip: async () => NO_APP_BAND });
    expect(await now.render('t_now', [])).toBeNull();
    await budgets.set('t_now', { perPersonMinor: 2_000_000, covers: 'whole_trip', messageId: 'm_3' });
    expect(await now.render('t_now', [])).toBe(
      "The trip's budget, decided in the chat: up to ₹20,000 per person for the whole trip. Search and pick with it in mind, mostly within it; " +
        `anything you show over it, say so plainly. ${WEIGH} It holds until the group changes it.`,
    );
    expect(budgetWords({ perPersonMinor: 1_500_000, covers: 'stay', source: 'app', messageId: null })).toBe(
      'up to ₹15,000 per person for the stay and food (the lowest band in the App answers, flights separate)',
    );
    await budgets.clear('t_now');
  });

  it('"Right now" says the group\'s budget in the App holds, and names it beside a stay budget from the chat', async () => {
    const now = budgetNow({ budgets, trip: async () => groupOf(2_000_000) });
    expect(await now.render('t_now_group', [])).toBe(
      "The trip's budget, the group's in the App: up to ₹20,000 per person for the whole trip. Search and pick with it in mind, mostly within it; " +
        `anything you show over it, say so plainly. ${WEIGH} It holds until the group changes it.`,
    );
    await budgets.set('t_now_group', { perPersonMinor: 900_000, covers: 'stay', messageId: 'm_7' });
    expect(await now.render('t_now_group', [])).toBe(
      "The trip's budget, decided in the chat: up to ₹9,000 per person for the stay. Search and pick with it in mind, mostly within it; " +
        `anything you show over it, say so plainly. ${WEIGH} It holds until the group changes it. The group's budget in the App is up to ₹20,000 per person for the whole trip.`,
    );
    await budgets.clear('t_now_group');
  });
});

describe('set_budget: the group\'s yes only', () => {
  const msg = (id: string, personId: string, reactions: Array<{ person_id: string; emoji: string }> = [], text = 'x') => ({
    message_id: id, author: { kind: 'person', person_id: personId }, reactions, deleted: false, text,
  });
  /** Go's offer to keep a figure as the trip's budget, with Yes and No under it. */
  const offer = (id: string, reactions: Array<{ person_id: string; emoji: string }> = []) => ({
    message_id: id, author: { kind: 'go' }, reactions, deleted: false, text: "Set ₹20,000 a head as the trip's budget?",
    quick_replies: [{ label: 'Yes' }, { label: 'No' }],
  });
  let link = new FakeLink();
  /** A turn on the trip t_set (or another): the App holds `group` as its budget, or none. */
  const ctxWith = (messages: unknown[], o: { tripId?: string; group?: number } = {}): TurnCtx =>
    ({
      tripId: o.tripId ?? 't_set',
      link,
      outcome: { reactions: 0 },
      stableId: (prefix: string) => `${prefix}_turn_1`,
      pack: {
        trip: {
          organizer_person_id: 'p_rahul',
          people: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'].map((person_id) => ({ person_id })),
          budget: { answered: 0, of: 4, ...(o.group ? { per_person_minor: o.group } : {}) },
        },
        messages: (messages as object[]).map((m, i) => ({ seq: i + 1, ...m })),
      },
    }) as unknown as TurnCtx;
  const tool = () => budgetTool({ budgets, pool: db.pool, now: lb.clock.now, log: silentLog });
  // Each test on the Server it names: a 1.1 one takes the budget in update_trip; one before 1.1 refuses the field.
  const olderServer = () => {
    link.failNext = { method: 'update_trip', error: new Error('422 invalid: unknown field budget_per_person_minor') };
  };

  // The exam, 10 Oct: "@Go villa with a pool in North Goa for all 5 of us, 6 to 9 Nov, under 8k a head" (the organizer's)
  // is a search, not the trip's budget. One person's figure, the organizer's too, is offered first.
  it("one person's figure, the organizer's too, is offered, never kept: the offer's words come back", async () => {
    link = new FakeLink();
    const offerWords =
      'Use it for what was asked. If you haven\'t offered it yet, offer it once in one short line, "Set ₹20,000 a head as the trip\'s budget?", ' +
      "with Yes and No as offer_replies: it is kept on the organizer's yes or a second person's. " +
      'Never offer a person\'s own limit ("I can only do 5k"), and don\'t ask again after a no. Don\'t say it is set.';
    for (const who of ['p_priya', 'p_rahul']) {
      const one = await tool().run({ amount_rupees: 20_000, proof_message_ids: ['m_1'] }, ctxWith([msg('m_1', who)]));
      expect(one).toEqual({ refused: "one person's figure, not the group's yes", tell_the_room: offerWords });
    }
    // A figure for the whole group is offered per head.
    const group = await tool().run({ amount_rupees: 80_000, per: 'group', proof_message_ids: ['m_1'] }, ctxWith([msg('m_1', 'p_rahul')]));
    expect((group as { tell_the_room: string }).tell_the_room).toContain('"Set ₹20,000 a head as the trip\'s budget?"');
    // The one who named it saying yes to Go's offer is still one person.
    const own = await tool().run({ amount_rupees: 20_000, proof_message_ids: ['m_1', 'm_yes'] }, ctxWith([msg('m_1', 'p_priya'), offer('m_go'), msg('m_yes', 'p_priya', [], 'Yes')]));
    expect(own).toMatchObject({ refused: "one person's figure, not the group's yes" });
    // The organizer answering a question of Go's that offered no budget is no yes to one.
    const where = { message_id: 'm_where', author: { kind: 'go' }, reactions: [], deleted: false, text: 'North or South Goa?' };
    const other = await tool().run({ amount_rupees: 20_000, proof_message_ids: ['m_2'] }, ctxWith([where, msg('m_2', 'p_rahul', [], 'North, under 20k a head')]));
    expect(other).toMatchObject({ refused: "one person's figure, not the group's yes" });
    expect(await budgets.get('t_set', NO_APP_BAND)).toBeNull();
    // Never one Go made up: nothing goes to the App, and no ✅.
    expect(link.requests).toEqual([]);
  });

  it("keeps it on the organizer's yes to Go's offer (said next or tapped later), or two people's in words", async () => {
    link = new FakeLink();
    olderServer();
    const organizer = await tool().run(
      { amount_rupees: 20_000, covers: 'whole_trip', proof_message_ids: ['m_1', 'm_2'] },
      ctxWith([msg('m_1', 'p_rahul', [], 'villa under 20k a head'), offer('m_go'), msg('m_2', 'p_rahul', [], 'yes')]),
    );
    expect(organizer).toMatchObject({ saved: 'up to ₹20,000 per person for the whole trip', tell_the_room: "Say in one short line that it's the trip's budget now." });
    const two = await tool().run(
      { amount_rupees: 15_000, covers: 'stay', proof_message_ids: ['m_3a', 'm_3'] },
      ctxWith([msg('m_3a', 'p_priya', [], '15k a head for the stay?'), msg('m_3', 'p_arjun', [], '15k works for me')]),
    );
    expect(two).toMatchObject({ saved: 'up to ₹15,000 per person for the stay' });
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ perPersonMinor: 1_500_000, covers: 'stay', source: 'chat', messageId: 'm_3' });
    // The stay's budget is not the trip's: only the whole-trip one was offered to the App (refused there, so Go kept it).
    expect(link.sent('update_trip').map((p) => p.budget_per_person_minor)).toEqual([2_000_000]);
    // A ✅ on the message that settled it, each time.
    expect(link.sent('add_reaction').map((p) => [p.message_id, p.emoji])).toEqual([['m_2', '✅'], ['m_3', '✅']]);

    // A tap on the offer's Yes after someone else spoke is a yes too.
    olderServer();
    const tapped = await tool().run(
      { amount_rupees: 20_000, proof_message_ids: ['m_4', 'm_5'] },
      ctxWith([msg('m_4', 'p_rahul'), offer('m_go'), msg('m_x', 'p_priya', [], 'ooh'), msg('m_5', 'p_rahul', [], 'Yes')]),
    );
    expect(tapped).toMatchObject({ saved: 'up to ₹20,000 per person for the whole trip' });
  });

  // Keshav's ruling: a bare 👍 is never a decision. Not as a reaction on the figure or on Go's offer, and not sent alone.
  it('never keeps it on a 👍: on the figure, on Go\'s offer, or sent as a message of its own', async () => {
    link = new FakeLink();
    olderServer();
    const refused = { refused: "one person's figure, not the group's yes" };
    const onOffer = await tool().run({ amount_rupees: 20_000, proof_message_ids: ['m_6', 'm_go'] }, ctxWith([msg('m_6', 'p_rahul'), offer('m_go', [{ person_id: 'p_rahul', emoji: '👍' }])]));
    expect(onOffer).toMatchObject(refused);
    const onFigure = await tool().run({ amount_rupees: 15_000, proof_message_ids: ['m_7'] }, ctxWith([msg('m_7', 'p_priya', [{ person_id: 'p_arjun', emoji: '👍' }], '15k a head')]));
    expect(onFigure).toMatchObject(refused);
    const alone = await tool().run(
      { amount_rupees: 20_000, proof_message_ids: ['m_8', 'm_9'] },
      ctxWith([msg('m_8', 'p_priya', [], '20k a head'), offer('m_go'), msg('m_9', 'p_rahul', [], '👍')]),
    );
    expect(alone).toMatchObject(refused);
    // Nothing kept: no ✅ on any of them, and nothing sent to the App.
    expect(link.sent('add_reaction')).toEqual([]);
    expect(link.sent('update_trip')).toEqual([]);
  });

  // GO-TEAM-ASKS-REV4 B1: the App holds the trip's budget once its Server takes update_trip.budget_per_person_minor.
  it('sends a whole-trip budget to the App, which then holds it: Go keeps no copy, and a person clears it there', async () => {
    link = new FakeLink();
    await budgets.set('t_app', { perPersonMinor: 900_000, covers: 'stay', messageId: 'm_1' });
    const saved = await tool().run({ amount_rupees: 80_000, per: 'group', proof_message_ids: ['m_7', 'm_8'] }, ctxWith([msg('m_7', 'p_rahul'), offer('m_go'), msg('m_8', 'p_rahul', [], 'Yes')], { tripId: 't_app' }));
    expect(saved).toMatchObject({ saved: 'up to ₹20,000 per person for the whole trip' });
    expect(link.sent('update_trip')).toEqual([{ request_id: 'go_budget_turn_1', trip_id: 't_app', budget_per_person_minor: 2_000_000 }]);
    // The new budget replaces the stay's, and the App's is the one read from now on.
    expect(await budgets.get('t_app', NO_APP_BAND)).toBeNull();
    expect(await budgets.get('t_app', groupOf(2_000_000))).toMatchObject({ perPersonMinor: 2_000_000, source: 'group' });
    // Go can't clear the App's: it says the budget stays there until someone clears it.
    const clear = await tool().run({ clear: true, proof_message_ids: ['m_9'] }, ctxWith([msg('m_9', 'p_rahul')], { tripId: 't_app', group: 2_000_000 }));
    expect(clear).toMatchObject({ cleared: false, tell_the_room: expect.stringContaining('stays in the App until someone clears it there') });
    expect(link.sent('update_trip')).toHaveLength(1);
  });

  it('a budget for the whole group is split per person; whole_trip by default; dropped on clear', async () => {
    link = new FakeLink();
    olderServer();
    await tool().run(
      { amount_rupees: 80_000, per: 'group', proof_message_ids: ['m_4', 'm_4b'] },
      ctxWith([msg('m_4', 'p_rahul', [], '80k for all of us'), msg('m_4b', 'p_priya', [], 'yes, 80k in all works')]),
    );
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ perPersonMinor: 2_000_000, covers: 'whole_trip' });
    expect(await tool().run({ clear: true, proof_message_ids: ['m_5'] }, ctxWith([msg('m_5', 'p_rahul')]))).toMatchObject({ cleared: true });
    expect(await budgets.get('t_set', NO_APP_BAND)).toBeNull();
    // Proof must hold a person's message in the trip.
    expect(await tool().run({ amount_rupees: 1_000, proof_message_ids: ['m_missing'] }, ctxWith([]))).toMatchObject({ tell_the_room: SAY_NOTHING });
    // Go's own estimate cited beside the organizer's yes is passed over, not a refusal (staging drill, 10 Oct).
    const goMsg = { message_id: 'm_go', author: { kind: 'go' }, reactions: [], deleted: false, text: "About 18k to 26k each. Want me to make it the trip's budget?" };
    olderServer();
    const withGo = await tool().run({ amount_rupees: 26_000, proof_message_ids: ['m_go', 'm_6'] }, ctxWith([goMsg, msg('m_6', 'p_rahul')]));
    expect(withGo).toMatchObject({ saved: 'up to ₹26,000 per person for the whole trip' });
    expect(await budgets.get('t_set', NO_APP_BAND)).toMatchObject({ messageId: 'm_6' });
    // Go's message alone is no one's word.
    expect(await tool().run({ amount_rupees: 26_000, proof_message_ids: ['m_go'] }, ctxWith([goMsg]))).toMatchObject({ tell_the_room: SAY_NOTHING });
  });
});
