/**
 * The trip's budget, once the group decides one (Keshav, 9 Oct: "if users decide the budget it should stick to that").
 * Decided in the chat ("let's keep it under 20k each", kept with set_budget on the group's word); the App's budget answers
 * reach the turn on their own line (composer/trip-now.ts). It holds until the group changes it.
 *
 * Strong context, never a filter (Keshav, 9 Oct: "no enforcement, rather it should be naturally decided"): "Right now"
 * carries it every turn, and Go searches and picks with it in mind (composer/rules.ts), mostly within it, a standout a
 * little over shown and said to be over. Nothing here caps a search or drops a result.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type * as C from '@go/contract';
import type { NowProvider } from '../composer/context.js';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';

/** What a budget is for: the stay, getting there and back, or everything. */
export type BudgetCovers = 'stay' | 'travel' | 'whole_trip';

export interface TripBudget {
  /** Per person, in paise. */
  perPersonMinor: number;
  covers: BudgetCovers;
  /** chat: the group said it; app: the lowest band of the App's budget answers. */
  source: 'chat' | 'app';
  /** The message the group decided it in (chat only). */
  messageId: string | null;
}

export interface TripBudgets {
  /** The decided budget: the chat's, else the App's lowest band (its top), else null. */
  get(tripId: string, trip: Pick<C.Trip, 'budget'>): Promise<TripBudget | null>;
  set(tripId: string, b: { perPersonMinor: number; covers: BudgetCovers; messageId: string }): Promise<void>;
  clear(tripId: string): Promise<void>;
}

export function createTripBudgets(d: { pool: Pool; now: () => Date }): TripBudgets {
  return {
    async get(tripId, trip) {
      const r = await d.pool.query<{ per_person_minor: string; covers: BudgetCovers; message_id: string }>(
        'select per_person_minor, covers, message_id from trip_budgets where trip_id = $1',
        [tripId],
      );
      const row = r.rows[0];
      if (row) return { perPersonMinor: Number(row.per_person_minor), covers: row.covers, source: 'chat', messageId: row.message_id };
      // The App's answers: per person, stay plus food, flights separate. An open top band ("25k+") caps nothing.
      const top = trip.budget.lowest?.max_minor;
      return top ? { perPersonMinor: top, covers: 'stay', source: 'app', messageId: null } : null;
    },
    async set(tripId, b) {
      await d.pool.query(
        `insert into trip_budgets (trip_id, per_person_minor, covers, message_id, set_at) values ($1, $2, $3, $4, $5)
         on conflict (trip_id) do update set per_person_minor = excluded.per_person_minor, covers = excluded.covers,
           message_id = excluded.message_id, set_at = excluded.set_at`,
        [tripId, b.perPersonMinor, b.covers, b.messageId, d.now()],
      );
    },
    async clear(tripId) {
      await d.pool.query('delete from trip_budgets where trip_id = $1', [tripId]);
    },
  };
}

const rupees = (minor: number): string => `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
const COVERS_WORDS: Record<BudgetCovers, string> = { stay: 'the stay', travel: 'getting there and back', whole_trip: 'the whole trip' };

/** The budget's words, for "Right now" and the tools' notes. */
export function budgetWords(b: TripBudget): string {
  const what = b.source === 'app' ? 'the stay and food (the lowest band in the App answers, flights separate)' : COVERS_WORDS[b.covers];
  return `up to ${rupees(b.perPersonMinor)} per person for ${what}`;
}

/** "Right now": the decided budget, and that it holds. */
export function budgetNow(d: { budgets: TripBudgets; trip: (tripId: string) => Promise<Pick<C.Trip, 'budget'>> }): NowProvider {
  return {
    name: 'trip_budget',
    order: 12,
    async render(tripId) {
      const b = await d.budgets.get(tripId, await d.trip(tripId));
      if (!b || b.source !== 'chat') return null;
      return (
        `The trip's budget, decided in the chat: ${budgetWords(b)}. Search and pick with it in mind, mostly within it; ` +
        'anything you show over it, say so plainly. It holds until the group changes it.'
      );
    },
  };
}

const SetBudgetArgs = z
  .object({
    amount_rupees: z.number().positive().max(10_000_000).optional().describe('The budget, in rupees. Leave out with clear.'),
    per: z.enum(['person', 'group']).optional().describe('Per person (the default) or for the whole group.'),
    covers: z.enum(['stay', 'travel', 'whole_trip']).optional().describe('What it is for: the stay, getting there and back, or the whole trip (the default).'),
    clear: z.boolean().optional().describe('true: the group dropped its budget.'),
    proof_message_ids: z.array(z.string().min(1).max(64)).min(1).max(10).describe('The messages the group decided it in.'),
  })
  .strict();

const THUMBS_UP = /👍/;

/**
 * set_budget: the group's decided budget, kept for the trip, or dropped. The group's word only: the organizer's, or two
 * people's (a 👍 on the message counts). One person's wish stays their preference (a ✅), never the trip's budget.
 */
export function budgetTool(d: { budgets: TripBudgets }): QuickTool<z.infer<typeof SetBudgetArgs>> {
  return {
    name: 'set_budget',
    description:
      "Keeps the budget the group decided for the trip (\"let's keep it under 20k each\", \"let's go cheaper, 15k\"), so every " +
      'turn has it in mind, or drops it (clear). Only on the group\'s word: the organizer\'s, or two people agreeing.',
    input: SetBudgetArgs,
    claims: /\bbudget (?:is )?(?:set|saved|locked|noted|updated)\b/i,
    async run(a, ctx: TurnCtx) {
      const people = ctx.pack.trip.people;
      const proof = a.proof_message_ids.map((id) => ctx.pack.messages.find((m) => m.message_id === id));
      if (proof.some((m) => !m || m.deleted || m.author.kind !== 'person')) return { refused: 'a proof is not a person\'s message in this trip', tell_the_room: SAY_NOTHING };
      const yes = new Set<string>();
      for (const m of proof) {
        if (m!.author.kind === 'person') yes.add(m!.author.person_id);
        for (const r of m!.reactions) if (r.person_id && THUMBS_UP.test(r.emoji)) yes.add(r.person_id);
      }
      if (!(yes.has(ctx.pack.trip.organizer_person_id) || yes.size >= 2)) {
        return {
          refused: "one person's wish, not the group's",
          tell_the_room: "Take it as that person's wish (a ✅). It becomes the trip's budget once the organizer or a second person agrees. Don't say it is set.",
        };
      }
      if (a.clear) {
        await d.budgets.clear(ctx.tripId);
        return { cleared: true, tell_the_room: 'Say in a few words that you will stop keeping to a budget.' };
      }
      if (!a.amount_rupees) return { error: 'no_amount', note: 'Give amount_rupees, or clear.' };
      const perPerson = a.per === 'group' ? a.amount_rupees / Math.max(1, people.length) : a.amount_rupees;
      const b = { perPersonMinor: Math.round(perPerson * 100), covers: a.covers ?? 'whole_trip', messageId: a.proof_message_ids.at(-1)! };
      await d.budgets.set(ctx.tripId, b);
      return {
        saved: budgetWords({ ...b, source: 'chat' }),
        tell_the_room: 'Say in a few words that you will keep it in mind.',
      };
    },
  };
}
