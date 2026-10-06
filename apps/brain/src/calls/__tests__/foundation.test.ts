import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { findCallee, loadCallsConfig, maskPhone, mediaUrl, normalisePhone, parseAllowlist, statusUrl, voiceKind } from '../config.js';
import { CallsEnv } from '../env.js';
import { saysStop } from '../stop-words.js';
import { CallStore, type NewCall } from '../store.js';

describe('config', () => {
  it('reads phone numbers in E.164 only', () => {
    expect(normalisePhone('+91 98000-00001')).toBe('+919800000001');
    expect(normalisePhone('0091 98000 00001')).toBe('+919800000001');
    expect(normalisePhone('9800000001')).toBeNull();
    expect(normalisePhone('+0123')).toBeNull();
  });

  it('parses the allowlist with optional names and skips junk', () => {
    expect(parseAllowlist('Villa Sol=+91 98000 00001, +14155550100, nonsense, Kabir Cabs=0091-9800000002,')).toEqual([
      { name: 'Villa Sol', phone: '+919800000001' },
      { name: null, phone: '+14155550100' },
      { name: 'Kabir Cabs', phone: '+919800000002' },
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('finds a callee by name or by number, and nothing off the list', () => {
    const cfg = { allowlist: parseAllowlist('Villa Sol=+919800000001,+14155550100') };
    expect(findCallee(cfg, { business: 'villa sol' })).toEqual({ name: 'Villa Sol', phone: '+919800000001' });
    expect(findCallee(cfg, { business: 'Anyone', phone: '+1 415 555 0100' })).toEqual({ name: null, phone: '+14155550100' });
    expect(findCallee(cfg, { business: 'Villa Sol', phone: '+919999999999' })).toBeNull();
    expect(findCallee(cfg, { business: 'Casa Azul' })).toBeNull();
  });

  it('says what is missing, and builds the public URLs', () => {
    const cfg = loadCallsConfig({ GO_PUBLIC_URL: 'https://brain.test/', TWILIO_ACCOUNT_SID: 'ACx', CALLS_ALLOWLIST: '+919800000001' });
    expect(cfg.missing).toEqual(['TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'OPENAI_API_KEY']);
    expect(cfg.publicUrl).toBe('https://brain.test');
    expect(statusUrl('https://brain.test', 'call_1')).toBe('https://brain.test/calls/twilio/status/call_1');
    expect(mediaUrl('https://brain.test', 'call_1')).toBe('wss://brain.test/calls/media/call_1');
    expect(maskPhone('+919800000001')).toBe('+91***001');
  });

  it('picks the voice model: gpt-realtime-2.1 unless the day-one A/B says gpt-live-1, and never a transcriber', () => {
    expect(loadCallsConfig({}).voiceModel).toBe('gpt-realtime-2.1');
    expect(loadCallsConfig({ CALLS_VOICE_MODEL: 'gpt-live-1' }).voiceModel).toBe('gpt-live-1');
    expect(loadCallsConfig({ CALLS_VOICE_MODEL: 'gpt-4o-mini-transcribe' }).voiceModel).toBe('gpt-realtime-2.1');
    expect(voiceKind('gpt-realtime-2.1')).toBe('realtime');
    expect(voiceKind('gpt-live-1')).toBe('live');
    expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: 'gpt-live-1' }).success).toBe(true);
    expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: 'gpt-realtime-2.1-mini' }).success).toBe(true);
    for (const m of ['gpt-4o-mini-transcribe', 'gpt-realtime-transcribe', 'whisper-1']) {
      expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: m }).success, m).toBe(false);
    }
  });
});

describe('saysStop', () => {
  it('hears stop in English and Hinglish', () => {
    for (const t of ['stop', 'STOP!!', 'Go ruko', 'ruk jao bhai', 'band karo', 'mat karo yaar', "don't call them", 'wait, hold on']) {
      expect(saysStop(t, false), t).toBe(true);
    }
  });
  it('takes a bare no only as a reply to the call line', () => {
    expect(saysStop('nahi', true)).toBe(true);
    expect(saysStop('no', true)).toBe(true);
    expect(saysStop('nahi', false)).toBe(false);
  });
  it('does not stop for ordinary chat', () => {
    for (const t of ['sounds good', 'non-stop flight hai kya?', 'nonstop party in Goa', 'ok cool', null, '']) {
      expect(saysStop(t, false), String(t)).toBe(false);
    }
  });
});

describe('CallStore', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: CallStore;
  const at = new Date('2026-10-06T10:00:00Z');
  const call = (over: Partial<NewCall> = {}): NewCall => ({
    callId: 'call_1', tripId: 't_goa', business: 'Villa Sol', phone: '+919800000001', goal: 'Ask if we can check in at 10 am',
    factsAllowed: ['Group of five', 'Staying 6 to 9 November'], forWhom: 'a group of 5 friends travelling together',
    askedByPersonId: 'p_arjun', askedMessageId: 'm_300', cardId: 'c_call_1', dialAt: new Date(at.getTime() + 30_000), ...over,
  });
  beforeAll(async () => {
    db = await withSchema();
    store = new CallStore(db.pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  it('moves through its states once each', async () => {
    const row = await store.create(call());
    expect(row).toMatchObject({ state: 'waiting', business: 'Villa Sol', factsAllowed: ['Group of five', 'Staying 6 to 9 November'], transcript: [] });
    expect((await store.liveFor('t_goa'))?.callId).toBe('call_1');
    await store.announced('call_1', 'm_go_1', 301, new Date(at.getTime() + 30_000));
    expect((await store.get('call_1'))?.announceSeq).toBe(301);

    expect(await store.dueToDial(at)).toEqual([]);
    expect((await store.dueToDial(new Date(at.getTime() + 30_000))).map((r) => r.callId)).toEqual(['call_1']);
    expect((await store.startDialing('call_1'))?.state).toBe('dialing');
    expect(await store.startDialing('call_1')).toBeNull();
    expect(await store.cancel('call_1', 'too_late', at)).toBeNull();

    await store.dialInfo('call_1', { cardMessageId: 'm_go_2', tokenHash: 'h1' });
    await store.dialInfo('call_1', { twilioSid: 'CA1' });
    expect(await store.get('call_1')).toMatchObject({ cardMessageId: 'm_go_2', twilioSid: 'CA1' });
    expect((await store.byCard('t_goa', 'c_call_1'))?.callId).toBe('call_1');

    expect(await store.claimMedia('call_1', 'wrong')).toBeNull();
    expect((await store.claimMedia('call_1', 'h1'))?.callId).toBe('call_1');
    expect(await store.claimMedia('call_1', 'h1')).toBeNull();

    expect((await store.talking('call_1', at))?.state).toBe('talking');
    expect((await store.inCall()).map((r) => r.callId)).toEqual(['call_1']);
    const ended = await store.end('call_1', { state: 'ended', at, outcome: '10 am is fine.', reported: true, record: { kind: 'agreed', text: 'Check-in at 10 am is fine' }, transcript: [{ who: 'go', text: 'So, check-in at 10 am is fine. Thank you!' }], reason: 'hangup' });
    expect(ended).toMatchObject({ state: 'ended', reported: true, record: { kind: 'agreed' }, transcript: [{ who: 'go', text: 'So, check-in at 10 am is fine. Thank you!' }] });
    expect(await store.end('call_1', { state: 'failed', at, outcome: 'x', reported: false, record: null, transcript: [], reason: 'busy' })).toBeNull();

    expect((await store.toCloseOut(new Date(at.getTime() + 1000))).map((r) => r.callId)).toEqual(['call_1']);
    await store.closedOut('call_1', at, 'r_9');
    expect(await store.toCloseOut(new Date(at.getTime() + 1000))).toEqual([]);
    expect(await store.liveFor('t_goa')).toBeNull();
  });

  it('cancels a waiting call once and remembers it for a while', async () => {
    await store.create(call({ callId: 'call_2', cardId: 'c_call_2' }));
    expect((await store.cancel('call_2', 'stopped_by:p_priya', at))?.state).toBe('cancelled');
    expect(await store.cancel('call_2', 'again', at)).toBeNull();
    expect((await store.recentlyCancelled('t_goa', new Date(at.getTime() - 60_000)))?.callId).toBe('call_2');
    expect(await store.recentlyCancelled('t_goa', new Date(at.getTime() + 60_000))).toBeNull();
  });
});
