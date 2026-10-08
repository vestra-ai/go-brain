import type * as C from '@go/contract';
import type { Packs } from '../trips/pack.js';
import type { NowProvider } from './context.js';
import { dataBlock, defuse, inlineData, personName } from './fence.js';

const money = (minor: number, currency: string): string =>
  currency === 'INR' ? `₹${Math.round(minor / 100).toLocaleString('en-IN')}` : `${currency} ${Math.round(minor / 100)}`;

/**
 * Who has voted on an open vote and who hasn't, by name, never what they picked: Go may say it, from this and nothing else
 * (8 Oct: with counts alone it named the wrong two). A secret ballot is counts only, and so is a vote the Server sent
 * without its votes.
 */
function votersOf(d: C.Decision, people: C.Person[]): string {
  if (d.anonymous) return ". Secret ballot: counts only; never say who has or hasn't voted";
  if (!d.votes) return ". Who has voted isn't known: counts only";
  const voted = new Set(d.votes.map((v) => v.person_id));
  const names = (ps: C.Person[]): string => ps.map((p) => personName(p.name)).join(', ') || 'nobody';
  return `. Voted: ${names(people.filter((p) => voted.has(p.person_id)))}. Not yet: ${names(people.filter((p) => !voted.has(p.person_id)))}`;
}

/** The 'trip' block of "right now": what the trip is, who is in it, open votes. Other lanes add the record, pages and tasks. */
export function tripNow(packs: Packs): NowProvider {
  return {
    name: 'trip',
    order: 10,
    async render(tripId) {
      const { trip } = await packs.get(tripId);
      const lines = [`Trip: ${inlineData(trip.title)} (${trip.status})`];
      if (trip.destination) lines.push(`Destination: ${inlineData(trip.destination.name)}`);
      if (trip.dates) lines.push(`Dates: ${trip.dates.start} to ${trip.dates.end}`);
      if (trip.stay) lines.push(`Stay wanted: ${inlineData(trip.stay)}`);
      if (trip.vibe.length) lines.push(`Vibe: ${inlineData(trip.vibe.join(', '))}`);
      const low = trip.budget.lowest;
      if (low) {
        const top = low.max_minor != null ? ` to ${money(low.max_minor, low.currency)}` : ' and up';
        lines.push(
          `Budget, the lowest band anyone picked: ${money(low.min_minor, low.currency)}${top} per person, stay plus food ` +
            `(${trip.budget.answered} of ${trip.budget.of} answered)`,
        );
      }
      const people = trip.people.map((p) => {
        const about = [
          p.role === 'organizer' ? 'organizer' : null,
          p.from_city ? `from ${p.from_city}` : null,
          p.earliest_leave ? `can leave ${p.earliest_leave}` : null,
          ...p.know,
        ].filter((x): x is string => Boolean(x));
        return defuse(`${personName(p.name)} (${p.person_id})${about.length ? `: ${about.join('; ')}` : ''}`);
      });
      lines.push(`People:\n${dataBlock('people', people)}`);
      for (const d of trip.decisions.filter((x) => x.status === 'open')) {
        const tally = d.options.map((op, k) => `${inlineData(op.label)} ${d.tally[k] ?? 0}`).join(', ');
        lines.push(
          `Open vote ${d.decision_id}: ${inlineData(d.question)}: ${tally} (${d.voted} of ${d.of} voted${d.closes_at ? `, closes ${d.closes_at}` : ''})` +
            votersOf(d, trip.people),
        );
      }
      const booked = trip.bookings.filter((b) => b.status === 'confirmed');
      if (booked.length) lines.push(`Booked: ${booked.map((b) => inlineData(b.title)).join(', ')}`);
      return lines.join('\n');
    },
  };
}
