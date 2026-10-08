import Fastify from 'fastify';
import type pg from 'pg';
import type { Brain } from '../../app.js';
import type { NowProvider } from '../../composer/context.js';
import type { QuickTool } from '../../composer/tools.js';
import type { Trip, TripEvent } from '../../door/methods.js';
import type { ServerLink } from '../../door/server-link.js';
import type { Travel } from '../../travel/travel.js';

/** A Brain made of recorders, for testing what a lane registers. Only the members a lane calls do anything. */
export function fakeBrain(o: {
  pool: pg.Pool;
  link: ServerLink;
  travel?: Travel;
  env?: Record<string, unknown>;
  trips?: Map<string, Trip>;
  switches?: Record<string, string>;
  now?: () => Date;
}) {
  const seen = {
    tools: [] as Array<QuickTool<any>>,
    taps: new Map<string, (tap: any, card: any) => Promise<any>>(),
    handlers: new Map<string, (params: any, meta: any) => Promise<any>>(),
    nows: [] as NowProvider[],
    listeners: [] as Array<(ev: TripEvent) => void | Promise<void>>,
    stoppers: [] as Array<() => Promise<void> | void>,
  };
  const http = Fastify({ logger: false });
  const switches = { PAY_RAIL: 'fake', ...o.switches };
  const brain = {
    env: { VAULT_URL: 'https://vault.test', VAULT_SHARED_SECRET: 'test-only-vault-shared-secret-0123456789', ...o.env },
    pool: o.pool,
    log: http.log,
    now: o.now ?? (() => new Date('2026-10-05T09:00:00Z')),
    http,
    onStop: (fn: () => Promise<void> | void) => void seen.stoppers.push(fn),
    door: { link: o.link, handle: (m: string, h: (params: any, meta: any) => Promise<any>) => void seen.handlers.set(m, h) },
    taps: { on: (kind: string, action: string, h: (tap: any, card: any) => Promise<any>) => void seen.taps.set(`${kind}:${action}`, h) },
    tripLog: { onEvent: (fn: (ev: TripEvent) => void | Promise<void>) => void seen.listeners.push(fn) },
    packs: {
      get: async (tripId: string) => {
        const trip = o.trips?.get(tripId);
        if (!trip) throw new Error(`no trip ${tripId}`);
        return { trip, messages: [], seq: trip.seq };
      },
      invalidate: () => undefined,
    },
    tools: { register: (t: QuickTool<any>) => void seen.tools.push(t), list: () => seen.tools },
    context: { addNow: (p: NowProvider) => void seen.nows.push(p), addWake: () => undefined, addTurnCard: () => undefined },
    switches: { get: (name: string) => (switches as Record<string, string>)[name] ?? '', set: async () => undefined },
    ...(o.travel ? { travel: o.travel } : {}),
  } as unknown as Brain;
  return { brain, seen };
}
