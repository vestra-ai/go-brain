/**
 * The stays card's top pick, its own photos and rooms (the Server team's 10 Oct B3 and B4): its page opens on the stage
 * once the card is up (register.ts showPick), and the photos that page lists, labelled with what each shows ("Swimming
 * pool"), replace the search's on that option, with its kinds of room priced for the stay and what one person pays
 * (rooms.ts stayRoomFields). The card is replaced in place with those and nothing else changed, so its prices and its
 * time stay as shown. A vote opened from the card afterwards carries them (votes.ts).
 */
import type { ServerLink } from '../door/server-link.js';
import type { EngineAnswer } from './book/engine.js';
import type { Images } from './images.js';
import { photosOf, type SourcePhoto } from './photos.js';
import type { ResultsStore } from './results.js';
import { stayRoomFields } from './rooms.js';

/** The top pick as its card put it up: its page on ixigo, its name to click on the results, its kind, and its card and option. */
export interface TopPick {
  page: string;
  name: string;
  kind?: 'stay' | 'bus';
  cardId: string;
  optionId: string;
}

/**
 * The card goes out with the turn's reply, which can come after the pick's page is read: the replace waits for that post
 * to answer, at most this long (a turn's whole time and then some), and is never sent before it.
 */
export const POSTED_WAIT_MS = 60_000;

/**
 * The top pick's page's photos and rooms on its card, when the page listed any (hotels.details' photo_list and
 * room_types): true once the card is replaced. group: the trip's people, in its order, and the stay's nights, for the
 * rooms' prices; without it, photos only. A page with neither, or a card or option no longer kept, changes nothing.
 */
export async function showPickPhotos(
  d: {
    results: Pick<ResultsStore, 'setOptionFields'>;
    images: Pick<Images, 'rehostUrl'>;
    link: Pick<ServerLink, 'request'>;
    /** brain.cardPosted: true once the card's post answered, waiting at most withinMs. */
    posted?: (tripId: string, cardId: string, withinMs: number) => Promise<boolean>;
  },
  tripId: string,
  pick: Pick<TopPick, 'cardId' | 'optionId'>,
  answer: EngineAnswer,
  group?: { personIds: string[]; nights: number },
): Promise<boolean> {
  const row = answer.as === 'facts' ? answer.rows[0] : undefined;
  const list = row?.['photo_list'];
  const photos = Array.isArray(list) ? await photosOf(list as SourcePhoto[], d.images) : [];
  const rooms = row && group ? stayRoomFields(row, group.personIds, group.nights) : null;
  if (photos.length === 0 && !rooms) return false;
  const card = await d.results.setOptionFields(tripId, pick.cardId, pick.optionId, { ...(photos.length > 0 ? { photos } : {}), ...(rooms ?? {}) });
  if (!card) return false;
  // The kept card has the photos now (a vote opened from it carries them); the room's, once its post has answered.
  if (d.posted && !(await d.posted(tripId, pick.cardId, POSTED_WAIT_MS))) return false;
  await d.link.request('replace_card', { trip_id: tripId, card });
  return true;
}
