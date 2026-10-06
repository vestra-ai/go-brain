import type { Message, TripEvent } from '../door/methods.js';
import { maskSecrets } from '../reflex/secrets.js';

const mask = (s: string): string => maskSecrets(s).text;

/**
 * A message with card numbers, CVVs, one-time codes and passwords hidden in everything a person typed: the text,
 * photo captions and file names. Runs before a message is written anywhere (the trip log, the messages table, the pack).
 */
export function screenMessage(m: Message): Message {
  const attachments = m.attachments.map((a) => {
    if (a.kind === 'file') return { ...a, name: mask(a.name) };
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
