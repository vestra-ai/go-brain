/**
 * The trip's budget, once the group decides one (Keshav, 9 Oct: "if users decide the budget it should stick to that").
 * Since 10 Oct (the Server team's GO-TEAM-ASKS-REV4, A3 and B1) a trip has one budget per person, the group's, which the
 * App holds: set there by a person, or by Go when the group settles one in the chat (set_budget writes it with
 * update_trip). Go keeps a chat budget itself only when the App can't hold it: one for the stay or getting there only, or
 * any on a Server before 1.1. It holds until the group changes it.
 *
 * Strong context, never a filter (Keshav, 9 Oct: "no enforcement, rather it should be naturally decided"): "Right now"
 * carries it every turn, and Go searches and picks with it in mind (composer/rules.ts), mostly within it, a standout a
 * little over shown and said to be over. Go never drops a result for it. A stays budget does pick ixigo's own price
 * bands for a stays read, one band over kept, and the read without them when they hold nothing (recipes/backend.ts).
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type * as C from '@go/contract';
import type { NowProvider } from '../composer/context.js';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import type { Log } from '../log.js';
import { reactOnce } from '../memory/reactions.js';
import { saveTrip } from '../trips/save-trip.js';

/** What a budget is for: the stay, getting there and back, or everything. */
export type BudgetCovers = 'stay' | 'travel' | 'whole_trip';

export interface TripBudget {
  /** Per person, in paise. */
  perPersonMinor: number;
  covers: BudgetCovers;
  /**
   * chat: the group said it and Go keeps it; group: the group's budget the App holds (1.1, for the whole trip); app: the
   * lowest band of the App's budget answers (a Server before 1.1).
   */
  source: 'chat' | 'group' | 'app';
  /** The message the group decided it in (chat only). */
  messageId: string | null;
}

export interface TripBudgets {
  /** The decided budget: the chat's Go keeps, else the group's in the App, else the App's lowest band (its top), else null. */
  get(tripId: string, trip: Pick<C.TripSnapshot, 'budget'>): Promise<TripBudget | null>;
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
      const group = trip.budget.per_person_minor;
      // A whole-trip budget Go kept itself yields to the App's: the App holds the trip's budget once its Server can (1.1).
      if (row && !(group && row.covers === 'whole_trip')) {
        return { perPersonMinor: Number(row.per_person_minor), covers: row.covers, source: 'chat', messageId: row.message_id };
      }
      if (group) return { perPersonMinor: group, covers: 'whole_trip', source: 'group', messageId: null };
      // A Server before 1.1, the App's answers: per person, stay plus food, flights separate. An open top band ("25k+") caps nothing.
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

/**
 * A stays search's budget a head: a stay never costs more than the budget it is part of, so any budget but one for getting
 * there and back caps it (ixigo's own price bands, recipes/backend.ts).
 */
export function stayCap(b: TripBudget | null): number | null {
  return b && b.covers !== 'travel' ? b.perPersonMinor : null;
}

/** "Right now": the decided budget, and that it holds. The App's lowest band before 1.1 has its own line (composer/trip-now.ts). */
export function budgetNow(d: { budgets: TripBudgets; trip: (tripId: string) => Promise<Pick<C.TripSnapshot, 'budget'>> }): NowProvider {
  return {
    name: 'trip_budget',
    order: 12,
    async render(tripId) {
      const trip = await d.trip(tripId);
      const b = await d.budgets.get(tripId, trip);
      if (!b || b.source === 'app') return null;
      const group = trip.budget.per_person_minor;
      // One for the stay or travel kept from the chat, beside the group's in the App: both hold.
      const also = b.source === 'chat' && group ? ` The group's budget in the App is ${budgetWords({ perPersonMinor: group, covers: 'whole_trip', source: 'group', messageId: null })}.` : '';
      return (
        `The trip's budget, ${b.source === 'chat' ? 'decided in the chat' : "the group's in the App"}: ${budgetWords(b)}. Search and pick with it in mind, mostly within it; ` +
        `anything you show over it, say so plainly. It holds until the group changes it.${also}`
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
 * A budget for the whole trip goes to the App (update_trip, 1.1 B1), which then holds it; Go keeps it itself only when
 * the App didn't take it (a Server before 1.1), and keeps any other.
 */
export function budgetTool(d: { budgets: TripBudgets; pool: Pool; now: () => Date; log: Log }): QuickTool<z.infer<typeof SetBudgetArgs>> {
  return {
    name: 'set_budget',
    description:
      "Keeps the budget the group decided for the trip (\"let's keep it under 20k each\", \"let's go cheaper, 15k\"), so every " +
      'turn has it in mind, or drops it (clear). Only on the group\'s word: the organizer\'s, or two people agreeing.',
    input: SetBudgetArgs,
    claims: /\bbudget (?:is )?(?:set|saved|locked|noted|updated)\b/i,
    async run(a, ctx: TurnCtx) {
      const people = ctx.pack.trip.people;
      // The people's messages among the proof: Go's own estimate cited beside their yes is passed over, never a refusal
      // (staging drill, 10 Oct: refused twice for it, the turn ran out of rounds).
      const proof = a.proof_message_ids
        .map((id) => ctx.pack.messages.find((m) => m.message_id === id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.deleted && m.author.kind === 'person');
      if (proof.length === 0) {
        return { refused: "no person's message in this trip among the proof: give the message ids of the people's own words", tell_the_room: SAY_NOTHING };
      }
      const yes = new Set<string>();
      for (const m of proof) {
        if (m.author.kind === 'person') yes.add(m.author.person_id);
        for (const r of m.reactions) if (r.person_id && THUMBS_UP.test(r.emoji)) yes.add(r.person_id);
      }
      if (!(yes.has(ctx.pack.trip.organizer_person_id) || yes.size >= 2)) {
        return {
          refused: "one person's wish, not the group's",
          tell_the_room: "Take it as that person's wish (a ✅). It becomes the trip's budget once the organizer or a second person agrees. Don't say it is set.",
        };
      }
      if (a.clear) {
        await d.budgets.clear(ctx.tripId);
        // Go cannot clear the App's: a person does, in the App.
        if (ctx.pack.trip.budget.per_person_minor) {
          return { cleared: false, tell_the_room: "Say in one short line that the budget stays in the App until someone clears it there." };
        }
        return { cleared: true, tell_the_room: 'Say in a few words that you will stop keeping to a budget.' };
      }
      if (!a.amount_rupees) return { error: 'no_amount', note: 'Give amount_rupees, or clear.' };
      const perPerson = a.per === 'group' ? a.amount_rupees / Math.max(1, people.length) : a.amount_rupees;
      const said = proof.at(-1)!;
      const b = { perPersonMinor: Math.round(perPerson * 100), covers: a.covers ?? 'whole_trip', messageId: said.message_id };
      if (b.covers === 'whole_trip' && (await toApp(d, ctx, b.perPersonMinor))) await d.budgets.clear(ctx.tripId);
      else await d.budgets.set(ctx.tripId, b);
      (ctx.outcome.noted ??= []).push(said.message_id);
      if ((await reactOnce(d.pool, ctx.link, ctx.tripId, said, '✅')) === 'sent') ctx.outcome.reactions += 1;
      return {
        saved: budgetWords({ ...b, source: 'chat' }),
        tell_the_room: "Say in one short line that it's the trip's budget now.",
      };
    },
  };
}

/** The trip's budget written to the App (update_trip, 1.1 B1); false when the Server didn't take it (one before 1.1). */
async function toApp(d: { pool: Pool; now: () => Date; log: Log }, ctx: TurnCtx, perPersonMinor: number): Promise<boolean> {
  try {
    const r = await saveTrip(d, { link: ctx.link, tripId: ctx.tripId, pack: ctx.pack, requestId: () => ctx.stableId('go_budget') }, { budgetPerPersonMinor: perPersonMinor });
    return r.ok;
  } catch (err) {
    d.log.warn({ tripId: ctx.tripId, err: String(err).slice(0, 200) }, "budget: the App didn't take the trip's budget; Go keeps it");
    return false;
  }
}
