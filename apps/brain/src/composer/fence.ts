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

/**
 * A person going on from Go's answer to them, without @Go (prod, 11 Oct 08:22: "also mention that he should be my
 * roommate", right after Go answered that person, got silence). Go's latest message before it answered them (it replies
 * to their message, or names them alone), nobody spoke in between, and it is the first thing they said since. Message id
 * to Go's answer's number. A line that answers a question Go asked is answersToGo's, and keeps that mark.
 */
export function followsGoAnswer(pack: TripPack): Map<string, number> {
  const out = new Map<string, number>();
  const questions = answersToGo(pack);
  let open: { seq: number; to: string } | null = null;
  for (const m of pack.messages) {
    const a = m.author;
    if (m.deleted || a.kind === 'system') continue;
    if (a.kind === 'go') {
      const repliedTo = m.reply_to ? pack.messages.find((x) => x.message_id === m.reply_to)?.author : undefined;
      const named = mentionsIn(m.text ?? '', pack.trip.people);
      const to = repliedTo?.kind === 'person' ? repliedTo.person_id : named.length === 1 ? named[0]! : null;
      open = to ? { seq: m.seq, to } : null;
      continue;
    }
    if (open?.to === a.person_id && !m.reply_to && !questions.has(m.message_id)) out.set(m.message_id, open.seq);
    open = null;
  }
  return out;
}

/** How one of Go's own earlier messages reads when it named someone who later had Go forget them in another trip. */
export const HIDDEN_GO = '[hidden: it named someone who asked Go to forget them]';

/**
 * The composer's view of a trip's chat: "#57 Priya: text", names and message numbers as the trip has them now.
 * `forgotElsewhere`: people who had Go forget them in another trip, each with the change number up to which Go's own
 * messages here that name them are hidden. Those messages may repeat what carry-over fed Go about them, and Go cannot
 * repeat what it cannot see (memory/forget-elsewhere.ts).
 */
export function roomView(pack: TripPack, forgotten: Forgotten, forgotElsewhere: Forgotten = new Map()): ChatView {
  const names = new Map(pack.trip.people.map((p) => [p.person_id, personName(p.name)]));
  const seqs = new Map(pack.messages.map((m) => [m.message_id, m.seq]));
  const answers = answersToGo(pack);
  const follows = followsGoAnswer(pack);
  // Paused people are named too: a name in Go's words is a name, whoever still hears from Go.
  const everyone = pack.trip.people.map((p) => ({ ...p, go_paused: false }));
  const namesForgotten = (m: Message): boolean => {
    if (m.author.kind !== 'go' || forgotElsewhere.size === 0) return false;
    const said = mentionsIn([m.text ?? '', m.card?.fallback_text ?? ''].join('\n'), everyone);
    return [...forgotElsewhere].some(
      ([id, upTo]) => m.seq <= upTo && (said.includes(id) || m.mentions.includes(id) || (m.card?.for_person_ids ?? []).includes(id)),
    );
  };
  return {
    forgotten,
    label: (m) =>
      m.deleted || m.withheld
        ? null
        : namesForgotten(m)
          ? `#${m.seq} Go (you): ${HIDDEN_GO}`
          : roomLabel(m, (id) => names.get(id) ?? 'Someone who left', (id) => seqs.get(id), (id) => answers.get(id), (id) => follows.get(id)),
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
  followOf: (messageId: string) => number | undefined = () => undefined,
): string | null {
  if (m.deleted || m.withheld) return null;
  const a = m.author;
  const who = a.kind === 'go' ? 'Go (you)' : a.kind === 'system' ? 'App' : nameOf(a.person_id);
  const parts: string[] = [];
  const replyTo = m.reply_to ? seqOf(m.reply_to) : undefined;
  if (replyTo !== undefined) parts.push(`(reply to #${replyTo})`);
  // A plain answer to a question Go asked this person: a reply to Go without the reply feature (answersToGo).
  const answers = answerOf(m.message_id);
  if (answers !== undefined) parts.push(`(answers Go's question #${answers})`);
  // Going on from Go's answer to this person: for Go as well, without @Go (followsGoAnswer).
  const follows = answers === undefined ? followOf(m.message_id) : undefined;
  if (follows !== undefined) parts.push(`(follows Go's answer #${follows})`);
  // "Ask Go about this": the message it asks about is its subject.
  const about = m.about_message_id ? seqOf(m.about_message_id) : undefined;
  if (about !== undefined) parts.push(`(about #${about})`);
  if (m.text) parts.push(defuse(m.text).replace(BREAK, '\n  '));
  for (const at of m.attachments) {
    if (at.kind === 'photo') parts.push(at.caption ? `[photo: ${defuse(oneLine(at.caption)).slice(0, 200)}]` : '[photo]');
    else if (at.kind === 'location') parts.push(`[📍 ${defuse(oneLine(at.name ?? `${at.lat},${at.lng}`)).slice(0, 120)}]`);
    else parts.push(`[file: ${defuse(oneLine(at.name)).slice(0, 80)}]`);
  }
  // An options card keeps its id, so "put the villas to a vote" names it (put_to_vote card_id) instead of searching again;
  // and its options by their numbers as the room sees them, so "the first bus" is card_id#1 for the ixigo tool.
  if (m.card) {
    const numbered = m.card.kind === 'options' ? `; ${m.card.options.map((o, i) => `${i + 1} ${defuse(oneLine(o.title)).slice(0, 40)}`).join(', ')}` : '';
    parts.push(`[${m.card.kind === 'options' ? `options card ${m.card.card_id}` : 'card'}: ${defuse(oneLine(m.card.fallback_text))}${numbered}]`);
  }
  if (parts.length === 0) return null;
  return `#${m.seq} ${who}: ${parts.join(' ')}`.slice(0, LINE_MAX);
}
