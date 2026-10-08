import type { Message } from '../door/methods.js';
import type { TripPack } from '../trips/pack.js';
import { mentionsIn } from './speak.js';

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

/** Who Go was asked to forget in a trip: each person's id, and the change number up to which their words are hidden. */
export type Forgotten = ReadonlyMap<string, number>;

/** The one test of "Go was asked to forget this": a person's words up to their forget. What they say after it is new. */
export function forgottenAt(forgotten: Forgotten, personId: string | null, seq: number): boolean {
  if (personId === null) return false;
  const upTo = forgotten.get(personId);
  return upTo !== undefined && seq <= upTo;
}

export const isForgotten = (m: Pick<Message, 'author' | 'seq'>, forgotten: Forgotten): boolean =>
  m.author.kind === 'person' && forgottenAt(forgotten, m.author.person_id, m.seq);

/** How a forgotten person's earlier message reads, in every prompt that shows the chat. */
export const HIDDEN = '[hidden: someone asked Go to forget them]';

/**
 * How one prompt draws the chat: who was forgotten (always given, so no prompt can show their earlier words) and how a
 * message reads to that prompt's model. roomView is the composer's; memory's notesView is the side passes'.
 */
export interface ChatView<L extends string | null = string | null> {
  readonly forgotten: Forgotten;
  /** The message's line for this prompt; null leaves it out (the composer has no line for a deleted message). */
  readonly label: (m: Message) => L;
}

/**
 * Every chat line in every prompt, the composer's and the side passes': the one place a forgotten person's earlier words
 * are hidden. A message the view leaves out stays out.
 */
export function chatLine<L extends string | null>(m: Message, view: ChatView<L>): L | string {
  const shown = view.label(m);
  if (shown === null) return shown;
  return isForgotten(m, view.forgotten) ? `#${m.seq} ${HIDDEN}` : shown;
}

/** A link in Go's words: its "?" starts a query, not a question. */
const LINK = /\bhttps?:\/\/\S+/gi;

/**
 * The people one of Go's messages asks something: the ones it @mentions or pins its card to, or, only when it has
 * neither, the ones its words name ("Rahul, want me to try again?"). Nobody when it asks nothing.
 */
function askedIn(m: Message, people: TripPack['trip']['people']): string[] {
  if (!m.text?.replace(LINK, '').includes('?')) return [];
  const structured = [...m.mentions, ...(m.card?.for_person_ids ?? [])];
  return structured.length ? structured : mentionsIn(m.text, people);
}

/**
 * Plain answers to Go's questions, message id to the question's number. The chat app's reply feature marks a reply to
 * Go; a plain answer carried no mark, so the turn guessed it was the group talking and stayed silent ("Rahul, want me to
 * try again?", then 48 minutes later "heyy can you try creating the tickets now", trip t_try_7f4e8e657c4f). A person's
 * message answers Go when Go's latest message before it asks them something, nobody spoke in between (Go included), and
 * it is the first thing they said since. A message made with the reply feature keeps its own mark only.
 */
export function answersToGo(pack: TripPack): Map<string, number> {
  const out = new Map<string, number>();
  let open: { seq: number; to: string[] } | null = null;
  for (const m of pack.messages) {
    const a = m.author;
    if (m.deleted || a.kind === 'system') continue;
    if (a.kind === 'go') {
      const to = askedIn(m, pack.trip.people);
      open = to.length ? { seq: m.seq, to } : null;
      continue;
    }
    if (open?.to.includes(a.person_id) && !m.reply_to) out.set(m.message_id, open.seq);
    open = null;
  }
  return out;
}

/** The composer's view of a trip's chat: "#57 Priya: text", names and message numbers as the trip has them now. */
export function roomView(pack: TripPack, forgotten: Forgotten): ChatView {
  const names = new Map(pack.trip.people.map((p) => [p.person_id, personName(p.name)]));
  const seqs = new Map(pack.messages.map((m) => [m.message_id, m.seq]));
  const answers = answersToGo(pack);
  return {
    forgotten,
    label: (m) => roomLabel(m, (id) => names.get(id) ?? 'Someone who left', (id) => seqs.get(id), (id) => answers.get(id)),
  };
}

/**
 * One chat line for the composer: "#57 Priya: text". A message's own new lines are indented two spaces, so it can never
 * start a line that looks like another message. Deleted and withheld messages have no line.
 */
function roomLabel(
  m: Message,
  nameOf: (personId: string) => string,
  seqOf: (messageId: string) => number | undefined,
  answerOf: (messageId: string) => number | undefined,
): string | null {
  if (m.deleted || m.withheld) return null;
  const a = m.author;
  const who = a.kind === 'go' ? 'Go (you)' : a.kind === 'system' ? 'Trip' : nameOf(a.person_id);
  const parts: string[] = [];
  const replyTo = m.reply_to ? seqOf(m.reply_to) : undefined;
  if (replyTo !== undefined) parts.push(`(reply to #${replyTo})`);
  // A plain answer to a question Go asked this person: a reply to Go without the reply feature (answersToGo).
  const answers = answerOf(m.message_id);
  if (answers !== undefined) parts.push(`(answers Go's question #${answers})`);
  // "Ask Go about this": the message it asks about is its subject.
  const about = m.about_message_id ? seqOf(m.about_message_id) : undefined;
  if (about !== undefined) parts.push(`(about #${about})`);
  if (m.text) parts.push(defuse(m.text).replace(BREAK, '\n  '));
  for (const at of m.attachments) {
    if (at.kind === 'photo') parts.push(at.caption ? `[photo: ${defuse(oneLine(at.caption)).slice(0, 200)}]` : '[photo]');
    else if (at.kind === 'location') parts.push(`[location: ${defuse(oneLine(at.name ?? at.address ?? `${at.lat}, ${at.lng}`)).slice(0, 120)}]`);
    else parts.push(`[file: ${defuse(oneLine(at.name)).slice(0, 80)}]`);
  }
  // An options card keeps its id, so "put the villas to a vote" names it (put_to_vote card_id) instead of searching again.
  if (m.card) parts.push(`[${m.card.kind === 'options' ? `options card ${m.card.card_id}` : 'card'}: ${defuse(oneLine(m.card.fallback_text))}]`);
  if (parts.length === 0) return null;
  return `#${m.seq} ${who}: ${parts.join(' ')}`.slice(0, LINE_MAX);
}
