/**
 * Go books a person's own flight when BOOKING is on for the trip (booking/flight-booking.ts): they tap "I'll take this"
 * on their own flights card, Go books it on ixigo on the trip's computer up to the pay button, and their Pay goes
 * through the vault. The rules were written for the time Go booked no flights, so on a trip it books for, the model is
 * told so here, in "right now" (bookingNow), and gets book_flight for a pick made before (prod, 11 Oct, BOOKING on since
 * 08:13Z: "@Go book flights from BLR-DPS" got "I can't book flights. Each person books their own ticket on ixigo", and
 * "Book my flights to Manali" got "I can search Delhi to Kullu Manali for you, though. Want me to?"). With BOOKING off
 * nothing here says a word, and the rules stand as they were.
 */
import type pg from 'pg';
import { z } from 'zod';
import type { NowProvider } from '../composer/context.js';
import { inlineData } from '../composer/fence.js';
import type { QuickTool } from '../composer/tools.js';
import { askedBy } from './asker.js';
import type { FlightBooking } from './booking/flight-booking.js';
import { stableId } from './ids.js';
import { picksOf, type PersonPick } from './picks.js';
import type { ResultsStore } from './results.js';

export interface BookFlightDeps {
  booking: Pick<FlightBooking, 'onFor' | 'start'>;
  pool: pg.Pool;
  results: Pick<ResultsStore, 'offer'>;
  nameOf: (tripId: string, personId: string) => Promise<string>;
}

/** Each person's latest flight pick in the trip. */
async function flightPicks(pool: pg.Pool, tripId: string): Promise<Map<string, PersonPick>> {
  const out = new Map<string, PersonPick>();
  for (const p of await picksOf(pool, tripId)) {
    if (p.kind !== 'flight') continue;
    const was = out.get(p.personId);
    if (!was || p.pickedAt > was.pickedAt) out.set(p.personId, p);
  }
  return out;
}

/** What "right now" says on a trip Go books flights for: that it does, how, and each person's pick so far. */
export function bookingNow(d: Pick<BookFlightDeps, 'booking' | 'pool' | 'nameOf'>): NowProvider {
  return {
    name: 'booking',
    order: 38,
    async render(tripId) {
      if (!(await d.booking.onFor(tripId))) return null;
      const picks = [...(await flightPicks(d.pool, tripId)).values()];
      const named = await Promise.all(picks.map(async (p) => `- ${inlineData(await d.nameOf(tripId, p.personId), 40)} (${p.personId}) picked ${inlineData(p.title, 80)}`));
      return [
        '# Booking flights',
        "You book a person's own flight on this trip: they tap \"I'll take this\" on their own flights card, and you book it on ixigo on the trip's computer up to the pay button; then their Pay goes through the vault, Face ID on their phone. " +
          "So never say you can't book flights, and never tell anyone to book on ixigo themselves. " +
          "Their own train is booked the same way: \"I'll take this\" on their train card, the class on it; a waitlist or RAC is said to them before they pay.",
        'When someone asks you to book their flights ("book my flights", "book my flight to Manali"): with a pick of theirs below, call book_flight for them now. ' +
          'With none, search their flights at once, never "want me to?": search_flights_each for the trip\'s own way, search_flights for a route they name. ' +
          '"My flights" is the asker\'s alone: search_flights_each with person_ids [theirs]; everyone\'s only when they ask for everyone\'s or ours. ' +
          "Their card carries \"I'll take this\", and their tap on it books it. A route outside the trip (\"BLR to DPS\") is searched all the same: answer the ask, " +
          'mention the trip once at most, and never refuse it.',
        ...(named.length ? ['Flight picks so far:', ...named] : []),
      ].join('\n');
    },
  };
}

const Args = z.object({
  person_id: z.string().min(1).max(80).optional().describe('Whose flight: the person who asked, when absent; "my flight" is always theirs'),
});

/** Books a person's flight pick made before: the same booking their tap on "I'll take this" starts. */
export function bookFlightTool(d: BookFlightDeps): QuickTool<z.infer<typeof Args>> {
  return {
    name: 'book_flight',
    description:
      "Books a person's own flight they already picked (\"I'll take this\" on their card) on ixigo on the trip's computer, up to the pay button; their Pay follows. " +
      'Only when "right now" says you book flights on this trip, and only for a pick it lists. With no pick, search their flights instead.',
    input: Args,
    async run(a, ctx) {
      if (!(await d.booking.onFor(ctx.tripId))) {
        return { error: 'not_here', note: "Go doesn't book flights on this trip. Search their flights, and they book on ixigo from their own card." };
      }
      // "Book my flights" is the asker's own, whoever the model names (p2's re-audit, 11 Oct).
      const asked = askedBy(ctx);
      const personId = asked?.own ? asked.personId : (a.person_id ?? asked?.personId ?? null);
      if (!personId) return { error: 'needs_more', note: 'Say whose flight to book: person_id.' };
      const pick = (await flightPicks(d.pool, ctx.tripId)).get(personId);
      const offer = pick ? await d.results.offer(pick.optionId) : null;
      if (!pick || !offer || offer.tripId !== ctx.tripId || offer.kind !== 'flight' || !offer.sourceUrl) {
        return { error: 'no_pick', note: "They have no flight picked that Go can book. Search their flights now (search_flights_each, or search_flights for the route they named): their tap on \"I'll take this\" books it." };
      }
      const name = await d.nameOf(ctx.tripId, personId);
      const started = await d.booking.start({ tapId: stableId('words', ctx.turnId, personId, offer.optionId), tripId: ctx.tripId, personId, name, offer, choice: 'basic' });
      // One booking of theirs at a time (flight-booking.ts start): the one under way goes on, and nothing starts twice.
      if (started === 'running') {
        return { booking: pick.title, note: `A flight booking of ${name}'s is already under way on the trip's computer; their own live card shows it. Say so in one short line.` };
      }
      return {
        booking: pick.title,
        note: `Go is booking ${pick.title} for ${name} on ixigo now, on the trip's computer; their own live card shows it, then their pay card. Say so in one short line, and nothing about booking it themselves.`,
      };
    },
  };
}
