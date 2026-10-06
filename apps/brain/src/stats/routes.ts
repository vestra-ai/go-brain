/** The proof board's routes. Closed unless ADMIN_TOKEN is set; every read needs it as ?token=, the bench sends it as a bearer. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Brain } from '../app.js';
import { renderBoardPage, renderClosedPage, renderTiles } from './board-html.js';
import { statsRegistry } from './sources.js';
import { computeBoard, type BoardNumbers } from './stats.js';

export type StatsBrain = Pick<Brain, 'env' | 'pool' | 'http' | 'now' | 'log'>;

/** What a bench run sends to the board for one chat. */
export const BenchSummary = z.object({
  chat: z.string().regex(/^[a-z0-9-]{1,40}$/),
  mode: z.enum(['fast', 'live']),
  cacheHit: z.number().min(0).max(1).nullable(),
  cacheStatus: z.enum(['ok', 'not_cacheable_yet', 'no_requests']),
  wakeRate: z.number().min(0).max(1).nullable(),
  typingP90Ms: z.number().nonnegative().nullable(),
  replyP50Ms: z.number().nonnegative().nullable(),
  recall: z.object({ passed: z.int().nonnegative(), probes: z.int().nonnegative() }),
  wrongSpeak: z.int().nonnegative(),
  messages: z.int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
});
export type BenchSummary = z.infer<typeof BenchSummary>;

type Query = { token?: string; hours?: string };
interface Denied { status: number; body: { error: { code: string; message: string } } }

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given === '') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function hoursOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 168 ? n : 2;
}

export function registerStats(brain: StatsBrain): void {
  const { http, pool } = brain;
  const denied = (token: unknown): Denied | null => {
    const expected = brain.env.ADMIN_TOKEN;
    if (expected === undefined || expected === '') return { status: 503, body: { error: { code: 'unavailable', message: 'The board is off until ADMIN_TOKEN is set.' } } };
    if (!tokenOk(token, expected)) return { status: 401, body: { error: { code: 'bad_signature', message: 'Wrong or missing token.' } } };
    return null;
  };
  const board = (q: Query): Promise<BoardNumbers> => computeBoard(pool, statsRegistry(brain), { now: brain.now(), hours: hoursOf(q.hours) });
  const htmlHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' };

  http.get<{ Querystring: Query }>('/stats.json', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.header('cache-control', 'no-store').send(await board(req.query));
  });

  http.get<{ Querystring: Query }>('/board', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).headers(htmlHeaders).type('text/html; charset=utf-8').send(renderClosedPage(no.status));
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderBoardPage(await board(req.query)));
  });

  http.get<{ Querystring: Query }>('/board/tiles', async (req, reply) => {
    const no = denied(req.query.token);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderTiles(await board(req.query)));
  });

  http.post('/stats/bench', async (req, reply) => {
    const auth = req.headers.authorization;
    const no = denied(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined);
    if (no !== null) return reply.code(no.status).send(no.body);
    const parsed = BenchSummary.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid', message: z.prettifyError(parsed.error).slice(0, 500) } });
    const s = parsed.data;
    await pool.query(
      `insert into bench_reports (chat, mode, summary, received_at) values ($1, $2, $3, $4)
       on conflict (chat) do update set mode = excluded.mode, summary = excluded.summary, received_at = excluded.received_at`,
      [s.chat, s.mode, JSON.stringify(s), brain.now()],
    );
    return reply.code(204).send();
  });
}
