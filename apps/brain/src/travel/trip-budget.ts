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
 * The budget a head that picks ixigo's own price bands for a stays search (recipes/backend.ts): one the chat set for the
 * stay, or the App's (the group's one budget, or before 1.1 its lowest band), as before 1.1. A whole-trip or travel
 * budget from the chat picks none: Go itself never drops a stay for a budget.
 */
export function stayCap(b: TripBudget | null): number | null {
  return b && (b.covers === 'stay' || b.source !== 'chat') ? b.perPersonMinor : null;
}

/**
 * How an option is weighed against the budget, and when the budget is left out. Prod, 11 Oct (Manali, a 60k a head
 * budget): stays at about ₹26,400 and ₹45,500 a head were called "well over the group's 60k a head", twice, to someone
 * who had asked for the most expensive ones.
 */
export const WEIGH =
  'Weigh an option by its share a head (a stay\'s "about ₹X each" for the whole stay), never by a per-room, per-night or ' +
  'whole-group price: it is over only when that share is. When someone asks for pricier ones, the most expensive, or one ' +
  'stay by name, show them without a word about the budget.';

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
        `anything you show over it, say so plainly. ${WEIGH} It holds until the group changes it.${also}`
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

/** A message with no word or number in it ("👍", "🙌") is a reaction sent as a message: never a yes. */
const bare = (m: C.Message): boolean => !/[\p{L}\p{N}]/u.test(m.text ?? '');

/** One of Go's own messages that offers to keep a budget ("Set ₹8,000 a head as the trip's budget?", with Yes and No). */
const offersBudget = (m: C.Message): boolean =>
  m.author.kind === 'go' && !m.deleted && /\bbudget\b/i.test(m.text ?? '') && ((m.quick_replies?.length ?? 0) > 0 || (m.text ?? '').includes('?'));

/**
 * Whether a person's message answers one of Go's budget offers: made with the reply feature on it, a tap on its quick
 * reply (a tap comes back as the tapper's own message), or the first thing anyone said after it.
 */
function answersBudgetOffer(m: C.Message, messages: readonly C.Message[]): boolean {
  if (m.reply_to) return messages.some((x) => x.message_id === m.reply_to && offersBudget(x));
  const before = messages.filter((x) => x.seq < m.seq && !x.deleted && x.author.kind !== 'system');
  const offer = [...before].reverse().find(offersBudget);
  if (!offer) return false;
  const said = (m.text ?? '').trim().toLowerCase();
  return before.at(-1) === offer || (offer.quick_replies ?? []).some((q) => (q.text ?? q.label).trim().toLowerCase() === said);
}

/**
 * set_budget: the group's decided budget, kept for the trip, or dropped. One person naming a figure, the organizer too,
 * is not the group's yes (the exam, 10 Oct: "villa with a pool … under 8k a head" is a search, not the trip's budget):
 * Go offers it, and keeps it on the organizer's yes to that offer or a second person's, in words: a reaction alone, a 👍
 * too, is never a yes (Keshav's ruling). Dropping it takes the organizer's word or two people's. A budget for the whole trip goes to the App (update_trip, 1.1 B1), which then
 * holds it; Go keeps it itself only when the App didn't take it (a Server before 1.1), and keeps any other.
 */
export function budgetTool(d: { budgets: TripBudgets; pool: Pool; now: () => Date; log: Log }): QuickTool<z.infer<typeof SetBudgetArgs>> {
  return {
    name: 'set_budget',
    description:
      "Keeps the budget the group decided for the trip (\"let's keep it under 20k each\", \"let's go cheaper, 15k\"), so every " +
      "turn has it in mind, or drops it (clear). Only on the group's yes: the organizer's yes to your offer, or two people " +
      "agreeing. One person naming a figure, the organizer too, is not a yes: offer it first. Proof: the figure's message and the yes.",
    input: SetBudgetArgs,
    claims: /\bbudget (?:is )?(?:set|saved|locked|noted|updated)\b/i,
    async run(a, ctx: TurnCtx) {
      const people = ctx.pack.trip.people;
      const organizer = ctx.pack.trip.organizer_person_id;
      const cited = a.proof_message_ids
        .map((id) => ctx.pack.messages.find((m) => m.message_id === id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.deleted);
      // The people's messages among the proof: Go's own estimate cited beside their yes is passed over, never a refusal
      // (staging drill, 10 Oct: refused twice for it, the turn ran out of rounds).
      const proof = cited.filter((m) => m.author.kind === 'person');
      if (proof.length === 0) {
        return { refused: "no person's message in this trip among the proof: give the message ids of the people's own words", tell_the_room: SAY_NOTHING };
      }
      // Who backs it: the people who said it in words. A reaction alone, a 👍 on the figure or on Go's offer too, is never
      // a yes, and neither is a bare 👍 sent as a message. The organizer's yes counts alone only as an answer to Go's offer.
      const yes = new Set<string>();
      let organizerSaidYes = false;
      for (const m of cited) {
        if (m.author.kind !== 'person' || bare(m)) continue;
        yes.add(m.author.person_id);
        if (m.author.person_id === organizer && answersBudgetOffer(m, ctx.pack.messages)) organizerSaidYes = true;
      }
      if (a.clear) {
        if (!(yes.has(organizer) || yes.size >= 2)) {
          return {
            refused: "one person's wish, not the group's",
            tell_the_room: "Take it as that person's wish. The budget is dropped on the organizer's word or a second person's. Don't say it is dropped.",
          };
        }
        await d.budgets.clear(ctx.tripId);
        // Go cannot clear the App's: a person does, in the App.
        if (ctx.pack.trip.budget.per_person_minor) {
          return { cleared: false, tell_the_room: "Say in one short line that the budget stays in the App until someone clears it there." };
        }
        return { cleared: true, tell_the_room: 'Say in a few words that you will stop keeping to a budget.' };
      }
      if (!a.amount_rupees) return { error: 'no_amount', note: 'Give amount_rupees, or clear.' };
      const perPerson = a.per === 'group' ? a.amount_rupees / Math.max(1, people.length) : a.amount_rupees;
      if (!(yes.size >= 2 || organizerSaidYes)) {
        return {
          refused: "one person's figure, not the group's yes",
          tell_the_room:
            `Use it for what was asked. If you haven't offered it yet, offer it once in one short line, "Set ${rupees(Math.round(perPerson * 100))} a head ` +
            "as the trip's budget?\", with Yes and No as offer_replies: it is kept on the organizer's yes or a second person's. " +
            "Never offer a person's own limit (\"I can only do 5k\"), and don't ask again after a no. Don't say it is set.",
        };
      }
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
