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

function make(tripId: string, o: { mode?: string; twilioFails?: boolean; placing?: Promise<void> } = {}) {
  const time = manualTime('2026-10-06T10:00:00Z');
  const link = fakeLink();
  const values: Record<string, string> = { CALLS_MODE: o.mode ?? 'allowlist' };
  const twilioCalls: CreateCall[] = [];
  const hangUps: string[] = [];
  const logs: string[] = [];
  const twilio: TwilioClient = {
    createCall: async (p) => {
      twilioCalls.push(p);
      if (o.placing) await o.placing;
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
    now: time.now, schedule: time.schedule,
    log: { info: (obj: object, m: string) => { logs.push(`${m} ${JSON.stringify(obj)}`); }, warn: (obj: object, m: string) => { logs.push(`${m} ${JSON.stringify(obj)}`); } },
  });
  let n = 0;
  /** As the tool does: a fresh call id per new request (the turn's stableId('call')). */
  const request = (over: Partial<CallRequest> = {}) => service.request(tripId, pack, { ...base, callId: `call_${tripId}_${++n}`, ...over });
  return { time, link, values, twilioCalls, hangUps, service, pack, request, logs };
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

  it('counts card digits however they are written, and screens the business name too', async () => {
    const m = make('t_digits');
    for (const fact of ['card 4111.1111.1111.1111', 'card 4111  1111  1111  1111', '4111/1111/1111/1111', 'call me on +91 98000 00001']) {
      expect(await m.request({ factsAllowed: [fact] }), fact).toHaveProperty('refused');
    }
    expect(await m.request({ business: 'Villa Sol, card 4111 1111 1111 1111' })).toHaveProperty('refused');
    expect(await m.request({ business: 'HDFC bank' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
    expect(await m.request({ factsAllowed: ['Staying 6 to 9 November', 'Group of 5, 2 rooms'] })).toMatchObject({ ok: true });
  });

  it("names the business the way the allowlist does, whatever the model wrote", async () => {
    const byName = make('t_name');
    const a = await byName.request({ business: 'villa sol' });
    if (!('ok' in a)) throw new Error('refused');
    expect((await store.get(a.callId))?.business).toBe('Villa Sol');
    const byNumber = make('t_number');
    const b = await byNumber.request({ business: 'the villa', phone: '+91 98000 00001' });
    if (!('ok' in b)) throw new Error('refused');
    expect((await store.get(b.callId))?.business).toBe('Villa Sol');
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

describe('the 30 seconds can never be skipped, and a stop is never lost', () => {
  const dialedFor = (m: { twilioCalls: CreateCall[] }, callId: string) => m.twilioCalls.filter((c) => c.statusCallback.endsWith(`/${callId}`));

  it('starts the 30 s when Go\'s line is in the room, however slow posting it was', async () => {
    const m = make('t_slow');
    const post = m.link.request.bind(m.link);
    m.link.request = (async (method: string, params: Record<string, unknown>) => {
      if (method === 'post_message' && String(params.request_id).endsWith('_announce')) m.time.advance(20_000);
      return post(method, params);
    }) as typeof m.link.request;
    expect(await m.request()).toMatchObject({ ok: true, callId: 'call_t_slow_1', dialAt: '2026-10-06T10:00:50.000Z' });
    m.time.advance(10_000); // 30 s after Go was asked, but only 10 s after its line landed
    await m.service.tick();
    expect(dialedFor(m, 'call_t_slow_1')).toHaveLength(0);
    m.time.advance(20_000);
    await m.service.tick();
    expect(dialedFor(m, 'call_t_slow_1')).toHaveLength(1);
  });

  it('never dials a call whose line did not reach the room; a rerun of the turn posts the line and starts the 30 s then', async () => {
    const m = make('t_crash');
    // The turn crashed after it stored the call and before Go's line went out.
    await store.create({
      callId: 'call_t_crash_9', tripId: 't_crash', business: 'Villa Sol', phone: '+919800000001', goal: 'Ask about check-in', factsAllowed: [],
      forWhom: 'a group of 5 friends travelling together', askedByPersonId: null, askedMessageId: null, cardId: 'c_call_t_crash_9',
      dialAt: new Date(m.time.now().getTime() + 30_000),
    });
    m.time.advance(30_000);
    await m.service.tick();
    expect(dialedFor(m, 'call_t_crash_9')).toHaveLength(0);
    expect(await m.service.request('t_crash', m.pack, { ...base, callId: 'call_t_crash_9' })).toMatchObject({ ok: true, dialAt: '2026-10-06T10:01:00.000Z' });
    expect(m.link.of('post_message')).toHaveLength(1);
    m.time.advance(30_000);
    await m.service.tick();
    expect(dialedFor(m, 'call_t_crash_9')).toHaveLength(1);
  });

  it('calls off a call whose line never went out, a minute after it was asked for, and says nothing', async () => {
    const m = make('t_lost');
    await store.create({
      callId: 'call_t_lost_1', tripId: 't_lost', business: 'Villa Sol', phone: '+919800000001', goal: 'Ask about check-in', factsAllowed: [],
      forWhom: 'a group of 5 friends travelling together', askedByPersonId: null, askedMessageId: null, cardId: 'c_call_t_lost_1',
      dialAt: new Date(m.time.now().getTime() + 30_000),
    });
    m.time.advance(61_000);
    await m.service.tick();
    expect(await store.get('call_t_lost_1')).toMatchObject({ state: 'cancelled', endReason: 'not_announced' });
    expect(m.link.of('post_message')).toHaveLength(0);
  });

  it('looks at the room once more before dialing: a stop the message hook missed calls it off', async () => {
    const m = make('t_missed');
    await m.request();
    m.pack.messages.push(msg({ id: 'm_missed', seq: 1003, by: 'p_kabir', text: 'band karo' }));
    m.time.advance(30_000);
    await m.service.tick();
    expect(dialedFor(m, 'call_t_missed_1')).toHaveLength(0);
    expect(m.link.of('post_message').at(-1)).toMatchObject({ text: "Okay, I won't call Villa Sol.", reply_to: 'm_missed' });
  });

  it('a stop sent inside the window that reaches Go after dialing began still hangs up; one sent after it does not', async () => {
    const m = await dialed('t_late_stop');
    await m.service.onMessage(msg({ id: 'm_after', seq: 1500, by: 'p_priya', text: 'stop', sentAt: '2026-10-06T10:00:40Z' }), m.pack);
    expect((await store.get(m.callId))?.state).toBe('dialing');
    await m.service.onMessage(msg({ id: 'm_late', seq: 1501, by: 'p_priya', text: 'ruko!', sentAt: '2026-10-06T10:00:20Z' }), m.pack);
    await waitFor(() => m.link.of('post_message').some((p) => p.text === 'Okay, I hung up on Villa Sol.'));
    expect(m.hangUps).toEqual(['CA_t_late_stop']);
    expect((await store.get(m.callId))?.state).toBe('ended');
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

  it('a Stop while Twilio is still placing the call hangs it up as soon as its sid is known', async () => {
    let placed = (): void => {};
    const m = make('t_early_stop', { placing: new Promise<void>((resolve) => { placed = resolve; }) });
    const r = await m.request();
    if (!('ok' in r)) throw new Error('refused');
    m.time.advance(30_000);
    const ticking = m.service.tick();
    await waitFor(() => m.twilioCalls.some((c) => c.statusCallback.endsWith(`/${r.callId}`)));
    const tap = { tap_id: 'tap_early', trip_id: 't_early_stop', card_id: `c_${r.callId}`, action_id: 'stop', person_id: 'p_priya' };
    expect(await m.service.stopTap(tap)).toEqual({ result: 'done', toast: 'Hanging up.' });
    await waitFor(() => m.link.of('post_message').some((p) => p.text === 'Okay, I hung up on Villa Sol.'));
    expect(m.hangUps).toEqual([]); // no sid yet
    placed();
    await ticking;
    expect(m.hangUps).toEqual(['CA_t_early_stop']);
    expect((await store.get(r.callId))?.state).toBe('ended');
  });

  it('measures "nobody picked up" from when the call was placed, not from when the window ended', async () => {
    const m = make('t_slow_place');
    const r = await m.request();
    if (!('ok' in r)) throw new Error('refused');
    m.time.advance(90_000); // the tick runs a minute late: the call is placed at 10:01:30, a minute after its dial time
    await m.service.tick();
    expect((await store.get(r.callId))?.placedAt?.toISOString()).toBe('2026-10-06T10:01:30.000Z');
    m.time.advance(40_000); // 100 s after the dial time, 40 s after it was placed
    await m.service.tick();
    expect((await store.get(r.callId))?.state).toBe('dialing');
    m.time.advance(60_000); // 100 s after it was placed
    await m.service.tick();
    expect(await store.get(r.callId)).toMatchObject({ state: 'failed', endReason: 'no_answer' });
  });

  it('turns a Twilio refusal into a failed card and one line', async () => {
    const m = make('t_refused', { twilioFails: true });
    await m.request();
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'failed', outcome: "Couldn't connect the call." } });
    expect(m.link.of('post_message').at(-1)?.text).toBe("I couldn't get through to Villa Sol.");
    // Twilio's error names the number it could not call; the logs never carry it whole.
    expect(m.logs.some((l) => l.includes('Twilio refused the call') && l.includes('+91***001'))).toBe(true);
    expect(m.logs.join('\n')).not.toContain('9800000001');
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
    // By design, the card carries Go's side only: a line from the business is dropped.
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
