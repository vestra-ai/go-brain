/**
 * The early start: when a whole travel ask to Go lands, its search begins on intake, before the composer's turn, and
 * the turn starts at once instead of waiting 2 s for more lines. In every TRAVEL_MODE, so a search ask is one model call
 * wherever the list comes from: the right-now block hands the turn its answer. The composer's own search_* call later
 * joins the same search (the layer shares one in flight, and ixigo_web by recipe and slots). A follow-up line ("after
 * 6 pm") still reaches the turn, and its filter applies to the same list.
 *
 * Travel intent wakes the trip's computer (warmForTravel): a line Jev's question 10 is sure asks for a search, from
 * anyone, to Go or not, and the search this hook starts. Other lines never wake it. Flights answer with ixigo's link.
 *
 * The other ixigo asks Jev picks (a train's running status, its timetable, a waitlist's chance, a place's guide, the
 * offers, a shown stay's rooms or reviews: fast.ts) start the same way where Go searches ixigo.com itself: their recipe
 * runs at once, and the turn's right-now part hands over its facts (now.ts earlyReadNow). Each acts only once its choice
 * is live (reflex/live-gate.ts LIVE_RECIPES); until then Jev's pick of one acts as none.
 */
import type { Switches } from '../../admin/switches.js';
import type { Message } from '../../door/methods.js';
import { isSearchChoice, type FastChoice } from '../../reflex/questions.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { HookAnswer } from '../../trips/hooks.js';
import { plainlyNamesGo } from '../../trips/names-go.js';
import type { TripPack } from '../../trips/pack.js';
import type { EngineAnswer } from '../book/engine.js';
import type { Travel, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { agreedDates, readTravelAsk } from './ask.js';
import { readFastAsk, STAY_CHOICES, type ShownStay } from './fast.js';
import { RECIPE_TTL_MS } from './recipe.js';

export interface EarlyStartDeps {
  travel: () => Travel | undefined;
  switches: Pick<Switches, 'get'>;
  /** Today in the trip's time zone. */
  today: (tripId: string) => Promise<string>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Wakes the trip's computer for a search of this kind and holds it two minutes (travel/register.ts); absent in tests. */
  warmForTravel?: (tripId: string, kind: TravelKind | null) => void;
  /** Kinds never started early (the backend's LINK_ONLY_KINDS: flights, whose page is paced and else a link). */
  linkOnly?: (kind: TravelKind) => boolean;
  /** The book's recipes, for the asks beyond the searches (fast.ts). Absent, none of those start early. */
  recipes?: {
    has(id: string): boolean;
    run(id: string, given: Record<string, unknown>, o: { tripId: string }): Promise<EngineAnswer>;
  };
  /** The shown stay a line points at, for a stay's rooms or reviews (stay-on-card.ts). */
  stayFor?: (tripId: string, text: string) => Promise<ShownStay | null>;
}

/** An ixigo read a message started on intake: a recipe beyond the searches (fast.ts). */
export interface EarlyRead {
  choice: FastChoice;
  recipe: string;
  /** Its inputs as the ixigo tool takes them, for a turn that calls the tool while it still runs (it joins the read). */
  asked: Record<string, string>;
  answer: Promise<EngineAnswer>;
}

/** A search a message started on intake. */
export interface EarlySearch {
  kind: TravelKind;
  query: TravelQuery;
  search: Promise<TravelSearch>;
  /** A live card in the room shows the search (ixigo_web) and has already said "On it." */
  live: boolean;
}

export interface EarlyStart {
  /** The message hook: starts the search and says the turn is due now, or does nothing. */
  onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<HookAnswer | undefined>;
  /** The search this message started, while it is fresh (its recipe's ten minutes); null when it started none. */
  searchFor(tripId: string, messageId: string): EarlySearch | null;
  /** The ixigo read this message started, while it is fresh; null when it started none. */
  readFor(tripId: string, messageId: string): EarlyRead | null;
}

const KEPT_MAX = 200;

/** Whether an ask names all its search needs: the places and the date, or the stay's place and its two dates. */
const complete = (kind: TravelKind, q: TravelQuery): boolean =>
  kind === 'stays' ? !!((q.area ?? q.to) && q.checkIn && q.checkOut) : !!(q.from && q.to && q.date);

/** Keeps the newest entries of a map, oldest out first. */
function keep<T>(m: Map<string, T>, key: string, value: T): void {
  m.set(key, value);
  while (m.size > KEPT_MAX) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

export function createEarlyStart(d: EarlyStartDeps): EarlyStart {
  const started = new Map<string, EarlySearch & { at: number }>();
  const reads = new Map<string, EarlyRead & { at: number }>();

  /** An ixigo ask beyond the searches: its recipe runs now, where Go searches ixigo.com itself and the words give its slots. */
  async function startRead(choice: FastChoice, msg: Message & { text: string }, pack: TripPack, today: string): Promise<HookAnswer | undefined> {
    if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !d.recipes) return undefined;
    const tripId = pack.trip.trip_id;
    const stay = STAY_CHOICES.has(choice) ? ((await d.stayFor?.(tripId, msg.text)) ?? null) : null;
    const dates = pack.trip.dates ?? agreedDates(pack.trip.record, today);
    const ask = readFastAsk(choice, msg.text, { today, destination: pack.trip.destination?.name ?? null, dates, stay });
    if (!ask || !d.recipes.has(ask.recipe)) return undefined;
    const answer = d.recipes.run(ask.recipe, ask.given, { tripId });
    answer.catch((err: unknown) => {
      // A PNR's read never logs its error: the message could carry the number.
      d.log.warn({ ...(choice === 'pnr' ? {} : { err }), tripId, recipe: ask.recipe }, 'travel: an early ixigo read failed; the composer reads again');
    });
    keep(reads, `${tripId}:${msg.message_id}`, { choice, recipe: ask.recipe, asked: ask.asked, answer, at: d.now().getTime() });
    return { dueNow: true };
  }

  return {
    async onRead(msg, read, pack) {
      const web = d.switches.get('TRAVEL_MODE') === 'ixigo_web';
      const tripId = pack.trip.trip_id;
      // Jev's question 10, when it is sure: its kind wins over the parser's; "none" (travel talk, not a search ask) starts
      // nothing. A sure kind is travel intent, whoever the line is to: the box wakes for the search or read that follows.
      const pick = read.recipe;
      const kind = pick?.sure && pick.value && isSearchChoice(pick.value) ? pick.value : null;
      const fast = pick?.sure && pick.value && !isSearchChoice(pick.value) ? pick.value : null;
      if (kind || fast) d.warmForTravel?.(tripId, kind);
      if (!msg.text) return undefined;
      const today = await d.today(tripId);
      // To Go: named plainly, or the quick read is sure it is for Go.
      if (!plainlyNamesGo(msg, pack) && !(read.forGo.sure && read.forGo.value === true)) return undefined;
      if (fast) return startRead(fast, { ...msg, text: msg.text }, pack, today);
      const travel = d.travel();
      if (!travel) return undefined;
      // Jev sure it is not a search ask: nothing starts. Unsure, the parser decides alone.
      if (pick?.sure && pick.value === null) return undefined;
      // The trip's dates; before they are set, the ones the group agreed in its record ("6 to 9 Nov").
      const dates = pack.trip.dates ?? agreedDates(pack.trip.record, today);
      const ask = readTravelAsk(msg.text, {
        today, destination: pack.trip.destination?.name ?? null, dates, ...(kind ? { kind } : {}),
      });
      if (!ask) return undefined;
      // An ask missing a place or a date: the composer asks, as usual.
      if (!complete(ask.kind, ask.query)) return undefined;
      // A link answers at once: the turn starts now, with nothing to search early.
      if (web && d.linkOnly?.(ask.kind)) return { dueNow: true };
      // The parser found the ask without a sure kind from Jev: this search is the travel intent.
      if (!kind) d.warmForTravel?.(tripId, ask.kind);
      // Not awaited: the hooks run one after another, and nothing should wait on the page.
      const search = travel.search(ask.kind, ask.query, { tripId, messageId: msg.message_id });
      search.catch((err: unknown) => {
        d.log.warn({ err, tripId, kind: ask.kind }, 'travel: an early search failed; the composer searches again');
      });
      keep(started, `${tripId}:${msg.message_id}`, { ...ask, search, live: web, at: d.now().getTime() });
      return { dueNow: true };
    },
    searchFor(tripId, messageId) {
      const s = started.get(`${tripId}:${messageId}`);
      if (!s || d.now().getTime() - s.at >= RECIPE_TTL_MS) return null;
      return { kind: s.kind, query: s.query, search: s.search, live: s.live };
    },
    readFor(tripId, messageId) {
      const r = reads.get(`${tripId}:${messageId}`);
      if (!r || d.now().getTime() - r.at >= RECIPE_TTL_MS) return null;
      return { choice: r.choice, recipe: r.recipe, asked: r.asked, answer: r.answer };
    },
  };
}
