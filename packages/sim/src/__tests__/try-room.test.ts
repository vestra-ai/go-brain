import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PAGE_HTML, roomPage } from '../dev-room/page.js';
import { FakeServer } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { Caps, DEFAULT_CAPS } from '../try-room/caps.js';
import { TryEnv } from '../try-room/env.js';
import { COOKIE_NAME, Gate, WrongTries, clientAddress } from '../try-room/gate.js';
import { CLOSE_TOO_MANY, LIVE_BEHIND_BYTES, refusal, serveTryRoom, visitTrip, type TryRoom, type TryRoomOptions } from '../try-room/serve.js';
import { DAILY_LIMIT_LINE, HINTS, NOT_IN_YOUR_TRIP, ROOM_FULL, SAY_FIRST, SIMULATED_LINE, SLOW_DOWN, TOO_MANY_TRIES, tooManyTabs, visitLimitLine } from '../try-room/words.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const passcode = 'judge-passcode-2026-try-room';
const cookieSalt = 'salt-for-the-try-room-tests-0123456789abcdef';

let go: TestGo | undefined;
let fake: FakeServer | undefined;
let room: TryRoom | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  room = await serveTryRoom({
    fake, passcode, cookieSalt, goUrl: go.url, port: 0, goHealth: async () => ({ ok: true, contract: '1.0.0' }), wrongTryDelayMs: 200, ...extra,
  });
  return { go, fake, room };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type Live = { ws: WebSocket; got: any[]; closed: Promise<number> };

/** Opens the page's live socket. Resolves with the open socket and the frames it gets, or with the refusal's status. */
function live(r: TryRoom, cookie: string | null, origin?: string): Promise<Live | { status: number }> {
  const host = new URL(r.url).host;
  const headers: Record<string, string> = { origin: origin ?? `http://${host}` };
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/live`, { headers });
    clients.push(ws);
    const got: any[] = [];
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, got, closed }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on('error', () => {});
  });
}

async function openLive(r: TryRoom, cookie: string): Promise<Live> {
  const l = await live(r, cookie);
  if (!('ws' in l)) throw new Error(`refused: ${l.status}`);
  return l;
}

/** Opens a live socket and waits for the room's first state. */
async function inRoom(r: TryRoom, cookie: string): Promise<Live> {
  const l = await openLive(r, cookie);
  await until(() => states(l.got).length > 0);
  return l;
}

const states = (got: any[]) => got.filter((m) => m.type === 'state');
const lastState = (got: any[]) => states(got).at(-1);
const said = (g: TestGo) => g.events.filter((e) => e.type === 'message.created');
const sayAs = (l: Live, personId: string, text: string) => l.ws.send(JSON.stringify({ type: 'say', personId, text }));
const personId = (l: Live, name: string): string => lastState(l.got).trip.people.find((p: { name: string }) => p.name === name).person_id;

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

  it('refuses a bad cookie: made up, changed, signed with another passcode or salt, or older than 12 hours', async () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const { go: g, room: r } = await setUp({ now: () => new Date(clock) });
    const good = await signIn(r);
    const [visit, at, mac] = good.slice(good.indexOf('=') + 1).split('.');
    const bad = [
      `${COOKIE_NAME}=made.up.cookie`,
      `${COOKIE_NAME}=${visit}x.${at}.${mac}`,
      `${COOKIE_NAME}=${visit}.${Number(at) + 1}.${mac}`,
      new Gate('another-passcode-entirely-0000', cookieSalt, () => new Date(clock)).newVisit().setCookie.split(';')[0]!,
      new Gate(passcode, 'another-salt-another-salt-another-salt-00', () => new Date(clock)).newVisit().setCookie.split(';')[0]!,
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
    sayAs(open, 'p_priya', '@Go still there?');
    expect(await open.closed).toBe(4401);
    expect(said(g)).toEqual([]);
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
    for (const hint of HINTS) expect(html).toContain(`data-fill="${hint}"`);

    const l = await inRoom(r, cookie);
    const state = states(l.got)[0];
    expect(state.trip.trip_id).toMatch(/^t_try_[0-9a-f]{12}$/);
    expect(state.trip.people.map((p: { name: string }) => p.name)).toEqual(['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir']);
    expect(state.messages).toEqual([]);
    expect(state.about).toEqual(['Go is live: this room talks to the real Go (contract 1.0.0).', SIMULATED_LINE]);
    expect(state.limit).toBeNull();
    // Opening the room makes no trip: the first message does, with the people the page was shown.
    await pause(150);
    expect(g.events).toEqual([]);
    expect(r.tripOf(visitOf(cookie))).toBeUndefined();
    sayAs(l, state.trip.people[1].person_id, '@Go hello');
    await until(() => said(g).length === 1);
    expect(g.events.map((e) => e.type)).toEqual(['trip.created', 'message.created']);
    expect(g.events[0].trip_id).toBe(state.trip.trip_id);
    expect(r.tripOf(visitOf(cookie))).toBe(state.trip.trip_id);
    expect(await live(r, cookie, 'https://somewhere-else.example')).toEqual({ status: 401 });
  });

  it('slows wrong tries after 5 a minute from one address, and never turns away the right passcode', async () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const { room: r } = await setUp({ now: () => new Date(clock), trustProxy: true });
    // Keyed on x-real-ip, as Railway's edge sets it: a made-up first x-forwarded-for address changes nothing.
    let n = 0;
    const from = (address: string) => ({ 'x-real-ip': address, 'x-forwarded-for': `203.0.113.${++n}, 10.0.0.1` });
    for (let i = 0; i < 5; i++) expect((await enter(r, 'wrong-guess', from('198.51.100.1'))).status).toBe(401);
    const started = Date.now();
    const slowed = await enter(r, 'wrong-guess', from('198.51.100.1'));
    expect(slowed.status).toBe(429);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(await slowed.text()).toContain('Too many wrong tries');
    // The right passcode still gets in at once, from the same address.
    const right = await enter(r, passcode, from('198.51.100.1'));
    expect(right.status).toBe(303);
    expect(right.headers.get('set-cookie')).toContain(COOKIE_NAME);
    // Another address is not slowed, and the first one is not slowed a minute later.
    expect((await enter(r, 'wrong-guess', from('198.51.100.2'))).status).toBe(401);
    clock += 61_000;
    expect((await enter(r, 'wrong-guess', from('198.51.100.1'))).status).toBe(401);
  });

  it('keys the limit on x-real-ip only when it is an IP address, else on the socket; never on x-forwarded-for', () => {
    const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '10.0.0.9' } }) as unknown as IncomingMessage;
    const edge = { address: '10.0.0.9', source: 'socket' };
    expect(clientAddress(req({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }), true)).toEqual({ address: '198.51.100.7', source: 'x-real-ip' });
    expect(clientAddress(req({ 'x-real-ip': ' 2001:db8::7 ' }), true)).toEqual({ address: '2001:db8::7', source: 'x-real-ip' });
    for (const junk of ['not-an-ip', 'x'.repeat(16_000), '198.51.100.7, 203.0.113.1', '198.51.100.300', '']) {
      expect(clientAddress(req({ 'x-real-ip': junk, 'x-forwarded-for': '203.0.113.1' }), true)).toEqual(edge);
    }
    expect(clientAddress(req({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }), true)).toEqual(edge);
    expect(clientAddress(req({ 'x-real-ip': '198.51.100.7' }), false)).toEqual(edge);
  });

  it('holds at most a set number of addresses, dropping the oldest first, and prunes the stale ones', () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const tries = new WrongTries(() => new Date(clock), 1, 60_000, 3, 10_000);
    for (const a of ['a', 'b', 'c']) expect(tries.wrong(a)).toBe('wrong');
    expect(['a', 'b', 'c'].map((a) => tries.blocked(a))).toEqual([true, true, true]);
    expect(tries.wrong('a')).toBe('slow'); // a went wrong again: now b is the oldest
    tries.wrong('d');
    expect(['a', 'b', 'c', 'd'].map((x) => tries.blocked(x))).toEqual([true, false, true, true]);
    for (let i = 0; i < 1000; i++) {
      tries.wrong(`198.51.${Math.floor(i / 250)}.${i % 250}`);
      expect(tries.size).toBeLessThanOrEqual(3);
    }
    clock += 61_000;
    tries.prune();
    expect(tries.size).toBe(0);
  });

  it('turns wrong tries away at once in a flood from everywhere, and still lets the right passcode in', async () => {
    const fixed = Date.parse('2026-10-06T06:00:00Z');
    const unit = new WrongTries(() => new Date(fixed), 5, 60_000, 10_000, 3);
    expect(['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'].map((a) => unit.wrong(a))).toEqual(['wrong', 'wrong', 'wrong', 'flood']);
    expect(unit.size).toBe(3); // a try in a flood is not remembered

    const { room: r } = await setUp({ now: () => new Date(fixed), trustProxy: true, wrongTriesPerSecond: 3, wrongTryDelayMs: 2000 });
    for (let i = 1; i <= 3; i++) expect((await enter(r, 'wrong-guess', { 'x-real-ip': `198.51.100.${i}` })).status).toBe(401);
    const started = Date.now();
    const flooded = await enter(r, 'wrong-guess', { 'x-real-ip': '198.51.100.4' });
    expect(flooded.status).toBe(429);
    expect(Date.now() - started).toBeLessThan(1000); // at once, not after the 2 s wait
    expect(await flooded.text()).toContain(TOO_MANY_TRIES);
    expect((await enter(r, passcode, { 'x-real-ip': '198.51.100.4' })).status).toBe(303);
  });

  it('logs once where the wrong-try key came from, on the first passcode that gets in, and never an address', async () => {
    const lines: string[] = [];
    const { room: r } = await setUp({ log: (line) => lines.push(line), trustProxy: true });
    const headers = { 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '203.0.113.8, 10.0.0.1' };
    await enter(r, 'wrong-guess', headers);
    await enter(r, passcode, headers);
    await enter(r, passcode, headers);
    expect(lines).toEqual(['the first passcode that got in: its wrong-try key came from x-real-ip']);
  });

  it('never puts the signing secret, the passcode or the salt in any answer', async () => {
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
    const l = await inRoom(r, cookie);
    sayAs(l, personId(l, 'Priya'), '@Go hello');
    await until(() => said(g).length === 1);
    await until(() => states(l.got).some((s) => s.messages.length === 1));
    seen.push(JSON.stringify(l.got));
    for (const text of seen) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(passcode);
      expect(text).not.toContain(cookieSalt);
    }
  });
});

describe('the caps', () => {
  it('TRY_DAILY_TURNS: one budget for everything that can wake Go, across every visit, started again at 05:30 IST', () => {
    let clock = Date.parse('2026-10-06T18:00:00Z');
    const caps = new Caps({ dailyTurns: 3, dailyMessages: 100, visitTurns: 100 }, () => new Date(clock));
    expect(caps.newTrip('a')).toEqual({ ok: true });
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.send('c', true)).toEqual({ ok: true });
    expect(caps.send('d', true)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.newTrip('d')).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.send('d', false)).toEqual({ ok: true }); // a reaction still goes through
    expect(caps.line('d')).toBe(DAILY_LIMIT_LINE);
    clock = Date.parse('2026-10-07T00:00:01Z'); // 05:30:01 IST
    expect(caps.line('d')).toBeNull();
    expect(caps.send('d', true)).toEqual({ ok: true });
    expect(DEFAULT_CAPS).toEqual({ dailyTurns: 200, dailyMessages: 600, visitTurns: 30 });
  });

  it('TRY_VISIT_TURNS: each visit has its own share of the day, so one visit cannot use it up', () => {
    let clock = Date.parse('2026-10-06T18:00:00Z');
    const caps = new Caps({ dailyTurns: 100, dailyMessages: 100, visitTurns: 2 }, () => new Date(clock));
    expect(caps.newTrip('a')).toEqual({ ok: true });
    expect(caps.send('a', true)).toEqual({ ok: true });
    expect(caps.send('a', true)).toEqual({ ok: false, line: visitLimitLine(2) });
    expect(caps.newTrip('a')).toEqual({ ok: false, line: visitLimitLine(2) });
    expect(caps.send('a', false)).toEqual({ ok: true }); // a reaction still goes through
    expect(caps.line('a')).toBe(visitLimitLine(2));
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.line('b')).toBeNull();
    clock = Date.parse('2026-10-07T00:00:01Z');
    expect(caps.send('a', true)).toEqual({ ok: true });
  });

  it('TRY_DAILY_MESSAGES: counts everything sent into the room, reactions included', () => {
    const caps = new Caps({ dailyTurns: 100, dailyMessages: 2, visitTurns: 100 });
    expect(caps.send('a', false)).toEqual({ ok: true });
    expect(caps.send('b', true)).toEqual({ ok: true });
    expect(caps.send('c', false)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.send('c', true)).toEqual({ ok: false, line: DAILY_LIMIT_LINE });
    expect(caps.line('c')).toBe(DAILY_LIMIT_LINE);
  });

  it('counts a message that does not name Go and each new trip as turns; Start over is free until someone speaks; a reaction still goes through', async () => {
    const { go: g, fake: f, room: r } = await setUp({ caps: { dailyTurns: 4 } });
    const cookie = await signIn(r);
    const l = await inRoom(r, cookie);
    sayAs(l, personId(l, 'Rahul'), 'hello all'); // the trip and the message: turns 1 and 2, though it never names Go
    await until(() => said(g).length === 1);
    l.ws.send(JSON.stringify({ type: 'start_over' })); // free: no trip yet
    await until(() => lastState(l.got).messages.length === 0 && r.tripOf(visitOf(cookie)) === undefined);
    await pause(100);
    expect(g.events.filter((e) => e.type === 'trip.created')).toHaveLength(1);
    sayAs(l, personId(l, 'Priya'), 'anyone up for scuba'); // the new trip and the message: turns 3 and 4
    await until(() => said(g).length === 2);
    sayAs(l, personId(l, 'Priya'), '@Go one more?');
    await until(() => l.got.some((m) => m.type === 'limit'));
    expect(l.got.find((m) => m.type === 'limit').text).toBe(DAILY_LIMIT_LINE);
    await until(() => lastState(l.got).limit === DAILY_LIMIT_LINE);
    // A reaction cannot wake Go: it still goes through.
    const tripId = r.tripOf(visitOf(cookie))!;
    const messageId = f.messages(tripId)[0]!.message_id;
    l.ws.send(JSON.stringify({ type: 'react', personId: personId(l, 'Meher'), messageId, emoji: '👍' }));
    await until(() => g.events.some((e) => e.type === 'reaction.added'));
    await pause(100);
    expect(said(g).map((e) => e.data.message.text)).toEqual(['hello all', 'anyone up for scuba']);
  });

  it('opening the room costs nothing: sockets without a message make no trip and take no turn', async () => {
    const { go: g, room: r } = await setUp({ caps: { dailyTurns: 1 } });
    for (let i = 0; i < 5; i++) {
      const l = await inRoom(r, await signIn(r));
      expect(lastState(l.got).limit).toBeNull();
    }
    await pause(100);
    expect(g.events).toEqual([]);
    expect(r.caps.line('anyone')).toBeNull();
  });

  it('gives one visit its share and then refuses it, while other visits still talk to Go; nothing more reaches Go from it', async () => {
    const { go: g, room: r } = await setUp({ caps: { visitTurns: 3 } });
    const a = await inRoom(r, await signIn(r));
    const b = await inRoom(r, await signIn(r));
    sayAs(a, personId(a, 'Rahul'), 'one'); // A's trip and message: 2 turns
    await until(() => said(g).length === 1);
    sayAs(a, personId(a, 'Rahul'), 'two'); // 3
    await until(() => said(g).length === 2);
    sayAs(a, personId(a, 'Rahul'), 'three');
    await until(() => a.got.some((m) => m.type === 'limit'));
    expect(a.got.find((m) => m.type === 'limit').text).toBe(visitLimitLine(3));
    sayAs(b, personId(b, 'Meher'), 'hello from B');
    await until(() => said(g).length === 3);
    await pause(100);
    expect(said(g).map((e) => e.data.message.text)).toEqual(['one', 'two', 'hello from B']);
  });

  it('cannot be reset by typing the passcode again: a new visit shares the same daily budget', async () => {
    const { go: g, room: r } = await setUp({ caps: { dailyTurns: 2 } });
    const a = await inRoom(r, await signIn(r));
    sayAs(a, personId(a, 'Rahul'), 'hi');
    await until(() => said(g).length === 1);
    const again = await inRoom(r, await signIn(r));
    expect(lastState(again.got).limit).toBe(DAILY_LIMIT_LINE);
    sayAs(again, personId(again, 'Kabir'), 'hello');
    await until(() => again.got.some((m) => m.type === 'limit'));
    await pause(100);
    expect(g.events.filter((e) => e.type === 'trip.created')).toHaveLength(1);
    expect(said(g)).toHaveLength(1);
  });

  it('over the daily message cap no visit can send, no trip is made, and nothing reaches Go', async () => {
    const { go: g, room: r } = await setUp({ caps: { dailyMessages: 1 } });
    const a = await inRoom(r, await signIn(r));
    const b = await inRoom(r, await signIn(r));
    sayAs(a, personId(a, 'Rahul'), 'hi all');
    await until(() => said(g).length === 1);
    sayAs(b, personId(b, 'Meher'), 'hello');
    await until(() => b.got.some((m) => m.type === 'limit'));
    expect(b.got.find((m) => m.type === 'limit').text).toBe(DAILY_LIMIT_LINE);
    await pause(100);
    expect(said(g)).toHaveLength(1);
    expect(g.events.filter((e) => e.type === 'trip.created')).toHaveLength(1);
  });

  it('asks for a message first before anything else can happen in a trip that does not exist yet', async () => {
    const { go: g, room: r } = await setUp();
    const l = await inRoom(r, await signIn(r));
    l.ws.send(JSON.stringify({ type: 'react', personId: personId(l, 'Meher'), messageId: 'm_nothing', emoji: '👍' }));
    await until(() => l.got.some((m) => m.type === 'error'));
    expect(l.got.find((m) => m.type === 'error').message).toBe(SAY_FIRST);
    await pause(100);
    expect(g.events).toEqual([]);
  });
});

describe('sockets', () => {
  it('lets a visit open 3 sockets; a 4th is told why and closed', async () => {
    const { room: r } = await setUp();
    const cookie = await signIn(r);
    for (let i = 0; i < 3; i++) await inRoom(r, cookie);
    const fourth = await openLive(r, cookie);
    expect(await fourth.closed).toBe(CLOSE_TOO_MANY);
    expect(fourth.got).toEqual([{ type: 'limit', text: tooManyTabs(3) }]);
  });

  it('holds the whole room to its socket limit', async () => {
    const { room: r } = await setUp({ maxSockets: 2 });
    await inRoom(r, await signIn(r));
    await inRoom(r, await signIn(r));
    const third = await openLive(r, await signIn(r));
    expect(await third.closed).toBe(CLOSE_TOO_MANY);
    expect(third.got).toEqual([{ type: 'limit', text: ROOM_FULL }]);
  });

  it('takes about 5 frames a second from a socket, drops the rest, and says so once', async () => {
    const fixed = Date.parse('2026-10-06T06:00:00Z');
    const { go: g, room: r } = await setUp({ now: () => new Date(fixed) }); // a stopped clock: nothing refills
    const l = await inRoom(r, await signIn(r));
    for (let i = 0; i < 20; i++) sayAs(l, personId(l, 'Kabir'), `message ${i}`);
    await until(() => said(g).length === 5);
    await pause(200);
    expect(said(g)).toHaveLength(5);
    expect(l.got.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: SLOW_DOWN }]);
  });

  it("works out a trip's state once for all the sockets watching it", async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const cookie = await signIn(r);
    const first = await inRoom(r, cookie);
    for (let i = 0; i < 2; i++) await inRoom(r, cookie);
    sayAs(first, personId(first, 'Rahul'), 'hi');
    await until(() => said(g).length === 1);
    await pause(150); // Go's answers have come and gone
    const spy = vi.spyOn(f, 'messages');
    await pause(1100); // at least one redraw tick, and no changes
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('checks a tap or reaction against the trip without copying the trip or its messages', async () => {
    const { fake: f } = await setUp();
    await f.createTrip({ ...goaFreshTrip(), trip_id: 't_try_check' });
    const hello = await f.say('p_priya', 'hello', { tripId: 't_try_check' });
    const messages = vi.spyOn(f, 'messages');
    const trip = vi.spyOn(f, 'trip');
    expect(refusal(f, 't_try_check', { type: 'react', personId: 'p_kabir', messageId: 'm_elsewhere', emoji: '👍' })).toBe(NOT_IN_YOUR_TRIP);
    expect(refusal(f, 't_try_check', { type: 'tap', cardId: 'c_elsewhere', actionId: 'pick', personId: 'p_kabir' })).toBe(NOT_IN_YOUR_TRIP);
    expect(refusal(f, 't_try_check', { type: 'react', personId: 'p_kabir', messageId: hello.message_id, emoji: '👍' })).toBeNull();
    expect(messages).not.toHaveBeenCalled();
    expect(trip).not.toHaveBeenCalled();
  });
});

describe('a trip for each visit', () => {
  it("gives each visit its own trip and its own person ids, and one visit cannot touch another's", async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const cookieA = await signIn(r);
    const cookieB = await signIn(r);
    const a = await inRoom(r, cookieA);
    const b = await inRoom(r, cookieB);
    const idsA = lastState(a.got).trip.people.map((p: { person_id: string }) => p.person_id);
    const idsB = lastState(b.got).trip.people.map((p: { person_id: string }) => p.person_id);
    sayAs(a, idsA[0], 'trip A begins');
    sayAs(b, idsB[0], 'trip B begins');
    await until(() => r.tripOf(visitOf(cookieA)) !== undefined && r.tripOf(visitOf(cookieB)) !== undefined);
    const tripA = r.tripOf(visitOf(cookieA))!;
    const tripB = r.tripOf(visitOf(cookieB))!;
    expect(tripA).not.toBe(tripB);
    expect(idsA).toEqual(['rahul', 'priya', 'arjun', 'meher', 'kabir'].map((n) => `p_${n}_${tripA.slice('t_try_'.length)}`));
    expect(idsB.some((id: string) => idsA.includes(id))).toBe(false);
    expect(lastState(a.got).trip.organizer_person_id).toBe(idsA[0]);
    await until(() => g.events.filter((e) => e.type === 'trip.created').length === 2);
    expect(g.events.find((e) => e.trip_id === tripA).data.trip.people.map((p: { person_id: string }) => p.person_id)).toEqual(idsA);

    sayAs(a, idsA[1], 'hi from A');
    await until(() => f.messages(tripA).length === 2);
    await until(() => lastState(a.got).messages.length === 2);
    await until(() => lastState(b.got).messages.length === 1);
    expect(lastState(b.got).messages.map((m: { text: string }) => m.text)).toEqual(['trip B begins']);
    const fromA = f.messages(tripA)[1]!.message_id;
    b.ws.send(JSON.stringify({ type: 'react', personId: idsB[4], messageId: fromA, emoji: '👍' }));
    await until(() => b.got.some((m) => m.type === 'error'));
    expect(b.got.find((m) => m.type === 'error').message).toBe(NOT_IN_YOUR_TRIP);
    // Someone from another trip is not in this one either.
    sayAs(b, idsA[1], 'hi as someone else');
    await until(() => b.got.filter((m) => m.type === 'error').length === 2);
    expect(f.messages(tripA)[1]!.reactions).toEqual([]);
    expect(f.messages(tripB)).toHaveLength(1);
  });

  it('Start over gives the visit a new trip with the same five friends, new ids, and keeps the cookie', async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const cookie = await signIn(r);
    const l = await inRoom(r, cookie);
    sayAs(l, personId(l, 'Rahul'), 'Goa in November?');
    await until(() => r.tripOf(visitOf(cookie)) !== undefined);
    const first = r.tripOf(visitOf(cookie))!;
    await until(() => f.messages(first).length === 1);
    l.ws.send(JSON.stringify({ type: 'start_over' }));
    await until(() => lastState(l.got).trip.trip_id !== first);
    const second = lastState(l.got).trip.trip_id;
    expect(lastState(l.got).messages).toEqual([]);
    expect(lastState(l.got).trip.people.map((p: { name: string }) => p.name)).toEqual(['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir']);
    expect(personId(l, 'Rahul')).toBe(`p_rahul_${second.slice('t_try_'.length)}`);
    sayAs(l, personId(l, 'Rahul'), 'starting again');
    await until(() => r.tripOf(visitOf(cookie)) === second);
    await until(() => g.events.filter((e) => e.type === 'trip.created').length === 2);
  });

  it('makes a trip with person ids of its own, the same names, and nothing else changed', () => {
    const trip = visitTrip('t_try_abc123', 'abc123');
    const fresh = goaFreshTrip();
    expect(trip.trip_id).toBe('t_try_abc123');
    expect(trip.people.map((p) => p.person_id)).toEqual(fresh.people.map((p) => `${p.person_id}_abc123`));
    expect(trip.people.map((p) => p.name)).toEqual(fresh.people.map((p) => p.name));
    expect(trip.organizer_person_id).toBe('p_rahul_abc123');
    expect(trip.people.map((p) => p.photo_url)).toEqual(fresh.people.map((p) => p.photo_url));
  });
});

describe('ids and memory', () => {
  it('mints ids with a part of their own for each FakeServer, so a restarted room never repeats an event_id', async () => {
    go = await startTestGo(secret);
    const one = new FakeServer({ goUrl: go.url, secret, instance: 'one' });
    const two = new FakeServer({ goUrl: go.url, secret, instance: 'two' });
    try {
      await one.start(3000);
      await one.createTrip({ ...goaFreshTrip(), trip_id: 't_one' });
      await two.start(3000);
      await two.createTrip({ ...goaFreshTrip(), trip_id: 't_two' });
      const [a, b] = [one.events[0]!.event.event_id, two.events[0]!.event.event_id];
      expect(a).toMatch(/^ev_[0-9a-f]{8}_0001$/);
      expect(b).toMatch(/^ev_[0-9a-f]{8}_0001$/);
      expect(a).not.toBe(b);
    } finally {
      one.stop();
      two.stop();
    }
  });

  it('keeps only the newest records of each trip, and drops a trip with everything about it', async () => {
    const { fake: f } = await setUp();
    await f.createTrip({ ...goaFreshTrip(), trip_id: 't_keep' });
    await f.createTrip({ ...goaFreshTrip(), trip_id: 't_drop' });
    for (let i = 0; i < 5; i++) await f.say('p_priya', `hello ${i}`, { tripId: 't_keep' });
    await f.say('p_priya', 'bye', { tripId: 't_drop' });
    f.trimRecords(2);
    expect(f.events.filter((e) => e.event.trip_id === 't_keep').map((e) => e.event.seq)).toEqual([5, 6]);
    f.forgetTrip('t_drop');
    expect(f.tripIds()).toEqual(['t_keep']);
    expect(f.events.some((e) => e.event.trip_id === 't_drop')).toBe(false);
    expect(f.has('t_drop', {})).toBe(false);
  });

  it('drops a trip nobody has used or watched for 6 hours; a visit coming back gets a fresh one', async () => {
    let clock = Date.parse('2026-10-06T06:00:00Z');
    const { fake: f, room: r } = await setUp({ now: () => new Date(clock) });
    const idle = await signIn(r);
    const watching = await signIn(r);
    const gone = await inRoom(r, idle);
    const stays = await inRoom(r, watching);
    sayAs(gone, personId(gone, 'Rahul'), 'hi');
    sayAs(stays, personId(stays, 'Rahul'), 'hi');
    await until(() => r.tripOf(visitOf(idle)) !== undefined && r.tripOf(visitOf(watching)) !== undefined);
    const idleTrip = r.tripOf(visitOf(idle))!;
    const watchedTrip = r.tripOf(visitOf(watching))!;
    gone.ws.close();
    await until(() => gone.ws.readyState === WebSocket.CLOSED);
    await pause(50);
    clock += 6 * 60 * 60 * 1000 + 60_000;
    r.sweep();
    expect(f.tripIds()).not.toContain(idleTrip);
    expect(f.tripIds()).toContain(watchedTrip);
    expect(r.tripOf(visitOf(idle))).toBeUndefined();
    const back = await inRoom(r, idle);
    expect(lastState(back.got).trip.trip_id).not.toBe(idleTrip);
  });
});

describe('Go Live', () => {
  /** A stand-in for Go's live view: each feed opened, the trip it is for, and a way to send on it. */
  function fakeLive() {
    const feeds: Array<{ tripId: string; send: (m: unknown) => void; closed: boolean }> = [];
    const live: TryRoomOptions['live'] = (tripId, onMessage) => {
      const feed = { tripId, send: onMessage, closed: false };
      feeds.push(feed);
      return { close: () => { feed.closed = true; } };
    };
    return { feeds, live };
  }
  const lives = (got: any[]) => got.filter((m) => m.type === 'live');

  it("draws the second column only when the room has Go Live, and the page's script still parses", async () => {
    const plain = roomPage({ title: 'Try Go', nonce: 'n0nce', hints: HINTS, hosted: true });
    expect(plain).not.toContain('class="split"');
    expect(plain).not.toContain('onLive(');
    const html = roomPage({ title: 'Try Go', nonce: 'n0nce', hints: HINTS, hosted: true, live: true });
    expect(html).toContain('<div class="split"><div class="app">');
    expect(html).toContain('<aside class="live" id="live" aria-label="Go Live">');
    expect(html).toContain("} else if (data.type === 'live') {");
    // A picture is shown at its own size or smaller, never stretched, and a finished or failed run's picture is never dimmed.
    expect(html).toContain('.view img { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; }');
    expect(html).not.toContain('object-fit: cover');
    expect(html).not.toContain('grayscale');
    expect(html).toContain("else if (m.type === 'screen' && m.event) { live.state = 'on'; screenEvent(m.event); }");
    // A group of steps (how we all get there) has its own badge and tile, and each step is named by its city.
    expect(html).toContain("steps: 'GROUP'");
    expect(html).toContain('<div class="tile group" data-run="');
    expect(html).toContain("return r.lane ? r.lane + ': ' + r.label : r.label;");
    // A live tab carries the run whose fetch has it (Bash echoes the fetch's tag), and its tile that run's label.
    expect(html).toContain('var run = t.tag ? live.runs[t.tag] : null;');
    expect(html).not.toContain('—');
    const script = html.slice(html.indexOf('<script nonce="n0nce">') + '<script nonce="n0nce">'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    const { feeds, live: open } = fakeLive();
    const { room: r } = await setUp({ live: open });
    const cookie = await signIn(r);
    expect(await (await page(r, cookie)).text()).toContain('id="screen"');
    expect(feeds).toEqual([]);
  });

  it("gives each socket the feed of its visit's trip once the first message makes it, relays what Go says, and lets it go", async () => {
    const { feeds, live: open } = fakeLive();
    const { room: r } = await setUp({ live: open });
    const cookie = await signIn(r);
    const l = await inRoom(r, cookie);
    await pause(50);
    expect(feeds).toEqual([]); // no trip yet: nothing to watch, and nothing opened
    sayAs(l, personId(l, 'Rahul'), 'Goa in November?');
    await until(() => feeds.length === 1);
    const tripId = r.tripOf(visitOf(cookie))!;
    expect(feeds[0]!.tripId).toBe(tripId);
    feeds[0]!.send({ type: 'hello', trip_id: tripId, events: [] });
    feeds[0]!.send({ type: 'run', event: { type: 'run_start', run_id: 'run_1', group_id: 'grp_1', recipe_id: 'trains.between', label: 'Trains', at: '2026-10-08T06:00:00Z' } });
    await until(() => lives(l.got).length === 2);
    expect(lives(l.got)[1]).toEqual({ type: 'live', trip_id: tripId, msg: { type: 'run', event: expect.objectContaining({ run_id: 'run_1' }) } });
    // Start over: the old trip's feed goes, and the next trip gets its own once someone speaks in it.
    l.ws.send(JSON.stringify({ type: 'start_over' }));
    await until(() => feeds[0]!.closed);
    sayAs(l, personId(l, 'Priya'), 'starting again');
    await until(() => feeds.length === 2);
    expect(feeds[1]!.tripId).not.toBe(tripId);
    l.ws.close();
    await until(() => feeds[1]!.closed);
  });

  it("never holds a run's events back behind a big picture", async () => {
    const { feeds, live: open } = fakeLive();
    const { room: r } = await setUp({ live: open });
    const cookie = await signIn(r);
    const l = await inRoom(r, cookie);
    sayAs(l, personId(l, 'Rahul'), 'hi');
    await until(() => feeds.length === 1);
    const big = 'A'.repeat(LIVE_BEHIND_BYTES + 1024);
    feeds[0]!.send({ type: 'run', event: { type: 'frames', run_id: 'run_1', frames: [{ label: 'results', at_ms: 1, page: '/hotels/search/result', jpeg_base64: big }] } });
    feeds[0]!.send({ type: 'run', event: { type: 'run_end', run_id: 'run_1', ok: true, speed: 'page', ms: 10 } });
    await until(() => lives(l.got).some((m) => m.msg.event?.type === 'run_end'));
    expect(lives(l.got).map((m) => m.msg.event.type)).toContain('run_end');
  });
});

describe('the hosted page and its settings', () => {
  it('draws Start over, the hints, the limit line and the nonce, keeps the same person on a new trip, and leaves the dev room page as it was', () => {
    const html = roomPage({ title: 'Try Go', nonce: 'n0nce', hints: HINTS, hosted: true });
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('<body data-hosted="1">');
    expect(html).toContain('data-start-over="1"');
    expect(html).toContain('id="limit"');
    expect(html).toContain("find(state.trip.people, 'name', was.name)");
    expect(html).toContain('e.code === 4429');
    expect(html.match(/data-fill=/g)).toHaveLength(HINTS.length);
    expect(html).not.toContain('—');
    const script = html.slice(html.indexOf('<script nonce="n0nce">') + '<script nonce="n0nce">'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(PAGE_HTML).toContain('<script>');
    for (const hosted of ['<body data-hosted', 'data-start-over="1"', 'id="limit"', 'id="about"', 'data-fill=']) expect(PAGE_HTML).not.toContain(hosted);
  });

  it('reads its settings from the environment: a long passcode, a salt, and the caps as defaults', () => {
    const base = {
      GO_URL: 'https://brain-try.example', GO_SIGNING_SECRET: 'a'.repeat(64), TRY_PASSCODE: 'judges-only-2026-passcode', TRY_COOKIE_SALT: 'b'.repeat(64),
    };
    expect(TryEnv.parse(base)).toMatchObject({
      PORT: 8080, TRY_DAILY_TURNS: 200, TRY_DAILY_MESSAGES: 600, TRY_VISIT_TURNS: 30, TRY_SIMULATED_LINE: SIMULATED_LINE, TRY_INSTANCE: 'try-room',
    });
    expect(TryEnv.parse({ ...base, PORT: '9000', TRY_DAILY_TURNS: '10' })).toMatchObject({ PORT: 9000, TRY_DAILY_TURNS: 10 });
    expect(TryEnv.parse(base).TRY_LIVE).toBe('0');
    expect(TryEnv.parse({ ...base, TRY_LIVE: '1' }).TRY_LIVE).toBe('1');
    expect(() => TryEnv.parse({ ...base, TRY_LIVE: 'yes' })).toThrow();
    expect(() => TryEnv.parse({ ...base, GO_SIGNING_SECRET: 'short' })).toThrow();
    expect(() => TryEnv.parse({ ...base, TRY_PASSCODE: 'nineteen-characters' })).toThrow();
    expect(() => TryEnv.parse({ ...base, TRY_COOKIE_SALT: 'c'.repeat(31) })).toThrow();
    const { TRY_COOKIE_SALT: _salt, ...noSalt } = base;
    expect(() => TryEnv.parse(noSalt)).toThrow();
    expect(() => TryEnv.parse({ ...base, GO_URL: 'brain-try.example' })).toThrow();
  });
});
