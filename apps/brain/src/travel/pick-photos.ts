/**
 * The stays card's top pick, its own photos (the Server team's 10 Oct B3): its page opens on the stage once the card is up
 * (register.ts showPick), and the photos that page lists, labelled with what each shows ("Swimming pool"), replace the
 * search's on that option. The card is replaced in place with those photos and nothing else changed, so its prices and
 * its time stay as shown. A vote opened from the card afterwards carries them (votes.ts).
 */
import type { ServerLink } from '../door/server-link.js';
import type { EngineAnswer } from './book/engine.js';
import type { Images } from './images.js';
import { photosOf, type SourcePhoto } from './photos.js';
import type { ResultsStore } from './results.js';

/** The top pick as its card put it up: its page on ixigo, its name to click on the results, and its card and option. */
export interface TopPick {
  page: string;
  name: string;
  cardId: string;
  optionId: string;
}

/**
 * The top pick's page's photos on its card, when the page listed any (hotels.details' photo_list): true once the card is
 * replaced. A page with none, or a card or option no longer kept, changes nothing.
 */
export async function showPickPhotos(
  d: { results: Pick<ResultsStore, 'setOptionFields'>; images: Pick<Images, 'rehostUrl'>; link: Pick<ServerLink, 'request'> },
  tripId: string,
  pick: Pick<TopPick, 'cardId' | 'optionId'>,
  answer: EngineAnswer,
): Promise<boolean> {
  const list = answer.as === 'facts' ? answer.rows[0]?.['photo_list'] : undefined;
  if (!Array.isArray(list)) return false;
  const photos = await photosOf(list as SourcePhoto[], d.images);
  if (photos.length === 0) return false;
  const card = await d.results.setOptionFields(tripId, pick.cardId, pick.optionId, { photos });
  if (!card) return false;
  await d.link.request('replace_card', { trip_id: tripId, card });
  return true;
}
