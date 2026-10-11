// One trip as the simulated Server holds it, in memory: the snapshot, the room's messages, the stored answers to
// Go's writes, spend approvals, and every ballot (even in an anonymous vote). It follows the Server's rules in
// docs/guide/04-gos-requests.md: every change takes the next change number and makes one event; a write is done
// once per request_id, with the stored answer checked before any rule; every rule is checked before anything
// changes, so a refused write leaves the trip as it was.
import { Event, MAX_FRAME_BYTES, type Card, type Message, type TripSnapshot } from '@go/contract';
import type * as C from '@go/contract';
import type { z } from 'zod';
import { SocketCallError } from '../server-socket.js';

export type Code = 'not_found' | 'invalid' | 'conflict';
const NUMBER: Record<Code, number> = { not_found: 404, invalid: 422, conflict: 409 };

/** The error Go gets: the number in error.code and the name in error.data.code. */
export const fail = (code: Code, message: string): SocketCallError => new SocketCallError(NUMBER[code], message.slice(0, 500), code);

export type Decision = TripSnapshot['decisions'][number];
export type RecordLine = TripSnapshot['record'][number];
export type Booking = TripSnapshot['bookings'][number];
export type Expense = TripSnapshot['expenses'][number];
export type Params<S extends z.ZodType> = z.infer<S>;

export interface Approval {
  approval_id: string;
  /** The vote; null for 1.3's personal approval, which names the person's own pick instead. */
  decision_id: string | null;
  personal: { person_id: string; card_id: string; option_id: string } | null;
  payer_person_id: string;
  amount_minor: number;
  currency: string;
  expires_at: Date;
  used: boolean;
  cancelled: boolean;
}

export interface Change<R> {
  result: R;
  events: Event[];
}

export interface SayOptions {
  replyTo?: string;
  aboutMessageId?: string;
  attachments?: Message['attachments'];
  /** Defaults to the person's go_paused. */
  withheld?: boolean;
}

export interface NeedsItem {
  kind: 'vote' | 'mandate' | 'card' | 'line';
  ref: string;
  text: string;
}

export interface TripDeps {
  mint: (prefix: string) => string;
  now: () => Date;
  /** The largest read_messages answer. Defaults to the frame limit, less room for the frame around it. */
  maxPageBytes?: number;
}

/** How the sim decides a message is for Go: "@Go" in any case, the word "Go" with a capital G, or a reply to Go. */
export function mentionsGo(text: string, replyToGo: boolean): boolean {
  return replyToGo || /@go\b/i.test(text) || /\bGo\b/.test(text);
}

const GO_TYPING_MS = 10_000;

export class TripState {
  readonly trip: TripSnapshot;
  readonly messages: Message[] = [];
  /** request_id to the answer Go got. Only writes that worked are here. */
  readonly answers = new Map<string, unknown>();
  readonly approvals = new Map<string, Approval>();
  /** decision_id to person_id to option index, for every vote, anonymous ones included. */
  readonly ballots = new Map<string, Map<string, number>>();
  /** Every tap on Go's cards, as the Server records them: "person|card|option" to when (a personal approval's pick). */
  readonly taps = new Map<string, Date>();
  private typingUntil = 0;

  constructor(snapshot: TripSnapshot, private readonly deps: TripDeps) {
    this.trip = structuredClone(snapshot);
    for (const d of this.trip.decisions) {
      this.ballots.set(d.decision_id, new Map((d.votes ?? []).map((v) => [v.person_id, v.option_index])));
    }
  }

  get id(): string {
    return this.trip.trip_id;
  }

  now(): Date {
    return this.deps.now();
  }

  mint(prefix: string): string {
    return this.deps.mint(prefix);
  }

  /** trip.created: change number 1, carrying the whole trip. */
  created(): Event {
    this.trip.seq = 0;
    return this.bump('trip.created', { trip: { ...this.snapshot(), seq: 1 } });
  }

  /** Takes the next change number and makes its event. Never sends an event that breaks the contract. */
  bump<T extends Event['type']>(type: T, data: Extract<Event, { type: T }>['data']): Event {
    this.trip.seq += 1;
    const event = { event_id: this.mint('ev_'), trip_id: this.id, seq: this.trip.seq, occurred_at: this.now().toISOString(), type, data };
    Event.parse(event); // checks it; the event sent keeps every field, cards included, exactly as stored
    return event as unknown as Event;
  }

  /** Does a write once per request_id: a repeat gets the first answer back, before any rule runs. */
  once<R>(requestId: string, work: () => Change<R>): Change<R> & { repeat: boolean } {
    if (this.answers.has(requestId)) return { result: this.answers.get(requestId) as R, events: [], repeat: true };
    const change = work();
    this.answers.set(requestId, change.result);
    return { ...change, repeat: false };
  }

  // ── lookups and the shared rules ──

  person(id: string, field: string): void {
    if (!this.trip.people.some((p) => p.person_id === id)) throw fail('invalid', `${field}: ${id} is not in this trip`);
  }

  people(ids: readonly string[], field: string): void {
    for (const id of ids) this.person(id, field);
  }

  message(id: string): Message | undefined {
    return this.messages.find((m) => m.message_id === id);
  }

  messageIn(id: string, field: string): Message {
    const m = this.message(id);
    if (!m) throw fail('invalid', `${field}: ${id} is not a message in this trip`);
    return m;
  }

  decision(id: string): Decision | undefined {
    return this.trip.decisions.find((d) => d.decision_id === id);
  }

  booking(id: string): Booking | undefined {
    return this.trip.bookings.find((b) => b.booking_id === id);
  }

  /** Every amount in a trip uses the trip's one currency. */
  currency(c: string | null | undefined, field: string): void {
    if (c != null && c !== this.trip.money.currency) throw fail('invalid', `${field}: ${c} is not the trip's currency, ${this.trip.money.currency}`);
  }

  cardMessage(cardId: string): Message | undefined {
    return this.messages.find((m) => m.card?.card_id === cardId);
  }

  /** The Server records a tap on one of Go's cards, with the option when the button was on one. */
  recordTap(personId: string, cardId: string, optionId: string | undefined): void {
    if (optionId) this.taps.set(`${personId}|${cardId}|${optionId}`, this.now());
  }

  // ── reads ──

  /** The trip as Go may see it: an anonymous vote never says who voted for what. */
  snapshot(): TripSnapshot {
    const s = structuredClone(this.trip);
    for (const d of s.decisions) if (d.anonymous) delete d.votes;
    return s;
  }

  readTrip(): TripSnapshot {
    return this.snapshot();
  }

  /** Messages changed after a change number, oldest change first, with fewer than `limit` when the page would be too big. */
  readMessages(p: Params<typeof C.ReadMessages>): { messages: Message[]; has_more: boolean } {
    const limit = p.limit ?? 200;
    const changed = this.messages.filter((m) => m.updated_seq > p.after_seq).sort((a, b) => a.updated_seq - b.updated_seq);
    const page = changed.slice(0, limit).map((m) => structuredClone(m));
    let hasMore = changed.length > page.length;
    const max = this.deps.maxPageBytes ?? MAX_FRAME_BYTES - 4096;
    while (page.length > 1 && Buffer.byteLength(JSON.stringify({ messages: page, has_more: false })) > max) {
      page.pop();
      hasMore = true;
    }
    return { messages: page, has_more: hasMore };
  }

  // ── Go in the room ──

  postMessage(p: Params<typeof C.PostMessage>, raw: Record<string, unknown>): Change<{ message_id: string; seq: number }> {
    this.people(p.mentions ?? [], 'mentions');
    // 1.2: a message only these people see. Fixed when posted; replace_card keeps it.
    this.people(p.visible_to_person_ids ?? [], 'visible_to_person_ids');
    if (p.reply_to != null) this.messageIn(p.reply_to, 'reply_to');
    const card = p.card ?? undefined;
    if (card) {
      this.checkRecordCard(card);
      if (card.kind === 'mandate' && !this.decision(card.decision_id)?.mandate) {
        throw fail('conflict', `decision ${card.decision_id} has no mandate yet: set_mandate first`);
      }
      if (this.cardMessage(card.card_id)) throw fail('conflict', `card ${card.card_id} is already in the room: use replace_card`);
    }
    const seq = this.trip.seq + 1;
    const message: Message = {
      message_id: this.mint('m_'),
      seq,
      updated_seq: seq,
      author: { kind: 'go' },
      ...(p.text != null ? { text: p.text } : {}),
      attachments: [],
      ...(p.reply_to != null ? { reply_to: p.reply_to } : {}),
      mentions_go: false,
      mentions: p.mentions ?? [],
      reactions: [],
      // The card exactly as Go sent it, so a field this copy of the contract does not know still reaches the room.
      ...(raw.card != null ? { card: raw.card as Card } : {}),
      ...(p.visible_to_person_ids != null ? { visible_to_person_ids: [...p.visible_to_person_ids] } : {}),
      withheld: false,
      deleted: false,
      sent_at: this.now().toISOString(),
    };
    this.messages.push(message);
    this.typingUntil = 0; // Go's message landed, so "Go is typing..." goes away
    const ev = this.bump('message.created', { message: structuredClone(message) });
    return { result: { message_id: message.message_id, seq: ev.seq }, events: [ev] };
  }

  /** Not a change to the trip: no change number, no event. */
  replaceCard(p: Params<typeof C.ReplaceCard>, raw: Record<string, unknown>): { message_id: string } {
    const m = this.cardMessage(p.card.card_id);
    if (!m || m.author.kind !== 'go') throw fail('not_found', `card ${p.card.card_id} is not on one of Go's messages in this trip`);
    m.card = raw.card as Card;
    return { message_id: m.message_id };
  }

  typing(on: boolean): void {
    this.typingUntil = on ? this.now().getTime() + GO_TYPING_MS : 0;
  }

  typingOn(): boolean {
    return this.typingUntil > this.now().getTime();
  }

  addReaction(p: Params<typeof C.AddReaction>): Change<{ seq: number }> {
    const m = this.message(p.message_id);
    if (!m) throw fail('not_found', `message ${p.message_id} is not in this trip`);
    if (m.deleted) throw fail('conflict', `message ${p.message_id} is deleted`);
    if (m.reactions.some((r) => r.person_id == null && r.emoji === p.emoji)) throw fail('conflict', `Go already reacted ${p.emoji} to ${p.message_id}`);
    m.reactions.push({ emoji: p.emoji });
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.added', { message_id: m.message_id, reaction: { emoji: p.emoji, person_id: null } });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  removeReaction(p: Params<typeof C.RemoveReaction>): Change<{ seq: number }> {
    const m = this.message(p.message_id);
    if (!m) throw fail('not_found', `message ${p.message_id} is not in this trip`);
    const i = m.reactions.findIndex((r) => r.person_id == null && r.emoji === p.emoji);
    if (i < 0) throw fail('conflict', `Go has no ${p.emoji} on ${p.message_id}`);
    m.reactions.splice(i, 1);
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.removed', { message_id: m.message_id, reaction: { emoji: p.emoji, person_id: null } });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  updateTrip(p: Params<typeof C.UpdateTrip>): Change<{ seq: number }> {
    const changed: Array<'title' | 'destination' | 'dates' | 'vibe' | 'stay' | 'itinerary'> = [];
    if (p.title != null) changed.push('title');
    if (p.destination != null) changed.push('destination');
    if (p.dates != null) changed.push('dates');
    if (p.vibe != null) changed.push('vibe');
    if (p.stay != null) changed.push('stay');
    if (p.itinerary != null) changed.push('itinerary');
    if (changed.length === 0) throw fail('invalid', 'send at least one field to change besides request_id and trip_id');
    if (p.dates != null && p.dates.start > p.dates.end) throw fail('invalid', 'dates: start is after end');
    for (const day of p.itinerary ?? []) {
      for (const item of day.items) {
        if (item.booking_id != null && !this.booking(item.booking_id)) throw fail('invalid', `itinerary: booking ${item.booking_id} is not in this trip`);
      }
    }
    if (p.title != null) this.trip.title = p.title;
    if (p.destination != null) this.trip.destination = p.destination;
    if (p.dates != null) this.trip.dates = p.dates;
    if (p.vibe != null) this.trip.vibe = p.vibe;
    if (p.stay != null) this.trip.stay = p.stay;
    if (p.itinerary != null) this.trip.itinerary = p.itinerary;
    const ev = this.bump('trip.updated', { by: { kind: 'go' }, changed });
    return { result: { seq: ev.seq }, events: [ev] };
  }

  // ── people in the room (the sim's helpers; the real Server gets these from the App) ──

  say(personId: string, text: string, o: SayOptions = {}): Change<Message> {
    const person = this.trip.people.find((p) => p.person_id === personId);
    if (!person) throw fail('invalid', `personId: ${personId} is not in this trip`);
    const replyTo = o.replyTo != null ? this.messageIn(o.replyTo, 'replyTo') : undefined;
    const withheld = o.withheld ?? person.go_paused;
    const seq = this.trip.seq + 1;
    const message: Message = {
      message_id: this.mint('m_'),
      seq,
      updated_seq: seq,
      author: { kind: 'person', person_id: personId },
      ...(withheld ? {} : { text }),
      attachments: withheld ? [] : (o.attachments ?? []),
      // A withheld message says nothing of what it answers: reply_to is null, as the guide's withheld example shows.
      ...(withheld ? { reply_to: null } : replyTo ? { reply_to: replyTo.message_id } : {}),
      ...(!withheld && o.aboutMessageId != null ? { about_message_id: o.aboutMessageId } : {}),
      mentions_go: !withheld && mentionsGo(text, replyTo?.author.kind === 'go'),
      mentions: withheld ? [] : this.mentioned(text),
      reactions: [],
      withheld,
      deleted: false,
      sent_at: this.now().toISOString(),
    };
    this.messages.push(message);
    const ev = this.bump('message.created', { message: structuredClone(message) });
    return { result: structuredClone(message), events: [ev] };
  }

  react(personId: string, messageId: string, emoji: string): Change<void> {
    this.person(personId, 'personId');
    const m = this.message(messageId);
    if (!m || m.deleted) throw fail('not_found', `message ${messageId} is not in this trip`);
    if (m.reactions.some((r) => r.person_id === personId && r.emoji === emoji)) return { result: undefined, events: [] };
    m.reactions.push({ emoji, person_id: personId });
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('reaction.added', { message_id: messageId, reaction: { emoji, person_id: personId } });
    return { result: undefined, events: [ev] };
  }

  edit(personId: string, messageId: string, text: string): Change<Message> {
    const m = this.ownMessage(personId, messageId);
    const replyToGo = m.reply_to != null && this.message(m.reply_to)?.author.kind === 'go';
    m.text = text;
    m.mentions_go = !m.withheld && mentionsGo(text, replyToGo);
    m.mentions = m.withheld ? [] : this.mentioned(text);
    m.edited_at = this.now().toISOString();
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('message.edited', { message: structuredClone(m) });
    return { result: structuredClone(m), events: [ev] };
  }

  delete(personId: string, messageId: string): Change<void> {
    const m = this.ownMessage(personId, messageId);
    m.deleted = true;
    delete m.text;
    m.attachments = [];
    m.updated_seq = this.trip.seq + 1;
    const ev = this.bump('message.deleted', { message_id: messageId });
    return { result: undefined, events: [ev] };
  }

  /** "Forget me in this trip", the Server's half: the person's join answers are cleared, so Go cannot learn them again. */
  clearJoinAnswers(personId: string): Change<void> {
    const person = this.trip.people.find((p) => p.person_id === personId);
    if (!person) throw fail('invalid', `personId: ${personId} is not in this trip`);
    const changed: Array<'from_city' | 'earliest_leave' | 'know'> = [];
    if (person.from_city != null) {
      person.from_city = null;
      changed.push('from_city');
    }
    if (person.earliest_leave != null) {
      person.earliest_leave = null;
      changed.push('earliest_leave');
    }
    if (person.know.length > 0) {
      person.know = [];
      changed.push('know');
    }
    if (changed.length === 0) return { result: undefined, events: [] };
    const ev = this.bump('person.updated', { person: structuredClone(person), changed });
    return { result: undefined, events: [ev] };
  }

  /** What the App's "needs you" strip shows this person, worked out from the trip like the Server does. */
  needsYou(personId: string): NeedsItem[] {
    const out: NeedsItem[] = [];
    for (const d of this.trip.decisions) {
      if (d.status === 'open' && !this.ballots.get(d.decision_id)?.has(personId)) out.push({ kind: 'vote', ref: d.decision_id, text: d.question });
      const m = d.mandate;
      if (m && m.payer_person_id === personId && m.confirmed_at == null && m.declined_at == null) {
        out.push({ kind: 'mandate', ref: d.decision_id, text: `Book ${d.options[m.choice_index]?.label ?? 'the winner'}?` });
      }
    }
    for (const msg of this.messages) {
      if (msg.card?.for_person_ids?.includes(personId)) out.push({ kind: 'card', ref: msg.card.card_id, text: msg.card.fallback_text });
    }
    for (const l of this.trip.record) {
      if (l.kind === 'open' && l.status === 'active' && l.person_ids.includes(personId)) out.push({ kind: 'line', ref: l.line_id, text: l.text });
    }
    return out;
  }

  private ownMessage(personId: string, messageId: string): Message {
    const m = this.message(messageId);
    if (!m || m.deleted) throw fail('not_found', `message ${messageId} is not in this trip`);
    if (m.author.kind !== 'person' || m.author.person_id !== personId) throw fail('conflict', `${personId} did not write ${messageId}`);
    return m;
  }

  private mentioned(text: string): string[] {
    const lower = text.toLowerCase();
    return this.trip.people.filter((p) => lower.includes(`@${p.name.toLowerCase()}`)).map((p) => p.person_id);
  }

  /** A record card's id must be a row of this trip. */
  private checkRecordCard(card: Card): void {
    if ((card.kind === 'vote' || card.kind === 'mandate') && !this.decision(card.decision_id)) {
      throw fail('invalid', `card.decision_id: ${card.decision_id} is not a vote in this trip`);
    }
    if (card.kind === 'ticket' && !this.booking(card.booking_id)) throw fail('invalid', `card.booking_id: ${card.booking_id} is not a booking in this trip`);
    if (card.kind === 'expense' && !this.trip.expenses.some((e) => e.expense_id === card.expense_id)) {
      throw fail('invalid', `card.expense_id: ${card.expense_id} is not an expense in this trip`);
    }
  }
}
