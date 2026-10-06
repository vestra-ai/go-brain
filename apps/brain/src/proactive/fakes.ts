// Test fakes shared by the proactive, watches and calls tests: the Goa trip from the guide, a pack, a
// server link that records every request, a desk that keeps what it is given, a clock whose timers move by
// hand, and a fake Brain that records what a lane registers. Nothing here runs in production.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Message as MessageSchema, TripSnapshot, type Card } from '@go/contract';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Brain } from '../app.js';
import type { NowProvider, TurnLimits } from '../composer/context.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { DeskItem } from '../desk/desk.js';
import type { UpgradeHandler } from '../door/handlers.js';
import type { CardTapParams, CardTapResult, Message, Trip, TripEvent } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { ReflexRead } from '../reflex/reflex.js';
import type { TripPack } from '../trips/pack.js';
import type { Candidate } from './policy.js';

export const GOA_TZ = 'Asia/Kolkata';
const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];

const person = (person_id: string, name: string, role: 'organizer' | 'member' = 'member') => ({
  person_id, name, role, joined_at: '2026-10-05T02:30:00Z', know: [], has_upi: false, go_paused: false,
});

/** The guide's Goa trip, trimmed: one open vote (Arjun and Meher have not voted), the villa and a flight. */
export function goaTrip(over: Partial<Trip> = {}): Trip {
  return TripSnapshot.parse({
    trip_id: 't_goa',
    seq: 120,
    title: 'Goa',
    status: 'planning',
    created_at: '2026-10-05T02:30:00Z',
    organizer_person_id: 'p_rahul',
    invite_url: 'https://go.example/j/8fK2xQ',
    dates: { start: '2026-11-06', end: '2026-11-09' },
    vibe: ['beaches'],
    budget: { answered: 0, of: 5 },
    people: [person('p_rahul', 'Rahul', 'organizer'), person('p_priya', 'Priya'), person('p_arjun', 'Arjun'), person('p_meher', 'Meher'), person('p_kabir', 'Kabir')],
    decisions: [
      {
        decision_id: 'd_villa',
        question: 'Where do we stay?',
        kind: 'choice',
        anonymous: false,
        status: 'open',
        options: [
          { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'opt_villa_sol' },
          { label: 'Casa Azul', price_minor: 6180000, currency: 'INR', option_ref: 'opt_casa_azul' },
        ],
        closes_at: '2026-10-06T12:30:00Z',
        voted: 3,
        of: 5,
        tally: [2, 1],
        votes: [
          { person_id: 'p_rahul', option_index: 0 },
          { person_id: 'p_priya', option_index: 0 },
          { person_id: 'p_kabir', option_index: 1 },
        ],
        opened_at: '2026-10-05T07:30:00Z',
      },
    ],
    bookings: [
      {
        booking_id: 'b_villa', kind: 'stay', status: 'confirmed', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9',
        amount_minor: 5420000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: EVERYONE,
        refundable_until: '2026-11-01T18:29:59Z', starts_at: '2026-11-06T14:00:00+05:30', ends_at: '2026-11-09T11:00:00+05:30',
        created_at: '2026-10-05T09:03:00Z',
      },
      {
        booking_id: 'b_flight', kind: 'flight', status: 'confirmed', title: 'IndiGo 6E 2134, Delhi to Goa', vendor: 'ixigo', ref: 'PNR6E2134',
        amount_minor: 1650000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya', 'p_kabir'],
        starts_at: '2026-11-06T18:15:00+05:30', ends_at: '2026-11-06T20:45:00+05:30',
        journey: {
          mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOX' },
          depart_at: '2026-11-06T18:15:00+05:30', arrive_at: '2026-11-06T20:45:00+05:30',
          carrier_name: 'IndiGo', carrier_code: '6E', number: '6E 2134',
        },
        created_at: '2026-10-05T10:00:00Z',
      },
    ],
    expenses: [],
    money: { currency: 'INR', spent_minor: 7070000, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
    ...over,
  });
}

let nextSeq = 200;
export function msg(o: {
  id?: string;
  seq?: number;
  by?: string;
  text?: string | null;
  mentionsGo?: boolean;
  replyTo?: string;
  sentAt?: string;
  reactions?: Array<{ emoji: string; person_id?: string }>;
  withheld?: boolean;
  deleted?: boolean;
}): Message {
  nextSeq += 1;
  const seq = o.seq ?? nextSeq;
  const go = o.by === 'go';
  return MessageSchema.parse({
    message_id: o.id ?? `m_${seq}`,
    seq,
    updated_seq: seq,
    author: go ? { kind: 'go' } : { kind: 'person', person_id: o.by ?? 'p_priya' },
    text: o.text === undefined ? 'hi' : o.text,
    attachments: [],
    ...(o.replyTo ? { reply_to: o.replyTo } : {}),
    mentions_go: go ? false : (o.mentionsGo ?? false),
    mentions: [],
    reactions: o.reactions ?? [],
    withheld: o.withheld ?? false,
    deleted: o.deleted ?? false,
    sent_at: o.sentAt ?? '2026-10-06T06:00:00Z',
  });
}

export function goaPack(o: { trip?: Trip; messages?: Message[] } = {}): TripPack {
  const trip = o.trip ?? goaTrip();
  return { trip, messages: o.messages ?? [], seq: trip.seq };
}

export function fakePacks(...packs: TripPack[]) {
  const byId = new Map(packs.map((p) => [p.trip.trip_id, p]));
  return {
    set(p: TripPack): void {
      byId.set(p.trip.trip_id, p);
    },
    async get(tripId: string): Promise<TripPack> {
      const p = byId.get(tripId);
      if (!p) throw new Error(`no pack for ${tripId}`);
      return p;
    },
    invalidate(_tripId: string): void {},
  };
}

export interface LinkCall { method: string; params: Record<string, unknown> }

/** A ServerLink that records every request and answers like the Server would. */
export function fakeLink(o: { trip?: Trip; fail?: (method: string) => Error | null } = {}) {
  const calls: LinkCall[] = [];
  let n = 0;
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    n += 1;
    switch (method) {
      case 'post_message':
        return { message_id: `m_go_${n}`, seq: 1000 + n };
      case 'replace_card':
        return { message_id: `m_card_${String((params.card as { card_id?: string } | undefined)?.card_id)}` };
      case 'add_record_line':
        return { line_id: `r_${n}`, seq: 1000 + n };
      case 'read_trip':
        return o.trip ?? goaTrip();
      default:
        return { seq: 1000 + n };
    }
  };
  const link = {
    calls,
    of(method: string): Array<Record<string, unknown>> {
      return calls.filter((c) => c.method === method).map((c) => c.params);
    },
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      const err = o.fail?.(method) ?? null;
      if (err) throw err;
      return answer(method, params);
    },
    notify(method: string, params: Record<string, unknown>): void {
      calls.push({ method, params });
    },
    isOpen: (): boolean => true,
  };
  return link as typeof link & ServerLink;
}

export function fakeDesk() {
  const items: DeskItem[] = [];
  const cancelled: Array<{ tripId: string; ref: string }> = [];
  return {
    items,
    cancelled,
    async put(item: Omit<DeskItem, 'id'> & { id?: string }): Promise<void> {
      const id = item.id ?? `desk_${items.length + 1}`;
      if (items.some((i) => i.id === id)) return;
      items.push({ ...item, id });
    },
    async cancel(tripId: string, ref: string): Promise<void> {
      cancelled.push({ tripId, ref });
    },
  };
}

/** A clock whose timers run only when the test moves time forward. */
export function manualTime(startIso: string) {
  let t = Date.parse(startIso);
  let order = 0;
  const timers: Array<{ at: number; n: number; fn: () => void }> = [];
  return {
    now: (): Date => new Date(t),
    schedule(fn: () => void, ms: number): () => void {
      const timer = { at: t + ms, n: order++, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    /** Moves the clock forward, running every timer that falls due, in order. */
    advance(ms: number): void {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.n - b.n);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: (): number => timers.length,
  };
}

export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    tripId: 't_goa',
    dedupeKey: 'test:1',
    source: 'watch',
    topic: 'flight_status',
    dueAt: new Date('2026-10-06T06:30:00Z'),
    expiresAt: null,
    importance: 0.9,
    confidence: 1,
    urgency: 0.9,
    useful: ['pin', 'message'],
    personIds: ['p_arjun'],
    facts: {},
    simulated: false,
    small: false,
    ...over,
  };
}

export function unsureRead(over: Partial<ReflexRead> = {}): ReflexRead {
  const u = { value: null, sure: false } as const;
  return { forGo: u, complete: u, size: u, taskId: u, fact: u, recordKind: u, reaction: u, risky: u, opening: u, ...over };
}

/** A turn context like P1's makeTurnCtx: stableId(prefix) gives `<prefix>_<turnId>_<n>`, the same on a rerun. */
export function turnCtx(o: { link: ServerLink; pack: TripPack; wake: DeskItem[]; turnId?: string }): TurnCtx {
  const turnId = o.turnId ?? 'turn_test';
  const counts = new Map<string, number>();
  return {
    tripId: o.pack.trip.trip_id,
    turnId,
    link: o.link,
    pack: o.pack,
    outcome: { spoke: false, silent: false, reactions: 0, posts: [] as string[] },
    wake: o.wake,
    cards: [] as Card[],
    stableId(prefix: string): string {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${turnId}_${n}`;
    },
    signal: new AbortController().signal,
  } as TurnCtx;
}

export async function seedTrip(pool: pg.Pool, tripId: string, tz = GOA_TZ): Promise<void> {
  await pool.query(`insert into trips (trip_id, last_seq, tz) values ($1, 0, $2) on conflict (trip_id) do nothing`, [tripId, tz]);
}

type ReadHook = (msg: Message, read: ReflexRead, pack: TripPack) => Promise<void>;
type EventHook = (ev: TripEvent) => void | Promise<void>;
type TapHook = (tap: CardTapParams, card: Card) => Promise<CardTapResult>;
type TurnRulesFn = (wake: DeskItem[]) => TurnLimits | null;

export interface Registered {
  tools: Array<QuickTool<any>>;
  wakes: Map<string, (item: DeskItem, pack: TripPack) => string>;
  nows: NowProvider[];
  onRead: ReadHook[];
  onEvent: EventHook[];
  taps: Map<string, TapHook>;
  turnRules: TurnRulesFn[];
  upgrades: Array<{ path: RegExp; handle: UpgradeHandler }>;
  stops: Array<() => Promise<void> | void>;
}

/** A Brain whose parts record what a lane registers. `http` is a real Fastify instance (not listening). */
export function fakeBrain(o: { pool: pg.Pool; now: () => Date; env?: Record<string, string>; switches?: Record<string, string>; pack?: TripPack }) {
  const app = Fastify();
  const reg: Registered = { tools: [], wakes: new Map(), nows: [], onRead: [], onEvent: [], taps: new Map(), turnRules: [], upgrades: [], stops: [] };
  // Like P1's door: an upgrade on a lane's path goes to that lane; any other path is refused.
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const lane = reg.upgrades.find((u) => u.path.test(path));
    if (lane) lane.handle(req, socket, head);
    else socket.destroy();
  });
  const link = fakeLink();
  const desk = fakeDesk();
  const packs = fakePacks(o.pack ?? goaPack());
  const values: Record<string, string> = { ...(o.switches ?? {}) };
  const switches = {
    values,
    get: (name: string): string => values[name] ?? '',
    set: async (name: string, value: string): Promise<void> => {
      values[name] = value;
    },
  };
  const brain = {
    env: { ...(o.env ?? {}) },
    pool: o.pool,
    log: app.log,
    now: o.now,
    http: app,
    onStop: (fn: () => Promise<void> | void): void => { reg.stops.push(fn); },
    door: {
      link,
      handle: (): void => {},
      onUpgrade: (path: RegExp, handle: UpgradeHandler): void => { reg.upgrades.push({ path, handle }); },
    },
    taps: { on: (kind: string, action: string, h: TapHook): void => { reg.taps.set(`${kind}:${action}`, h); } },
    tripLog: {
      onEvent: (fn: EventHook): void => { reg.onEvent.push(fn); },
      append: async (): Promise<'new'> => 'new',
      lastSeq: async (): Promise<number> => 0,
    },
    packs,
    setup: { addStep: (): void => {}, ensureTrip: async (): Promise<void> => {} },
    desk,
    tools: { register: (t: QuickTool<any>): void => { reg.tools.push(t); }, list: (): Array<QuickTool<any>> => reg.tools },
    context: {
      addNow: (p: NowProvider): void => { reg.nows.push(p); },
      addWake: (kind: string, render: (item: DeskItem, pack: TripPack) => string): void => { reg.wakes.set(kind, render); },
      addTurnRules: (fn: TurnRulesFn): void => { reg.turnRules.push(fn); },
    },
    hooks: { onRead: (fn: ReadHook): void => { reg.onRead.push(fn); } },
    switches,
    reflex: { read: async (): Promise<ReflexRead> => unsureRead() },
  } as unknown as Brain;
  return { brain, app, reg, link, desk, packs, switches };
}
