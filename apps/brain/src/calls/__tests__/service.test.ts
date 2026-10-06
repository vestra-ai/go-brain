import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { fakeLink, fakePacks, goaPack, goaTrip, manualTime, msg, waitFor } from '../../proactive/fakes.js';
import type { TripPack } from '../../trips/pack.js';
import { loadCallsConfig } from '../config.js';
import { CallService, STOP_LINE, type CallRequest } from '../service.js';
import { CallStore } from '../store.js';
import { TwilioError, type CreateCall, type TwilioClient } from '../twilio.js';

const env = {
  GO_PUBLIC_URL: 'https://brain.test',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  TWILIO_FROM: '+14155550100',
  OPENAI_API_KEY: 'sk-test',
  CALLS_ALLOWLIST: 'Villa Sol=+919800000001',
};
const base = {
  business: 'Villa Sol',
  goal: 'Ask if we can check in at 10 am on 6 Nov',
  announce: "I'll call Villa Sol about early check-in — 10 am on the 6th.",
  factsAllowed: ['Group of five', 'Staying 6 to 9 November'],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

let db: Awaited<ReturnType<typeof withSchema>>;
let store: CallStore;
beforeAll(async () => {
  db = await withSchema();
  store = new CallStore(db.pool);
});
afterAll(async () => {
  await db.drop();
});

function make(tripId: string, o: { mode?: string; twilioFails?: boolean } = {}) {
  const time = manualTime('2026-10-06T10:00:00Z');
  const link = fakeLink();
  const values: Record<string, string> = { CALLS_MODE: o.mode ?? 'allowlist' };
  const twilioCalls: CreateCall[] = [];
  const hangUps: string[] = [];
  const twilio: TwilioClient = {
    createCall: async (p) => {
      twilioCalls.push(p);
      if (o.twilioFails) throw new TwilioError(400, 21215, 'Account not authorized to call +919800000001');
      return { sid: `CA_${tripId}` };
    },
    hangUp: async (sid) => { hangUps.push(sid); },
  };
  const pack: TripPack = goaPack({
    trip: goaTrip({ trip_id: tripId }),
    messages: [msg({ id: 'm_300', seq: 300, by: 'p_arjun', text: '@Go can you ask Villa Sol if we can check in at 10?', mentionsGo: true })],
  });
  const service = new CallService({
    store, link, packs: fakePacks(pack), switches: { get: (n: string) => values[n] ?? '' }, config: loadCallsConfig(env), twilio,
    now: time.now, schedule: time.schedule, log: { info: () => {}, warn: () => {} },
  });
  let n = 0;
  /** As the tool does: a fresh call id per new request (the turn's stableId('call')). */
  const request = (over: Partial<CallRequest> = {}) => service.request(tripId, pack, { ...base, callId: `call_${tripId}_${++n}`, ...over });
  return { time, link, values, twilioCalls, hangUps, service, pack, request };
}

async function dialed(tripId: string) {
  const m = make(tripId);
  const r = await m.request();
  if (!('ok' in r)) throw new Error('refused');
  m.time.advance(30_000);
  await m.service.tick();
  const token = /name="token" value="([^"]+)"/.exec(m.twilioCalls[0]?.twiml ?? '')?.[1] ?? '';
  return { ...m, callId: r.callId, token };
}

describe('request', () => {
  it('refuses when calls are off', async () => {
    const m = make('t_off', { mode: 'off' });
    expect(await m.request()).toEqual({ refused: 'Calls are switched off right now.' });
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses a number or a business that is not on the allowlist', async () => {
    const m = make('t_list');
    expect(await m.request({ phone: '+919999999999' })).toHaveProperty('refused');
    expect(await m.request({ business: 'Casa Azul' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses card, bank and login details, so a call can never pay', async () => {
    const m = make('t_pay');
    expect(await m.request({ factsAllowed: ["Rahul's card 4111 1111 1111 1111"] })).toHaveProperty('refused');
    expect(await m.request({ goal: 'Pay the deposit by UPI' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('says who and why with the stop line, waits 30 s, and allows one call at a time', async () => {
    const m = make('t_announce');
    const r = await m.request();
    expect(r).toEqual({ ok: true, callId: 'call_t_announce_1', dialAt: '2026-10-06T10:00:30.000Z' });
    const [announce] = m.link.of('post_message');
    expect(announce).toMatchObject({ request_id: 'go_call_t_announce_1_announce', trip_id: 't_announce', text: `I'll call Villa Sol about early check-in, 10 am on the 6th. ${STOP_LINE}` });
    expect(String(announce?.text)).not.toContain('—');
    expect(m.twilioCalls).toHaveLength(0);
    expect(await m.request()).toEqual({ refused: 'Go is already on a call for this trip. One at a time.' });
  });

  it('repeats nothing when a rerun of the same turn asks again with the same call id', async () => {
    const m = make('t_rerun');
    await m.request();
    const again = await m.service.request('t_rerun', m.pack, { ...base, callId: 'call_t_rerun_1' });
    expect(again).toMatchObject({ ok: true, callId: 'call_t_rerun_1' });
    expect(m.link.of('post_message')).toHaveLength(1);
  });
});

describe('the stop window', () => {
  it('a Hinglish stop cancels the call before it dials', async () => {
    const m = make('t_ruko');
    await m.request();
    await m.service.onMessage(msg({ id: 'm_stop', seq: 1002, by: 'p_priya', text: 'ruk jao, mat karo abhi' }), m.pack);
    expect(m.link.of('post_message').at(-1)).toMatchObject({ text: "Okay, I won't call Villa Sol.", reply_to: 'm_stop' });
    m.time.advance(30_000);
    await m.service.tick();
    // The tick dials every trip's due calls (the store is shared by these tests), so look at this trip's call only.
    expect(m.twilioCalls.filter((c) => c.statusCallback.endsWith('/call_t_ruko_1'))).toHaveLength(0);
    expect((await store.get('call_t_ruko_1'))?.state).toBe('cancelled');
  });

  it('takes a bare "nahi" only as a reply to the call line', async () => {
    const m = make('t_nahi');
    await m.request();
    await m.service.onMessage(msg({ seq: 1002, by: 'p_kabir', text: 'nahi' }), m.pack);
    expect((await m.service.liveFor('t_nahi'))?.state).toBe('waiting');
    await m.service.onMessage(msg({ seq: 1003, by: 'p_kabir', text: 'nahi', replyTo: 'm_go_1' }), m.pack);
    expect(await m.service.liveFor('t_nahi')).toBeNull();
  });

  it('a stop said before Go spoke does not count', async () => {
    const m = make('t_before');
    await m.request();
    await m.service.onMessage(msg({ seq: 900, by: 'p_priya', text: 'stop' }), m.pack);
    expect((await m.service.liveFor('t_before'))?.state).toBe('waiting');
  });

  it('switching calls off inside the window means no call', async () => {
    const m = make('t_flip');
    await m.request();
    m.values.CALLS_MODE = 'off';
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.twilioCalls).toHaveLength(0);
    expect(m.link.of('post_message').at(-1)?.text).toBe("Calls are switched off right now, so I didn't call Villa Sol.");
  });
});

describe('dialing', () => {
  it('posts the dialing card and calls through Twilio with a one-use token', async () => {
    const m = await dialed('t_dial');
    const card = m.link.of('post_message').at(-1);
    expect(card).toMatchObject({ request_id: `go_${m.callId}_card`, card: { card_id: `c_${m.callId}`, kind: 'call', call_id: m.callId, business: 'Villa Sol', state: 'dialing', actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' }] } });
    const call = m.twilioCalls[0]!;
    expect(call).toMatchObject({ to: '+919800000001', from: '+14155550100', statusCallback: `https://brain.test/calls/twilio/status/${m.callId}`, timeLimitS: 255, ringTimeoutS: 30 });
    expect(call.twiml).toContain(`<Stream url="wss://brain.test/calls/media/${m.callId}">`);
    expect(m.token.length).toBeGreaterThan(20);
    expect(await m.service.claim(m.callId, 'forged')).toBeNull();
    expect(await m.service.claim(m.callId, m.token)).toMatchObject({ business: 'Villa Sol', forWhom: 'a group of 5 friends travelling together' });
    expect(await m.service.claim(m.callId, m.token)).toBeNull();
  });

  it('turns a Twilio refusal into a failed card and one line', async () => {
    const m = make('t_refused', { twilioFails: true });
    await m.request();
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'failed', outcome: "Couldn't connect the call." } });
    expect(m.link.of('post_message').at(-1)?.text).toBe("I couldn't get through to Villa Sol.");
  });
});

describe('a call that connects', () => {
  it('updates the card at most every 3 s, then lands the outcome in the chat and the record', async () => {
    const m = await dialed('t_live');
    await m.service.claim(m.callId, m.token);
    await m.service.talking(m.callId);
    await flush();
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'talking', started_at: '2026-10-06T10:00:30.000Z' } });
    m.service.line(m.callId, { who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of 5 friends.' });
    m.service.line(m.callId, { who: 'go', text: 'So, 10 am check-in is fine — and ₹2,000 off for the deposit this week.' });
    // The card carries Go's side only (Keshav's ruling): a line from the business is dropped.
    m.service.line(m.callId, { who: 'them', text: 'Yes, that is right.' });
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(1);
    m.time.advance(3000);
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(2);
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'talking', last_line: { who: 'go', text: 'So, 10 am check-in is fine, and ₹2,000 off for the deposit this week.' } } });

    m.service.outcome(m.callId, { outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.', answered: true, record: { kind: 'open', text: '₹2,000 off at Villa Sol if we pay the deposit this week?' } });
    await m.service.ended(m.callId, 'hangup');

    const final = m.link.of('replace_card').at(-1)?.card as Record<string, unknown>;
    expect(final).toMatchObject({ state: 'ended', outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.' });
    expect((final.transcript as Array<{ who: string }>).map((l) => l.who)).toEqual(['go', 'go']);
    expect(final.actions).toBeUndefined();
    expect(m.link.of('post_message').at(-1)).toMatchObject({
      request_id: `go_${m.callId}_outcome`,
      text: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week. Rahul, want to decide on this?',
      reply_to: 'm_300',
      mentions: ['p_rahul'],
    });
    const row = await store.get(m.callId);
    expect(m.link.of('add_record_line').at(-1)).toEqual({
      request_id: `go_${m.callId}_record`,
      trip_id: 't_live',
      kind: 'open',
      text: '₹2,000 off at Villa Sol if we pay the deposit this week?',
      proof: [{ message_id: row?.cardMessageId }],
      person_ids: ['p_rahul'],
    });
    expect(row).toMatchObject({ state: 'ended', reported: true });
    expect(row?.closedOutAt).not.toBeNull();
  });

  it('says once that nobody picked up', async () => {
    const m = await dialed('t_noanswer');
    await m.service.onTwilioStatus(m.callId, 'no-answer');
    await m.service.onTwilioStatus(m.callId, 'no-answer');
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'failed', outcome: 'Nobody picked up.' } });
    expect(m.link.of('post_message').filter((p) => p.text === "Villa Sol didn't pick up. Want me to try again later?")).toHaveLength(1);
  });

  it('hangs up on the Stop button, and refuses Stop once the call has ended', async () => {
    const m = await dialed('t_tap');
    const tap = { tap_id: 'tap_1', trip_id: 't_tap', card_id: `c_${m.callId}`, action_id: 'stop', person_id: 'p_priya' };
    expect(await m.service.stopTap(tap)).toEqual({ result: 'done', toast: 'Hanging up.' });
    await waitFor(() => m.link.of('post_message').some((p) => p.text === 'Okay, I hung up on Villa Sol.'));
    expect(m.hangUps).toEqual(['CA_t_tap']);
    expect(await m.service.stopTap({ ...tap, tap_id: 'tap_2' })).toEqual({ result: 'refused', toast: 'The call has already ended.' });
  });

  it('closes a call a restart left talking', async () => {
    const m = await dialed('t_orphan');
    await m.service.claim(m.callId, m.token);
    await store.talking(m.callId, m.time.now()); // talking in the table, but no live call in this process
    m.time.advance(16_000);
    await m.service.tick();
    expect((await store.get(m.callId))?.state).toBe('ended');
    expect(m.hangUps).toEqual(['CA_t_orphan']);
    expect(m.link.of('post_message').at(-1)?.text).toBe("I called Villa Sol but didn't get an answer to that. Want me to try again?");
  });
});
