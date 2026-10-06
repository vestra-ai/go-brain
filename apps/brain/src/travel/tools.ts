/**
 * The composer's travel tools. Searches answer compact results for the model and save the full set, so show_options
 * builds the card from what was checked, never from prices the model typed. Constraints people gave ("can't leave
 * before 6") arrive as arguments and are applied in code by the travel layer.
 */
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import { buildOptionsCard, clip, formatInr, subtitleFor } from './cards.js';
import { stableId } from './ids.js';
import type { Images } from './images.js';
import { TravelError } from './mcp-travel.js';
import { toResultOption, type OptionKind, type ResultOption, type ResultsStore } from './results.js';
import { Clock, MUST_HAVES, type Travel, type TravelKind, type TravelQuery } from './travel.js';
import { openVoteFromCard } from './votes.js';

export interface TravelToolDeps { travel: Travel; results: ResultsStore; images: Images; now: () => Date }

export const OPTION_KIND: Record<TravelKind, OptionKind> = { flights: 'flight', trains: 'train', buses: 'bus', stays: 'stay' };

const Where = z.string().min(2).max(60);
const Rupees = z.number().positive().max(10_000_000);
const toPaise = (rupees: number): number => Math.round(rupees * 100);

export const FlightsArgs = z.object({
  from: Where.describe('City or airport code, e.g. "Delhi" or "DEL"'),
  to: Where.describe('City or airport code, e.g. "Goa"'),
  date: z.iso.date().describe('YYYY-MM-DD'),
  depart_after: Clock.optional().describe('24-hour HH:MM. Someone who can only leave after 6 pm is "18:00".'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  max_price_per_person: Rupees.optional().describe('In rupees'),
  non_stop: z.boolean().optional(),
  travellers: z.int().min(1).max(9).optional(),
});
export const JourneyArgs = z.object({
  from: Where,
  to: Where,
  date: z.iso.date().describe('YYYY-MM-DD'),
  depart_after: Clock.optional().describe('24-hour HH:MM'),
  depart_before: Clock.optional(),
  arrive_before: Clock.optional(),
  max_price_per_person: Rupees.optional().describe('In rupees'),
});
export const StaysArgs = z.object({
  area: Where.describe('A place or a part of Goa, e.g. "North Goa" or "Anjuna"'),
  check_in: z.iso.date(),
  check_out: z.iso.date(),
  guests: z.int().min(1).max(30).optional(),
  max_price_per_night: Rupees.optional().describe('In rupees, for the whole place per night'),
  must_have: z.array(z.enum(MUST_HAVES)).max(5).optional().describe('pool, beach (10 minutes or less), breakfast, free_cancellation'),
  min_rating: z.number().min(0).max(5).optional(),
});

export function flightsQuery(a: z.infer<typeof FlightsArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
    ...(a.non_stop ? { mustHave: ['non_stop' as const] } : {}),
    ...(a.travellers ? { guests: a.travellers } : {}),
  };
}

export function journeyQuery(a: z.infer<typeof JourneyArgs>): TravelQuery {
  return {
    from: a.from,
    to: a.to,
    date: a.date,
    ...(a.depart_after ? { departAfter: a.depart_after } : {}),
    ...(a.depart_before ? { departBefore: a.depart_before } : {}),
    ...(a.arrive_before ? { arriveBefore: a.arrive_before } : {}),
    ...(a.max_price_per_person ? { maxPriceMinor: toPaise(a.max_price_per_person) } : {}),
  };
}

export function staysQuery(a: z.infer<typeof StaysArgs>): TravelQuery {
  return {
    area: a.area,
    checkIn: a.check_in,
    checkOut: a.check_out,
    ...(a.guests ? { guests: a.guests } : {}),
    ...(a.max_price_per_night ? { maxPriceMinor: toPaise(a.max_price_per_night) } : {}),
    ...(a.must_have ? { mustHave: a.must_have } : {}),
    ...(a.min_rating !== undefined ? { minRating: a.min_rating } : {}),
  };
}

export function ageText(checkedAt: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(checkedAt)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export function compactOption(n: number, o: ResultOption): Record<string, unknown> {
  const when = o.journey ? subtitleFor(o) : null;
  const nights = typeof o.facts.nights === 'number' ? o.facts.nights : null;
  return {
    n,
    title: o.title,
    ...(when ? { when } : {}),
    ...(typeof o.facts.area === 'string' ? { area: o.facts.area } : {}),
    ...(o.priceMinor !== undefined ? { price: `${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}` } : {}),
    ...(o.totalMinor !== undefined && nights ? { total: `${formatInr(o.totalMinor)} for ${nights} nights` } : {}),
    ...(o.rating !== undefined ? { rating: o.rating } : {}),
    highlights: o.highlights,
  };
}

function suggestTitle(kind: TravelKind, q: TravelQuery): string {
  switch (kind) {
    case 'flights':
      return clip(`Flights, ${q.from ?? ''} to ${q.to ?? ''}`, 80);
    case 'trains':
      return clip(`Trains, ${q.from ?? ''} to ${q.to ?? ''}`, 80);
    case 'buses':
      return clip(`Buses, ${q.from ?? ''} to ${q.to ?? ''}`, 80);
    case 'stays':
      return clip(`Stays in ${q.area ?? q.to ?? 'Goa'}`, 80);
  }
}

async function runSearch(kind: TravelKind, q: TravelQuery, ctx: TurnCtx, d: TravelToolDeps): Promise<unknown> {
  let found;
  try {
    found = await d.travel.search(kind, q);
  } catch (err) {
    if (err instanceof TravelError) return { count: 0, error: err.code, note: clip(err.message, 200) };
    throw err;
  }
  const options = found.results.slice(0, 10).map(toResultOption);
  if (options.length === 0) {
    return { count: 0, checked: ageText(found.checkedAt, d.now()), note: 'Nothing matched. Say so in one line and suggest loosening one thing.' };
  }
  const set = await d.results.save({ tripId: ctx.tripId, optionKind: OPTION_KIND[kind], source: 'search', query: q, options, checkedAt: found.checkedAt });
  return {
    results_id: set.resultsId,
    checked: ageText(found.checkedAt, d.now()),
    count: options.length,
    results: options.map((o, i) => compactOption(i + 1, o)),
    card: { results_id: set.resultsId, option_numbers: options.slice(0, 3).map((_, i) => i + 1), title: suggestTitle(kind, q) },
    note: 'To show options, call show_options with this results_id. Quote prices only from these results, and say how long ago they were checked when it is not just now.',
  };
}

const SEARCH_RULE = 'Put every constraint people gave into the arguments: Go applies them to the results itself.';

const ShowArgs = z.object({
  results_id: z.string().min(3).max(64),
  option_numbers: z.array(z.int().min(1).max(10)).min(1).max(5).optional().describe('From the results, best first. Default: the first three.'),
  title: z.string().min(1).max(80),
});

const VoteArgs = z.object({
  card_id: z.string().min(3).max(64),
  question: z.string().min(3).max(200).optional(),
  closes_in_hours: z.number().min(0.5).max(72).optional(),
});

export function travelTools(d: TravelToolDeps): QuickTool<any>[] {
  const searchFlights: QuickTool<z.infer<typeof FlightsArgs>> = {
    name: 'search_flights',
    description: `Searches flights on one date. ${SEARCH_RULE} For example depart_after "18:00" when someone cannot leave before 6 pm.`,
    input: FlightsArgs,
    run: (a, ctx) => runSearch('flights', flightsQuery(a), ctx, d),
  };
  const searchTrains: QuickTool<z.infer<typeof JourneyArgs>> = {
    name: 'search_trains',
    description: `Searches trains on one date, one fare per class. ${SEARCH_RULE}`,
    input: JourneyArgs,
    run: (a, ctx) => runSearch('trains', journeyQuery(a), ctx, d),
  };
  const searchBuses: QuickTool<z.infer<typeof JourneyArgs>> = {
    name: 'search_buses',
    description: `Searches buses on one date. ${SEARCH_RULE}`,
    input: JourneyArgs,
    run: (a, ctx) => runSearch('buses', journeyQuery(a), ctx, d),
  };
  const searchStays: QuickTool<z.infer<typeof StaysArgs>> = {
    name: 'search_stays',
    description: `Searches villas and hotels for check-in and check-out dates. ${SEARCH_RULE} For a deep comparison (reviews, many sites), use start_task instead.`,
    input: StaysArgs,
    run: (a, ctx) => runSearch('stays', staysQuery(a), ctx, d),
  };
  const showOptions: QuickTool<z.infer<typeof ShowArgs>> = {
    name: 'show_options',
    description: 'Shows an options card from a results_id (a search, or a finished job), with up to 5 option_numbers, best first, and a short title. The card goes out with your message and shows the checked prices, so never type prices yourself. Add one short line about it.',
    input: ShowArgs,
    async run(a, ctx) {
      const set = await d.results.get(ctx.tripId, a.results_id);
      if (!set || set.options.length === 0) return { error: 'unknown_results', note: 'Search again, then show the new results.' };
      const numbers = [...new Set(a.option_numbers ?? set.options.slice(0, 3).map((_, i) => i + 1))].filter((n) => n <= set.options.length).slice(0, 5);
      if (numbers.length === 0) return { error: 'no_such_options', note: `Pick numbers from 1 to ${set.options.length}.` };
      const cardId = ctx.stableId('c_opt');
      const picks = await Promise.all(
        numbers.map(async (n, i) => {
          const option = set.options[n - 1]!;
          return { n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl: option.imageUrl ? await d.images.rehostUrl(option.imageUrl) : null };
        }),
      );
      const card = buildOptionsCard({ cardId, title: a.title, optionKind: set.optionKind, checkedAt: set.checkedAt, picks });
      // Saved before it is shown, so a tap on it always finds its offers.
      await d.results.saveCard({ cardId, tripId: ctx.tripId, resultsId: set.resultsId, title: card.title, optionKind: set.optionKind, card }, picks, set.checkedAt);
      // A rerun of the same turn finds this card id saved already: it shows the card saved first, which its stored offers match.
      const shown = (await d.results.card(ctx.tripId, cardId))?.card ?? card;
      ctx.cards.push(shown);
      return { card_id: cardId, shown: shown.options.length, checked: ageText(set.checkedAt, d.now()), note: 'The card goes out with your message. Add one short line; quote prices only from the card.' };
    },
  };
  const putToVote: QuickTool<z.infer<typeof VoteArgs>> = {
    name: 'put_to_vote',
    description: 'Opens a vote on the options of an options card Go showed (card_id). The vote card goes out with your message. Use it when the group should decide together.',
    input: VoteArgs,
    async run(a, ctx) {
      const r = await openVoteFromCard(
        { results: d.results, link: ctx.link, now: d.now },
        {
          tripId: ctx.tripId,
          cardId: a.card_id,
          key: ctx.turnId,
          requestId: ctx.stableId('go_vote'),
          voteCardId: ctx.stableId('c_vote'),
          ...(a.question ? { question: a.question } : {}),
          ...(a.closes_in_hours ? { closesInHours: a.closes_in_hours } : {}),
        },
      );
      if (!r.ok) return { error: r.reason, ...(r.decisionId ? { decision_id: r.decisionId } : {}) };
      ctx.cards.push(r.voteCard);
      return { decision_id: r.decisionId, note: 'The vote card goes out with your message. Add one short line.' };
    },
  };
  return [searchFlights, searchTrains, searchBuses, searchStays, showOptions, putToVote];
}
