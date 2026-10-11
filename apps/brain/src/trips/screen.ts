import type { Message, TripEvent } from '../door/methods.js';
import { maskSecrets } from '../reflex/secrets.js';

const mask = (s: string): string => maskSecrets(s).text;

/**
 * A message only some people see (1.2, visible_to_person_ids: Go's own, posted to one traveller: their flight options,
 * their booking's steps, an owner's note). Keshav, 10 Oct: only those people see it. Go keeps none of its words.
 */
export const isPrivate = (m: Pick<Message, 'visible_to_person_ids'>): boolean => (m.visible_to_person_ids?.length ?? 0) > 0;

/**
 * A message with card numbers, CVVs, one-time codes and passwords hidden in everything a person typed: the text,
 * photo captions, file names, and a shared location's name and address (1.1). Runs before a message is written anywhere
 * (the trip log, the messages table, the pack).
 */
export function screenMessage(m: Message): Message {
  // Its words never reach the trip log, the messages table or the pack, so no turn, recall or summary can repeat them to
  // the room or to anyone it isn't for: what is kept is that it was posted, for its number in the trip.
  if (isPrivate(m)) return { ...m, text: null, card: null, attachments: [], quick_replies: null };
  const attachments = m.attachments.map((a) => {
    if (a.kind === 'file') return { ...a, name: mask(a.name) };
    if (a.kind === 'location') {
      return { ...a, ...(typeof a.name === 'string' ? { name: mask(a.name) } : {}), ...(typeof a.address === 'string' ? { address: mask(a.address) } : {}) };
    }
    return typeof a.caption === 'string' ? { ...a, caption: mask(a.caption) } : a;
  });
  return { ...m, ...(typeof m.text === 'string' ? { text: mask(m.text) } : {}), attachments };
}

/** The same screen on an event that carries a message; every other event passes through as it is. */
export function screenEvent(ev: TripEvent): TripEvent {
  if (ev.type === 'message.created' || ev.type === 'message.edited') {
    return { ...ev, data: { ...ev.data, message: screenMessage(ev.data.message) } };
  }
  return ev;
}
