import { afterEach, describe, expect, it } from 'vitest';
import { Card, TripSnapshot, verifyRequest, verifySpendApproval } from '@go/contract';
import { FakeServer, socketUrl, type FakeServerOptions } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
let go: TestGo | undefined;
let fake: FakeServer | undefined;
afterEach(async () => {
  fake?.stop();
  fake = undefined;
  await go?.close();
  go = undefined;
});

async function setUp(extra: Partial<FakeServerOptions> = {}) {
  // A Server given its own clock signs its socket by it, so Go checks by the same clock.
  const now = extra.now;
  go = await startTestGo(secret, now ? { nowSeconds: () => Math.floor(now().getTime() / 1000) } : {});
  fake = new FakeServer({ goUrl: go.url, secret, ...extra });
  await fake.start(3000);
  await fake.createTrip(goaFreshTrip());
  return { go, fake };
}

const villaVote = { trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] };

describe('connecting and the trip', () => {
  it('dials Go with a signed upgrade for its instance, and sends trip.created as change 1', async () => {
    const { go: g } = await setUp();
    expect(g.targets[0]).toBe('/v1/socket?instance=sim');
    expect(verifyRequest({ method: 'GET', target: g.targets[0]!, body: '' }, g.signatures[0], secret).ok).toBe(true);
    expect(g.events[0]).toMatchObject({ type: 'trip.created', seq: 1, trip_id: 't_goa' });
    expect(TripSnapshot.safeParse(g.events[0].data.trip).success).toBe(true);
    expect(socketUrl('https://go.example', 'server-1')).toBe('wss://go.example/v1/socket?instance=server-1');
    expect(socketUrl('ws://localhost:8080/v1/socket', 'sim')).toBe('ws://localhost:8080/v1/socket?instance=sim');
  });

  it("signs its upgrade with its own clock, so a test that moves the clock (Go's and the Server's alike) still connects", async () => {
    // Ten hours before the real time: a signature from the real clock would be outside Go's 300 s window.
    const offset = -10 * 3_600_000;
    go = await startTestGo(secret, { nowSeconds: () => Math.floor((Date.now() + offset) / 1000) });
    fake = new FakeServer({ goUrl: go.url, secret, now: () => new Date(Date.now() + offset) });
    await fake.start(3000);
    expect(go.refused).toBe(0);
    const moved = Math.floor((Date.now() + offset) / 1000);
    expect(verifyRequest({ method: 'GET', target: go.targets[0]!, body: '' }, go.signatures[0], secret, moved).ok).toBe(true);
    expect(verifyRequest({ method: 'GET', target: go.targets[0]!, body: '' }, go.signatures[0], secret).ok).toBe(false);
  });

  it('says things as people, with the next change number, and tells listeners', async () => {
    const { go: g, fake: f } = await setUp();
    let changes = 0;
    f.onChange(() => (changes += 1));
    const msg = await f.say('p_priya', '@Go flights on Friday?');
    expect(msg.mentions_go).toBe(true);
    expect(g.events[1]).toMatchObject({ type: 'message.created', seq: 2, data: { message: { message_id: msg.message_id, mentions_go: true } } });
    expect(changes).toBeGreaterThan(0);
  });

  it('reacts, edits and deletes as people', async () => {
    const { go: g, fake: f } = await setUp();
    const m = await f.say('p_arjun', 'I land at 9');
    await f.react('p_meher', m.message_id, '👍');
    await f.edit('p_arjun', m.message_id, 'I land at 11');
    await f.delete('p_arjun', m.message_id);
    expect(g.events.slice(-3).map((e) => e.type)).toEqual(['reaction.added', 'message.edited', 'message.deleted']);
  });

  it('reconnects on a new socket signed fresh, keeps the trip and the write log, and sends a waiting event again with its event_id', async () => {
    const { go: g, fake: f } = await setUp();
    await g.call('post_message', { request_id: 'rq_before', trip_id: 't_goa', text: 'Before the drop' });
    await f.waitFor(() => f.events.length === 2 && f.events.every((e) => e.answer !== undefined));
    g.mode = 'silent-once';
    const said = f.say('p_rahul', 'are you still there?');
    await f.waitFor(() => g.events.length === 3);
    // Away for 1.1 s: a new second, so the new upgrade signature differs from the old one.
    await f.reconnect({ downMs: 1_100 });
    expect(f.isOpen()).toBe(true);
    expect(g.signatures).toHaveLength(2);
    expect(g.signatures[1]).not.toBe(g.signatures[0]);
    expect(g.targets[1]).toBe('/v1/socket?instance=sim');
    const msg = await said;
    expect(g.events.filter((e) => e.event_id === g.events[2].event_id)).toHaveLength(2);
    expect(f.events.at(-1)).toMatchObject({ event: { seq: msg.seq }, answer: { accepted: true, duplicate: false } });
    // The same write again on the new socket: answered, counted, not applied twice.
    await g.call('post_message', { request_id: 'rq_before', trip_id: 't_goa', text: 'Before the drop' });
    expect(f.countWrites('rq_before')).toBe(2);
    expect(f.writes.filter((w) => w.request_id === 'rq_before' && w.applied)).toHaveLength(1);
    expect(f.trip().seq).toBe(3);
  });
});

describe("answering Go's requests", () => {
  it('answers reads from the trip, 404 for a trip it does not have, and -32601 for a method it does not know', async () => {
    const { go: g, fake: f } = await setUp();
    await f.say('p_rahul', 'hi');
    expect(TripSnapshot.parse((await g.call('read_trip', { trip_id: 't_goa' })).result).seq).toBe(2);
    expect((await g.call('read_messages', { trip_id: 't_goa', after_seq: 0 })).result.messages).toHaveLength(1);
    expect((await g.call('read_trip', { trip_id: 't_nope' })).error).toMatchObject({ code: 404, data: { code: 'not_found' } });
    expect((await g.call('read_trip', {})).error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect((await g.call('add_sticker', { trip_id: 't_goa' })).error).toEqual({ code: -32601, message: 'unknown method add_sticker' });
  });

  it('does each write once per request_id: both arrivals are counted, one is applied, one event goes out', async () => {
    const { go: g, fake: f } = await setUp();
    const params = { request_id: 'rq_hello', trip_id: 't_goa', text: 'Hi all, I am Go.' };
    const first = await g.call('post_message', params);
    const second = await g.call('post_message', params);
    expect(second.result).toEqual(first.result);
    expect(f.countWrites('rq_hello')).toBe(2);
    expect(f.writes.filter((w) => w.request_id === 'rq_hello').map((w) => w.applied)).toEqual([true, false]);
    const fromGo = () => g.events.filter((e) => e.type === 'message.created' && e.data.message.author.kind === 'go');
    await f.waitFor(() => fromGo().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(fromGo()).toHaveLength(1);
    expect(f.messages().filter((m) => m.author.kind === 'go')).toHaveLength(1);
  });

  it("answers a write before it sends the write's event", async () => {
    const { go: g, fake: f } = await setUp();
    const answer = await g.call('post_message', { request_id: 'rq_order', trip_id: 't_goa', text: 'Order check' });
    await f.waitFor(() => g.events.some((e) => e.seq === answer.result.seq));
    const answerAt = g.frames.findIndex((x) => x.id === answer.id && 'result' in x);
    const eventAt = g.frames.findIndex((x) => x.method === 'send_event' && x.params.seq === answer.result.seq);
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeLessThan(eventAt);
  });

  it('answers refused writes with the contract error, records them, and changes nothing', async () => {
    const { go: g, fake: f } = await setUp();
    const seq = f.trip().seq;
    expect((await g.call('post_message', { request_id: 'rq_x', trip_id: 't_goa', text: 'hi', mentions: ['p_nobody'] })).error)
      .toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect((await g.call('add_reaction', { request_id: 'rq_y', trip_id: 't_goa', message_id: 'm_nope', emoji: '✅' })).error).toMatchObject({ code: 404 });
    const card = { card_id: 'c_once', kind: 'notice', fallback_text: 'Note', tone: 'info', title: 'Title', body: 'Body' };
    await g.call('post_message', { request_id: 'rq_c1', trip_id: 't_goa', card });
    expect((await g.call('post_message', { request_id: 'rq_c2', trip_id: 't_goa', card })).error).toMatchObject({ code: 409, data: { code: 'conflict' } });
    expect(f.writes.find((w) => w.request_id === 'rq_x')).toMatchObject({ applied: false, error: { code: 422 } });
    expect(f.trip().seq).toBe(seq + 1);
  });

  it('close_vote sends decision.closed and then record.changed, and answers the first change number', async () => {
    const { go: g, fake: f } = await setUp();
    const opened = (await g.call('open_vote', { request_id: 'rq_o', ...villaVote })).result;
    await f.vote(opened.decision_id, 'p_rahul', 0);
    const closed = (await g.call('close_vote', { request_id: 'rq_close', trip_id: 't_goa', decision_id: opened.decision_id })).result;
    await f.waitFor(() => g.events.some((e) => e.type === 'record.changed'));
    expect(g.events.slice(-2).map((e) => [e.type, e.seq])).toEqual([['decision.closed', closed.seq], ['record.changed', closed.seq + 1]]);
  });

  it("runs the pay path: the mandate, the payer's yes, an approval signed with the test key, the booking", async () => {
    const { go: g, fake: f } = await setUp();
    const opened = (await g.call('open_vote', { request_id: 'rq_o', ...villaVote })).result;
    for (const p of everyone) await f.vote(opened.decision_id, p, 0);
    expect(f.trip().decisions[0]!.status).toBe('closed');
    await g.call('set_mandate', {
      request_id: 'rq_m', trip_id: 't_goa', decision_id: opened.decision_id, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul',
    });
    expect(f.needsYou('p_rahul')).toEqual([expect.objectContaining({ kind: 'mandate' })]);
    await f.confirmMandate(opened.decision_id);
    const approved = (await g.call('request_spend_approval', {
      request_id: 'rq_s', trip_id: 't_goa', decision_id: opened.decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights',
    })).result;
    expect(approved.status).toBe('approved');
    expect(verifySpendApproval(approved.approval, TEST_SPEND_PUBLIC_KEY_PEM).ok).toBe(true);
    const booked = (await g.call('add_booking', {
      request_id: 'rq_b', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id: opened.decision_id, approval_id: approved.approval_id,
    })).result;
    expect(booked.booking_id).toBeTruthy();
  });

  it("shows Go's typing for 10 seconds, and drops a typing for a trip it does not have", async () => {
    let t = Date.parse('2026-10-05T07:00:00Z');
    const { go: g, fake: f } = await setUp({ now: () => new Date(t) });
    g.notify('typing', { trip_id: 't_goa', on: true });
    await f.waitFor(() => f.typingOn());
    // Every typing notification is in requests with its arrival time, so a test can time "Go is typing".
    expect(f.requests.filter((r) => r.method === 'typing')).toEqual([
      { method: 'typing', params: { trip_id: 't_goa', on: true }, at: '2026-10-05T07:00:00.000Z' },
    ]);
    t += 11_000;
    expect(f.typingOn()).toBe(false);
    g.notify('typing', { trip_id: 't_nope', on: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(g.frames.filter((x) => 'error' in x)).toEqual([]);
  });
});

describe('taps and events', () => {
  it("taps a Go card with a fresh tap_id each time, and returns Go's answer", async () => {
    const { go: g, fake: f } = await setUp();
    const card = {
      card_id: 'c_flights', kind: 'options', fallback_text: 'Flights', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
      options: [{ option_id: 'opt_1', title: 'IndiGo', highlights: [] }],
      actions: [{ action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true }],
    };
    expect(Card.safeParse(card).success).toBe(true);
    await g.call('post_message', { request_id: 'rq_card', trip_id: 't_goa', card });
    expect(await f.tap('c_flights', 'pick', 'p_priya', 'opt_1')).toEqual({ result: 'done', toast: 'Noted.' });
    await f.tap('c_flights', 'pick', 'p_kabir', 'opt_1');
    expect(new Set(g.taps.map((x) => x.tap_id)).size).toBe(2);
    expect(g.taps[0]).toMatchObject({ trip_id: 't_goa', card_id: 'c_flights', action_id: 'pick', person_id: 'p_priya', option_id: 'opt_1' });
    await expect(f.askGo('get_person', { person_id: 'p_kabir' })).rejects.toMatchObject({ code: -32601 });
  });

  it("sends a trip's events one at a time, and sends an unanswered one again with the same event_id", async () => {
    const { go: g, fake: f } = await setUp({ eventTimeoutMs: 150, eventRetryMs: [50] });
    g.mode = 'silent-once';
    await Promise.all([f.say('p_rahul', 'one'), f.say('p_priya', 'two')]);
    expect(g.events.slice(1).map((e) => e.seq)).toEqual([2, 2, 3]);
    expect(g.events[1].event_id).toBe(g.events[2].event_id);
    expect(f.events.find((e) => e.event.seq === 2)!.answer).toEqual({ accepted: true, duplicate: false });
  });
});
