import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { manualTime, waitFor } from '../../proactive/fakes.js';
import { attachBridge, BARGE_IN_LEVEL, frameLevel, type EndReason } from '../bridge.js';
import type { CallBrief, ReportedOutcome } from '../realtime.js';
import type { CallLine } from '../store.js';

/** G.711 μ-law, as Twilio sends it: 160 bytes per 20 ms frame at 8 kHz. */
function muLaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  s = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return s;
}
function toneFrame(n: number): string {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i += 1) buf[i] = muLaw(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (n * 160 + i)) / 8000)));
  return buf.toString('base64');
}
const quiet = Buffer.alloc(160, 0xff).toString('base64'); // one 20 ms frame of μ-law silence

const brief: CallBrief = { business: 'Villa Sol', goal: 'Ask if we can check in at 10 am on 6 Nov', factsAllowed: ['Group of five', 'Staying 6 to 9 November'], forWhom: 'a group of 5 friends travelling together' };
const startFrame = (token: string) => ({ event: 'start', sequenceNumber: '1', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function setup(model = 'gpt-realtime-2.1') {
  const time = manualTime('2026-10-06T10:00:00Z');
  const voice = new WebSocketServer({ port: 0 });
  const modelGot: Array<Record<string, any>> = [];
  let modelSocket: WebSocket | null = null;
  voice.on('connection', (ws) => {
    modelSocket = ws;
    ws.on('message', (data) => modelGot.push(JSON.parse(data.toString()) as Record<string, any>));
  });
  const voiceUrl = `ws://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  const seen = { talking: [] as string[], lines: [] as CallLine[], outcomes: [] as ReportedOutcome[], ended: [] as EndReason[], hangUps: [] as string[] };

  const bridgeServer = new WebSocketServer({ port: 0 });
  bridgeServer.on('connection', (ws) =>
    attachBridge(ws, 'call_1', {
      claim: async (_id, token) => (token === 'tok' ? brief : null),
      openVoice: () => new WebSocket(voiceUrl),
      hangUp: async (id) => { seen.hangUps.push(id); },
      hooks: {
        talking: async (id) => { seen.talking.push(id); },
        line: (_id, line) => { seen.lines.push(line); },
        outcome: (_id, o) => { seen.outcomes.push(o); },
        ended: async (_id, reason) => { seen.ended.push(reason); },
      },
      schedule: time.schedule,
      capMs: 240_000,
      session: { model, voice: 'marin' },
      log: { warn: () => {} },
    }),
  );
  const twilio = new WebSocket(`ws://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`);
  const twilioGot: Array<Record<string, any>> = [];
  let closedWith: number | null = null;
  twilio.on('message', (data) => twilioGot.push(JSON.parse(data.toString()) as Record<string, any>));
  twilio.on('close', (code) => { closedWith = code; });
  await new Promise((resolve) => twilio.once('open', resolve));
  cleanups.push(() => { twilio.terminate(); voice.close(); bridgeServer.close(); });
  return {
    time, seen, modelGot, twilioGot,
    send: (frame: object) => twilio.send(JSON.stringify(frame)),
    fromModel: (event: object) => modelSocket?.send(JSON.stringify(event)),
    modelSocket: () => modelSocket,
    closedWith: () => closedWith,
  };
}

describe('frameLevel', () => {
  it('reads silence as 0 and a spoken-level tone well above the barge-in level', () => {
    expect(frameLevel(quiet)).toBe(0);
    expect(frameLevel(toneFrame(0))).toBeGreaterThan(BARGE_IN_LEVEL * 2);
  });
});

describe('attachBridge on gpt-realtime-2.1 (the default)', () => {
  it('bridges μ-law both ways with no transcriber, clears on barge-in, keeps Go\'s lines only and hangs up after the goodbye', async () => {
    const s = await setup();
    s.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    s.send(startFrame('tok'));
    await waitFor(() => s.seen.talking.length === 1 && s.modelGot.some((e) => e.type === 'session.update'));
    const update = s.modelGot.find((e) => e.type === 'session.update')!;
    expect(update.session.model).toBe('gpt-realtime-2.1');
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(update.session.audio.output.format).toEqual({ type: 'audio/pcmu' });
    // No second ear: the session never asks for a transcript of the business.
    expect(update.session.audio.input).not.toHaveProperty('transcription');
    expect(JSON.stringify(update)).not.toMatch(/transcri/i);
    expect(update.session.tools[0].name).toBe('report_outcome');
    expect(update.session.instructions).toContain('an AI assistant');
    expect(update.session.instructions).toContain('Never pay');
    expect(update.session.instructions).not.toMatch(/openai|gpt/i);

    s.fromModel({ type: 'response.created', response: { id: 'resp_1' } });
    s.fromModel({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'item_1', delta: toneFrame(0) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'media'));
    expect(s.twilioGot.find((f) => f.event === 'media')).toEqual({ event: 'media', streamSid: 'MZ1', media: { payload: toneFrame(0) } });
    expect(s.twilioGot.some((f) => f.event === 'mark')).toBe(false); // marks are for the Live wire only

    const frames = [10, 11, 12].map(toneFrame);
    frames.forEach((payload, i) => s.send({ event: 'media', sequenceNumber: String(i + 2), streamSid: 'MZ1', media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload } }));
    await waitFor(() => s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').length === 3);
    expect(s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').map((e) => e.audio)).toEqual(frames);

    s.fromModel({ type: 'input_audio_buffer.speech_started', audio_start_ms: 40, item_id: 'item_2' });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'clear') && s.modelGot.some((e) => e.type === 'conversation.item.truncate'));
    expect(s.twilioGot.find((f) => f.event === 'clear')).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(s.modelGot.find((e) => e.type === 'conversation.item.truncate')).toMatchObject({ item_id: 'item_1', content_index: 0, audio_end_ms: 40 });

    s.fromModel({ type: 'response.output_audio_transcript.done', item_id: 'item_1', transcript: 'Hi, this is Go, an AI assistant calling for a group of five.' });
    // Even if an account sent a transcript of the business, it would never reach the card.
    s.fromModel({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: 'Yes, check-in at 10 is fine.' });
    await waitFor(() => s.seen.lines.length === 1);

    s.fromModel({
      type: 'response.function_call_arguments.done', response_id: 'resp_3', item_id: 'item_3', call_id: 'fc_1', name: 'report_outcome',
      arguments: JSON.stringify({ outcome: 'Check-in at 10 am is fine.', answered: true, record: { kind: 'agreed', text: 'Early check-in at 10 am at Villa Sol is fine' } }),
    });
    await waitFor(() => s.seen.outcomes.length === 1 && s.modelGot.some((e) => e.type === 'conversation.item.create'));
    expect(s.modelGot.find((e) => e.type === 'conversation.item.create')).toMatchObject({ item: { type: 'function_call_output', call_id: 'fc_1' } });
    expect(s.seen.outcomes[0]).toMatchObject({ outcome: 'Check-in at 10 am is fine.', record: { kind: 'agreed' } });
    expect(s.seen.lines).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of five.' }]);

    s.fromModel({ type: 'response.done', response: { id: 'resp_3' } });
    s.fromModel({ type: 'response.created', response: { id: 'resp_4' } });
    s.fromModel({ type: 'response.done', response: { id: 'resp_4' } });
    await waitFor(() => s.time.pending() === 5); // greet, wrap-up, cap, report fallback, goodbye
    s.time.advance(2_500);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
  });

  it('refuses a media connection with the wrong token and ends nothing', async () => {
    const s = await setup();
    s.send(startFrame('forged'));
    await waitFor(() => s.closedWith() !== null);
    expect(s.closedWith()).toBe(1008);
    expect(s.seen.talking).toEqual([]);
    expect(s.seen.ended).toEqual([]);
    expect(s.modelSocket()).toBeNull();
  });

  it('speaks first when nobody says hello, wraps up near the cap and hangs up at 4 minutes', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.time.advance(4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'response.create'));
    s.time.advance(240_000 - 20_000 - 4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'conversation.item.create'));
    expect(JSON.stringify(s.modelGot.find((e) => e.type === 'conversation.item.create'))).toContain('Time is nearly up');
    s.time.advance(20_000);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['cap']);
  });

  it('ends when the business hangs up, without hanging up again', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.send({ event: 'stop', streamSid: 'MZ1', stop: { callSid: 'CA1' } });
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
    expect(s.seen.hangUps).toEqual([]);
  });

  it('hangs up when the voice model drops', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.modelSocket()?.terminate();
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['error']);
    expect(s.seen.hangUps).toEqual(['call_1']);
  });
});

describe('attachBridge on gpt-live-1 (the day-one A/B)', () => {
  it('starts a Live session with no transcriber, clears Go on loud audio while it still plays, and keeps Go\'s lines only', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));
    const start = s.modelGot.find((e) => e.type === 'session.start')!;
    expect(start.session).toMatchObject({ model: 'gpt-live-1', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } }, delegation: { type: 'client' } });
    expect(JSON.stringify(start)).not.toMatch(/transcri/i);
    expect(start.session.instructions).toContain('starts with "So,"');
    expect(start.session.instructions).not.toMatch(/openai|gpt/i);

    // Go speaks: each chunk of its audio goes to Twilio followed by a mark.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Hi, this is Go, ' });
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'an AI assistant calling for a group of five.' });
    s.fromModel({ type: 'session.output_audio.delta', delta: toneFrame(0) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'mark'));
    expect(s.twilioGot).toEqual([
      { event: 'media', streamSid: 'MZ1', media: { payload: toneFrame(0) } },
      { event: 'mark', streamSid: 'MZ1', mark: { name: 'go_1' } },
    ]);

    // Quiet frames from the business clear nothing; three loud ones while Go's audio still plays clear it.
    [quiet, quiet, quiet].forEach((payload, i) => s.send({ event: 'media', streamSid: 'MZ1', media: { timestamp: String(i * 20), payload } }));
    await waitFor(() => s.modelGot.filter((e) => e.type === 'session.input_audio.append').length === 3);
    expect(s.twilioGot.some((f) => f.event === 'clear')).toBe(false);
    [10, 11, 12].map(toneFrame).forEach((payload, i) => s.send({ event: 'media', streamSid: 'MZ1', media: { timestamp: String(60 + i * 20), payload } }));
    await waitFor(() => s.twilioGot.some((f) => f.event === 'clear'));
    expect(s.twilioGot.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    await waitFor(() => s.modelGot.filter((e) => e.type === 'session.input_audio.append').length === 6);

    // The business talks: Go's line is over and kept; their words are not.
    s.fromModel({ type: 'session.input_transcript.delta', delta: 'Yes, 10 is fine.', start_ms: 3000, end_ms: 4200 });
    await waitFor(() => s.seen.lines.length === 1);
    expect(s.seen.lines).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of five.' }]);
  });

  it('takes Go\'s read-back as the outcome, answers every hand-off, and hangs up once the goodbye has played', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));

    // A hand-off that is not a read-back is answered, and is not an outcome.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Could you hold on a moment?' });
    s.fromModel({ type: 'session.delegation.created', delegation: { id: 'dl_1', target: 'client' }, offset_ms: 5000 });
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.thinking.append'));
    expect(s.modelGot.find((e) => e.type === 'session.thinking.append')).toMatchObject({ delegation_id: 'dl_1' });
    expect(s.seen.outcomes).toEqual([]);

    s.fromModel({ type: 'session.output_transcript.delta', delta: 'So, check-in at 10 am ' });
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'on the 6th is fine.' });
    s.fromModel({ type: 'session.delegation.created', delegation: { id: 'dl_2', target: 'client' }, offset_ms: 9000 });
    await waitFor(() => s.seen.outcomes.length === 1 && s.modelGot.filter((e) => e.type === 'session.thinking.append').length === 2);
    expect(s.seen.outcomes[0]).toEqual({ outcome: 'Check-in at 10 am on the 6th is fine.', answered: true, record: null });
    expect(s.modelGot.filter((e) => e.type === 'session.thinking.append').at(-1)).toMatchObject({ delegation_id: 'dl_2', content: 'Noted. Now thank them and say goodbye.' });

    // The goodbye plays; once Twilio echoes its mark, Go hangs up 2.5 s later.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Thank you so much, goodbye!' });
    s.fromModel({ type: 'session.output_audio.delta', delta: toneFrame(1) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'mark'));
    const mark = s.twilioGot.find((f) => f.event === 'mark')!;
    s.send({ event: 'mark', streamSid: 'MZ1', mark: mark.mark });
    await waitFor(() => s.time.pending() === 5); // greet, wrap-up, cap, report fallback, goodbye
    s.time.advance(2_500);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
    expect(s.seen.lines).toEqual([
      { who: 'go', text: 'Could you hold on a moment?' },
      { who: 'go', text: 'So, check-in at 10 am on the 6th is fine.' },
      { who: 'go', text: 'Thank you so much, goodbye!' },
    ]);
  });

  it('says its greeting first when nobody says hello', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));
    s.time.advance(4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.commentary.append'));
    expect(s.modelGot.find((e) => e.type === 'session.commentary.append')).toMatchObject({
      delegation_id: null,
      content: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.',
    });
  });
});
