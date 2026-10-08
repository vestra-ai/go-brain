/**
 * Lane C's test kit: a whole Brain made of small fakes that record what Go sent, so travel and tasks tests run
 * without the socket, the composer or a model. The pool is real (withSchema); everything else is here.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type * as C from '@go/contract';
import type { Brain } from '../../app.js';
import type { AnthropicLike } from '../../composer/anthropic.js';
import type { Desk, DeskItem, DeskKind } from '../../desk/desk.js';
import type { QuickTool, Tools, TurnCtx } from '../../composer/tools.js';
import type { Context, NowProvider } from '../../composer/context.js';
import type { ServerLink } from '../../door/server-link.js';
import type { TapRouter } from '../../door/taps.js';
import type { CardTapParams, CardTapResult, ToServerMethod, ToServerParams, ToServerResult } from '../../door/methods.js';
import type { Setup } from '../../trips/setup.js';
import type { TripPack } from '../../trips/pack.js';
import type { SwitchName, Switches } from '../../admin/switches.js';
import { GOA_TRIP, goaPack } from './goa.js';

/** Wednesday 7 Oct 2026, 12:00 UTC: the day G3 is checked. */
export const TEST_START_MS = Date.parse('2026-10-07T12:00:00Z');

export class FakeClock {
  constructor(public ms: number) {}
  readonly now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface SentRequest { method: string; params: Record<string, unknown> }

/** The Server's side of Go's requests. It stores each answer by request_id, as the real one does. */
export class FakeLink implements ServerLink {
  readonly requests: SentRequest[] = [];
  readonly notifications: SentRequest[] = [];
  /** The next request of this method throws this error instead of answering. */
  failNext: { method: string; error: Error } | null = null;
  private readonly answers = new Map<string, unknown>();
  private readonly cardMessages = new Map<string, string>();
  private n = 0;

  async request<M extends ToServerMethod>(method: M, params: ToServerParams<M>): Promise<ToServerResult<M>> {
    const p = structuredClone(params) as unknown as Record<string, unknown>;
    this.requests.push({ method, params: p });
    if (this.failNext && this.failNext.method === method) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
    const requestId = typeof p.request_id === 'string' ? p.request_id : null;
    if (requestId !== null && this.answers.has(requestId)) return this.answers.get(requestId) as ToServerResult<M>;
    const answer = this.answer(method, p);
    if (requestId !== null) this.answers.set(requestId, answer);
    return answer as ToServerResult<M>;
  }

  notify(method: 'typing', params: ToServerParams<'typing'>): void {
    this.notifications.push({ method, params: structuredClone(params) as unknown as Record<string, unknown> });
  }

  isOpen(): boolean {
    return true;
  }

  /** Every request of one method, oldest first. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  /** The latest version of a card, from post_message or replace_card. */
  card(cardId: string): Record<string, unknown> | undefined {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      const card = this.requests[i]!.params.card as Record<string, unknown> | undefined;
      if (card && card.card_id === cardId) return card;
    }
    return undefined;
  }

  private answer(method: string, p: Record<string, unknown>): unknown {
    this.n += 1;
    switch (method) {
      case 'post_message': {
        const card = p.card as { card_id?: string } | undefined;
        if (card?.card_id && this.cardMessages.has(card.card_id)) throw new Error(`409 conflict: card ${card.card_id} is already in this trip's room`);
        const messageId = `m_go_${this.n}`;
        if (card?.card_id) this.cardMessages.set(card.card_id, messageId);
        return { message_id: messageId, seq: 100 + this.n };
      }
      case 'replace_card': {
        const card = p.card as { card_id: string };
        const messageId = this.cardMessages.get(card.card_id);
        if (!messageId) throw new Error(`404 not_found: card ${card.card_id} is not on one of Go's messages`);
        return { message_id: messageId };
      }
      case 'open_vote':
        return { decision_id: `d_${this.n}`, seq: 100 + this.n };
      case 'read_trip':
        return GOA_TRIP;
      default:
        return { seq: 100 + this.n };
    }
  }
}

export class FakeDesk implements Desk {
  readonly items: DeskItem[] = [];
  readonly cancelled: Array<{ tripId: string; ref: string }> = [];
  async put(item: Omit<DeskItem, 'id'> & { id?: string }): Promise<void> {
    const id = item.id ?? `desk_${this.items.length + 1}`;
    if (this.items.some((i) => i.id === id)) return;
    this.items.push({ ...item, id });
  }
  async cancel(tripId: string, ref: string): Promise<void> {
    this.cancelled.push({ tripId, ref });
  }
  of(kind: DeskKind): DeskItem[] {
    return this.items.filter((i) => i.kind === kind);
  }
}

type TapKind = Parameters<TapRouter['on']>[0];
type TapHandler = (tap: CardTapParams, card: C.Card) => Promise<CardTapResult>;

export class FakeTaps implements TapRouter {
  readonly handlers = new Map<string, TapHandler>();
  on(kind: TapKind, actionId: string, h: TapHandler): void {
    this.handlers.set(`${kind}/${actionId}`, h);
  }
  async tap(kind: TapKind, actionId: string, tap: CardTapParams, card: C.Card): Promise<CardTapResult> {
    const h = this.handlers.get(`${kind}/${actionId}`);
    if (!h) throw new Error(`no tap handler for ${kind}/${actionId}`);
    return h(tap, card);
  }
  /** Master's TapRouter.dispatch. Lane C never dispatches a tap by id (it holds no card store), so tests use tap(). */
  async dispatch(tap: CardTapParams): Promise<CardTapResult> {
    throw new Error(`lane C tests tap with tap(kind, actionId, tap, card); dispatch(${tap.tap_id}) is P1's`);
  }
}

export class FakeTools implements Tools {
  private readonly byName = new Map<string, QuickTool<any>>();
  register(t: QuickTool<any>): void {
    if (this.byName.has(t.name)) throw new Error(`tool ${t.name} registered twice`);
    this.byName.set(t.name, t);
  }
  list(): QuickTool<any>[] {
    return [...this.byName.values()];
  }
  /** Runs a tool the way the composer does: the model's arguments are parsed first. */
  async run(name: string, args: unknown, ctx: TurnCtx): Promise<unknown> {
    const t = this.byName.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(t.input.parse(args), ctx);
  }
}

type WakeRender = (item: DeskItem, pack: TripPack) => string | null;

export class FakeContext implements Context {
  readonly nows: NowProvider[] = [];
  /** Every renderer per kind, in registration order, as P1's Context keeps them (P4, P5 and P6 all render 'tap'). */
  readonly wakes = new Map<DeskKind, WakeRender[]>();
  readonly turnRules: Array<Parameters<Context['addTurnRules']>[0]> = [];
  addNow(p: NowProvider): void {
    this.nows.push(p);
  }
  addWake(kind: DeskKind, render: WakeRender): void {
    this.wakes.set(kind, [...(this.wakes.get(kind) ?? []), render]);
  }
  /** How P1 reads one desk item in "why Go woke": the first renderer with a line wins; null means P1's generic line. */
  wake(item: DeskItem, pack: TripPack): string | null {
    for (const render of this.wakes.get(item.kind) ?? []) {
      const line = render(item, pack);
      if (line !== null) return line;
    }
    return null;
  }
  setStory(): void {
    // Lane C never folds the chat.
  }
  setForgotten(): void {
    // Nor forgets anyone.
  }
  addTurnRules(fn: Parameters<Context['addTurnRules']>[0]): void {
    this.turnRules.push(fn);
  }
  addWakeNote(): void {
    // Lane C's turns are scripted: no note under "why Go woke".
  }
  addEndNote(): void {
    // Nor an order at the end of the prompt.
  }
  /** The lanes' turn-end hooks: a test ends a turn as P1's composer does, by calling each one. */
  readonly turnEnds: Array<Parameters<Context['addTurnEnd']>[0]> = [];
  addTurnEnd(fn: Parameters<Context['addTurnEnd']>[0]): void {
    this.turnEnds.push(fn);
  }
  /** The lanes' answers with no model call: a test runs one as P1's composer does, before the model. */
  readonly directs: Array<Parameters<Context['addDirect']>[0]> = [];
  addDirect(fn: Parameters<Context['addDirect']>[0]): void {
    this.directs.push(fn);
  }
}

type SetupStep = Parameters<Setup['addStep']>[0];

export class FakeSetup implements Setup {
  readonly steps: SetupStep[] = [];
  addStep(step: SetupStep): void {
    this.steps.push(step);
  }
  async ensureTrip(tripId: string): Promise<void> {
    for (const s of this.steps) await s.run(tripId);
  }
  async run(name: string, tripId: string): Promise<void> {
    const s = this.steps.find((x) => x.name === name);
    if (!s) throw new Error(`no setup step ${name}`);
    await s.run(tripId);
  }
}

const SWITCH_DEFAULTS: Partial<Record<SwitchName, string>> = { TRAVEL_MODE: 'fake', TRAVEL_RUNNER: 'agent_job', PAY_RAIL: 'fake', CALLS_MODE: 'off', REFLEX_LIVE: '' };

export class FakeSwitches implements Switches {
  private readonly values = new Map<SwitchName, string>();
  get(name: SwitchName): string {
    return this.values.get(name) ?? SWITCH_DEFAULTS[name] ?? '';
  }
  async set(name: SwitchName, value: string): Promise<void> {
    this.values.set(name, value);
  }
}

export interface LaneBrain {
  brain: Brain;
  clock: FakeClock;
  link: FakeLink;
  desk: FakeDesk;
  taps: FakeTaps;
  tools: FakeTools;
  context: FakeContext;
  setup: FakeSetup;
  switches: FakeSwitches;
  http: FastifyInstance;
  /** What lanes registered with brain.onStop, oldest first. */
  stoppers: Array<() => Promise<void> | void>;
  /** Runs the stoppers newest first and empties the list, as P1's built.stop() does. */
  stop(): Promise<void>;
  /** A composer turn's context for the Goa trip. */
  ctx(over?: Partial<TurnCtx>): TurnCtx;
}

export function makeLaneBrain(o: { pool: pg.Pool; env?: Record<string, string>; startMs?: number }): LaneBrain {
  const clock = new FakeClock(o.startMs ?? TEST_START_MS);
  const http = Fastify({ logger: false });
  const link = new FakeLink();
  const desk = new FakeDesk();
  const taps = new FakeTaps();
  const tools = new FakeTools();
  const context = new FakeContext();
  const setup = new FakeSetup();
  const switches = new FakeSwitches();
  const stoppers: Array<() => Promise<void> | void> = [];
  const unsure = { value: null, sure: false as const };
  const noModel = (): never => {
    throw new Error('lane C tests never call the model');
  };
  const brain: Brain = {
    env: { GO_PUBLIC_URL: 'https://go.test', ...o.env } as unknown as Brain['env'],
    pool: o.pool,
    log: http.log,
    now: clock.now,
    http,
    anthropic: { messages: { stream: noModel, create: noModel } } as unknown as AnthropicLike,
    onStop: (fn) => {
      stoppers.push(fn);
    },
    door: { handle: () => undefined, onUpgrade: () => undefined, link },
    taps,
    tripLog: { append: async () => 'new', lastSeq: async () => 0, onEvent: () => undefined },
    packs: { get: async () => goaPack(), invalidate: () => undefined },
    setup,
    desk,
    tools,
    context,
    hooks: { onRead: () => undefined },
    switches,
    reflex: {
      read: async () => ({ forGo: unsure, complete: unsure, size: unsure, taskId: unsure, fact: unsure, recordKind: unsure, reaction: unsure, risky: unsure, opening: unsure }),
    },
  };
  const ctx = (over: Partial<TurnCtx> = {}): TurnCtx => {
    const turnId = over.turnId ?? 'turn_test_1';
    const counts = new Map<string, number>();
    return {
      tripId: 't_goa',
      turnId,
      link,
      pack: goaPack(),
      outcome: { spoke: false, silent: false, reactions: 0, posts: [] },
      wake: [],
      cards: [],
      lines: [],
      // The same ids P1's makeTurnCtx gives: a rerun of the same turn repeats them.
      stableId(prefix: string): string {
        const n = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, n);
        return `${prefix}_${turnId}_${n}`;
      },
      signal: new AbortController().signal,
      ...over,
    };
  };
  const stop = async (): Promise<void> => {
    for (const fn of stoppers.splice(0).reverse()) await fn();
  };
  return { brain, clock, link, desk, taps, tools, context, setup, switches, http, stoppers, stop, ctx };
}

/** Waits until check() is true, looking every 10 ms, or fails after timeoutMs. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
