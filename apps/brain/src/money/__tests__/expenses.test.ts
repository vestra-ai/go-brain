import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reactionRequestId, reactOnce } from '../../memory/reactions.js';
import { SocketCallError } from '../../door/rpc.js';
import { amountsIn, readExpensesTool, recordExpenseTool, SPLIT_NOT_HERE, splitExpenseTool } from '../expenses.js';
import { goaTrip, moneyKit, runToolCalls, say, turnCtx, type MoneyKit } from './kit.js';

const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];

let k: MoneyKit;
beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

/** A turn whose chat holds these lines, #1 onward, with the two expense tools. */
function turn(lines: Array<[string, string]>) {
  const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'), lines.map(([who, text], i) => say(i + 1, who, text)));
  return { ctx, run: (calls: Array<{ name: string; input: unknown }>) => runToolCalls([recordExpenseTool({ pool: k.pool }), readExpensesTool()], ctx, calls) };
}

const expenses = () => k.server.writesOf('add_expense').map((w) => w.params);
const reactions = () => k.server.writesOf('add_reaction').map((w) => w.params);

describe('amounts a message says', () => {
  it('reads rupees with commas, a rupee sign, k and lakh', () => {
    expect(amountsIn('I paid 3,200 for the cab from the airport')).toContain(320000);
    expect(amountsIn('₹1,500 for the tickets')).toContain(150000);
    expect(amountsIn('dinner was 2.4k')).toContain(240000);
    expect(amountsIn('the villa advance, 1 lakh')).toContain(10000000);
    expect(amountsIn('I paid for the cab')).toEqual([]);
  });
});

describe('record_expense', () => {
  it('"I paid 3,200 for the cab" records the speaker paying, split between everyone, with a ✅ and nothing to say', async () => {
    const { ctx, run } = turn([['p_rahul', 'I paid 3,200 for the cab from the airport']]);
    const [out] = await run([
      { name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab from the airport', category: 'getting_around' } },
    ]);
    // No vault payment behind it, so no approval_id goes. It counts at once (GO-TEAM-ASKS-REV4 A2): nothing pending.
    expect(out).toMatchObject({ recorded: true, tell_the_room: expect.stringContaining('Stay quiet') });
    expect(out).not.toHaveProperty('pending');
    expect(expenses()[0]).not.toHaveProperty('approval_id');
    expect(expenses()).toEqual([
      expect.objectContaining({
        request_id: 'go_expense_m_1',
        paid_by_person_id: 'p_rahul',
        amount_minor: 320000,
        currency: 'INR',
        note: 'Cab from the airport',
        category: 'getting_around',
        split_person_ids: EVERYONE,
      }),
    ]);
    expect(reactions()).toEqual([expect.objectContaining({ message_id: 'm_1', emoji: '✅' })]);
    expect(ctx.outcome.reactions).toBe(1);
  });

  it('"Rahul owes me 1,500 for the tickets" records the speaker paying, split to Rahul only', async () => {
    const { run } = turn([['p_priya', 'Rahul owes me 1,500 for the tickets']]);
    await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 150000, for_what: 'Tickets', split_with: ['Rahul'] } }]);
    expect(expenses()).toEqual([
      expect.objectContaining({ paid_by_person_id: 'p_priya', amount_minor: 150000, split_person_ids: ['p_rahul'], category: 'other' }),
    ]);
  });

  it('"paid 2,400 for dinner for me and Meher" splits between the speaker and Meher', async () => {
    const { run } = turn([['p_arjun', 'paid 2,400 for dinner for me and Meher']]);
    await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 240000, for_what: 'Dinner', split_with: ['me', 'Meher'], category: 'food' } }]);
    expect(expenses()).toEqual([expect.objectContaining({ paid_by_person_id: 'p_arjun', split_person_ids: ['p_arjun', 'p_meher'] })]);
  });

  it('records once when the turn runs again, with the same request id from the message', async () => {
    const call = { name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab' } };
    await turn([['p_rahul', 'I paid 3,200 for the cab']]).run([call]);
    await turn([['p_rahul', 'I paid 3,200 for the cab']]).run([call]);
    expect(expenses()).toHaveLength(1);
    expect(reactions()).toHaveLength(1);
    expect(k.server.trip('t_goa').expenses).toHaveLength(1);
  });

  it("joins the reflex's quick ✅ on the same line: exactly one ✅ request, never a second one or a 409", async () => {
    const { ctx, run } = turn([['p_rahul', 'I paid 3,200 for the cab']]);
    // The reflex is quicker than a turn: its ✅ went first.
    expect(await reactOnce(k.pool, k.server, 't_goa', ctx.pack.messages[0]!, '✅')).toBe('sent');
    const [out] = await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab' } }]);
    expect(out).toMatchObject({ recorded: true });
    expect(expenses()).toHaveLength(1);
    expect(reactions()).toEqual([expect.objectContaining({ message_id: 'm_1', emoji: '✅', request_id: reactionRequestId('t_goa', 'm_1', '✅') })]);
    expect(ctx.outcome.reactions).toBe(0);
  });

  it('records nothing from an amount the message does not say, and says to ask', async () => {
    const { ctx, run } = turn([['p_rahul', 'I paid for the cab, will check the amount']]);
    const [out] = await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab' } }]);
    expect(out).toMatchObject({ refused: expect.stringContaining('does not say'), tell_the_room: expect.stringContaining('Ask the person one short question') });
    expect(expenses()).toEqual([]);
    expect(reactions()).toEqual([]);
    // The turn keeps the ✅ off the message Go asks about.
    expect(ctx.outcome.asked).toEqual(['m_1']);
    expect(ctx.outcome.noted ?? []).toEqual([]);
  });

  it('a recorded expense is noted by the turn, so a question in the same turn keeps its ✅', async () => {
    const { ctx, run } = turn([['p_rahul', 'I paid 3,200 for the cab']]);
    await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab' } }]);
    expect(ctx.outcome.noted).toEqual(['m_1']);
    expect(ctx.outcome.asked ?? []).toEqual([]);
  });

  it('records nothing when it cannot tell who shares the cost, and says to ask', async () => {
    const { run } = turn([['p_rahul', 'paid 900 for snacks for me and Sam']]);
    const [out] = await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 90000, for_what: 'Snacks', split_with: ['me', 'Sam'] } }]);
    expect(out).toMatchObject({ tell_the_room: expect.stringContaining('Ask the person') });
    expect(expenses()).toEqual([]);
  });

  it('never takes a payer from the model: the person who wrote the message paid', async () => {
    const { run } = turn([['p_kabir', 'I paid 600 for the boat tickets']]);
    const [out] = await run([
      { name: 'record_expense', input: { message_id: '#1', amount_minor: 60000, for_what: 'Boat', paid_by_person_id: 'p_rahul' } },
    ]);
    expect(out).toEqual({ error: 'the input did not match the tool' });
    await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 60000, for_what: 'Boat' } }]);
    expect(expenses()).toEqual([expect.objectContaining({ paid_by_person_id: 'p_kabir' })]);
  });

  it('never reaches the vault, a rail, a hold or a booking', async () => {
    const { run } = turn([['p_rahul', 'I paid 3,200 for the cab']]);
    await run([{ name: 'record_expense', input: { message_id: '#1', amount_minor: 320000, for_what: 'Cab' } }]);
    expect(k.vault.payLinks).toEqual([]);
    expect(k.vault.voids).toEqual([]);
    expect(k.travel.holds).toEqual([]);
    expect(k.travel.confirms).toEqual([]);
    expect(k.server.writesOf('request_spend_approval')).toEqual([]);
    expect(k.server.writesOf('add_booking')).toEqual([]);
  });
});

describe('who_owes_what', () => {
  it("answers from the Server's expenses and balances, not from the chat", async () => {
    const trip = goaTrip('confirmed');
    trip.expenses.push(
      C.Expense.parse({
        expense_id: 'e_cab', paid_by_person_id: 'p_rahul', amount_minor: 320000, currency: 'INR', note: 'Cab from the airport',
        category: 'getting_around', split_person_ids: EVERYONE, created_at: '2026-10-05T08:00:00Z',
      }),
      C.Expense.parse({
        expense_id: 'e_tix', paid_by_person_id: 'p_priya', amount_minor: 150000, currency: 'INR', note: 'Tickets',
        category: 'other', split_person_ids: ['p_rahul'], created_at: '2026-10-05T08:10:00Z',
      }),
    );
    trip.money = { ...trip.money, spent_minor: 470000, transfers: [{ from_person_id: 'p_arjun', to_person_id: 'p_rahul', amount_minor: 64000, currency: 'INR' }] };
    k.server.trips.set('t_goa', trip);
    // The turn's own copy of the trip knows nothing about money: the answer must come from the Server.
    const ctx = turnCtx('t_goa', k.server, goaTrip('confirmed'), [say(1, 'p_meher', 'who owes what so far?')]);
    const [out] = await runToolCalls([recordExpenseTool({ pool: k.pool }), readExpensesTool()], ctx, [{ name: 'who_owes_what', input: {} }]);
    expect(out).toMatchObject({
      spent_in_all: '₹4,700',
      paid_by: [{ name: 'Rahul', paid: '₹3,200' }, { name: 'Priya', paid: '₹1,500' }],
      owes: [{ from: 'Arjun', to: 'Rahul', amount: '₹640' }],
      expenses: [
        { for: 'Cab from the airport', paid_by: 'Rahul', amount: '₹3,200', shared_by: 'everyone' },
        { for: 'Tickets', paid_by: 'Priya', amount: '₹1,500', shared_by: 'Rahul' },
      ],
    });
    expect(k.server.writesOf('read_trip')).toHaveLength(1);
  });

  // GO-TEAM-ASKS-REV4 A2 (the Server team, 10 Oct): expense approval was withdrawn, and every expense counts from when it
  // is added. An older Server's answers on an expense still read, and Go says nothing of them.
  it('reads every expense as counted: no status, nobody waited on, no dispute, even when an older Server sends them', async () => {
    const trip = goaTrip('confirmed');
    trip.expenses.push(
      C.Expense.parse({
        expense_id: 'e_cab', paid_by_person_id: 'p_kabir', amount_minor: 340000, currency: 'INR', note: 'Airport cab', category: 'getting_around',
        split_person_ids: EVERYONE, created_at: '2026-10-09T13:20:00Z', status: 'disputed',
        confirmations: [
          { person_id: 'p_rahul', state: 'approved', at: '2026-10-10T08:10:00Z' },
          { person_id: 'p_priya', state: 'disputed', at: '2026-10-10T08:40:00Z', reason: 'I took the bus' },
          { person_id: 'p_arjun', state: 'pending' },
          { person_id: 'p_meher', state: 'pending' },
        ],
      }),
      C.Expense.parse({
        expense_id: 'e_dinner', paid_by_person_id: 'p_priya', amount_minor: 250000, currency: 'INR', note: 'Dinner', category: 'food',
        split_person_ids: ['p_priya', 'p_meher'], created_at: '2026-10-09T20:00:00Z', status: 'pending',
        confirmations: [{ person_id: 'p_meher', state: 'pending' }],
      }),
      C.Expense.parse({
        expense_id: 'e_villa', paid_by_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', note: 'Villa Sol', category: 'stay',
        split_person_ids: EVERYONE, created_at: '2026-10-08T10:00:00Z', status: 'approved',
      }),
    );
    k.server.trips.set('t_goa', trip);
    const ctx = turnCtx('t_goa', k.server, goaTrip('confirmed'), [say(1, 'p_arjun', 'who owes what now?')]);
    const [out] = (await runToolCalls([readExpensesTool()], ctx, [{ name: 'who_owes_what', input: {} }])) as Array<{ expenses: Array<Record<string, unknown>>; tell_the_room: string }>;
    const byFor = Object.fromEntries(out!.expenses.map((e) => [e['for'], e]));
    // Its id too, for split_expense to name it (Saket's trip, 12 Oct).
    for (const e of Object.values(byFor)) expect(Object.keys(e).sort()).toEqual(['amount', 'for', 'id', 'paid_by', 'shared_by']);
    expect(Object.keys(byFor).sort()).toEqual(['Airport cab', 'Dinner', 'Villa Sol']);
    expect(out!.tell_the_room).not.toMatch(/pending|disput|approve/i);
    expect(JSON.stringify(out)).not.toContain('I took the bus');
  });

  it('says nothing is recorded yet when there is nothing', async () => {
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const [out] = await runToolCalls([readExpensesTool()], ctx, [{ name: 'who_owes_what', input: {} }]);
    expect(out).toMatchObject({ paid_by: [], owes: [], tell_the_room: expect.stringContaining('Nothing is recorded yet') });
  });
});

describe('the tools say what they do', () => {
  it('record and read, and never move money between people, with no em dash and no model name', () => {
    for (const t of [recordExpenseTool({ pool: k.pool }), readExpensesTool()]) {
      expect(t.description).toContain('never move money between people');
      expect(t.description).not.toMatch(/[—–]|Claude/);
    }
  });
});

// Saket's trip (t_b25c5123e4cabd59, 11 Oct): on "Yes, split evenly" Go could only add_expense, so it added a second ₹24,846
// split 1 way beside the ₹49,692 stay split to Saket alone, and the trip's spend read ₹91,829 instead of ₹66,983.
describe('split_expense', () => {
  /** The stay Rahul paid, split to him alone, and the chat's lines; the turn's own trip knows no money. */
  function stayTurn(lines: Array<[string, string]>, more: C.Expense[] = []) {
    const trip = goaTrip('confirmed');
    trip.expenses.push(
      C.Expense.parse({
        expense_id: 'e_villa', paid_by_person_id: 'p_rahul', amount_minor: 4969200, currency: 'INR', note: 'Villa Sol, 3 nights', category: 'stay',
        split_person_ids: ['p_rahul'], created_at: '2026-10-11T10:00:00Z',
      }),
      ...more,
    );
    k.server.trips.set('t_goa', trip);
    const ctx = turnCtx('t_goa', k.server, goaTrip('confirmed'), lines.map(([who, text], i) => say(i + 1, who, text)));
    return { ctx, run: (calls: Array<{ name: string; input: unknown }>) => runToolCalls([recordExpenseTool({ pool: k.pool }), splitExpenseTool({ pool: k.pool }), readExpensesTool()], ctx, calls) };
  }
  const updates = () => k.server.writesOf('update_expense').map((w) => w.params);

  it('"Yes, split evenly" changes the expense that stands to everyone, never adds a second, with a ✅', async () => {
    const { ctx, run } = stayTurn([['p_priya', 'Yes, split evenly']]);
    const [out] = await run([{ name: 'split_expense', input: { message_id: '#1', expense: 'Villa Sol, 3 nights' } }]);
    expect(out).toMatchObject({ changed: true, expense: 'Villa Sol, 3 nights', amount: '₹49,692', shared_by: 'everyone' });
    expect(updates()).toEqual([{ request_id: 'go_split_m_1_e_villa', trip_id: 't_goa', expense_id: 'e_villa', split_person_ids: EVERYONE }]);
    expect(expenses()).toEqual([]);
    expect(k.server.trip('t_goa').expenses).toHaveLength(1);
    expect(reactions()).toEqual([expect.objectContaining({ message_id: 'm_1', emoji: '✅' })]);
    expect(ctx.outcome.noted).toEqual(['m_1']);
  });

  it('names the expense by its id, and splits it with the people named, "me" the asker', async () => {
    const { run } = stayTurn([['p_priya', 'split the villa between me and Kabir']]);
    const [out] = await run([{ name: 'split_expense', input: { message_id: '#1', expense: 'e_villa', split_with: ['me', 'Kabir'] } }]);
    expect(out).toMatchObject({ changed: true, shared_by: 'Priya, Kabir' });
    expect(updates()).toEqual([expect.objectContaining({ expense_id: 'e_villa', split_person_ids: ['p_priya', 'p_kabir'] })]);
  });

  it('asks the model for the id when the words name more than one, and changes nothing already split that way', async () => {
    const cab = (id: string, note: string) =>
      C.Expense.parse({ expense_id: id, paid_by_person_id: 'p_kabir', amount_minor: 120000, currency: 'INR', note, category: 'getting_around', split_person_ids: ['p_kabir'], created_at: '2026-10-11T11:00:00Z' });
    const { run } = stayTurn([['p_kabir', 'split the cab evenly']], [cab('e_cab1', 'Cab to the airport'), cab('e_cab2', 'Cab from the airport')]);
    const [out] = await run([{ name: 'split_expense', input: { message_id: '#1', expense: 'cab' } }]);
    expect(out).toMatchObject({ refused: expect.stringContaining('Not sure which'), expenses: [{ id: 'e_cab1' }, { id: 'e_cab2' }] });
    expect(updates()).toEqual([]);
    const [same] = await run([{ name: 'split_expense', input: { message_id: '#1', expense: 'e_villa', split_with: ['Rahul'] } }]);
    expect(same).toMatchObject({ changed: false });
    expect(updates()).toEqual([]);
  });

  it('an older Server without update_expense: said plainly, and never a second expense instead', async () => {
    const { run } = stayTurn([['p_priya', 'Yes, split evenly']]);
    k.server.failNext.set('update_expense', new SocketCallError(-32601, 'unknown method update_expense'));
    const [out] = await run([{ name: 'split_expense', input: { message_id: '#1', expense: 'Villa Sol, 3 nights' } }]);
    expect(out).toMatchObject({ refused: expect.any(String), tell_the_room: SPLIT_NOT_HERE });
    expect(SPLIT_NOT_HERE).toContain('Never record a new expense for it');
    expect(expenses()).toEqual([]);
    expect(reactions()).toEqual([]);
  });

  it('is the tool for a new split, and record_expense says so', () => {
    expect(splitExpenseTool({ pool: k.pool }).description).toContain('It changes that expense, never adds another: never record_expense for this');
    expect(recordExpenseTool({ pool: k.pool }).description).toContain('Never to change how a cost already recorded is split');
  });
});
