/**
 * Code decides what becomes a fact or a record line. A model (the side pass, the composer, the trip's
 * computer) only proposes. The rules (spec §11 and the guide's add_record_line):
 *  - a fact's proof is a visible message written by that same person, with no secret in it;
 *  - "agreed" needs two people saying yes in words, or the organizer, and no objection; a reaction alone, a 👍 too, is
 *    never a yes; otherwise the line is written as "open";
 *  - a doing line names only people who said they would do it, and never rests on a message to Go (that is an ask:
 *    Go does it);
 *  - only an open question may cite Go's own message;
 *  - a person Go was asked to forget is never proof for anything said before the forget.
 */
import * as C from '@go/contract';
import { forgottenAt, isForgotten } from '../composer/fence.js';
import type { Message } from '../door/methods.js';
import { looksLikeMoney, saysMoneyMoved } from '../reflex/money-line.js';
import { messageText } from '../reflex/questions.js';
import { isSmallTalk } from '../reflex/small-talk.js';
import { hasSecret } from '../reflex/secrets.js';
import { partOfAskToGo, plainlyNamesGo } from '../trips/names-go.js';
import type { TripPack } from '../trips/pack.js';
import { normTopic, type Audience, type FactScope } from './facts.js';

export interface FactProposal {
  person_id: string;
  topic: string;
  text: string;
  message_id: string;
  audience?: Audience;
  /** Only about this trip: never carried into the person's next trips. */
  this_trip?: boolean;
  /** Read off the person's reaction on someone's line: a lean, never a rule. */
  reaction?: boolean;
}
export interface LineProposal {
  kind: 'agreed' | 'open' | 'doing';
  text: string;
  person_ids: string[];
  proof: string[];
  objections?: string[];
  due_at?: string;
  /** Set to change one of Go's own lines (an open question that got settled, a job that is done). */
  line_id?: string;
  status?: 'done';
  /** What part of the plan the line is about (the notes pass says): dates, place, or anything else. */
  about?: 'dates' | 'place' | 'other';
}
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface CheckedFact {
  personId: string;
  tripId: string;
  topic: string;
  text: string;
  messageId: string;
  saidAt: Date;
  audience: Audience;
  scope: FactScope;
}
export interface CheckedLine {
  kind: 'agreed' | 'open' | 'doing';
  text: string;
  personIds: string[];
  proof: Array<{ message_id: string; person_id: string | null }>;
  dueAt?: string;
  lineId?: string;
  status?: 'done';
  /** Proposed as agreed, written as open because the bar was not met. */
  downgraded?: boolean;
}
export interface CheckEnv {
  pack: TripPack;
  /** person_id to the change number up to which Go must forget them in this trip. */
  forgotten: ReadonlyMap<string, number>;
  record: C.RecordLine[];
}

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const MASKED = /\[(card number )?hidden\]/;

/** One line of plain words: no newlines, no em dashes, 1 to max characters; null when it does not fit. */
export function cleanText(s: string, max: number): string | null {
  const t = s
    .replace(/\s*—\s*/g, ', ')
    .replace(/–/g, '-')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

/** Lowercase letters and digits only, for comparing lines. */
export function normLine(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function holdsSecret(m: Message): boolean {
  const t = messageText(m);
  return hasSecret(t) || MASKED.test(t);
}

/** What a fact read off a reaction may say: the reactor's lean, never a rule (staging, 10 Oct: 😍 and 👍 were missed). */
const LEAN = /^(?:prefers|likes|dislikes|wants)\b/i;

export function checkFact(p: FactProposal, env: CheckEnv): Checked<CheckedFact> {
  const m = env.pack.messages.find((x) => x.message_id === p.message_id);
  if (p.reaction) {
    // The proof is the line they reacted to, and their reaction on it: a lean of theirs, never someone else's words.
    if (!m || m.deleted || m.withheld || m.author.kind === 'system') return no('the proof is not a message in this trip');
    if (!m.reactions.some((r) => r.person_id === p.person_id)) return no('that person did not react to that line');
    if (!LEAN.test(p.text.trim())) return no('a reaction only shows a lean: Prefers, Likes, Dislikes or Wants');
    if (forgottenAt(env.forgotten, p.person_id, m.seq)) return no('that person asked Go to forget this');
  } else {
    if (!m || m.deleted || m.withheld || !m.text) return no('the proof is not a message in this trip');
    if (m.author.kind !== 'person' || m.author.person_id !== p.person_id) return no('the proof is not a message by that person');
    if (isForgotten(m, env.forgotten)) return no('that person asked Go to forget this');
  }
  if (!env.pack.trip.people.some((x) => x.person_id === p.person_id)) return no('that person is not in the trip');
  if (holdsSecret(m)) return no('the message holds a secret');
  const text = cleanText(p.text, 200);
  if (!text) return no('the fact text is empty or too long');
  if (hasSecret(text) || MASKED.test(text)) return no('the fact holds a secret');
  // A budget belongs to its trip (the group's, set for that trip): never a fact that carries
  // across trips, whether its topic says budget or its text names an amount ("Pool stay under ₹3,000 per night").
  if (normTopic(p.topic) === 'budget' || looksLikeMoney(text)) return no("a person's budget or money stays private to the trip");
  return {
    ok: true,
    value: {
      personId: p.person_id,
      tripId: env.pack.trip.trip_id,
      topic: normTopic(p.topic),
      text,
      messageId: m.message_id,
      saidAt: new Date(m.sent_at),
      audience: p.audience ?? 'group',
      scope: p.this_trip ? 'trip' : 'person',
    },
  };
}

export function checkLine(p: LineProposal, env: CheckEnv): Checked<CheckedLine> {
  const { pack } = env;
  // The plan already has it: a question about set dates or a set place is answered by the plan, never an open line (the
  // 9 Oct golden run: "Trip dates" opened for all five on a trip set for 6 to 9 Nov, and Go kept asking about it).
  if (p.kind === 'open' && !p.line_id && p.about === 'dates' && pack.trip.dates) return no('the trip already has its dates: a question about them is not open');
  if (p.kind === 'open' && !p.line_id && p.about === 'place' && pack.trip.destination) return no('the trip already has its place: a question about it is not open');
  const inTrip = new Set(pack.trip.people.map((x) => x.person_id));
  const text = cleanText(p.text, 200);
  if (!text) return no('the line text is empty or too long');
  if (hasSecret(text) || MASKED.test(text)) return no('the line holds a secret');

  const proofIds = [...new Set(p.proof)].slice(0, 10);
  if (proofIds.length === 0) return no('a line needs proof');
  const proof: Message[] = [];
  for (const id of proofIds) {
    const m = pack.messages.find((x) => x.message_id === id);
    if (!m || m.deleted || m.withheld) return no('a proof is not a message in this trip');
    if (m.author.kind === 'system') return no('a proof is not a message in this trip');
    if (m.author.kind === 'go' && p.kind !== 'open') return no('only an open question may cite Go');
    if (isForgotten(m, env.forgotten)) return no('a proof is from someone Go was asked to forget');
    if (holdsSecret(m)) return no('a proof message holds a secret');
    proof.push(m);
  }
  // A bare 👍, ok or haha is never a yes to anything: it counts for no one, and a line resting on nothing else is refused.
  // An agreement needs words that say what is agreed (a reaction alone is never a decision).
  if (!proof.some((m) => !isSmallTalk(m.text))) return no('a bare 👍 or ok is never proof: a yes says what it agrees to');
  const authors = proof.flatMap((m) => (m.author.kind === 'person' && !isSmallTalk(m.text) ? [m.author.person_id] : []));
  // "@Go what's planned for Sunday?" is a question put to Go, and Go answers it: an open line is for what the group still
  // has to settle among themselves. Lines of a burst that asked Go count the same. An agreement that fell short of a yes
  // still becomes open below, as before.
  const asked = proof.filter((m) => m.author.kind === 'person');
  if (p.kind === 'open' && asked.length > 0 && asked.every((m) => partOfAskToGo(m, pack))) {
    return no('an open line cannot rest on a question put to Go: Go answers it');
  }

  const named = [...new Set(p.person_ids)];
  if (named.some((id) => !inTrip.has(id))) return no('someone named is not in the trip');
  // Go's own question is open only until the people it asks speak again (prod, 11 Oct: "Goa or Gokarna for the beach
  // trip?" was opened as the person tapped Goa, and stayed open in everyone's record for a minute).
  if (p.kind === 'open' && !p.line_id && proof.every((m) => m.author.kind === 'go')) {
    const asked = new Set(named.length > 0 ? named : [...inTrip]);
    const after = Math.max(...proof.map((m) => m.seq));
    if (pack.messages.some((m) => m.seq > after && m.author.kind === 'person' && asked.has(m.author.person_id) && !m.deleted && !m.withheld)) {
      return no("Go's question was answered: the people it asks spoke after it");
    }
  }
  let personIds = named.slice(0, 30);

  let kind = p.kind;
  let downgraded = false;
  if (kind === 'agreed') {
    const objections = (p.objections ?? [])
      .map((id) => pack.messages.find((x) => x.message_id === id))
      .filter((m): m is Message => m !== undefined && !m.deleted && m.author.kind === 'person');
    // Only words say yes: a 👍 on a proof message is never a decision (Keshav's ruling).
    const yes = new Set(authors);
    for (const m of objections) if (m.author.kind === 'person') yes.delete(m.author.person_id);
    const enough = objections.length === 0 && (yes.size >= 2 || yes.has(pack.trip.organizer_person_id));
    if (enough) {
      personIds = [...new Set([...personIds, ...yes])].slice(0, 30);
    } else {
      kind = 'open';
      downgraded = true;
    }
  }
  // Nobody is asked for a budget (rev 4, the Server team's GO-TEAM-FINAL §2: production Go opened a line about collecting
  // everyone's): the trip's one budget is set in the App, or kept with set_budget once the group agrees one. So no line
  // about one is opened, nor left open when its agreement fell short. A line Go opened before can still be closed.
  if (kind === 'open' && !p.line_id && /\bbudgets?\b/i.test(text)) return no("the trip's budget is the group's, set in the App or with set_budget: never an open question");
  // Nor an agreed one: the App holds the budget the group agreed (set_budget writes it there), and a record line beside it
  // says it twice (prod, 11 Oct: "Group budget ₹20,000 per person", agreed, next to the App's ₹20,000).
  if (!p.line_id && /\bbudgets?\b/i.test(text)) return no("the trip's budget is kept in the App, never in the record");
  if (kind === 'doing') {
    // "@Go find flights Friday" is an ask: Go does it, so it is never "Rahul is finding flights". A promise said to Go in
    // the same breath ("@Go I'll sort the cab, you do flights") goes too: code cannot tell it from the ask beside it, and a
    // wrong name in everyone's record costs more than a line the person can say again.
    if (proof.some((m) => plainlyNamesGo(m, pack))) return no('a doing line cannot rest on a message to Go: that is an ask, and Go does it');
    // "I paid 2400 for the cab" is an expense, kept by record_expense with who shares it: not a job someone is doing.
    if (proof.some((m) => saysMoneyMoved(m.text))) return no('a payment or a debt is a money record, not a doing line');
    if (personIds.length === 0) personIds = [...new Set(authors)];
    if (personIds.length === 0 || !personIds.every((id) => authors.includes(id))) {
      return no('a doing line names someone who did not say they would do it');
    }
  }

  if (p.line_id) {
    const existing = env.record.find((l) => l.line_id === p.line_id);
    if (!existing) return no('no such line');
    if (existing.source !== 'go') return no("that line is not Go's to change");
    if (existing.status === 'undone') return no('someone undid that line');
  } else {
    const key = normLine(text);
    if (env.record.some((l) => l.status === 'active' && normLine(l.text) === key)) return no('already in the record');
    const undone = env.record.find((l) => l.status === 'undone' && normLine(l.text) === key);
    if (undone && proof.every((m) => Date.parse(m.sent_at) <= Date.parse(undone.updated_at))) {
      return no('someone undid that line; it needs new messages to come back');
    }
  }

  const dueAt = p.due_at && C.IsoDateTime.safeParse(p.due_at).success ? p.due_at : undefined;
  return {
    ok: true,
    value: {
      kind,
      text,
      personIds,
      proof: proof.map((m) => ({ message_id: m.message_id, person_id: m.author.kind === 'person' ? m.author.person_id : null })),
      ...(dueAt ? { dueAt } : {}),
      ...(p.line_id ? { lineId: p.line_id } : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(downgraded ? { downgraded } : {}),
    },
  };
}
