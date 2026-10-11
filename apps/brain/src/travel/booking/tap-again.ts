import type { ServerLink } from '../../door/server-link.js';
import { PICK_ACTION, type OptionsCardT } from '../cards.js';
import { stableId } from '../ids.js';
import type { ResultsStore } from '../results.js';
import type { StoredOffer } from '../travel.js';
import { spokenFirstName } from './travellers.js';

/** One line, theirs alone, asking for the tap that books it. */
export const tapAgainLine = (name: string, title: string): string => `${spokenFirstName(name)}, tap I'll take this on ${title} and I'll book it.`;

/**
 * The Server refused a person's own ticket as no_pick: the Server grants it only for an option they tapped on Go's card in
 * the last 30 minutes, and this pick is older (a booking asked in words books the pick from before; prod, 11 Oct). A fresh
 * tap passes, so their card gets its "I'll take this" back on that option and one line asks for it: never a failure.
 * Their card as it was, when the booking kept it; else the option alone with its button, on their own card.
 */
export async function tapAgain(
  d: { link: Pick<ServerLink, 'request'>; log: { warn: (obj: object, msg: string) => void }; results?: Pick<ResultsStore, 'card' | 'replaceCard'> | undefined },
  ask: { tripId: string; personId: string; name: string; offer: StoredOffer; restore?: OptionsCardT },
  runId: string,
): Promise<void> {
  try {
    const again = ask.restore ?? (await ownCardWithPick(d, ask));
    if (again && d.results) {
      await d.results.replaceCard(ask.tripId, again);
      await d.link.request('replace_card', { trip_id: ask.tripId, card: again });
    }
  } catch (err) {
    d.log.warn({ err: String(err).slice(0, 200), cardId: ask.offer.cardId }, "travel: a person's card could not get its I'll take this back");
  }
  await d.link.request('post_message', {
    request_id: stableId('go_tap_again', runId), trip_id: ask.tripId, text: tapAgainLine(ask.name, ask.offer.title), visible_to_person_ids: [ask.personId],
  });
}

/** Their own card (for them alone) showing the option alone with "I'll take this"; null for a card the room shares. */
async function ownCardWithPick(
  d: { results?: Pick<ResultsStore, 'card'> | undefined },
  ask: { tripId: string; personId: string; offer: StoredOffer },
): Promise<OptionsCardT | null> {
  const row = ask.offer.cardId ? await d.results?.card(ask.tripId, ask.offer.cardId) : null;
  const forWho = row?.card.for_person_ids ?? [];
  const option = row?.card.options.find((o) => o.option_id === ask.offer.optionId);
  if (!row || !option || forWho.length !== 1 || forWho[0] !== ask.personId) return null;
  return { ...row.card, options: [option], actions: [{ ...PICK_ACTION, only_for_person_ids: [ask.personId] }] };
}
