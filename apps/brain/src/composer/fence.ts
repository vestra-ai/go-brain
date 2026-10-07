import type { Message } from '../door/methods.js';

const LINE_MAX = 1_500;

/** A display name can never carry fence syntax or pose as Go. */
export function personName(raw: string): string {
  const name =
    raw
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[<>[\]()#:]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'Someone';
  if (/^go$/i.test(name)) return `${name} (a member named Go)`;
  if (/^go\b/i.test(name)) return `${name} (a member)`;
  return name;
}

/** People's text can never open or close a data fence. */
export function defuse(text: string): string {
  return text.replace(/<\s*\/?\s*data\b[^>]*>/gi, '[tag removed]');
}

/** Every line break a model may read as one: \r\n, \r, \n, the Unicode line and paragraph separators, NEL, \v and \f. */
const BREAK = /\r\n|[\r\n\u2028\u2029\u0085\v\f]/g;

export const oneLine = (text: string): string => text.replace(BREAK, ' ').replace(/\s+/g, ' ').trim();

/** Lines of people's text, fenced as data. */
export function dataBlock(source: string, lines: string[]): string {
  return `<data source="${source}">\n${lines.join('\n')}\n</data>`;
}

/** A short piece of people's text inside one of Go's own lines. */
export function inlineData(text: string, max = 120): string {
  return `<data>${defuse(oneLine(text)).slice(0, max)}</data>`;
}

/**
 * One chat line: "#57 Priya: text". A message's own new lines are indented two spaces, so it can never
 * start a line that looks like another message. Deleted and withheld messages have no line.
 */
export function chatLine(
  m: Message,
  nameOf: (personId: string) => string,
  seqOf: (messageId: string) => number | undefined,
): string | null {
  if (m.deleted || m.withheld) return null;
  const a = m.author;
  const who = a.kind === 'go' ? 'Go (you)' : a.kind === 'system' ? 'Trip' : nameOf(a.person_id);
  const parts: string[] = [];
  const replyTo = m.reply_to ? seqOf(m.reply_to) : undefined;
  if (replyTo !== undefined) parts.push(`(reply to #${replyTo})`);
  // "Ask Go about this": the message it asks about is its subject.
  const about = m.about_message_id ? seqOf(m.about_message_id) : undefined;
  if (about !== undefined) parts.push(`(about #${about})`);
  if (m.text) parts.push(defuse(m.text).replace(BREAK, '\n  '));
  for (const at of m.attachments) {
    if (at.kind === 'photo') parts.push(at.caption ? `[photo: ${defuse(oneLine(at.caption)).slice(0, 200)}]` : '[photo]');
    else parts.push(`[file: ${defuse(oneLine(at.name)).slice(0, 80)}]`);
  }
  // An options card keeps its id, so "put the villas to a vote" names it (put_to_vote card_id) instead of searching again.
  if (m.card) parts.push(`[${m.card.kind === 'options' ? `options card ${m.card.card_id}` : 'card'}: ${defuse(oneLine(m.card.fallback_text))}]`);
  if (parts.length === 0) return null;
  return `#${m.seq} ${who}: ${parts.join(' ')}`.slice(0, LINE_MAX);
}
