/**
 * Each person's own flights (the Server's REV4 ask B7; Keshav, 10 Oct: a ticket is each traveller's own). From each
 * member's home city (Person.from_city) to the trip on its day, on cards for them alone: the room sees each card, only
 * its people act on it, and a pick is the picker's own (taps.ts), never a vote.
 *
 * The composite trip.flights_each (recipes/trip/) reads one flights page per home city on the trip's computer (paced:
 * one flights page across every trip in 20 s), and each person's leaving time (Person.earliest_leave, leave-window.ts)
 * narrows their city's flights in Go, with no second load. Every traveller gets a card of their own (the Server team's
 * final round, 10 Oct: one card per traveller, theirs alone to act on, no vote), even two from one city. Each city's
 * cards go up as its page lands, the first in about 5 s, behind a live card ticking off the cities; a city whose page
 * doesn't come gets its people's ixigo link instead, each their own.
 */
import { z } from 'zod';
import type * as C from '@go/contract';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import type { ServerLink } from '../door/server-link.js';
import { dayText } from './answer.js';
import type { Engine, EngineAnswer, StepsEvent } from './book/engine.js';
import { buildFlightsLinkCard, buildOptionsCard, clip, formatInr, type CardPick } from './cards.js';
import { flightDetails } from './details.js';
import { applyConstraints } from './filters.js';
import { stableId } from './ids.js';
import { leaveWindow, type LeaveWindow } from './leave-window.js';
import { TravelError } from './mcp-travel.js';
import { CARD_DELAY_MS, TRAVEL_WAIT_MS } from './recipes/backend.js';
import { norm } from './recipes/places.js';
import { toResultOption, type ResultOption, type ResultsStore } from './results.js';
import type { TravelOption } from './travel.js';
import { waysLiveCard } from './ways-there.js';

export const FLIGHTS_EACH = 'trip.flights_each';
/** The flights on a person's card at most: the cheapest that fit their window. */
const CARD_FLIGHTS = 3;
/** The tool waits a search's own time; past it, each city's cards still post themselves as they land. */
const EACH_TOOL_MS = TRAVEL_WAIT_MS + 2_000;

/**
 * How long the composite may take: one flights page a city, 20 s apart across every trip (another trip's page may come
 * first), and a page's own time. No turn waits on it: each card posts itself as its page gets through (waitOutPace).
 */
export function eachDeadlineMs(cities: number): number {
  return Math.min(240_000, 30_000 + cities * 30_000);
}

type Person = C.Person;
type Window = Extract<LeaveWindow, { kind: 'window' }>;

/** One traveller's card: their home city and leaving window (people holds them alone). */
export interface EachGroup {
  home: string;
  people: Array<{ personId: string; name: string }>;
  window: Window | null;
}

export interface EachPlan {
  groups: EachGroup[];
  /** Members who haven't said where they fly from: asked in the line. */
  noHome: string[];
  /** Members whose leaving words aren't a time: their card has every flight, and the line says why. */
  unread: Array<{ name: string; text: string }>;
}

/** Who gets which card: each member their own, by home city and leaving window; nobody whose home is the trip's own place. */
export function planEach(people: Person[], to: string, date: string): EachPlan {
  const groups: EachGroup[] = [];
  const noHome: string[] = [];
  const unread: EachPlan['unread'] = [];
  for (const p of people) {
    const home = p.from_city?.trim();
    if (!home) {
      noHome.push(p.name);
      continue;
    }
    if (norm(home) === norm(to)) continue;
    const w = leaveWindow(p.earliest_leave, date);
    if (w.kind === 'unread') unread.push({ name: p.name, text: w.text });
    groups.push({ home, people: [{ personId: p.person_id, name: p.name }], window: w.kind === 'window' ? w : null });
  }
  return { groups, noHome, unread };
}

const listOf = (words: string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
const namesOf = (g: EachGroup): string => listOf(g.people.map((p) => p.name));

/** A seat people can still buy: a price, a time, and not a fare ixigo says has no seat left. */
const bookable = (o: TravelOption): boolean => o.priceMinor > 0 && !!o.journey && o.facts['seats_left'] !== 0;

/** A group's flights: those its window lets them take, the cheapest first, and how many fit. */
export function flightsFor(g: EachGroup, options: TravelOption[]): { shown: TravelOption[]; fit: number } {
  const q = { ...(g.window?.departAfter ? { departAfter: g.window.departAfter } : {}), ...(g.window?.departBefore ? { departBefore: g.window.departBefore } : {}) };
  const fit = applyConstraints('flights', q, options.filter(bookable)).sort(
    (a, b) => a.priceMinor - b.priceMinor || (a.journey?.depart_at ?? '').localeCompare(b.journey?.depart_at ?? ''),
  );
  return { shown: fit.slice(0, CARD_FLIGHTS), fit: fit.length };
}

export interface FlightsEachDeps {
  engine: Pick<Engine, 'answer'>;
  results: Pick<ResultsStore, 'save' | 'saveCard' | 'card'>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the composite runs in the trip's browser. */
  live: () => boolean;
  /** Where the live card and each city's cards are posted. */
  link: Pick<ServerLink, 'request'>;
  now: () => Date;
  log?: { warn(obj: object, msg: string): void };
  /** How long the turn waits (TRAVEL_WAIT_MS), and before the live card shows (CARD_DELAY_MS). */
  waitMs?: number;
  cardDelayMs?: number;
}

const Args = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, only when the ask names a day other than the trip's start"),
  to: z.string().min(2).max(60).optional().describe("Only when the ask names a place other than the trip's destination"),
  cabin: z.enum(['economy', 'premium_economy', 'business']).optional().describe('Only when the ask names a cabin'),
});

export function flightsEachTool(d: FlightsEachDeps): QuickTool<z.infer<typeof Args>> {
  /** A group's card and its line, saved before it posts so its taps find their offers. */
  async function groupCard(tripId: string, turnId: string, g: EachGroup, at: { to: string; date: string }, got: Extract<EngineAnswer, { as: 'options' }>) {
    const { shown, fit } = flightsFor(g, got.options);
    const who = namesOf(g);
    const when = g.window ? `, ${g.window.words}` : '';
    if (shown.length === 0) return { card: null, line: `${who}, no flight from ${g.home} on ${dayText(at.date)}${when} has seats on ixigo.` };
    const cardId = stableId('c_each', turnId, ...g.people.map((p) => p.personId));
    const options: ResultOption[] = shown.map((o) => toResultOption(o));
    const ids = g.people.map((p) => p.personId);
    const set = await d.results.save({
      tripId, optionKind: 'flight', source: 'search', options, checkedAt: got.checkedAt, page: got.page,
      query: { from: g.home, to: at.to, date: at.date, guests: 1, ...(g.window?.departAfter ? { departAfter: g.window.departAfter } : {}), ...(g.window?.departBefore ? { departBefore: g.window.departBefore } : {}), for_person_ids: ids },
    });
    const picks: Array<CardPick & { n: number }> = options.map((option, i) => {
      const details = flightDetails(option, 1);
      return { n: i + 1, optionId: stableId('opt', cardId, i + 1), option, imageUrl: null, ...(details ? { details } : {}) };
    });
    const title = `Flights for ${who}, ${g.home} to ${at.to}, ${dayText(at.date)}${when}`;
    const card = buildOptionsCard({ cardId, title: clip(title, 80), optionKind: 'flight', checkedAt: got.checkedAt, picks, forPersonIds: ids });
    await d.results.saveCard({ cardId, tripId, resultsId: set.resultsId, title: card.title, optionKind: 'flight', card }, picks, got.checkedAt);
    // A rerun of the same turn finds this card saved already, and posts that one.
    const saved = (await d.results.card(tripId, cardId))?.card ?? card;
    const cheapest = shown[0]!;
    const line =
      `${who}, your flights from ${g.home} on ${dayText(at.date)}${when}: ${fit} ${fit === 1 ? 'fits' : 'fit'}, from ${formatInr(cheapest.priceMinor)} a person. ` +
      `Tap "I'll take this" on yours.`;
    return { card: saved, line };
  }

  return {
    name: 'search_flights_each',
    description:
      "Finds each person's own flights to the trip from their home city, on the trip's day: one card for each city and leaving time, " +
      "for those people alone, each picking their own (a ticket is never a group vote). Each person's leaving time narrows their flights. " +
      'Use it when the group asks for everyone\'s flights, or each person\'s; use search_flights for one route someone names. ' +
      'The day, the destination, the home cities and the leaving times come from the trip.',
    input: Args,
    timeoutMs: EACH_TOOL_MS,
    async run(a, ctx: TurnCtx) {
      if (!d.live()) return { error: 'not_here', note: "Go finds each person's flights only when it searches ixigo.com itself: use search_flights for each route." };
      const trip = ctx.pack.trip;
      const to = a.to ?? trip.destination?.name ?? null;
      const date = a.date ?? trip.dates?.start ?? null;
      if (!to || !date) return { error: 'needs_more', note: `Ask the group in one line for ${!to ? 'where the trip goes' : 'the day they fly'}.` };
      const plan = planEach(trip.people, to, date);
      const asks = [
        ...(plan.noHome.length > 0 ? [`${listOf(plan.noHome)}, where do you fly from?`] : []),
        ...plan.unread.map((u) => `${u.name}, "${clip(u.text, 40)}" isn't a time, so your card has every flight.`),
      ].join(' ');
      if (plan.groups.length === 0) return { error: 'needs_more', note: `Nobody has said where they fly from. Say only this, in one line: ${asks || 'where does everyone fly from?'}` };

      const at = { to, date };
      const live = waysLiveCard(d, ctx.tripId, ctx.stableId('c_live'), { kinds: ['flights'], fallback: "Go is checking each person's flights on ixigo from their home city." });
      const timeUp = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const showing = setTimeout(() => live.show(), d.cardDelayMs ?? CARD_DELAY_MS);
      showing.unref?.();
      // Each city's two steps (its page and its link); its cards post as its page lands, its link when the page didn't.
      const cities = new Map<string, { steps: number; posted: boolean; link: string | null }>();
      const posts: Array<Promise<void>> = [];
      const said: string[] = [];
      // Each traveller's card and its line are theirs alone to see (1.2 visible_to_person_ids, Keshav, 10 Oct), as well as
      // to act on; the turn's own line, to the room, names no flight, price or window.
      const post = (key: string, card: C.Card | null, text: string, only: string[]): void => {
        posts.push(
          d.link.request('post_message', { request_id: stableId('go_each', ctx.turnId, key), trip_id: ctx.tripId, text, ...(card ? { card } : {}), visible_to_person_ids: only })
            .then(() => undefined)
            .catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: ctx.tripId }, "travel: a person's flights card could not be posted")),
        );
      };
      const groupsOf = (entry: string): EachGroup[] => plan.groups.filter((g) => norm(g.home) === norm(entry));
      const onStep = (e: Extract<StepsEvent, { type: 'step' }>): void => {
        const city = cities.get(norm(e.entry)) ?? { steps: 0, posted: false, link: null };
        cities.set(norm(e.entry), city);
        city.steps += 1;
        if (e.answer?.as === 'link') city.link = e.answer.link;
        if (e.recipe === 'flights.results') live.step(e.entry, 'flights', e.answer?.as === 'options');
        const got = e.answer;
        if (got?.as === 'options' && got.options.length > 0 && !city.posted) {
          city.posted = true;
          for (const g of groupsOf(e.entry)) {
            posts.push(
              groupCard(ctx.tripId, ctx.turnId, g, at, got)
                .then((made) => post(g.people.map((p) => p.personId).join(','), made.card, made.line, g.people.map((p) => p.personId)))
                .catch((err: unknown) => d.log?.warn({ err: String(err).slice(0, 200), tripId: ctx.tripId }, "travel: a person's flights card could not be made")),
            );
          }
          return;
        }
        // Both steps in and no flights read: the city's people get ixigo's own page, set for them.
        if (city.steps >= 2 && !city.posted) {
          city.posted = true;
          for (const g of groupsOf(e.entry)) {
            const title = clip(`Flights for ${namesOf(g)}, ${g.home} to ${to}`, 80);
            if (!city.link) {
              said.push(`Flights from ${g.home} didn't come back from ixigo.`);
              continue;
            }
            const only = g.people.map((p) => p.personId);
            const link = buildFlightsLinkCard({ cardId: stableId('c_each_link', ctx.turnId, ...only), title, url: city.link });
            // Theirs alone to act on, as their options card would be.
            const card = { ...link, for_person_ids: only, actions: (link.actions ?? []).map((a) => ({ ...a, only_for_person_ids: only })) };
            post(`${only.join(',')}|link`, card, `${namesOf(g)}, Go couldn't read the flights from ${g.home} just now, so here they are on ixigo${g.window ? `; yours leave ${g.window.words}` : ''}.`, only);
          }
        }
      };
      const running = d.engine.answer(FLIGHTS_EACH, { to, date, ...(a.cabin ? { cabin: a.cabin } : {}) }, {
        tripId: ctx.tripId,
        signal: timeUp.signal,
        // Each city's page waits its turn as often as it takes: a traveller gets their flights, never a link for a wait.
        waitOutPace: true,
        onSteps: (e) => {
          if (e.type === 'entries') {
            live.cities(e.entries);
            deadline = setTimeout(() => timeUp.abort(), eachDeadlineMs(e.entries.length));
            deadline.unref?.();
            return;
          }
          onStep(e);
        },
      });
      const done: Promise<{ ok: true } | { err: unknown }> = running
        .then(async () => {
          // Every card the cities made, posted, before the live card says done.
          for (let n = 0; n < posts.length; n++) await posts[n];
          await live.finish([...cities.values()].some((c) => c.posted));
          return { ok: true as const };
        })
        .catch(async (err: unknown) => {
          await live.finish(false);
          return { err };
        })
        .finally(() => {
          clearTimeout(showing);
          clearTimeout(deadline);
        });
      const STILL = Symbol('still running');
      let waited: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([done, new Promise<typeof STILL>((r) => (waited = setTimeout(() => r(STILL), d.waitMs ?? TRAVEL_WAIT_MS)))]);
      clearTimeout(waited);
      const facts = plan.groups.map((g) => ({ home: g.home, people: g.people.map((p) => p.name), leaving: g.window?.words ?? 'any time' }));
      if (first === STILL) {
        void done.then((out) => {
          if ('err' in out) d.log?.warn({ err: String(out.err).slice(0, 200), tripId: ctx.tripId }, "travel: each person's flights failed after the turn");
        });
        return {
          running: true,
          cards: facts,
          tell_the_room: asks ? `Say only this, in one line: ${asks}` : SAY_NOTHING,
          note: "Each person's flights are still coming in on the trip's computer, and the live card ticks off each city. Each city's cards post themselves as they land: never list the flights.",
        };
      }
      if ('err' in first) {
        if (!(first.err instanceof TravelError)) throw first.err;
        return { error: first.err.code, note: clip(first.err.message, 200) };
      }
      const line = [...said, asks].filter((s) => s !== '').join(' ');
      if (line) {
        ctx.lines.push(line);
        ctx.answered = true;
      }
      return {
        cards: facts,
        answered: !!line,
        ...(line ? {} : { tell_the_room: SAY_NOTHING }),
        note: line
          ? 'Each person\'s flights card is up, and this turn\'s line asks what is missing: it has said what it needed to.'
          : "Each person's flights card is up, each with its own line: say nothing more about them.",
      };
    },
  };
}
