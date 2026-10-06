import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic } from '../../__tests__/fixtures/fake-anthropic.js';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import type { CardTapParams } from '../../door/methods.js';
import { loadEnv } from '../../env.js';
import type { Tasks } from '../../tasks/tasks.js';
import type { Probe } from '../health.js';
import { NOT_DEPLOYED, type AdminLanes } from '../lanes.js';
import { DOCS_URL, registerAdmin, registerAdminWith } from '../register.js';
import { createSwitches } from '../switches.js';

const TOKEN = 'admin-token-for-the-tests-0001';
const AUTH = { authorization: `Bearer ${TOKEN}` };
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
const stopped: string[] = [];

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
    stopped.push(id);
  },
  running: async (tripId) =>
    tripId === 't_goa' ? [{ id: 'gt_villa', brief: 'villas', state: 'running' }, { id: 'gt_cab', brief: 'a cab', state: 'needs_you' }] : [],
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
  built = await buildBrain(loadEnv({ ...base, ADMIN_TOKEN: TOKEN }), { pool: db.pool, anthropic: model.client, logger: false });
  built.brain.tasks = fakeTasks;
  built.brain.taps.on('pay', 'decline', async (tap) => {
    declined.push(tap);
    return { result: 'done', toast: 'Declined.' };
  });
  // Stands in for P6's route, so the test sees exactly what the admin page sends it.
  built.brain.http.post('/admin/watch/fire', async (req) => {
    fired.push({ auth: req.headers.authorization, body: req.body });
    return { ok: true, dedupe_key: 'sim:flight_status:abc123', promoted: 1 };
  });
  await registerAdminWith({ probes, lanes })(built.brain);

  closed = await buildBrain(loadEnv(base), { pool: db.pool, anthropic: model.client, logger: false });
  await registerAdmin(closed.brain);

  // A Go with the admin page on but none of the other lanes deployed: no jobs, no watch route, no calls, no P4 helpers.
  bare = await buildBrain(loadEnv({ ...base, ADMIN_TOKEN: TOKEN }), { pool: db.pool, anthropic: model.client, logger: false });
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

  it('needs the token, as a bearer or as ?token=', async () => {
    const http = built.brain.http;
    expect((await http.inject({ method: 'GET', url: '/admin/health.json' })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json?token=wrong-token-00000000' })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'POST', url: '/admin/switches', payload: { name: 'TRAVEL_MODE', value: 'fake' } })).statusCode).toBe(401);
    expect((await http.inject({ method: 'GET', url: '/admin/health.json', headers: AUTH })).statusCode).toBe(200);
    expect((await http.inject({ method: 'GET', url: `/admin?token=${TOKEN}` })).statusCode).toBe(200);
  });

  it('health.json: every check for the chosen trip (else the newest), the switches, and the allowlist by name only', async () => {
    const http = built.brain.http;
    const newest = (await http.inject({ method: 'GET', url: '/admin/health.json', headers: AUTH })).json();
    expect(newest.trip_id).toBe('t_goa');
    expect(newest.probes).toEqual([
      expect.objectContaining({ name: 'server', dot: 'green', detail: 'open' }),
      expect.objectContaining({ name: 'v1', dot: 'amber', detail: 'computer waking for t_goa' }),
    ]);
    const chosen = (await http.inject({ method: 'GET', url: '/admin/health.json?trip=t_old', headers: AUTH })).json();
    expect(chosen.trip_id).toBe('t_old');
    expect(chosen.server_socket_open).toBe(false);
    expect(chosen.switches).toEqual({ TRAVEL_MODE: 'fake', PAY_RAIL: 'fake', CALLS_MODE: 'allowlist', REFLEX_LIVE: 'q1,q2,q3' });
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
      method: 'POST', url: `/admin/switches?token=${TOKEN}&trip=t_goa`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=CALLS_MODE&value=off',
    });
    expect(res.statusCode).toBe(303);
    const to = new URL(String(res.headers.location), 'http://go.local');
    expect(to.pathname).toBe('/admin');
    expect(to.searchParams.get('token')).toBe(TOKEN);
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

  it('stops every running job for the trip through brain.tasks', async () => {
    const res = await built.brain.http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(res.json()).toEqual({ ok: true, stopped: ['gt_villa', 'gt_cab'] });
    expect(stopped).toEqual(['gt_villa', 'gt_cab']);
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
    const res = await built.brain.http.inject({ method: 'GET', url: `/admin?token=${TOKEN}&trip=t_goa` });
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const html = res.body;
    for (const text of [
      'The Server&#39;s socket', 'computer waking for t_goa', 'TRAVEL_MODE', 'PAY_RAIL', 'CALLS_MODE', 'REFLEX_LIVE', 'DEMO_ROOM',
      '<option value="stripe_test"', 'Villa Sol (+91***001)', 'Fire a watch', 'Stop all running jobs for this trip',
      'Decline the waiting pay card', `/board?token=${TOKEN}`, DOCS_URL,
    ]) expect(html, text).toContain(text);
    expect(html).not.toContain('9800000001');
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });

  it('escapes what it shows', async () => {
    const res = await built.brain.http.inject({ method: 'GET', url: `/admin?token=${TOKEN}&trip=${encodeURIComponent('<script>x</script>')}` });
    expect(res.body).not.toContain('<script>x</script>');
    expect(res.body).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('a lane that is not on this Go yet', () => {
  it('reads as not deployed on the page, in health.json and on each action, and nothing breaks', async () => {
    const http = bare.brain.http;
    const health = (await http.inject({ method: 'GET', url: '/admin/health.json?trip=t_goa', headers: AUTH })).json();
    expect(health.probes.find((p: { name: string }) => p.name === 'v1')).toMatchObject({ dot: 'red', detail: `trip computers are ${NOT_DEPLOYED}` });
    expect(health.probes.find((p: { name: string }) => p.name === 'ixigo')).toMatchObject({ dot: 'red', detail: `the ixigo connection is ${NOT_DEPLOYED}` });
    expect(health.calls).toEqual({ mode: 'allowlist', allowlist: [], allowlist_count: 0 });

    const page = (await http.inject({ method: 'GET', url: `/admin?token=${TOKEN}&trip=t_goa` })).body;
    expect(page).toContain('Calls are not deployed on this Go yet');
    expect(page).not.toContain('9800000001');

    const jobs = await http.inject({ method: 'POST', url: '/admin/stop-jobs', headers: AUTH, payload: { trip_id: 't_goa' } });
    expect(jobs.statusCode).toBe(409);
    expect(jobs.json().error.message).toBe(`Jobs are ${NOT_DEPLOYED}.`);

    const watch = await http.inject({ method: 'POST', url: '/admin/fire-watch', headers: AUTH, payload: { trip_id: 't_goa', person_id: 'p_arjun' } });
    expect(watch.statusCode).toBe(404);
    expect(watch.json().error.message).toBe(`Watches are ${NOT_DEPLOYED}.`);

    const form = await http.inject({
      method: 'POST', url: `/admin/stop-jobs?token=${TOKEN}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'trip_id=t_goa',
    });
    expect(form.statusCode).toBe(303);
    expect(new URL(String(form.headers.location), 'http://go.local').searchParams.get('note')).toBe(`Jobs are ${NOT_DEPLOYED}.`);
  });
});
