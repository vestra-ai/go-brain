/**
 * The proof board's routes. Closed unless ADMIN_TOKEN is set. A person signs in by opening /board#token=... (the same
 * cookie sign-in as the admin page, admin/session.ts); the bench sends the token as a bearer. Never ?token=.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearerOf, PAGE_HEADERS, registerSessionRoute, sameToken, signedIn, signInPage, type SessionOptions } from '../admin/session.js';
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
  /** The commit and branch the bench ran, and the composer model it judged (kept, never shown on the board). */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  branch: z.string().min(1).max(100).nullable(),
  model: z.string().min(1).max(80),
});
export type BenchSummary = z.infer<typeof BenchSummary>;

type Query = { hours?: string };
interface Denied { status: number; body: { error: { code: string; message: string } } }
/** The GET routes log at warn: a request line never lands in the logs at info. */
const QUIET = { logLevel: 'warn' } as const;

function hoursOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 168 ? n : 2;
}

export function registerStats(brain: StatsBrain): void {
  const { http, pool } = brain;
  const expected = brain.env.ADMIN_TOKEN;
  const session: SessionOptions | null =
    expected !== undefined && expected !== '' ? { token: expected, secure: brain.env.GO_PUBLIC_URL.startsWith('https:'), now: brain.now } : null;
  if (session) registerSessionRoute(http, session);
  /** A person's browser signs in with the cookie; `bearerOnly` is for the bench's POST. */
  const denied = (req: FastifyRequest, bearerOnly = false): Denied | null => {
    if (!session) return { status: 503, body: { error: { code: 'unavailable', message: 'The board is off until ADMIN_TOKEN is set.' } } };
    const ok = bearerOnly ? sameToken(bearerOf(req), session.token) : signedIn(req, session);
    if (!ok) return { status: 401, body: { error: { code: 'bad_signature', message: 'Wrong or missing token.' } } };
    return null;
  };
  const board = (q: Query): Promise<BoardNumbers> => computeBoard(pool, statsRegistry(brain), { now: brain.now(), hours: hoursOf(q.hours) });
  const htmlHeaders = PAGE_HEADERS;

  http.get<{ Querystring: Query }>('/stats.json', QUIET, async (req, reply) => {
    const no = denied(req);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.header('cache-control', 'no-store').send(await board(req.query));
  });

  http.get<{ Querystring: Query }>('/board', QUIET, async (req, reply) => {
    const no = denied(req);
    if (no?.status === 401) return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(signInPage('Go: live numbers', '/board'));
    if (no !== null) return reply.code(no.status).headers(htmlHeaders).type('text/html; charset=utf-8').send(renderClosedPage(no.status));
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderBoardPage(await board(req.query)));
  });

  http.get<{ Querystring: Query }>('/board/tiles', QUIET, async (req, reply) => {
    const no = denied(req);
    if (no !== null) return reply.code(no.status).send(no.body);
    return reply.headers(htmlHeaders).type('text/html; charset=utf-8').send(renderTiles(await board(req.query)));
  });

  http.post('/stats/bench', async (req, reply) => {
    const no = denied(req, true);
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
