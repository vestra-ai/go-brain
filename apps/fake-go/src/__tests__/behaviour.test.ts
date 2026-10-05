import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Card, CardActionResult, CatchUp, ForgetResult, Link as LinkResult, Ok, PersonPage, PostMessage } from '@go/contract';
import { GOA_PEOPLE, GoSocket, goaFreshTrip, type Handler } from '@go/sim';
import { FAKE_CARD_KINDS, fakeCard } from '../cards.js';
import { fakeGoBehaviour } from '../behaviour.js';
import { Env, publicUrl } from '../env.js';
import { buildFakeGo, type FakeGo } from '../server.js';

const secret = 'fake-go-test-secret-0123456789abcdef';
const at = '2026-10-05T06:49:00Z';
const publicBase = 'https://fake-go.test';

let fake: FakeGo | undefined;
const sockets: GoSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await fake?.close();
  fake = undefined;
});

interface Seen { method: string; params: any }

/** Handlers for the Server's end that record each request Go sends, and answer it the way the contract asks. */
function recorder(seen: Seen[]): Record<string, Handler> {
  let seq = 100;
  return {
    read_trip: async (p) => { seen.push({ method: 'read_trip', params: p }); return goaFreshTrip(); },
    add_reaction: async (p) => { seen.push({ method: 'add_reaction', params: p }); return { seq: ++seq }; },
    post_message: async (_p, raw) => { seen.push({ method: 'post_message', params: raw }); return { message_id: `m_go_${seq}`, seq: ++seq }; },
    typing: async (p) => { seen.push({ method: 'typing', params: p }); },
  };
}

/** Opens one Server socket to the running fake Go, as the given instance. */
async function connect(instance: string, handlers: Record<string, Handler>): Promise<GoSocket> {
  const port = (fake!.app.server.address() as AddressInfo).port;
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  const s = new GoSocket({ url: `ws://127.0.0.1:${port}/v1/socket?instance=${instance}`, secret, handlers, onOpen: () => opened() });
  sockets.push(s);
  s.start();
  await ready;
  return s;
}

/** Starts the fake Go with its behaviour, and the Server's end with handlers that record each request Go sends. */
async function setUp(overrides: Record<string, Handler> = {}) {
  fake = buildFakeGo({ secret, adminToken: 'admin-token-for-tests-0001', behaviour: (link) => fakeGoBehaviour(link, { publicUrl: publicBase }) });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  const seen: Seen[] = [];
  const sock = await connect('behaviour', { ...recorder(seen), ...overrides });
  return { seen, sock };
}

let n = 0;
function message(over: Record<string, unknown> = {}, author: object = { kind: 'person', person_id: GOA_PEOPLE.priya }) {
  n += 1;
  return {
    event_id: `ev_test_${n}`, trip_id: 't_goa', seq: 200 + n, occurred_at: at, type: 'message.created',
    data: {
      message: {
        message_id: `m_test_${n}`, seq: 200 + n, updated_seq: 200 + n, author, text: '@Go hello', attachments: [],
        mentions_go: true, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: at, ...over,
      },
    },
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const posts = (seen: Seen[]) => seen.filter((s) => s.method === 'post_message');
const label = (s: Seen) => (s.method === 'typing' ? `typing ${s.params.on ? 'on' : 'off'}` : s.method);

/** Sends one event and waits for the whole answer: a post and typing off. Returns the post's params as sent. */
async function mention(s: GoSocket, seen: Seen[], ev = message()) {
  const before = posts(seen).length;
  expect(await s.request('send_event', ev)).toEqual({ accepted: true, duplicate: false });
  await until(() => posts(seen).length === before + 1 && label(seen[seen.length - 1]!) === 'typing off');
  return posts(seen)[before]!.params;
}

describe('a message that mentions Go', () => {
  it('gets typing, read_trip, a ✅, a reply with a card, then typing off', async () => {
    const { seen, sock: s } = await setUp();
    const ev = message();
    const post = await mention(s, seen, ev);
    expect(seen.map(label)).toEqual(['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off']);
    const reaction = seen.find((x) => x.method === 'add_reaction')!.params;
    expect(reaction).toMatchObject({ trip_id: 't_goa', message_id: ev.data.message.message_id, emoji: '✅' });
    expect(reaction.request_id).toMatch(/^rq_fake_/);
    expect(PostMessage.safeParse(post).success).toBe(true);
    expect(post.request_id).not.toBe(reaction.request_id);
    expect(post).toMatchObject({ trip_id: 't_goa', reply_to: ev.data.message.message_id, mentions: ['p_priya'] });
    expect(post.text).toBe('Hi Priya, this is the fake Go. Here is an options card to test with.');
    expect(Card.parse(post.card).kind).toBe('options');
    for (const x of seen) expect(JSON.stringify(x.params)).not.toContain('\u2014');
  });

  it('posts a different Go card kind each time, each one valid with a fresh card_id', async () => {
    const { seen, sock: s } = await setUp();
    const kinds: string[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const card = Card.parse((await mention(s, seen)).card);
      kinds.push(card.kind);
      ids.add(card.card_id);
    }
    expect(kinds).toEqual(['options', 'working', 'call', 'pay', 'notice', 'options']);
    expect(ids.size).toBe(6);
    const pay = posts(seen)[3]!.params.card;
    expect(pay).toMatchObject({ kind: 'pay', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], state: 'waiting', merchant: 'Fake Go test merchant' });
    expect(pay.approval_id).toMatch(/^ap_fake_/);
    expect(pay.purpose).toContain('Nothing is charged');
    expect(pay.actions.map((a: { only_for_person_ids: string[] }) => a.only_for_person_ids)).toEqual([['p_rahul'], ['p_rahul']]);
  });

  it("stays quiet for repeats, Go's own messages, withheld messages and messages not for Go", async () => {
    const { seen, sock: s } = await setUp();
    const ev = message();
    await mention(s, seen, ev);
    const count = posts(seen).length;
    expect(await s.request('send_event', ev)).toEqual({ accepted: true, duplicate: true });
    const quiet = [message({}, { kind: 'go' }), message({ withheld: true, text: null }), message({ mentions_go: false, text: 'lets go to the beach' })];
    for (const q of quiet) expect(await s.request('send_event', q)).toEqual({ accepted: true, duplicate: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(seen).length).toBe(count);
  });

  it('still reacts and posts when read_trip fails', async () => {
    const { seen, sock: s } = await setUp({ read_trip: async () => { throw new Error('database down'); } });
    const post = await mention(s, seen);
    expect(seen.map(label)).toEqual(['typing on', 'add_reaction', 'post_message', 'typing off']);
    expect(post.text).toBe('This is the fake Go. Here is an options card to test with.');
    expect(post.mentions).toEqual(['p_priya']);
  });

  it('sends everything about an event on the socket the event came on, never on another instance', async () => {
    const { seen, sock: a } = await setUp();
    const seenOnB: Seen[] = [];
    await connect('second', recorder(seenOnB)); // the newest socket now belongs to another instance
    await mention(a, seen);
    expect(seen.map(label)).toEqual(['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off']);
    await new Promise((r) => setTimeout(r, 100));
    expect(seenOnB).toEqual([]);
  });
});

describe('fixed answers', () => {
  it('answers each tap_id once, and lets only the payer approve', async () => {
    const { seen, sock: s } = await setUp();
    const byKind: Record<string, any> = {};
    for (let i = 0; i < 5; i++) {
      const card = (await mention(s, seen)).card;
      byKind[card.kind] = card;
    }
    const tap = (tap_id: string, card_id: string, action_id: string, person_id: string, option_id?: string) =>
      s.request('card_tap', { tap_id, trip_id: 't_goa', card_id, action_id, person_id, ...(option_id ? { option_id } : {}) }, { timeoutMs: 3500 })
        .then((r) => CardActionResult.parse(r));
    const pay = byKind.pay.card_id as string;
    const refusedPriya = { result: 'refused', toast: 'Only the payer can approve this payment.' };

    expect(await tap('tap_1', pay, 'approve', 'p_priya')).toEqual(refusedPriya);
    const ok = await tap('tap_2', pay, 'approve', 'p_rahul');
    expect(ok.result).toBe('open');
    if (ok.result === 'open') {
      expect(ok.url.startsWith(`${publicBase}/fake/page/vault?`)).toBe(true);
      expect(Date.parse(ok.expires_at)).toBeGreaterThan(Date.now());
    }
    expect(await tap('tap_1', pay, 'approve', 'p_rahul')).toEqual(refusedPriya); // the first answer, again
    expect(await tap('tap_3', byKind.working.card_id, 'watch', 'p_arjun')).toMatchObject({ result: 'open' });
    expect(await tap('tap_4', byKind.working.card_id, 'stop', 'p_arjun')).toEqual({ result: 'done', toast: 'Stopped.' });
    expect(await tap('tap_5', byKind.options.card_id, 'pick', 'p_priya', byKind.options.options[0].option_id))
      .toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    expect(await tap('tap_6', byKind.options.card_id, 'vote', 'p_priya')).toEqual({ result: 'done', toast: 'Go will put it to a vote.' });
    expect(await tap('tap_7', pay, 'decline', 'p_rahul')).toEqual({ result: 'done', toast: 'Declined. Nothing was paid.' });
    expect(await tap('tap_8', 'c_unknown', 'approve', 'p_rahul')).toEqual({ result: 'refused', toast: 'This payment is no longer waiting.' });
    expect(await tap('tap_9', pay, 'dance', 'p_rahul')).toEqual({ result: 'refused', toast: 'The fake Go does not know this button.' });
  });

  it('answers catch_up, the people requests and vault_link with answers that pass the contract', async () => {
    const { sock: s } = await setUp();
    expect(CatchUp.safeParse(await s.request('catch_up', { trip_id: 't_goa', person_id: 'p_meher', since: at }, { timeoutMs: 3500 })).success).toBe(true);
    const page = PersonPage.parse(await s.request('get_person', { person_id: 'p_kabir' }));
    expect(page.person_id).toBe('p_kabir');
    expect(page.facts).toHaveLength(3);
    expect(Ok.parse(await s.request('update_person', { person_id: 'p_kabir', carry_over: true }))).toEqual({ ok: true });
    expect(Ok.parse(await s.request('delete_fact', { person_id: 'p_kabir', fact_id: 'f_kb_02' }))).toEqual({ ok: true });
    expect(ForgetResult.parse(await s.request('forget_person', { person_id: 'p_kabir', trip_id: 't_goa' }))).toEqual({ deleted_facts: 3, remaining_facts: 0 });
    const link = LinkResult.parse(await s.request('vault_link', { kind: 'vault', person_id: 'p_rahul', start: 'add_card' }));
    expect(link.url).toBe(`${publicBase}/fake/page/vault?person=p_rahul&start=add_card`);
  });
});

describe('the cards and the environment', () => {
  it('makes every card kind valid, with no em dash anywhere', () => {
    const now = new Date('2026-10-05T07:00:00Z');
    for (const kind of FAKE_CARD_KINDS) {
      const card = fakeCard(kind, { n: 7, payerId: 'p_rahul', publicUrl: publicBase, now });
      expect(Card.parse(card).kind).toBe(kind);
      expect(JSON.stringify(card)).not.toContain('\u2014');
    }
  });

  it('needs a real secret and token, and finds its public URL', () => {
    expect(() => Env.parse({ GO_SIGNING_SECRET: 'short', FAKE_GO_ADMIN_TOKEN: 'x'.repeat(16) })).toThrow();
    const base = { GO_SIGNING_SECRET: 'a'.repeat(64), FAKE_GO_ADMIN_TOKEN: 'b'.repeat(32) };
    expect(publicUrl(Env.parse(base))).toBe('http://localhost:8080');
    expect(publicUrl(Env.parse({ ...base, RAILWAY_PUBLIC_DOMAIN: 'fake-go-production.up.railway.app' }))).toBe('https://fake-go-production.up.railway.app');
    expect(publicUrl(Env.parse({ ...base, PORT: '9000', FAKE_GO_PUBLIC_URL: 'https://fake-go.example/' }))).toBe('https://fake-go.example');
  });
});
