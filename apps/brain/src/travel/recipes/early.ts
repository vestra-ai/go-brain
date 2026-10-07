/**
 * The early start: when a whole travel ask to Go lands, its search begins on intake, before the composer's turn, and
 * the turn starts at once instead of waiting 2 s for more lines. Only under TRAVEL_MODE ixigo_web, where a search takes
 * seconds. The composer's own search_* call later joins the same search: ixigo_web shares one in flight, by recipe and
 * slots. A follow-up line ("after 6 pm") still reaches the turn, and its filter applies to the same list.
 */
import type { Switches } from '../../admin/switches.js';
import type { Message } from '../../door/methods.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { HookAnswer } from '../../trips/hooks.js';
import { plainlyNamesGo } from '../../trips/names-go.js';
import type { TripPack } from '../../trips/pack.js';
import type { Travel, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { readTravelAsk } from './ask.js';
import { RECIPES } from './index.js';
import { RECIPE_TTL_MS } from './recipe.js';

export interface EarlyStartDeps {
  travel: () => Travel | undefined;
  switches: Pick<Switches, 'get'>;
  /** Today in the trip's time zone. */
  today: (tripId: string) => Promise<string>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

/** A search a message started on intake. */
export interface EarlySearch {
  kind: TravelKind;
  query: TravelQuery;
  search: Promise<TravelSearch>;
}

export interface EarlyStart {
  /** The message hook: starts the search and says the turn is due now, or does nothing. */
  onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<HookAnswer | undefined>;
  /** The search this message started, while it is fresh (its recipe's ten minutes); null when it started none. */
  searchFor(tripId: string, messageId: string): EarlySearch | null;
}

const KEPT_MAX = 200;

export function createEarlyStart(d: EarlyStartDeps): EarlyStart {
  const started = new Map<string, EarlySearch & { at: number }>();
  return {
    async onRead(msg, read, pack) {
      if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !msg.text) return undefined;
      // To Go: named plainly, or the quick read is sure it is for Go.
      if (!plainlyNamesGo(msg, pack) && !(read.forGo.sure && read.forGo.value === true)) return undefined;
      const travel = d.travel();
      if (!travel) return undefined;
      const tripId = pack.trip.trip_id;
      const ask = readTravelAsk(msg.text, { today: await d.today(tripId), destination: pack.trip.destination?.name ?? null, dates: pack.trip.dates ?? null });
      if (!ask) return undefined;
      try {
        RECIPES[ask.kind].slotsFrom(ask.query, { people: Math.max(1, pack.trip.people.length) });
      } catch {
        // A place the recipes have no code for: the composer asks, or searches, as usual.
        return undefined;
      }
      // Not awaited: the hooks run one after another, and nothing should wait on the page.
      const search = travel.search(ask.kind, ask.query, { tripId });
      search.catch((err: unknown) => {
        d.log.warn({ err, tripId, kind: ask.kind }, 'travel: an early search failed; the composer searches again');
      });
      started.set(`${tripId}:${msg.message_id}`, { ...ask, search, at: d.now().getTime() });
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
      return { kind: s.kind, query: s.query, search: s.search };
    },
  };
}
