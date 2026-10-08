import type * as C from '@go/contract';
import type { Packs } from '../trips/pack.js';
import { flexibleOf } from '../trips/votes.js';
import type { NowProvider } from './context.js';
import { dataBlock, defuse, inlineData, personName } from './fence.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A calendar day, as "Fri 6 Nov". A date has no time of day, so its weekday is the same in every time zone. */
const dayOf = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
/** Trips this long or shorter list every day, so the model never counts its way from a date to a weekday. */
const LIST_DAYS = 14;

/**
 * The trip's dates with their weekdays, worked out in code (8 Oct: given "2026-11-06 to 2026-11-09", the model called
 * the Saturday the 8th): "Fri 6 Nov to Mon 9 Nov 2026 (3 nights): Fri 6 Nov, Sat 7 Nov, Sun 8 Nov, Mon 9 Nov".
 */
export function datesLine(start: string, end: string): string {
  const from = Date.parse(`${start}T00:00:00Z`);
  const nights = Math.round((Date.parse(`${end}T00:00:00Z`) - from) / 86_400_000);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const range = `${dayOf(start)}${sameYear ? '' : ` ${start.slice(0, 4)}`} to ${dayOf(end)} ${end.slice(0, 4)}`;
  const length = nights === 0 ? 'a day trip' : `${nights} night${nights === 1 ? '' : 's'}`;
  if (nights < 0 || nights >= LIST_DAYS) return `${range} (${length})`;
  const days = Array.from({ length: nights + 1 }, (_, k) => dayOf(new Date(from + k * 86_400_000).toISOString().slice(0, 10)));
  return `${range} (${length}): ${days.join(', ')}`;
}

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
  // 1.1: a flexible vote counts as voted but names no pick, so who hasn't voted can't be told apart from who is flexible.
  const flexible = flexibleOf(d);
  if (flexible > 0) return `. Picked: ${names(people.filter((p) => voted.has(p.person_id)))}; ${flexible} flexible. Who hasn't voted isn't known by name: counts only`;
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
      if (trip.dates) lines.push(`Dates: ${datesLine(trip.dates.start, trip.dates.end)}`);
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
          `Open vote ${d.decision_id}: ${inlineData(d.question)}: ${tally} (${d.voted} of ${d.of} voted${flexibleOf(d) ? `, ${flexibleOf(d)} flexible` : ''}${d.closes_at ? `, closes ${d.closes_at}` : ''})` +
            votersOf(d, trip.people),
        );
      }
      const booked = trip.bookings.filter((b) => b.status === 'confirmed');
      if (booked.length) lines.push(`Booked: ${booked.map((b) => inlineData(b.title)).join(', ')}`);
      return lines.join('\n');
    },
  };
}
