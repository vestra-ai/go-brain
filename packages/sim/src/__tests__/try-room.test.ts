import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_HTML, roomPage } from '../dev-room/page.js';
import { FakeServer } from '../fake-server.js';
import { Caps, DEFAULT_CAPS, asksGo, type CapLimits } from '../try-room/caps.js';
import { TryEnv } from '../try-room/env.js';
import { COOKIE_NAME, Gate } from '../try-room/gate.js';
import { serveTryRoom, type TryRoom, type TryRoomOptions } from '../try-room/serve.js';
import { DAILY_LIMIT_LINE, HINTS, NOT_IN_YOUR_TRIP, SIMULATED_LINE, sessionLimitLine } from '../try-room/words.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const passcode = 'judge-passcode-2026';

let go: TestGo | undefined;
let fake: FakeServer | undefined;
let room: TryRoom | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await room?.close();
  fake?.stop();
  await go?.close();
  room = undefined;
  fake = undefined;
  go = undefined;
});

async function setUp(extra: Partial<TryRoomOptions> = {}) {
  go = await startTestGo(secret);
  fake = new FakeServer({ goUrl: go.url, secret });
  await fake.start(3000);
  room = await serveTryRoom({ fake, passcode, goUrl: go.url, port: 0, goHealth: async () => ({ ok: true, contract: '1.0.0' }), ...extra });
  return { go, fake, room };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function enter(r: TryRoom, code: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${r.url}enter`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ passcode: code }).toString(),
  });
}

/** Signs in with the passcode and returns the cookie as a browser sends it back: "name=value". */
async function signIn(r: TryRoom): Promise<string> {
  const res = await enter(r, passcode);
  expect(res.status).toBe(303);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const visitOf = (cookie: string): string => cookie.slice(cookie.indexOf('=') + 1).split('.')[0]!;
const page = (r: TryRoom, cookie?: string): Promise<Response> => fetch(r.url, cookie ? { headers: { cookie } } : {});

/** Opens the page's live socket. Resolves with the open socket and the frames it gets, or with the refusal's status. */
function live(r: TryRoom, cookie: string | null, origin?: string): Promise<{ ws: WebSocket; got: any[] } | { status: number }> {
  const host = new URL(r.url).host;
  const headers: Record<string, string> = { origin: origin ?? `http://${host}` };
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/live`, { headers });
    clients.push(ws);
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, got }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on('error', () => {});
  });
}

async function openLive(r: TryRoom, cookie: string) {
  const l = await live(r, cookie);
  if (!('ws' in l)) throw new Error(`refused: ${l.status}`);
  return l;
}

const states = (got: any[]) => got.filter((m) => m.type === 'state');
const lastState = (got: any[]) => states(got).at(-1);
const said = (g: TestGo) => g.events.filter((e) => e.type === 'message.created');

describe('the passcode gate', () => {
  it('shows only the passcode field without a cookie, and every answer is no-store, unframeable and under a strict CSP', async () => {
    const { room: r } = await setUp();
    const res = await page(r);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="passcode"');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('data-start-over');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const missing = await fetch(`${r.url}nope`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await live(r, null)).toEqual({ status: 401 });
  });

  it('refuses a bad cookie: made up, changed, signed with another passcode, or older than 12 hours', async () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const { room: r } = await setUp({ now: () => new Date(clock) });
    const good = await signIn(r);
    const [visit, at, mac] = good.slice(good.indexOf('=') + 1).split('.');
    const bad = [
      `${COOKIE_NAME}=made.up.cookie`,
      `${COOKIE_NAME}=${visit}x.${at}.${mac}`,
      `${COOKIE_NAME}=${visit}.${Number(at) + 1}.${mac}`,
      new Gate('another-passcode-entirely', () => new Date(clock)).newVisit().setCookie.split(';')[0]!,
    ];
    for (const cookie of bad) {
      expect(await (await page(r, cookie)).text()).toContain('name="passcode"');
      expect(await live(r, cookie)).toEqual({ status: 401 });
    }
    expect(await (await page(r, good)).text()).toContain('data-start-over');
    const open = await openLive(r, good);
    clock += 12 * 60 * 60 * 1000 + 1000;
    expect(await (await page(r, good)).text()).toContain('name="passcode"');
    expect(await live(r, good)).toEqual({ status: 401 });
    // A socket opened before the cookie ran out stops at its next action, and the action goes nowhere.
    const closed = new Promise<number>((resolve) => open.ws.on('close', (code) => resolve(code)));
    open.ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go still there?' }));
    expect(await closed).toBe(4401);
    expect(said(go!)).toEqual([]);
  });

  it('opens the room with a good cookie: the page with its nonce, and a live socket with a fresh Goa trip', async () => {
    const { go: g, room: r } = await setUp();
    const res = await enter(r, passcode);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) expect(setCookie).toContain(part);
    const cookie = setCookie.split(';')[0]!;

    const room1 = await page(r, cookie);
    const html = await room1.text();
    const csp = room1.headers.get('content-security-policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(html).toContain('<title>Try Go</title>');
    expect(html).toContain('data-start-over');
    for (const hint of HINTS) expect(html).toContain(`data-fill="${hint}"`);
    const again = /script-src 'nonce-([^']+)'/.exec((await page(r, cookie)).headers.get('content-security-policy')!)?.[1];
    expect(again).not.toBe(nonce);

    const { got } = await openLive(r, cookie);
    await until(() => states(got).length > 0);
    const state = states(got)[0];
    expect(state.trip.trip_id).toMatch(/^t_try_[0-9a-f]{12}$/);
    expect(state.trip.people.map((p: { name: string }) => p.name)).toEqual(['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir']);
    expect(state.messages).toEqual([]);
    expect(state.about).toEqual(['Go is live: this room talks to the real Go (contract 1.0.0).', SIMULATED_LINE]);
    expect(state.limit).toBeNull();
    await until(() => g.events.some((e) => e.type === 'trip.created' && e.trip_id === state.trip.trip_id));
    // The socket is for this room's page only.
    expect(await live(r, cookie, 'https://somewhere-else.example')).toEqual({ status: 401 });
  });

  it('holds wrong passcode tries to 5 a minute for each address', async () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const { room: r } = await setUp({ now: () => new Date(clock), trustProxy: true });
    const from = (address: string) => ({ 'x-forwarded-for': `203.0.113.9, ${address}` });
    for (let i = 0; i < 5; i++) expect((await enter(r, 'wrong-guess', from('198.51.100.1'))).status).toBe(401);
    const blocked = await enter(r, passcode, from('198.51.100.1'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect(await blocked.text()).toContain('Too many wrong tries');
    // Another address is not held up, and the first one may try again a minute later.
    expect((await enter(r, passcode, from('198.51.100.2'))).status).toBe(303);
    clock += 61_000;
    expect((await enter(r, passcode, from('198.51.100.1'))).status).toBe(303);
  });

  it('never puts the signing secret or the passcode in any answer', async () => {
    const { go: g, room: r } = await setUp();
    const seen: string[] = [];
    const keep = async (res: Response) => seen.push(JSON.stringify([...res.headers]), await res.text());
    await keep(await page(r));
    await keep(await enter(r, 'wrong-guess'));
    const res = await enter(r, passcode);
    await keep(res.clone());
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    await keep(await page(r, cookie));
    await keep(await fetch(`${r.url}health`));
    await keep(await fetch(`${r.url}nope`));
    const { ws, got } = await openLive(r, cookie);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go hello' }));
    await until(() => said(g).length === 1);
    await until(() => states(got).some((s) => s.messages.length === 1));
    seen.push(JSON.stringify(got));
    for (const text of seen) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(passcode);
    }
  });
});

describe('the caps', () => {
  const limits = (over: Partial<CapLimits>): CapLimits => ({ dailyGoAsks: 100, dailyMessages: 100, sessionGoAsks: 100, dailyTrips: 100, ...over });

  it('TRY_DAILY_GO_ASKS: counts messages that ask Go across every visit, and starts again at 05:30 IST', () => {
    let clock = Date.parse('2026-10-06T18:00:00Z');
    const caps = new Caps(limits({ dailyGoAsks: 2 }), () => new Date(clock));
    expect(caps.send('a', true)).toEqual({ ok: true });
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.send('c', true)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.send('c', false)).toEqual({ ok: true }); // talking to the group still works
    expect(caps.line('c')).toBe(DAILY_LIMIT_LINE);
    clock = Date.parse('2026-10-07T00:00:01Z'); // 05:30:01 IST
    expect(caps.line('c')).toBeNull();
    expect(caps.send('c', true)).toEqual({ ok: true });
  });

  it('TRY_DAILY_MESSAGES: counts everything sent into the room, by every visit', () => {
    const caps = new Caps(limits({ dailyMessages: 2 }));
    expect(caps.send('a', false)).toEqual({ ok: true });
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.send('c', false)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.send('c', true)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
  });

  it('TRY_SESSION_GO_ASKS: counts messages that ask Go in one visit only', () => {
    const caps = new Caps(limits({ sessionGoAsks: 2 }));
    expect(caps.send('a', true)).toEqual({ ok: true });
    expect(caps.send('a', true)).toEqual({ ok: true });
    expect(caps.send('a', true)).toEqual({ ok: false, line: sessionLimitLine(2) });
    expect(caps.send('a', false)).toEqual({ ok: true });
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.line('a')).toBe(sessionLimitLine(2));
    expect(caps.line('b')).toBeNull();
  });

  it('TRY_DAILY_TRIPS: counts new trips, each visit and every Start over', () => {
    const caps = new Caps(limits({ dailyTrips: 1 }));
    expect(caps.newTrip()).toEqual({ ok: true });
    expect(caps.newTrip()).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
  });

  it('counts a message as asking Go when it has the word go in any case', () => {
    for (const text of ['@Go hello', 'what do you think, go?', "let's go", 'GO find flights']) expect(asksGo(text)).toBe(true);
    for (const text of ['Goa is lovely', 'going at 6', 'ego trip']) expect(asksGo(text)).toBe(false);
    expect(DEFAULT_CAPS).toEqual({ dailyGoAsks: 150, dailyMessages: 600, sessionGoAsks: 25, dailyTrips: 100 });
  });

  it('over the visit cap the room refuses, says so, and nothing reaches Go; talking to the group still works', async () => {
    const { go: g, room: r } = await setUp({ caps: { sessionGoAsks: 1 } });
    const { ws, got } = await openLive(r, await signIn(r));
    await until(() => states(got).length > 0);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go one' }));
    await until(() => said(g).length === 1);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go two' }));
    await until(() => got.some((m) => m.type === 'limit'));
    expect(got.find((m) => m.type === 'limit')).toEqual({ type: 'limit', text: sessionLimitLine(1) });
    await until(() => lastState(got).limit === sessionLimitLine(1));
    ws.send(JSON.stringify({ type: 'say', personId: 'p_arjun', text: 'see you all there' }));
    await until(() => said(g).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(said(g).map((e) => e.data.message.text)).toEqual(['@Go one', 'see you all there']);
  });

  it('over the daily cap no visit can send, and nothing reaches Go', async () => {
    const { go: g, room: r } = await setUp({ caps: { dailyMessages: 1 } });
    const a = await openLive(r, await signIn(r));
    const b = await openLive(r, await signIn(r));
    await until(() => states(a.got).length > 0 && states(b.got).length > 0);
    a.ws.send(JSON.stringify({ type: 'say', personId: 'p_rahul', text: 'hi all' }));
    await until(() => said(g).length === 1);
    b.ws.send(JSON.stringify({ type: 'say', personId: 'p_meher', text: 'hello' }));
    await until(() => b.got.some((m) => m.type === 'limit'));
    expect(b.got.find((m) => m.type === 'limit').text).toBe(DAILY_LIMIT_LINE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(said(g)).toHaveLength(1);
  });

  it('over the daily trip cap a new visit gets the limit line and no trip', async () => {
    const { room: r } = await setUp({ caps: { dailyTrips: 1 } });
    const a = await openLive(r, await signIn(r));
    await until(() => states(a.got).length > 0);
    const cookie = await signIn(r);
    const b = await openLive(r, cookie);
    await until(() => b.got.length > 0);
    expect(b.got[0]).toEqual({ type: 'limit', text: DAILY_LIMIT_LINE });
    expect(r.tripOf(visitOf(cookie))).toBeUndefined();
    a.ws.send(JSON.stringify({ type: 'start_over' }));
    await until(() => a.got.some((m) => m.type === 'limit'));
  });
});

describe('a trip for each visit', () => {
  it("gives each visit its own trip, and one visit cannot touch another's", async () => {
    const { fake: f, room: r } = await setUp();
    const cookieA = await signIn(r);
    const cookieB = await signIn(r);
    const a = await openLive(r, cookieA);
    const b = await openLive(r, cookieB);
    await until(() => states(a.got).length > 0 && states(b.got).length > 0);
    const tripA = r.tripOf(visitOf(cookieA))!;
    const tripB = r.tripOf(visitOf(cookieB))!;
    expect(tripA).not.toBe(tripB);
    a.ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: 'hi from A' }));
    await until(() => f.messages(tripA).length === 1);
    await until(() => lastState(a.got).messages.length === 1);
    expect(lastState(b.got).trip.trip_id).toBe(tripB);
    expect(lastState(b.got).messages).toEqual([]);
    const fromA = f.messages(tripA)[0]!.message_id;
    b.ws.send(JSON.stringify({ type: 'react', personId: 'p_kabir', messageId: fromA, emoji: '👍' }));
    await until(() => b.got.some((m) => m.type === 'error'));
    expect(b.got.find((m) => m.type === 'error').message).toBe(NOT_IN_YOUR_TRIP);
    expect(f.messages(tripA)[0]!.reactions).toEqual([]);
  });

  it('Start over gives the visit a new trip with the same five friends, and keeps the cookie', async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const cookie = await signIn(r);
    const { ws, got } = await openLive(r, cookie);
    await until(() => states(got).length > 0);
    const first = r.tripOf(visitOf(cookie))!;
    ws.send(JSON.stringify({ type: 'say', personId: 'p_rahul', text: 'Goa in November?' }));
    await until(() => f.messages(first).length === 1);
    ws.send(JSON.stringify({ type: 'start_over' }));
    await until(() => r.tripOf(visitOf(cookie)) !== first);
    const second = r.tripOf(visitOf(cookie))!;
    await until(() => lastState(got).trip.trip_id === second);
    expect(lastState(got).messages).toEqual([]);
    expect(lastState(got).trip.people).toHaveLength(5);
    expect(f.tripIds()).toEqual(expect.arrayContaining([first, second]));
    await until(() => g.events.filter((e) => e.type === 'trip.created').length === 2);
  });
});

describe('the hosted page and its settings', () => {
  it('draws Start over, the hints, the limit line and the nonce, and leaves the dev room page as it was', () => {
    const html = roomPage({ title: 'Try Go', nonce: 'n0nce', hints: HINTS, hosted: true });
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('<body data-hosted="1">');
    expect(html).toContain('data-start-over="1"');
    expect(html).toContain('id="limit"');
    expect(html).toContain('id="about"');
    expect(html.match(/data-fill=/g)).toHaveLength(HINTS.length);
    expect(html).not.toContain('—');
    const script = html.slice(html.indexOf('<script nonce="n0nce">') + '<script nonce="n0nce">'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(PAGE_HTML).toContain('<script>');
    expect(PAGE_HTML).toContain('<title>Go dev room</title>');
    for (const hosted of ['<body data-hosted', 'data-start-over="1"', 'id="limit"', 'id="about"', 'data-fill=']) expect(PAGE_HTML).not.toContain(hosted);
  });

  it('reads its settings from the environment, with the caps from the brief as defaults', () => {
    const base = { GO_URL: 'https://brain-rehearsal.example', GO_SIGNING_SECRET: 'a'.repeat(64), TRY_PASSCODE: 'judges-only-2026' };
    expect(TryEnv.parse(base)).toMatchObject({
      PORT: 8080, TRY_DAILY_GO_ASKS: 150, TRY_DAILY_MESSAGES: 600, TRY_SESSION_GO_ASKS: 25, TRY_DAILY_TRIPS: 100,
      TRY_SIMULATED_LINE: SIMULATED_LINE, TRY_INSTANCE: 'try-room',
    });
    expect(TryEnv.parse({ ...base, PORT: '9000', TRY_DAILY_GO_ASKS: '10' })).toMatchObject({ PORT: 9000, TRY_DAILY_GO_ASKS: 10 });
    expect(() => TryEnv.parse({ ...base, GO_SIGNING_SECRET: 'short' })).toThrow();
    expect(() => TryEnv.parse({ ...base, TRY_PASSCODE: 'short' })).toThrow();
    expect(() => TryEnv.parse({ ...base, GO_URL: 'brain-rehearsal.example' })).toThrow();
  });
});
