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
import type { Travel } from '../travel.js';
import { readTravelAsk } from './ask.js';
import { RECIPES } from './index.js';

export interface EarlyStartDeps {
  travel: () => Travel | undefined;
  switches: Pick<Switches, 'get'>;
  /** Today in the trip's time zone. */
  today: (tripId: string) => Promise<string>;
  log: { warn(obj: object, msg: string): void };
}

/** The message hook: starts the search and says the turn is due now, or does nothing. */
export function earlyStart(d: EarlyStartDeps): (msg: Message, read: ReflexRead, pack: TripPack) => Promise<HookAnswer | undefined> {
  return async (msg, read, pack) => {
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
    void travel.search(ask.kind, ask.query, { tripId }).catch((err: unknown) => {
      d.log.warn({ err, tripId, kind: ask.kind }, 'travel: an early search failed; the composer searches again');
    });
    return { dueNow: true };
  };
}
