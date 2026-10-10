// FakeServer: the simulated Server. It opens the socket to Go like the real Server (GoSocket, signed, with
// ?instance=), keeps trips in memory, answers all 19 of Go's methods with the contract's rules, and sends each
// trip's events to Go one at a time, in change-number order, waiting for each answer. Its helpers play the
// people in the room: say, react, edit, delete, tap, vote, a vote closing on time, and the payer's yes or no.
import { randomBytes } from 'node:crypto';
import { CardActionResult, EventAccepted, ForgetResult, SOCKET_PATH, type Event, type Message, type TripSnapshot } from '@go/contract';
import type { z } from 'zod';
import { GoSocket, SocketCallError, SocketTimeoutError, type Handler } from './server-socket.js';
import { addVoteOptions, closeVote, closeVoteByTime, confirmMandate, declineMandate, openVote, setMandate, vote } from './state/decisions.js';
import { addBooking, addExpense, cancelSpendApproval, requestSpendApproval, updateBooking } from './state/money.js';
import { addRecordLine, updateRecordLine } from './state/records.js';
import { TripState, fail, type Change, type NeedsItem, type SayOptions } from './state/trip-state.js';
import { TEST_SPEND_PRIVATE_KEY_PEM } from './test-spend-key.js';

type Write = (s: TripState, p: any, raw: Record<string, unknown>, spendKey: string) => Change<unknown>;

/** Go's 15 writes. Each carries a request_id and is done once per request_id. */
const WRITES: Record<string, Write> = {
  post_message: (s, p, raw) => s.postMessage(p, raw),
  add_reaction: (s, p) => s.addReaction(p),
  remove_reaction: (s, p) => s.removeReaction(p),
  update_trip: (s, p) => s.updateTrip(p),
  open_vote: (s, p) => openVote(s, p),
  close_vote: (s, p) => closeVote(s, p),
  add_vote_options: (s, p) => addVoteOptions(s, p),
  set_mandate: (s, p) => setMandate(s, p),
  add_record_line: (s, p) => addRecordLine(s, p),
  update_record_line: (s, p) => updateRecordLine(s, p),
  add_booking: (s, p) => addBooking(s, p),
  update_booking: (s, p) => updateBooking(s, p),
  add_expense: (s, p) => addExpense(s, p),
  request_spend_approval: (s, p, _raw, spendKey) => requestSpendApproval(s, p, spendKey),
  cancel_spend_approval: (s, p) => cancelSpendApproval(s, p),
};

export interface FakeServerOptions {
  /** Go's base URL (http(s):// or ws(s)://), with or without /v1/socket. */
  goUrl: string;
  /** GO_SIGNING_SECRET. */
  secret: string;
  /** This Server instance's name in the query string. Default "sim". */
  instance?: string;
  now?: () => Date;
  /** The key spend approvals are signed with. Default: the contract's TEST key (dev and tests only). */
  spendPrivateKeyPem?: string;
  /** How long to wait for Go's answer to an event (default 2000 ms), and the waits before each retry (default 200, 1000, 5000 ms). */
  eventTimeoutMs?: number;
  eventRetryMs?: readonly number[];
  /** The largest read_messages answer, for tests. */
  maxPageBytes?: number;
  /** The socket's reconnect waits, for tests. */
  backoffSeconds?: readonly number[];
  log?: (line: string) => void;
}

/** One of Go's writes as it arrived. `applied` is true for the arrival that changed the trip. */
export interface WriteRecord {
  method: string;
  request_id: string;
  trip_id: string;
  params: Record<string, unknown>;
  applied: boolean;
  error?: { code: number; message: string };
  at: string;
}

/** Every request and notification Go sent, in arrival order. */
export interface GoRequest {
  method: string;
  params: Record<string, unknown>;
  at: string;
}

/** An event the sim sent, with Go's answer or the last error. */
export interface SentEvent {
  event: Event;
  answer?: z.infer<typeof EventAccepted>;
  error?: string;
}

export type TapResult = z.infer<typeof CardActionResult>;

/** Go's socket URL for this instance: ws(s)://host/v1/socket?instance=<name>. */
export function socketUrl(goUrl: string, instance: string): string {
  const u = new URL(goUrl.replace(/^http/, 'ws'));
  if (u.pathname === '/' || u.pathname === '') u.pathname = SOCKET_PATH;
  u.searchParams.set('instance', instance);
  return u.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Keeps the items of a list that pass, in place. */
function keepOnly<T>(list: T[], keep: (x: T) => boolean): void {
  const kept = list.filter(keep);
  list.length = 0;
  for (const x of kept) list.push(x);
}
const RETRYABLE = new Set([429, 500, 503]);

export class FakeServer {
  readonly writes: WriteRecord[] = [];
  readonly requests: GoRequest[] = [];
  readonly events: SentEvent[] = [];
  private readonly trips = new Map<string, TripState>();
  private readonly order: string[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly handlers: Record<string, Handler>;
  private socket: GoSocket;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private n = 0;
  /** Random for each FakeServer, so its ids never repeat after a restart: Go ignores an event_id it has seen. */
  private readonly run = randomBytes(4).toString('hex');
  private open = false;
  private stopped = false;

  constructor(private readonly o: FakeServerOptions) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
    this.handlers = {
      read_trip: (p, raw) => this.answer('read_trip', raw, p.trip_id, (s) => s.readTrip()),
      read_messages: (p, raw) => this.answer('read_messages', raw, p.trip_id, (s) => s.readMessages(p)),
      replace_card: (p, raw) => this.answer('replace_card', raw, p.trip_id, (s) => s.replaceCard(p, raw)),
      // A notification: GoSocket never answers it, even when the trip is unknown.
      typing: (p, raw) => this.answer('typing', raw, p.trip_id, (s) => s.typing(p.on)),
    };
    for (const method of Object.keys(WRITES)) this.handlers[method] = (p, raw) => this.write(method, p, raw);
    this.socket = this.newSocket();
  }

  /** A socket to Go, signed fresh on every connect. Only the current socket's open and close change isOpen(). */
  private newSocket(): GoSocket {
    const sock: GoSocket = new GoSocket({
      url: socketUrl(this.o.goUrl, this.o.instance ?? 'sim'),
      secret: this.o.secret,
      // Signed with this Server's own clock, the one Go is given too in a test that moves time.
      nowSeconds: () => Math.floor(this.now().getTime() / 1000),
      handlers: this.handlers,
      ...(this.o.backoffSeconds ? { backoffSeconds: this.o.backoffSeconds } : {}),
      onOpen: () => {
        if (sock !== this.socket) return;
        this.open = true;
        this.log('socket to Go open');
        this.changed();
      },
      onClose: () => {
        if (sock !== this.socket) return;
        this.open = false;
        this.log('socket to Go closed');
        this.changed();
      },
      onError: (err) => this.log(`socket to Go: ${err.message}`),
    });
    return sock;
  }

  /** Opens the socket to Go and resolves once it is open (and, with a time limit, fails after it). */
  async start(timeoutMs?: number): Promise<void> {
    this.socket.start();
    await this.waitFor(() => this.open, timeoutMs ?? Number.POSITIVE_INFINITY);
  }

  stop(): void {
    this.stopped = true;
    this.socket.close();
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * The Server drops its socket and dials Go again on a new one, signed fresh. Trips, writes, requests and events are
   * kept; a request still waiting goes again on the new socket (an event keeps its event_id). `downMs` is how long the
   * Server stays away: Go accepts each signature once and a signature names its second, so tests wait at least 1,100 ms.
   */
  async reconnect(o: { downMs?: number; timeoutMs?: number } = {}): Promise<void> {
    if (this.stopped) throw new Error('this FakeServer was stopped');
    const old = this.socket;
    this.socket = this.newSocket();
    this.open = false;
    old.close(); // its waiting requests fail at once; sendOne sends a waiting event again on the new socket
    this.changed();
    if (o.downMs) await sleep(o.downMs);
    this.socket.start();
    await this.waitFor(() => this.open, o.timeoutMs ?? 5000);
  }

  // ── trips and people ──

  /** Adds a trip and sends trip.created (change 1) to Go. Resolves once Go answered it. */
  async createTrip(snapshot: TripSnapshot): Promise<SentEvent> {
    const s = new TripState(snapshot, {
      mint: (prefix) => this.mint(prefix),
      now: this.now,
      ...(this.o.maxPageBytes !== undefined ? { maxPageBytes: this.o.maxPageBytes } : {}),
    });
    if (this.trips.has(s.id)) throw new Error(`trip ${s.id} is already in this FakeServer`);
    this.trips.set(s.id, s);
    this.order.push(s.id);
    const created = s.created();
    this.changed();
    const [sent] = await this.send(s.id, [created]);
    return sent!;
  }

  /** A person says something in the room. Resolves with the message once Go answered its event. */
  say(personId: string, text: string, opts: SayOptions & { tripId?: string } = {}): Promise<Message> {
    return this.act(opts.tripId ?? this.lastTripId(), (s) => s.say(personId, text, opts));
  }

  react(personId: string, messageId: string, emoji: string): Promise<void> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.react(personId, messageId, emoji));
  }

  edit(personId: string, messageId: string, text: string): Promise<Message> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.edit(personId, messageId, text));
  }

  delete(personId: string, messageId: string): Promise<void> {
    return this.act(this.tripWith((s) => s.message(messageId) !== undefined, `message ${messageId}`), (s) => s.delete(personId, messageId));
  }

  vote(decisionId: string, personId: string, optionIndex: number): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => vote(s, decisionId, personId, optionIndex));
  }

  closeVoteByTime(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => closeVoteByTime(s, decisionId));
  }

  /** The payer taps "Yes, book it" on the mandate card. */
  confirmMandate(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => confirmMandate(s, decisionId));
  }

  /** The payer taps "Not now". */
  declineMandate(decisionId: string): Promise<void> {
    return this.act(this.tripWithDecision(decisionId), (s) => declineMandate(s, decisionId));
  }

  /** Someone taps a button on one of Go's cards: card_tap with a new tap_id, waiting 3.5 s like the Server. */
  async tap(cardId: string, actionId: string, personId: string, optionId?: string): Promise<TapResult> {
    const s = this.state(this.tripWith((t) => t.cardMessage(cardId) !== undefined, `card ${cardId}`));
    const tap = { tap_id: this.mint('tap_'), trip_id: s.id, card_id: cardId, action_id: actionId, person_id: personId, ...(optionId ? { option_id: optionId } : {}) };
    return CardActionResult.parse(await this.socket.request('card_tap', tap, { timeoutMs: 3500 }));
  }

  /**
   * Someone taps "Forget me in this trip" in the App: forget_person to Go, and once Go answers that nothing is left,
   * the Server clears the person's join answers in the trip and sends person.updated (guide 07).
   */
  async forgetPerson(personId: string, tripId: string = this.lastTripId()): Promise<z.infer<typeof ForgetResult>> {
    const result = ForgetResult.parse(await this.askGo('forget_person', { person_id: personId, trip_id: tripId }));
    await this.act(tripId, (s) => s.clearJoinAnswers(personId));
    return result;
  }

  /** Sends any of the Server's requests to Go (catch_up, get_person, forget_person, vault_link...). */
  askGo(method: string, params: object, timeoutMs = 2500): Promise<Record<string, unknown>> {
    return this.socket.request(method, params, { timeoutMs });
  }

  /** Resolves with the first value of `check` that is not null, undefined or false; checks every 10 ms of real time. */
  waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        let value: T | null | undefined | false;
        try {
          value = check();
        } catch (err) {
          reject(err);
          return;
        }
        if (value !== null && value !== undefined && value !== false) {
          resolve(value);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`waitFor: nothing after ${timeoutMs} ms`));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  // ── what tests read ──

  /** How many times a write with this request_id arrived, repeats included. */
  countWrites(requestId: string): number {
    return this.writes.filter((w) => w.request_id === requestId).length;
  }

  tripIds(): string[] {
    return [...this.order];
  }

  trip(tripId: string = this.lastTripId()): TripSnapshot {
    return this.state(tripId).snapshot();
  }

  messages(tripId: string = this.lastTripId()): Message[] {
    return structuredClone(this.state(tripId).messages);
  }

  typingOn(tripId: string = this.lastTripId()): boolean {
    return this.state(tripId).typingOn();
  }

  needsYou(personId: string, tripId: string = this.lastTripId()): NeedsItem[] {
    return this.state(tripId).needsYou(personId);
  }

  /** Whether a trip holds this person, message, card or decision. It copies nothing, so a refused action costs little. */
  has(tripId: string, what: { person?: string; message?: string; card?: string; decision?: string }): boolean {
    const s = this.trips.get(tripId);
    if (!s) return false;
    if (what.person !== undefined && !s.trip.people.some((p) => p.person_id === what.person)) return false;
    if (what.message !== undefined && s.message(what.message) === undefined) return false;
    if (what.card !== undefined && s.cardMessage(what.card) === undefined) return false;
    if (what.decision !== undefined && s.decision(what.decision) === undefined) return false;
    return true;
  }

  // ── for a FakeServer that runs for days (the hosted try room) ──

  /** Drops a trip and everything recorded about it. Go's later requests for it are answered not_found. */
  forgetTrip(tripId: string): void {
    this.trips.delete(tripId);
    this.queues.delete(tripId);
    const at = this.order.indexOf(tripId);
    if (at >= 0) this.order.splice(at, 1);
    keepOnly(this.writes, (w) => w.trip_id !== tripId);
    keepOnly(this.requests, (r) => r.params.trip_id !== tripId);
    keepOnly(this.events, (e) => e.event.trip_id !== tripId);
    this.changed();
  }

  /** Keeps only the newest `keep` writes, requests and events of each trip. */
  trimRecords(keep: number): void {
    const newest = <T>(list: T[], tripOf: (x: T) => unknown): void => {
      const seen = new Map<unknown, number>();
      const kept = new Set<T>();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const n = (seen.get(tripOf(list[i]!)) ?? 0) + 1;
        seen.set(tripOf(list[i]!), n);
        if (n <= keep) kept.add(list[i]!);
      }
      keepOnly(list, (x) => kept.has(x));
    };
    newest(this.writes, (w) => w.trip_id);
    newest(this.requests, (r) => r.params.trip_id);
    newest(this.events, (e) => e.event.trip_id);
  }

  /** Called after every change: a write, a person's action, an event answered, the socket opening or closing. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ── inside ──

  private mint(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.run}_${String(this.n).padStart(4, '0')}`;
  }

  private state(tripId: string): TripState {
    const s = this.trips.get(tripId);
    if (!s) throw fail('not_found', `trip ${tripId} does not exist`);
    return s;
  }

  private lastTripId(): string {
    const id = this.order[this.order.length - 1];
    if (!id) throw new Error('create a trip first: createTrip(goaFreshTrip())');
    return id;
  }

  private tripWith(test: (s: TripState) => boolean, what: string): string {
    for (const id of [...this.order].reverse()) if (test(this.state(id))) return id;
    throw new Error(`${what} is not in any trip`);
  }

  private tripWithDecision(decisionId: string): string {
    return this.tripWith((s) => s.decision(decisionId) !== undefined, `decision ${decisionId}`);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        this.log(`a change listener failed: ${String(err)}`);
      }
    }
  }

  private async act<R>(tripId: string, work: (s: TripState) => Change<R>): Promise<R> {
    const change = work(this.state(tripId));
    this.changed();
    await this.send(tripId, change.events);
    return change.result;
  }

  private async answer<R>(method: string, raw: Record<string, unknown>, tripId: string, work: (s: TripState) => R): Promise<R> {
    this.requests.push({ method, params: raw, at: this.now().toISOString() });
    const result = work(this.state(tripId));
    this.changed();
    return result;
  }

  private async write(method: string, p: { request_id: string; trip_id: string }, raw: Record<string, unknown>): Promise<object> {
    const at = this.now().toISOString();
    this.requests.push({ method, params: raw, at });
    const record: WriteRecord = { method, request_id: p.request_id, trip_id: p.trip_id, params: raw, applied: false, at };
    this.writes.push(record);
    try {
      const s = this.state(p.trip_id);
      const work = WRITES[method]!;
      const done = s.once(p.request_id, () => work(s, p, raw, this.o.spendPrivateKeyPem ?? TEST_SPEND_PRIVATE_KEY_PEM));
      record.applied = !done.repeat;
      // Answer first, then send the events, as the real Server's outbox does after its commit.
      setImmediate(() => void this.send(p.trip_id, done.events));
      this.changed();
      return done.result as object;
    } catch (err) {
      if (err instanceof SocketCallError) record.error = { code: err.code, message: err.message };
      this.changed();
      throw err;
    }
  }

  /** Queues events behind the trip's earlier ones; each is sent only after Go answered the one before. */
  private send(tripId: string, events: Event[]): Promise<SentEvent[]> {
    const before = this.queues.get(tripId) ?? Promise.resolve();
    const next = before.then(async () => {
      const sent: SentEvent[] = [];
      for (const event of events) sent.push(await this.sendOne(event));
      return sent;
    });
    this.queues.set(tripId, next.catch(() => undefined));
    return next;
  }

  private async sendOne(event: Event): Promise<SentEvent> {
    const record: SentEvent = { event };
    this.events.push(record);
    const waits = this.o.eventRetryMs ?? [200, 1000, 5000];
    for (let attempt = 0; ; attempt += 1) {
      if (this.stopped) return record;
      try {
        const answer = await this.socket.request('send_event', event, { timeoutMs: this.o.eventTimeoutMs ?? 2000 });
        record.answer = EventAccepted.parse(answer);
        delete record.error;
        this.changed();
        return record;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        const again = err instanceof SocketTimeoutError || (err instanceof SocketCallError && RETRYABLE.has(err.code));
        if (!again || attempt >= waits.length || this.stopped) {
          this.log(`event ${event.type} (change ${event.seq}) was not taken: ${record.error}`);
          this.changed();
          return record;
        }
        const wait = err instanceof SocketCallError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : (waits[attempt] ?? 5000);
        await sleep(wait);
      }
    }
  }
}
