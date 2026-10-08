import * as C from '@go/contract';
import type { Pool } from 'pg';
import { z } from 'zod';
import { inlineData } from '../composer/fence.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { Message, Trip } from '../door/methods.js';
import { reactOnce } from '../memory/reactions.js';
import { rid } from './ids.js';
import { clip, money, plain } from './words.js';

/**
 * What people in the chat say they paid for the group, kept as the trip's expenses on the Server, and who owes whom read
 * back from the Server. Go records and reads; it never moves money between people, and nothing here reaches the vault.
 */

/** "#57", "57" or a message id. */
function findMessage(messages: Message[], ref: string): Message | undefined {
  const n = /^#?(\d+)$/.exec(ref.trim());
  return n ? messages.find((m) => m.seq === Number(n[1])) : messages.find((m) => m.message_id === ref);
}

const AMOUNT = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|l)?\b/gi;
const UNITS: Record<string, number> = { k: 1_000, thousand: 1_000, l: 100_000, lakh: 100_000, lac: 100_000 };

/** Every amount a message says, in minor units: "3,200", "₹3200", "1.5k", "2 lakh". */
export function amountsIn(text: string): number[] {
  const out = new Set<number>();
  for (const hit of text.matchAll(AMOUNT)) {
    const major = Number((hit[1] ?? '').replace(/,/g, '')) * (UNITS[(hit[2] ?? '').toLowerCase()] ?? 1);
    if (Number.isFinite(major) && major > 0) out.add(Math.round(major * 100));
  }
  return [...out];
}

/** A person in the trip by id, full name or first name ("me" is the speaker). Null when nobody or more than one matches. */
function personOf(trip: Trip, said: string, speakerId: string): string | null {
  const s = said.trim().toLowerCase();
  if (s === 'me' || s === 'i' || s === 'myself') return speakerId;
  const exact = trip.people.filter((p) => p.person_id === said.trim() || p.name.toLowerCase() === s);
  if (exact.length === 1) return exact[0]?.person_id ?? null;
  const first = trip.people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === s);
  return first.length === 1 ? (first[0]?.person_id ?? null) : null;
}

export const RecordExpenseInput = z.strictObject({
  message_id: z.string().min(1).max(64).describe('The message where the person said what they paid, like "#57". They are the one who paid.'),
  amount_minor: z.int().positive().describe('What they paid, in paise (minor units): ₹3,200 is 320000. Exactly the amount the message says.'),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Leave it out for the trip's currency."),
  for_what: z.string().min(1).max(120).describe('What it was for, in a few words, like "Cab from the airport".'),
  split_with: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(30)
    .optional()
    .describe(
      'Who shares the cost, by first name ("me" for the person who paid, if they share it). Leave it out when it was for ' +
        'everyone in the trip. "Rahul owes me 1,500 for the tickets" is just ["Rahul"].',
    ),
  category: C.Category.optional().describe('stay, food, getting_around, activities or other (the default).'),
});
export type RecordExpenseInput = z.infer<typeof RecordExpenseInput>;

const QUIET = 'Nothing to say: it is recorded and the message has a ✅. Stay quiet unless someone asked you something.';
const ASK = 'Do not record anything. Ask the person one short question to get it right.';

/**
 * Records one expense from what a person said they paid, with a request id made from their message, so a rerun records
 * it once. The payer is always the person who wrote the message; the amount must be one the message says.
 */
export async function recordExpense(ctx: Pick<TurnCtx, 'tripId' | 'link' | 'pack' | 'outcome'>, a: RecordExpenseInput, pool: Pool): Promise<object> {
  const m = findMessage(ctx.pack.messages, a.message_id);
  if (!m || m.deleted || m.withheld || m.author.kind !== 'person' || !m.text) return { refused: `There is no message ${a.message_id} from a person to record.`, tell_the_room: ASK };
  const trip = ctx.pack.trip;
  const payer = m.author.person_id;
  // Go asks instead of recording: the turn keeps the ✅ off this message.
  const ask = (why: string) => {
    (ctx.outcome.asked ??= []).push(m.message_id);
    return { refused: why, tell_the_room: ASK };
  };
  if (!trip.people.some((p) => p.person_id === payer)) return ask('The person who wrote that is not in the trip.');
  if (!amountsIn(m.text).includes(a.amount_minor)) {
    return ask(`That message does not say ${money(a.amount_minor, a.currency ?? trip.money.currency)}.`);
  }
  let split: string[];
  if (a.split_with) {
    const ids = a.split_with.map((s) => personOf(trip, s, payer));
    if (ids.some((id) => id === null)) return ask(`Not sure who ${a.split_with.join(', ')} is in this trip.`);
    split = [...new Set(ids as string[])];
  } else {
    split = trip.people.map((p) => p.person_id);
  }
  const r = await ctx.link.request('add_expense', {
    request_id: rid('go_expense', m.message_id),
    trip_id: ctx.tripId,
    paid_by_person_id: payer,
    amount_minor: a.amount_minor,
    currency: a.currency ?? trip.money.currency,
    note: clip(plain(a.for_what), 120),
    category: a.category ?? 'other',
    split_person_ids: split,
  });
  (ctx.outcome.noted ??= []).push(m.message_id);
  // The same path as every ✅ Go sends: one that the reflex already put on this line is joined, never sent twice. A ✅
  // that did not go through leaves the expense recorded either way.
  if ((await reactOnce(pool, ctx.link, ctx.tripId, m, '✅')) === 'sent') ctx.outcome.reactions += 1;
  // 1.1 B4: with no vault payment behind it, the Server records it pending, for the people it is split between to
  // approve or dispute in the App: never final, and never something Go chases.
  return { recorded: true, expense_id: r.expense_id, pending: true, tell_the_room: QUIET };
}

/** Who paid what and who owes whom, read from the Server's expenses and balances, never from the chat. */
export async function readExpenses(ctx: Pick<TurnCtx, 'tripId' | 'link'>): Promise<object> {
  const trip = await ctx.link.request('read_trip', { trip_id: ctx.tripId });
  const cur = trip.money.currency;
  const nameOf = (id: string) => trip.people.find((p) => p.person_id === id)?.name ?? 'someone who left';
  const everyone = new Set(trip.people.map((p) => p.person_id));
  const paid = new Map<string, number>();
  for (const e of trip.expenses) if (e.currency === cur) paid.set(e.paid_by_person_id, (paid.get(e.paid_by_person_id) ?? 0) + e.amount_minor);
  const shared = (ids: string[]) => (ids.length === everyone.size && ids.every((id) => everyone.has(id)) ? 'everyone' : ids.map(nameOf).join(', '));
  return {
    spent_in_all: money(trip.money.spent_minor, cur),
    paid_by: [...paid].map(([id, minor]) => ({ name: nameOf(id), paid: money(minor, cur) })),
    owes: trip.money.transfers.map((t) => ({ from: nameOf(t.from_person_id), to: nameOf(t.to_person_id), amount: money(t.amount_minor, t.currency) })),
    expenses: trip.expenses.slice(-15).map((e) => ({
      for: e.note, paid_by: nameOf(e.paid_by_person_id), amount: money(e.amount_minor, e.currency), shared_by: shared(e.split_person_ids),
      ...answersOf(e, nameOf),
    })),
    tell_the_room:
      trip.expenses.length === 0
        ? 'Nothing is recorded yet. Say so in one short line.'
        : 'Answer from these numbers only, in one or two short lines. You never move money between people; the App settles up. ' +
          'An expense still pending is not final until the people it is split between approve it in the App. ' +
          'Never press anyone about one they disputed: you may say who disputed it and why, when it matters.',
  };
}

/**
 * Where an expense stands with the people it is split between (1.1 B4): pending until they approve it in the App, or
 * disputed by someone, with their reason in their words (fenced). Nothing for a 1.0 Server, which asks nobody.
 */
function answersOf(e: Trip['expenses'][number], nameOf: (id: string) => string): Record<string, unknown> {
  if (!e.status) return {};
  const waiting = (e.confirmations ?? []).filter((c) => c.state === 'pending').map((c) => nameOf(c.person_id));
  const disputed = (e.confirmations ?? [])
    .filter((c) => c.state === 'disputed')
    .map((c) => ({ by: nameOf(c.person_id), ...(c.reason ? { why: inlineData(c.reason, 200) } : {}) }));
  return {
    status: e.status,
    ...(e.status === 'pending' && waiting.length ? { waiting_on: waiting } : {}),
    ...(disputed.length ? { disputed } : {}),
  };
}

export function recordExpenseTool(o: { pool: Pool }): QuickTool<RecordExpenseInput> {
  return {
    name: 'record_expense',
    description:
      'Record what someone in the group says they paid for the group, or that someone owes them ("I paid 3,200 for the cab", ' +
      '"Rahul owes me 1,500 for the tickets"). The person who wrote the message is the payer. It adds a ✅ to their message. ' +
      'Only from what they clearly said: if the amount or who it was for is unclear, ask instead. You record costs; you never move money between people.',
    input: RecordExpenseInput,
    run: (a, ctx) => recordExpense(ctx, a, o.pool),
  };
}

export function readExpensesTool(): QuickTool<Record<string, never>> {
  return {
    name: 'who_owes_what',
    description:
      'Read who paid what and who owes whom, from the trip\'s recorded expenses and balances. Use it to answer any question ' +
      'about money between people in the group. You never move money between people; the App settles up.',
    input: z.strictObject({}) as unknown as z.ZodType<Record<string, never>>,
    run: (_a, ctx) => readExpenses(ctx),
  };
}
