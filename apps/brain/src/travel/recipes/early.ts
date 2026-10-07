/**
 * The early start: when a whole travel ask to Go lands, its search begins on intake, before the composer's turn, and
 * the turn starts at once instead of waiting 2 s for more lines. In every TRAVEL_MODE, so a search ask is one model call
 * wherever the list comes from: the right-now block hands the turn its answer. The composer's own search_* call later
 * joins the same search (the layer shares one in flight, and ixigo_web by recipe and slots). A follow-up line ("after
 * 6 pm") still reaches the turn, and its filter applies to the same list.
 *
 * Travel intent wakes the trip's computer (warmForTravel): a line Jev's question 10 is sure asks for a search, from
 * anyone, to Go or not, and the search this hook starts. Other lines never wake it. Flights answer with ixigo's link.
 */
import type { Switches } from '../../admin/switches.js';
import type { Message } from '../../door/methods.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { HookAnswer } from '../../trips/hooks.js';
import { plainlyNamesGo } from '../../trips/names-go.js';
import type { TripPack } from '../../trips/pack.js';
import type { Travel, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { agreedDates, readTravelAsk } from './ask.js';
import { RECIPE_TTL_MS } from './recipe.js';

export interface EarlyStartDeps {
  travel: () => Travel | undefined;
  switches: Pick<Switches, 'get'>;
  /** Today in the trip's time zone. */
  today: (tripId: string) => Promise<string>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Wakes the trip's computer for a search of this kind and holds it two minutes (travel/register.ts); absent in tests. */
  warmForTravel?: (tripId: string, kind: TravelKind) => void;
  /** Kinds that answer with ixigo's link and load nothing (the backend's linkOnly): nothing to start early. */
  linkOnly?: (kind: TravelKind) => boolean;
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
}

const KEPT_MAX = 200;

/** Whether an ask names all its search needs: the places and the date, or the stay's place and its two dates. */
const complete = (kind: TravelKind, q: TravelQuery): boolean =>
  kind === 'stays' ? !!((q.area ?? q.to) && q.checkIn && q.checkOut) : !!(q.from && q.to && q.date);

export function createEarlyStart(d: EarlyStartDeps): EarlyStart {
  const started = new Map<string, EarlySearch & { at: number }>();
  return {
    async onRead(msg, read, pack) {
      const web = d.switches.get('TRAVEL_MODE') === 'ixigo_web';
      const tripId = pack.trip.trip_id;
      // Jev's question 10, when it is sure: its kind wins over the parser's; "none" (travel talk, not a search ask) starts
      // nothing. A sure kind is travel intent, whoever the line is to: the box wakes for the search that follows.
      const pick = read.recipe;
      if (pick?.sure && pick.value) d.warmForTravel?.(tripId, pick.value);
      if (!msg.text) return undefined;
      const today = await d.today(tripId);
      // To Go: named plainly, or the quick read is sure it is for Go.
      if (!plainlyNamesGo(msg, pack) && !(read.forGo.sure && read.forGo.value === true)) return undefined;
      const travel = d.travel();
      if (!travel) return undefined;
      // Jev sure it is not a search ask: nothing starts. Unsure, the parser decides alone.
      if (pick?.sure && pick.value === null) return undefined;
      // The trip's dates; before they are set, the ones the group agreed in its record ("6 to 9 Nov").
      const dates = pack.trip.dates ?? agreedDates(pack.trip.record, today);
      const ask = readTravelAsk(msg.text, {
        today, destination: pack.trip.destination?.name ?? null, dates, ...(pick?.sure && pick.value ? { kind: pick.value } : {}),
      });
      if (!ask) return undefined;
      // An ask missing a place or a date: the composer asks, as usual.
      if (!complete(ask.kind, ask.query)) return undefined;
      // A link answers at once: the turn starts now, with nothing to search early.
      if (web && d.linkOnly?.(ask.kind)) return { dueNow: true };
      // The parser found the ask without a sure kind from Jev: this search is the travel intent.
      if (!(pick?.sure && pick.value)) d.warmForTravel?.(tripId, ask.kind);
      // Not awaited: the hooks run one after another, and nothing should wait on the page.
      const search = travel.search(ask.kind, ask.query, { tripId, messageId: msg.message_id });
      search.catch((err: unknown) => {
        d.log.warn({ err, tripId, kind: ask.kind }, 'travel: an early search failed; the composer searches again');
      });
      started.set(`${tripId}:${msg.message_id}`, { ...ask, search, live: web, at: d.now().getTime() });
      while (started.size > KEPT_MAX) {
        const oldest = started.keys().next().value;
        if (oldest === undefined) break;
        started.delete(oldest);
      }
      return { dueNow: true };
    },
    searchFor(tripId, messageId) {
      const s = started.get(`${tripId}:${messageId}`);
      if (!s || d.now().getTime() - s.at >= RECIPE_TTL_MS) return null;
      return { kind: s.kind, query: s.query, search: s.search, live: s.live };
    },
  };
}
