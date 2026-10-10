import type * as C from '@go/contract';
import type pg from 'pg';
import { sanitize } from '../composer/sanitize.js';
import type { Log } from '../log.js';
import type { CardStore } from './cards.js';
import type { ToGoHandler } from './handlers.js';
import type { CardTapParams, CardTapResult } from './methods.js';

export type GoCardKind = 'options' | 'working' | 'call' | 'pay' | 'notice' | 'rooms';
const GO_CARD_KINDS: ReadonlySet<string> = new Set<GoCardKind>(['options', 'working', 'call', 'pay', 'notice', 'rooms']);

type TapHandler = (tap: CardTapParams, card: C.Card) => Promise<CardTapResult>;

export interface TapRouter {
  /** Go cards only: options, working, call, pay, notice, rooms. One answer per tap_id: a repeat gets the first answer back. */
  on(kind: GoCardKind, actionId: string, h: TapHandler): void;
  /** Runs a tap as if the Server sent it (the admin page's "Decline the waiting pay card"); same once-per-tap_id rule. */
  dispatch(tap: CardTapParams): Promise<CardTapResult>;
}

/** What the door registers for card_tap. `dispatch` and `handle` share one path, so a tap_id is acted on once either way. */
export type TapRouterImpl = TapRouter & { handle: ToGoHandler<'card_tap'> };

class TooSlow extends Error {}

const refused = (toast: string): CardTapResult => ({ result: 'refused', toast });

function clean(r: CardTapResult): CardTapResult {
  if (r.result === 'open') return r;
  const toast = r.toast ? sanitize(r.toast).slice(0, 120) : '';
  if (r.result === 'refused') return { result: 'refused', toast: toast || 'That did not work.' };
  return toast ? { result: 'done', toast } : { result: 'done' };
}

export function createTapRouter(o: { pool: pg.Pool; cards: CardStore; log: Log; limitMs?: number }): TapRouterImpl {
  // The Server waits about 3.5 s and never resends a tap, so the answer must be ready well inside 3 s.
  const limitMs = o.limitMs ?? 2_500;
  const routes = new Map<string, TapHandler>();
  const inflight = new Map<string, Promise<CardTapResult>>();

  /** The answer a tap already got, in its own trip only: a tap id another trip used is another tap. */
  async function stored(tripId: string, tapId: string): Promise<CardTapResult | null> {
    const { rows } = await o.pool.query<{ result: CardTapResult }>('select result from card_taps where trip_id = $1 and tap_id = $2', [tripId, tapId]);
    return rows[0]?.result ?? null;
  }

  async function run(h: TapHandler, tap: CardTapParams, card: C.Card): Promise<CardTapResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        h(tap, card),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TooSlow()), limitMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof TooSlow) return refused('That took too long. Try again in a moment.');
      o.log.error({ err: e, card: tap.card_id, action: tap.action_id }, 'a card tap failed');
      return refused('Something went wrong. Try again in a moment.');
    } finally {
      clearTimeout(timer);
    }
  }

  /** One answer per tap_id, from the Server (handle) or from inside Go (dispatch). */
  function once(tap: CardTapParams, fromServer: boolean): Promise<CardTapResult> {
    const key = `${tap.trip_id}\u0000${tap.tap_id}`;
    const cur = inflight.get(key);
    if (cur) return cur;
    const p = decide(tap, fromServer).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function decide(tap: CardTapParams, fromServer: boolean): Promise<CardTapResult> {
    const first = await stored(tap.trip_id, tap.tap_id);
    if (first) return first;
    // A card Go has sent but has no answer for yet counts: the Server only sends a tap for a card it has, so its tap
    // also proves the card landed, in the same statement that finds it. A tap made inside Go proves nothing.
    const card = fromServer ? await o.cards.landed(tap.trip_id, tap.card_id) : await o.cards.get(tap.trip_id, tap.card_id);
    const h = card ? routes.get(`${card.kind}:${tap.action_id}`) : undefined;
    const result = clean(
      !card ? refused('That card is not active any more.') : !h ? refused("That button doesn't do anything yet.") : await run(h, tap, card),
    );
    const ins = await o.pool.query<{ result: CardTapResult }>(
      `insert into card_taps (tap_id, trip_id, card_id, action_id, person_id, result) values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (trip_id, tap_id) do nothing returning result`,
      [tap.tap_id, tap.trip_id, tap.card_id, tap.action_id, tap.person_id, JSON.stringify(result)],
    );
    return ins.rows[0]?.result ?? (await stored(tap.trip_id, tap.tap_id)) ?? result;
  }

  return {
    on(kind, actionId, h) {
      if (!GO_CARD_KINDS.has(kind)) throw new Error(`${kind} is not a Go card: the Server owns its buttons`);
      const key = `${kind}:${actionId}`;
      if (routes.has(key)) throw new Error(`${key} already has a handler`);
      routes.set(key, h);
    },
    handle: (tap) => once(tap, true),
    dispatch: (tap) => once(tap, false),
  };
}
