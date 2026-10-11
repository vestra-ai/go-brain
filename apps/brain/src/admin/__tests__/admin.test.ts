import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic } from '../../__tests__/fixtures/fake-anthropic.js';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import type { CardTapParams } from '../../door/methods.js';
import { loadEnv } from '../../env.js';
import type { Tasks } from '../../tasks/tasks.js';
import type { Probe } from '../health.js';
import { NOT_DEPLOYED, type AdminLanes } from '../lanes.js';
import { renderAdminPage } from '../page.js';
import { DOCS_URL, registerAdmin, registerAdminWith, roleOf } from '../register.js';
import { cookieName, registerSessionRoute, SESSION_SECONDS, sessionCookie, sessionValue, signedIn } from '../session.js';
import { createSwitches } from '../switches.js';

const TOKEN = 'admin-token-for-the-tests-0001';
const AUTH = { authorization: `Bearer ${TOKEN}` };
/** What the browser sends once it has signed in at /admin#token=... (Go here is plain http, so the cookie is go_admin). */
const SIGNED_IN = { cookie: `go_admin=${sessionValue(TOKEN, new Date())}` };
/** A form on Go's own page: the browser adds Sec-Fetch-Site. */
const FORM = { ...SIGNED_IN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
const base = {
  PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: 'a'.repeat(64), GO_PUBLIC_URL: 'http://127.0.0.1',
  ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent', REFLEX_LIVE: 'q1,q2,q3', CALLS_MODE: 'allowlist', CALLS_ALLOWLIST: 'Villa Sol=+919800000001',
};

let db: Awaited<ReturnType<typeof withSchema>>;
let built: Built;
let closed: Built;
let bare: Built;
const fired: Array<{ auth: string | undefined; body: unknown }> = [];
const declined: CardTapParams[] = [];
const routes: Array<{ method: unknown; url: string; logLevel: unknown }> = [];
const stopped: string[] = [];
/** The /v1 warms the admin page made: only "Check this trip's computer" may make one. */
const warms: string[] = [];
const warmFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  warms.push(`${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input)}`);
  return new Response('{"status":"waking"}', { status: 202 });
}) as typeof fetch;

/** Two checks that answer at once, so the page and health.json need no network. */
const probes = (_brain: unknown, tripId: string | null): Probe[] => [
  { name: 'server', label: "The Server's socket", run: async () => ({ ok: true, detail: 'open' }) },
  { name: 'v1', label: "/v1 and this trip's computer", run: async () => ({ ok: true, degraded: true, detail: `computer waking for ${tripId ?? 'no trip'}` }) },
];

/** Stand in for P4's and P6's helpers: the allowlist read from CALLS_ALLOWLIST ("name=phone,..."), numbers masked. */
const lanes: AdminLanes = {
  v1UserIdFor: (tripId) => `vu_${tripId}`,
  listIxigoTools: async () => 12,
  calls: {
    allowlist: (env) =>
      (env.CALLS_ALLOWLIST ?? '').split(',').filter(Boolean).map((entry) => {
        const [name = '', phone = ''] = entry.split('=');
        return { name: name || null, phone };
      }),
    maskPhone: (phone) => `${phone.slice(0, 3)}***${phone.slice(-3)}`,
  },
};

const fakeTasks: Tasks = {
  start: async () => ({ taskId: 'gt_new', cardId: 'c_new' }),
  message: async () => undefined,
  stop: async (id) => {
    if (id === 'gt_stuck') throw new Error('/v1 did not answer');
    stopped.push(id);
  },
  running: async (tripId) =>
    tripId === 't_goa' ? [{ id: 'gt_villa', brief: 'villas', state: 'running' }, { id: 'gt_cab', brief: 'a cab', state: 'needs_you' }]
      : tripId === 't_stuck' ? [{ id: 'gt_stuck', brief: 'a train', state: 'running' }, { id: 'gt_ok', brief: 'a bus', state: 'running' }] : [],
  handoff: async () => undefined,
};

const payCard = (cardId: string, state: string) => ({
  card_id: cardId, kind: 'pay', fallback_text: 'Pay ₹38,400 for Villa Sol', for_person_ids: ['p_rahul'], approval_id: `ap_${cardId}`,
  payer_person_id: 'p_rahul', amount_minor: 3_840_000, currency: 'INR', merchant: 'Villa Sol', purpose: 'Villa Sol, 3 nights',
  expires_at: '2026-10-06T10:10:00Z', state,
});

beforeAll(async () => {
  db = await withSchema();
  const model = fakeAnthropic([]);
  built = await buildBrain(
    loadEnv({ ...base, ADMIN_TOKEN: TOKEN, GO_ROLE: 'rehearsal', VESTRA_API_URL: 'https://api.vestra.test', VESTRA_API_KEYS: `vk_test_${'a'.repeat(43)}` }),
    { pool: db.pool, anthropic: model.client, logger: false, timings: { typingMinMs: 0 } },
  );
  built.brain.tasks = fakeTasks;
  built.brain.taps.on('pay', 'decline', async (tap) => {
    declined.push(tap);
    return { result: 'done', toast: 'Declined.' };
  });
  // Stands in for P6's route, so the test sees exactly what the admin page sends it.
  built.brain.http.post('/admin/watch/fire', async (req) => {
    if ((req.body as { label?: string }).label === 'Again') return { ok: true, dedupe_key: 'sim:flight_status:again', duplicate: true, promoted: 0 };
    fired.push({ auth: req.headers.authorization, body: req.body });
    return { ok: true, dedupe_key: 'sim:flight_status:abc123', promoted: 1 };
  });
  built.brain.http.addHook('onRoute', (r) => {
    routes.push({ method: r.method, url: r.url, logLevel: r.logLevel });
  });
  await registerAdminWith({ probes, lanes, fetch: warmFetch })(built.brain);

  closed = await buildBrain(loadEnv(base), { pool: db.pool, anthropic: model.client, logger: false });
  await registerAdmin(closed.brain);

  // A Go with the admin page on but none of the other lanes deployed: no jobs, no watch route, no calls, no P4 helpers.
  bare = await buildBrain(loadEnv({ ...base, ADMIN_TOKEN: TOKEN, RAILWAY_SERVICE_NAME: 'brain' }), { pool: db.pool, anthropic: model.client, logger: false });
  const offline = (async () => new Response('', { status: 503 })) as typeof fetch;
  await registerAdminWith({ lanes: { v1UserIdFor: null, listIxigoTools: null, calls: null }, fetch: offline })(bare.brain);

  await db.pool.query(`insert into trips (trip_id, active_at) values ('t_old', now() - interval '2 hours'), ('t_goa', now())`);
  await db.pool.query(
    `insert into cards (trip_id, card_id, kind, message_id, card, updated_at) values
       ($1, 'c_pay_old', 'pay', 'm_1', $2::jsonb, now() - interval '1 hour'),
       ($1, 'c_pay_now', 'pay', 'm_2', $3::jsonb, now())`,
    ['t_goa', JSON.stringify(payCard('c_pay_old', 'declined')), JSON.stringify(payCard('c_pay_now', 'waiting'))],
  );
});

afterAll(async () => {
  await built.stop();
  await closed.stop();
  await bare.stop();
  await db.drop();
});

describe('the admin page', () => {
  it('does not exist without ADMIN_TOKEN', async () => {
    for (const [method, url] of [['GET', '/admin'], ['GET', '/admin/health.json'], ['POST', '/admin/switches']] as const) {
      expect((await closed.brain.http.inject({ method, url: `${url}?token=${TOKEN}` })).statusCode, url).toBe(404);
    }
  });

  it('needs the token as a bearer, or the session cookie; never from the URL', async () => {
    const http = built.brain.http;
    expect((await http.inject({ method: 'GET', url: '/admin/health.json' })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: `/admin/health.json?token=${TOKEN}` })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: { cookie: `go_admin=${TOKEN}` } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'POST', url: '/admin/switches', payload: { name: 'TRAVEL_MODE', value: 'fake' } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: AUTH })).statusCode).toBe(200);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: SIGNED_IN })).statusCode).toBe(200);
  });

  it('signs a person in from /admin#token=...: the token goes once as a bearer, and comes back as an HttpOnly cookie', async () => {
    const http = built.brain.http;
    const before = await http.inject({ method: 'GET', url: `/admin?token=${TOKEN}` });
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('location.hash');
    expect(before.body).toContain("fetch('/admin/session'");
    expect(before.body).toContain('history.replaceState');
    expect(before.body).not.toContain('Stage actions');
    expect(before.body).not.toContain(TOKEN);

    expect((await http.inject({ method: 'POST', url: '/admin/session', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const session = await http.inject({ method: 'POST', url: '/admin/session', headers: AUTH });
    expect(session.statusCode).toBe(204);
    const cookie = String(session.headers['set-cookie']);
    expect(cookie).toMatch(/^go_admin=\d+\.[\w-]+; Path=\/;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toContain(TOKEN);

    const after = await http.inject({ method: 'GET', url: '/admin', headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(after.body).toContain('Stage actions');
    // The board registers the same route: whichever lane comes second leaves it as it is.
    expect(() => registerSessionRoute(http, { token: TOKEN, secure: false, now: () => new Date() })).not.toThrow();
  });

  it('its GET routes log at warn, so a request line never reaches the logs at info', () => {
    const gets = routes.filter((r) => r.method === 'GET' && r.url.startsWith('/admin'));
    expect(gets.map((r) => r.url).sort()).toEqual(['/admin', '/admin/health.json']);
    for (const r of gets) expect(r.logLevel, r.url).toBe('warn');
  });

  it('health.json: every check for the chosen trip (else the newest), the switches, and the allowlist by name only', async () => {
    const http = built.brain.http;
    const newest = (await http.inject({ method: 'GET', url: '/admin/health.json', headers: AUTH })).json();
    expect(newest.trip_id).toBe('t_goa');
    expect(newest.role).toBe('rehearsal');
    expect(newest.probes).toEqual([
      expect.objectContaining({ name: 'server', dot: 'green', detail: 'open' }),
      expect.objectContaining({ name: 'v1', dot: 'amber', detail: 'computer waking for t_goa' }),
    ]);
    const chosen = (await http.inject({ method: 'GET', url: '/admin/health.json?trip=t_old', headers: AUTH })).json();
    expect(chosen.trip_id).toBe('t_old');
    expect(chosen.server_socket_open).toBe(false);
    expect(chosen.switches).toEqual({ TRAVEL_MODE: 'fake', TRAVEL_RUNNER: 'agent_job', PAY_RAIL: 'fake', CALLS_MODE: 'allowlist', REFLEX_LIVE: 'q1,q2,q3', BROWSER_FETCH_SLOTS: '2', RECIPE_WATCHES: 'off', BOOKING: 'off' });
    // The watches groups asked for, per trip (none here): how many and the next check, never a watch id.
    expect(chosen.watches).toEqual([]);
    expect(chosen.calls).toEqual({ mode: 'allowlist', allowlist: ['Villa Sol'], allowlist_count: 1 });
    expect(JSON.stringify(chosen)).not.toContain('9800000001');
  });

  it('changes a switch: checked against SWITCH_RULES, stored, and seen by another copy of Go', async () => {
    const http = built.brain.http;
    const ok = await http.inject({ method: 'POST', url: '/admin/switches', headers: AUTH, payload: { name: 'PAY_RAIL', value: 'stripe_test' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, name: 'PAY_RAIL', value: 'stripe_test' });
    expect(built.brain.switches.get('PAY_RAIL')).toBe('stripe_test');
    const other = createSwitches({ pool: db.pool, env: {}, now: () => new Date() });
    await other.refresh();
    expect(other.get('PAY_RAIL')).toBe('stripe_test');

    const bad = await http.inject({ method: 'POST', url: '/admin/switches', headers: AUTH, payload: { name: 'TRAVEL_MODE', value: 'bus' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe('TRAVEL_MODE cannot be "bus"');
    expect(built.brain.switches.get('TRAVEL_MODE')).toBe('fake');
    for (const name of ['DEMO_ROOM', '__proto__', 'toString']) {
      expect((await http.inject({ method: 'POST', url: '/admin/switches', headers: AUTH, payload: { name, value: 'sim' } })).statusCode, name).toBe(422);
    }
  });

  it("the page's forms come back to the page with a note", async () => {
    const res = await built.brain.http.inject({
      method: 'POST', url: '/admin/switches?trip=t_goa', headers: FORM, payload: 'name=CALLS_MODE&value=off',
    });
    expect(res.statusCode).toBe(303);
    const to = new URL(String(res.headers.location), 'http://go.local');
    expect(to.pathname).toBe('/admin');
    expect(to.searchParams.has('token')).toBe(false);
    expect(to.searchParams.get('trip')).toBe('t_goa');
    expect(to.searchParams.get('note')).toBe('CALLS_MODE is now off');
    expect(built.brain.switches.get('CALLS_MODE')).toBe('off');
    await built.brain.switches.set('CALLS_MODE', 'allowlist');
  });

  it("fires a watch through P6's route, with the bearer and the demo's body", async () => {
    const res = await built.brain.http.inject({
      method: 'POST', url: '/admin/fire-watch', headers: AUTH,
      payload: { trip_id: 't_goa', person_id: 'p_arjun', label: 'IndiGo 6E 2134', delay_minutes: '120', note: "Arjun's airport cab is booked for 9 pm" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dedupe_key: 'sim:flight_status:abc123', promoted: 1 });
    expect(fired).toEqual([{
      auth: `Bearer ${TOKEN}`,
      body: {
        trip_id: 't_goa', label: 'IndiGo 6E 2134', person_ids: ['p_arjun'], delay_minutes: 120,
        note: "Arjun's airport cab is booked for 9 pm", importance: 1, urgency: 1, reset_budget: true, force: true,
      },
    }]);
    const empty = await built.brain.http.inject({ method: 'POST', url: '/admin/fire-watch', headers: AUTH, payload: { trip_id: 't_goa', person_id: '' } });
    expect(empty.statusCode).toBe(422);
    expect(fired).toHaveLength(1);
  });

  it('passes "now lands at", in the trip\'s own time, as the watch\'s arrive_at; an empty field passes none', async () => {
    fired.length = 0;
    const res = await built.brain.http.inject({
      method: 'POST', url: '/admin/fire-watch', headers: FORM,
      payload: 'trip_id=t_goa&person_id=p_arjun&label=IndiGo+6E+2134&delay_minutes=120&lands_at=2026-11-06T22%3A45&note=Cab+at+9+pm',
    });
    expect(res.statusCode).toBe(303);
    // 10:45 pm in Goa (the trip's zone, India) is 17:15 UTC.
    expect((fired[0]?.body as { arrive_at?: string }).arrive_at).toBe('2026-11-06T17:15:00.000Z');
    await built.brain.http.inject({ method: 'POST', url: '/admin/fire-watch', headers: FORM, payload: 'trip_id=t_goa&person_id=p_arjun&lands_at=' });
    expect(fired[1]?.body).not.toHaveProperty('arrive_at');
    const bad = await built.brain.http.inject({ method: 'POST', url: '/admin/fire-watch', headers: AUTH, payload: { trip_id: 't_goa', person_id: 'p_arjun', lands_at: '10:45 pm' } });
    expect(bad.statusCode).toBe(422);
  });

  it('stops every running job for the trip through brain.tasks', async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(res.json()).toEqual({ ok: true, stopped: ['gt_villa', 'gt_cab'] });
    expect(stopped).toEqual(['gt_villa', 'gt_cab']);
  });

  it("checks a trip's computer only when asked: one /v1 warm, and the note says what it found", async () => {
    await built.brain.http.inject({ method: 'GET', url: '/admin/health.json?trip=t_goa', headers: AUTH });
    await built.brain.http.inject({ method: 'GET', url: '/admin?trip=t_goa', headers: SIGNED_IN });
    expect(warms).toEqual([]);
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/check-computer', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(res.json()).toEqual({ ok: true, detail: "The trip's computer was asleep and is waking now; check again in a minute." });
    expect(warms).toEqual(['POST https://api.vestra.test/v1/users/vu_t_goa/warm']);
    const form = await built.brain.http.inject({ method: 'POST', url: '/admin/check-computer', headers: FORM, payload: 'trip_id=t_goa' });
    expect(new URL(String(form.headers.location), 'http://go.local').searchParams.get('note')).toMatch(/waking now/);
  });

  it('a job that will not stop never keeps the others running, and says so', async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: AUTH, payload: { trip_id: 't_stuck' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, stopped: ['gt_ok'], failed: ['gt_stuck'] });
    const form = await built.brain.http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: FORM, payload: 'trip_id=t_stuck' });
    expect(new URL(String(form.headers.location), 'http://go.local').searchParams.get('note')).toBe('Stopped 1 running job; 1 did not stop.');
  });

  it('a watch fired twice in a minute reads "already fired"', async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/fire-watch', headers: FORM, payload: 'trip_id=t_goa&person_id=p_arjun&label=Again' });
    expect(res.statusCode).toBe(303);
    expect(new URL(String(res.headers.location), 'http://go.local').searchParams.get('note')).toBe('That watch already fired a moment ago, so nothing new went out.');
  });

  it("declines the waiting pay card as the payer's own Decline tap", async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/decline-pay', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, card_id: 'c_pay_now', answer: { result: 'done', toast: 'Declined.' } });
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ trip_id: 't_goa', card_id: 'c_pay_now', action_id: 'decline', person_id: 'p_rahul' });
    expect(declined[0]?.tap_id).toMatch(/^tap_admin_/);
    const none = await built.brain.http.inject({ method: 'POST', url: '/admin/decline-pay', headers: AUTH, payload: { trip_id: 't_old' } });
    expect(none.statusCode).toBe(404);
  });

  it('the page: health, every switch with a choice, the allowlist masked, the actions and the links, and no em dash', async () => {
    const res = await built.brain.http.inject({ method: 'GET', url: '/admin?trip=t_goa', headers: SIGNED_IN });
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const html = res.body;
    for (const text of [
      'The Server&#39;s socket', 'computer waking for t_goa', 'TRAVEL_MODE', 'PAY_RAIL', 'CALLS_MODE', 'REFLEX_LIVE', 'DEMO_ROOM',
      '<option value="stripe_test"', 'Villa Sol (+91***001)', 'Fire a watch', 'Stop all running jobs for this trip',
      'Decline the waiting pay card', "Check this trip's computer (wakes it)", 'href="/board"', DOCS_URL, 'This is the rehearsal Go.', 'action="/admin/sign-out"',
    ]) expect(html, text).toContain(text);
    expect(html).not.toContain('fontshare');
    expect(html).not.toContain('9800000001');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });

  it('escapes what it shows', async () => {
    const res = await built.brain.http.inject({ method: 'GET', url: `/admin?trip=${encodeURIComponent('<script>x</script>')}`, headers: SIGNED_IN });
    expect(res.body).not.toContain('<script>x</script>');
    expect(res.body).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe("the session: from Go's own pages only, never framed, 12 hours, and a sign-out", () => {
  const press = (headers: Record<string, string>) =>
    built.brain.http.inject({ method: 'POST', url: '/admin/switches', headers: { ...SIGNED_IN, host: 'go.test', ...headers }, payload: { name: 'TRAVEL_MODE', value: 'fake' } });

  it("a button pressed with the cookie must come from Go's own page; a bearer needs no Origin", async () => {
    expect((await press({})).statusCode).toBe(401);
    expect((await press({ origin: 'https://evil.example' })).statusCode).toBe(401);
    expect((await press({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(401);
    expect((await press({ origin: 'https://go.test' })).statusCode).toBe(200);
    expect((await press({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    // A read changes nothing, so the cookie alone is enough.
    expect((await built.brain.http.inject({ method: 'GET', url: '/admin/health.json', headers: { ...SIGNED_IN, origin: 'https://evil.example' } })).statusCode).toBe(200);
    expect((await built.brain.http.inject({ method: 'POST', url: '/admin/switches', headers: AUTH, payload: { name: 'TRAVEL_MODE', value: 'fake' } })).statusCode).toBe(200);
  });

  it('is never framed, signed in or not', async () => {
    for (const headers of [SIGNED_IN, {}]) {
      const page = await built.brain.http.inject({ method: 'GET', url: '/admin', headers });
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('ends on the server after 12 hours, and a cookie made with another token is no session', async () => {
    const read = (cookie: string) => built.brain.http.inject({ method: 'GET', url: '/admin/health.json', headers: { cookie } });
    expect((await read(`go_admin=${sessionValue(TOKEN, new Date(Date.now() - (SESSION_SECONDS + 60) * 1000))}`)).statusCode).toBe(401);
    expect((await read(`go_admin=${sessionValue(TOKEN, new Date(Date.now() - (SESSION_SECONDS - 60) * 1000))}`)).statusCode).toBe(200);
    expect((await read(`go_admin=${sessionValue('another-admin-token-0000', new Date())}`)).statusCode).toBe(401);
  });

  it('over https the cookie is __Host-go_admin, the only name read, and a planted cookie beside it changes nothing', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const o = { token: TOKEN, secure: true, now: () => now };
    const set = sessionCookie(o);
    expect(set).toMatch(/^__Host-go_admin=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    const valid = sessionValue(TOKEN, now);
    const req = (cookie: string) => ({ method: 'GET', headers: { cookie }, host: 'go.test' }) as unknown as FastifyRequest;
    expect(signedIn(req(`__Host-go_admin=${valid}`), o)).toBe(true);
    expect(signedIn(req(`go_admin=${valid}`), o)).toBe(false);
    expect(signedIn(req(`__Host-go_admin=1.planted; __Host-go_admin=${valid}`), o)).toBe(true);
    expect(signedIn(req('__Host-go_admin=1.planted'), o)).toBe(false);
    expect(cookieName(false)).toBe('go_admin');
  });

  it('signs out: the cookie is cleared, and back to the page it came from', async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/sign-out' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin');
    expect(String(res.headers['set-cookie'])).toMatch(/^go_admin=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
    expect((await built.brain.http.inject({ method: 'POST', url: '/admin/sign-out?next=/board' })).headers.location).toBe('/board');
    expect((await built.brain.http.inject({ method: 'POST', url: '/admin/sign-out?next=https://evil.example' })).headers.location).toBe('/admin');
  });
});

describe('which Go this is', () => {
  it('GO_ROLE first, then Railway\'s service name; otherwise it cannot tell', () => {
    expect(roleOf({ GO_ROLE: 'stage', RAILWAY_SERVICE_NAME: 'brain-rehearsal' })).toBe('stage');
    expect(roleOf({ RAILWAY_SERVICE_NAME: 'brain-rehearsal' })).toBe('rehearsal');
    expect(roleOf({ RAILWAY_SERVICE_NAME: 'brain' })).toBe('stage');
    expect(roleOf({ GO_ROLE: 'try', RAILWAY_SERVICE_NAME: 'brain' })).toBe('try');
    expect(roleOf({ RAILWAY_SERVICE_NAME: 'brain-try' })).toBe('try');
    const page = renderAdminPage({
      tripId: null, role: 'try', trips: [], at: new Date('2026-10-06T10:00:00Z'), health: [], switches: [], people: [],
      calls: { mode: 'off', deployed: false, allowlist: [] }, note: null, docsUrl: DOCS_URL, recipes: [],
    });
    expect(page).toContain('This is the try-room Go, where visitors chat with Go.');
    expect(page).toContain('No recipe has run since Go started.');
    // Numbers, not adjectives: each ixigo recipe's middle and slow end, at each speed.
    const timed = renderAdminPage({
      tripId: null, role: 'stage', trips: [], at: new Date('2026-10-06T10:00:00Z'), health: [], switches: [], people: [],
      calls: { mode: 'off', deployed: false, allowlist: [] }, note: null, docsUrl: DOCS_URL,
      recipes: [{ recipe: 'trains.between', speed: 'page', runs: 3, failed: 1, p50_ms: 1605, p90_ms: 2400 }],
    });
    expect(timed).toContain('<td>trains.between</td><td>page</td><td class="num">1605 ms</td><td class="num">2400 ms</td><td class="num">3</td><td class="num">1</td>');
    expect(roleOf({ RAILWAY_SERVICE_NAME: 'something-else' })).toBeNull();
    expect(roleOf({})).toBeNull();
  });
});

describe('a lane that is not on this Go yet', () => {
  it('reads as not deployed on the page, in health.json and on each action, and nothing breaks', async () => {
    const http = bare.brain.http;
    const health = (await http.inject({ method: 'GET', url: '/admin/health.json?trip=t_goa', headers: AUTH })).json();
    expect(health.probes.find((p: { name: string }) => p.name === 'v1')).toMatchObject({ dot: 'red', detail: `trip computers are ${NOT_DEPLOYED}` });
    expect(health.probes.find((p: { name: string }) => p.name === 'ixigo')).toMatchObject({ dot: 'red', detail: `the ixigo connection is ${NOT_DEPLOYED}` });
    expect(health.calls).toEqual({ mode: 'allowlist', allowlist: [], allowlist_count: 0 });
    expect(health.role).toBe('stage');
    expect(health.recipes).toEqual([]);

    const page = (await http.inject({ method: 'GET', url: '/admin?trip=t_goa', headers: SIGNED_IN })).body;
    expect(page).toContain('Calls are not deployed on this Go yet');
    expect(page).not.toContain('9800000001');

    const jobs = await http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(jobs.statusCode).toBe(409);
    expect(jobs.json().error.message).toBe(`Jobs are ${NOT_DEPLOYED}.`);

    const check = await http.inject({ method: 'POST', url: '/admin/check-computer', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(check.statusCode).toBe(404);
    expect(check.json().error.message).toBe(`Trip computers are ${NOT_DEPLOYED}.`);

    const watch = await http.inject({ method: 'POST', url: '/admin/fire-watch', headers: AUTH, payload: { trip_id: 't_goa', person_id: 'p_arjun' } });
    expect(watch.statusCode).toBe(404);
    expect(watch.json().error.message).toBe(`Watches are ${NOT_DEPLOYED}.`);

    const form = await http.inject({
      method: 'POST', url: '/admin/stop-jobs', headers: FORM, payload: 'trip_id=t_goa',
    });
    expect(form.statusCode).toBe(303);
    expect(new URL(String(form.headers.location), 'http://go.local').searchParams.get('note')).toBe(`Jobs are ${NOT_DEPLOYED}.`);
  });
});
