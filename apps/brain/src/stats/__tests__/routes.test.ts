import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, sessionValue } from '../../admin/session.js';
import { withSchema } from '../../db/test-db.js';
import { registerStats, type StatsBrain } from '../routes.js';
import { statsRegistry } from '../sources.js';
import { NOW, seedTrip, seedTurn, truncateAll } from './seed.js';

const TOKEN = 'board-token-for-tests';
const AUTH = { authorization: `Bearer ${TOKEN}` };
/** What the browser sends once it has signed in at /board#token=... */
const SIGNED_IN = { cookie: `${SESSION_COOKIE}=${sessionValue(TOKEN)}` };
const routes: Array<{ method: unknown; url: string; logLevel: unknown }> = [];
let db: Awaited<ReturnType<typeof withSchema>>;
let app: FastifyInstance;
let brain: StatsBrain;

function makeApp(adminToken: string | undefined): { app: FastifyInstance; brain: StatsBrain } {
  const a = Fastify();
  a.addHook('onRoute', (r) => {
    routes.push({ method: r.method, url: r.url, logLevel: r.logLevel });
  });
  const env = { GO_PUBLIC_URL: 'http://127.0.0.1', ...(adminToken === undefined ? {} : { ADMIN_TOKEN: adminToken }) };
  const b = { env, pool: db.pool, http: a, now: () => NOW, log: a.log } as unknown as StatsBrain;
  registerStats(b);
  return { app: a, brain: b };
}
const summary = {
  chat: 'goa-300', mode: 'live', cacheHit: 0.91, cacheStatus: 'ok', wakeRate: 0.12, typingP90Ms: 180, replyP50Ms: 1900,
  recall: { passed: 7, probes: 7 }, wrongSpeak: 0, messages: 300, at: '2026-10-08T17:00:00Z',
  commit: '1a2b3c4d5e', branch: 'build', model: 'claude-sonnet-5-5',
};

beforeAll(async () => {
  db = await withSchema();
  await seedTrip(db.pool, 't_goa');
  ({ app, brain } = makeApp(TOKEN));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});
beforeEach(async () => {
  await truncateAll(db.pool);
});

describe('the proof board routes', () => {
  it('needs the token as a bearer or the session cookie, never from the URL, and is off without ADMIN_TOKEN', async () => {
    expect((await app.inject({ method: 'GET', url: '/stats.json' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/stats.json?token=${TOKEN}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/board/tiles?token=${TOKEN}` })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/stats.json', headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toMatchObject({ empty: true, window: { hours: 2 } });
    expect((await app.inject({ method: 'GET', url: '/stats.json', headers: SIGNED_IN })).statusCode).toBe(200);
    // The bench's POST takes the bearer only.
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: SIGNED_IN, payload: summary })).statusCode).toBe(401);
    const off = makeApp(undefined);
    expect((await off.app.inject({ method: 'GET', url: '/stats.json', headers: AUTH })).statusCode).toBe(503);
    await off.app.close();
  });

  it('signs a person in from /board#token=..., through the same session route as the admin page', async () => {
    const before = await app.inject({ method: 'GET', url: `/board?token=${TOKEN}` });
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('location.hash');
    expect(before.body).toContain("fetch('/admin/session'");
    expect(before.body).not.toContain(TOKEN);
    expect(before.body).not.toContain('No turns yet');
    const session = await app.inject({ method: 'POST', url: '/admin/session', headers: AUTH });
    expect(session.statusCode).toBe(204);
    const cookie = String(session.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    const after = await app.inject({ method: 'GET', url: '/board', headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(after.body).toContain('No turns yet');
  });

  it('its GET routes log at warn, so a request line never reaches the logs at info', () => {
    const gets = routes.filter((r) => r.method === 'GET');
    expect([...new Set(gets.map((r) => r.url))].sort()).toEqual(['/board', '/board/tiles', '/stats.json']);
    for (const r of gets) expect(r.logLevel, r.url).toBe('warn');
  });

  it('says "No turns yet" before any turn, with no NaN, no em dash, no model names and no referrer', async () => {
    const res = await app.inject({ method: 'GET', url: '/board', headers: SIGNED_IN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('No turns yet');
    expect(res.body).toContain('<meta name="referrer" content="no-referrer">');
    expect(res.body).toContain('api.fontshare.com');
    for (const bad of ['NaN', 'undefined', 'Infinity', '\u2014', 'Sonnet', 'Haiku', 'Claude', 'Anthropic', 'claude-']) expect(res.body, bad).not.toContain(bad);
  });

  it('shows the numbers from real turns, labelled with where they come from', async () => {
    await seedTurn(db.pool, { id: 'tu_1', at: 20, waitMs: 2000, typingMs: 300, postedMs: 1900, input: 1_000, cached: 9_000, cost: 0.004 });
    await seedTurn(db.pool, { id: 'tu_2', at: 40, typingMs: 400, postedMs: 2300, input: 800, cached: 7_200, cost: 0.004 });
    const res = await app.inject({ method: 'GET', url: '/board/tiles', headers: SIGNED_IN });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('From the last 2 hours of real turns.');
    expect(res.body).toContain('0.3 s');
    expect(res.body).toContain('1.9 s');
    expect(res.body).toContain('90%');
    expect(res.body).not.toContain('claude-sonnet');
  });

  it('refreshes its tiles every 5 seconds with the same query', async () => {
    const res = await app.inject({ method: 'GET', url: '/board?hours=1', headers: SIGNED_IN });
    expect(res.body).toContain("fetch('/board/tiles' + location.search");
    expect(res.body).toContain('setInterval(refresh, 5000)');
    expect(res.body).toContain('the last hour');
  });

  it('takes hours from 1 to 168 and falls back to 2 otherwise', async () => {
    const h = async (q: string): Promise<number> => (await app.inject({ method: 'GET', url: `/stats.json?hours=${q}`, headers: AUTH })).json().window.hours as number;
    expect(await h('24')).toBe(24);
    expect(await h('999')).toBe(2);
    expect(await h('1.5')).toBe(2);
  });

  it('stores a bench summary sent with the bearer token and shows it on the board', async () => {
    expect((await app.inject({ method: 'POST', url: '/stats/bench', payload: summary })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: { ...summary, cacheHit: 3 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: summary })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: { authorization: `Bearer ${TOKEN}` }, payload: { ...summary, cacheHit: 0.93 } })).statusCode).toBe(204);
    const { rows } = await db.pool.query<{ n: number }>('select count(*)::int as n from bench_reports');
    expect(rows[0]?.n).toBe(1);
    const page = await app.inject({ method: 'GET', url: '/board', headers: SIGNED_IN });
    expect(page.body).toContain('From the replay bench');
    expect(page.body).toContain('goa-300');
    expect(page.body).toContain('93%');
    expect(page.body).toContain('build at 1a2b3c4');
    expect(page.body).not.toContain('claude-');
    const { rows: stored } = await db.pool.query<{ summary: Record<string, unknown> }>('select summary from bench_reports');
    expect(stored[0]?.summary).toMatchObject({ commit: '1a2b3c4d5e', branch: 'build', model: 'claude-sonnet-5-5' });
    const { model: _model, ...noModel } = summary;
    expect((await app.inject({ method: 'POST', url: '/stats/bench', headers: AUTH, payload: noModel })).statusCode).toBe(422);
  });

  it('escapes text another lane gives it', async () => {
    statsRegistry(brain).add({ name: 'x', label: '<script>alert(1)</script>', order: 1, good: 'low', read: async () => ({ value: 3 }) });
    const res = await app.inject({ method: 'GET', url: '/board/tiles', headers: SIGNED_IN });
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>alert');
  });
});
