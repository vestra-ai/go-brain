import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { withSchema } from '../../db/test-db.js';
import { fakeBrain, goaPack, goaTrip, manualTime, msg, turnCtx, waitFor } from '../../proactive/fakes.js';
import { createTools } from '../../composer/tools.js';
import { CallStore } from '../store.js';
import { startCalls } from '../register.js';

const env = {
  GO_PUBLIC_URL: 'https://brain.test',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  TWILIO_FROM: '+14155550100',
  OPENAI_API_KEY: 'sk-test',
  CALLS_ALLOWLIST: 'Villa Sol=+919800000001',
};
const silence = Buffer.alloc(160, 0xff).toString('base64'); // one 20 ms frame of μ-law silence

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

/** A scripted gpt-realtime-2.1: Go greets, then reports the outcome. It never sends a transcript of the business. */
function fakeModel() {
  const server = new WebSocketServer({ port: 0 });
  const got: Array<Record<string, any>> = [];
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const ev = JSON.parse(data.toString()) as { type: string; item?: { type?: string } };
      got.push(ev);
      if (ev.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'i1', transcript: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.' }));
        ws.send(JSON.stringify({
          type: 'response.function_call_arguments.done', call_id: 'fc_1', name: 'report_outcome',
          arguments: JSON.stringify({ outcome: 'Check-in at 10 am on 6 Nov is fine.', answered: true, record: { kind: 'agreed', text: 'Villa Sol: check-in at 10 am on 6 Nov is fine' } }),
        }));
      }
      if (ev.type === 'conversation.item.create' && ev.item?.type === 'function_call_output') {
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_bye' } }));
        ws.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_bye' } }));
      }
    });
  });
  return { server, got, url: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('startCalls', () => {
  it('registers the tool, the stop hook, the Stop button, the media path with the door and the "Go can phone" block', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' } });
    const h = await startCalls(brain, { intervals: false, schedule: time.schedule });
    expect(reg.tools.map((t) => t.name)).toEqual(['call_business']);
    expect(reg.tools[0]!.offered?.()).toBe(true);
    expect(reg.onRead).toHaveLength(1);
    expect(reg.taps.has('call:stop')).toBe(true);
    expect(reg.upgrades).toHaveLength(1);
    expect(reg.upgrades[0]!.path.test('/calls/media/call_turn_1_1')).toBe(true);
    expect(reg.upgrades[0]!.path.test('/v1/socket')).toBe(false);
    expect(reg.stops).toHaveLength(1); // the tick stops when Go stops
    const block = await reg.nows.find((n) => n.name === 'calls')!.render('t_goa', []);
    expect(block).toContain('Go can phone (call_business with the name): Villa Sol.');
    expect(block).not.toContain('+91');
    h.stop();
  });

  // Prod, 10 Oct: calls were unset, yet the tool ("a cab about a pickup") was offered; Go offered to call a local cab
  // operator, and "yes call" placed nothing. The tool is offered only when a call can really go out.
  it('offers call_business only when a call can go out: every setting, a named business, and the switch on', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const blockOf = (reg: ReturnType<typeof fakeBrain>['reg']) => reg.nows.find((n) => n.name === 'calls')!.render('t_goa', []);
    // Not set up: a setting missing, or no business with a name. Never offered, and no "Go can phone" block.
    for (const e of [{ ...env, TWILIO_AUTH_TOKEN: '' }, { ...env, CALLS_ALLOWLIST: '' }, { ...env, CALLS_ALLOWLIST: '+919800000001' }]) {
      const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env: e, switches: { CALLS_MODE: 'allowlist' } });
      const h = await startCalls(brain, { intervals: false, schedule: time.schedule });
      expect(reg.tools).toEqual([]);
      expect(await blockOf(reg)).toBeNull();
      h.stop();
    }
    // Set up, with the switch off: left out of the turn's tools until the switch goes on, read every turn.
    const { brain, reg, switches } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'off' } });
    const h = await startCalls(brain, { intervals: false, schedule: time.schedule });
    const tools = createTools();
    for (const t of reg.tools) tools.register(t);
    expect(tools.list().map((t) => t.name)).toEqual([]);
    expect(await blockOf(reg)).toBeNull();
    await switches.set('CALLS_MODE', 'allowlist');
    expect(tools.list().map((t) => t.name)).toEqual(['call_business']);
    expect(await blockOf(reg)).toContain('Go can phone (call_business with the name): Villa Sol.');
    h.stop();
  });

  it('refuses to start, loudly, when the door cannot hand it the media socket', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' } });
    delete (brain.door as { onUpgrade?: unknown }).onUpgrade;
    await expect(startCalls(brain, { intervals: false, schedule: time.schedule })).rejects.toThrow(/onUpgrade/);
    expect(reg.tools).toEqual([]);
    expect(reg.taps.size).toBe(0);
  });

  it('runs a whole call: the line, the wait, the dial, the live card with Go\'s side, the outcome and the record', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const pack = goaPack({ messages: [msg({ id: 'm_300', seq: 300, by: 'p_arjun', text: '@Go ask the villa if we can check in at 10', mentionsGo: true })] });
    const { brain, app, reg, link } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' }, pack });
    const model = fakeModel();
    const twilioReqs: Array<{ url: string; form: URLSearchParams }> = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      twilioReqs.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
      return new Response(JSON.stringify({ sid: 'CA_e2e', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const h = await startCalls(brain, { intervals: false, fetch: fetchFake, openVoice: () => new WebSocket(model.url()), schedule: time.schedule });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    // 1. The composer calls the tool; Go says who and why.
    const tool = reg.tools.find((t) => t.name === 'call_business')!;
    const out = (await tool.run(
      tool.input.parse({ business: 'Villa Sol', goal: 'Ask if we can check in at 10 am on 6 Nov', announce: "I'll call Villa Sol about early check-in.", facts_allowed: ['Group of five', 'Staying 6 to 9 November'] }),
      turnCtx({ link, pack, wake: [] }),
    )) as { ok: boolean; call_id: string };
    expect(out.ok).toBe(true);
    const callId = out.call_id;
    expect(link.of('post_message')[0]?.text).toBe("I'll call Villa Sol about early check-in. Say stop in the next 30 seconds if you'd rather I didn't.");
    expect(await reg.nows.find((n) => n.name === 'calls')!.render('t_goa', [])).toContain('waiting 30 seconds');

    // 2. Nobody says stop: after 30 s Go dials.
    time.advance(30_000);
    await h.tick();
    expect(twilioReqs[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json');
    const token = /name="token" value="([^"]+)"/.exec(twilioReqs[0]?.form.get('Twiml') ?? '')?.[1] ?? '';

    // 3. Twilio connects the media stream through the door; the voice model talks; the card goes live.
    const twilio = new WebSocket(`ws://127.0.0.1:${port}/calls/media/${callId}`);
    await new Promise((resolve) => twilio.once('open', resolve));
    twilio.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    twilio.send(JSON.stringify({ event: 'start', streamSid: 'MZ_e2e', start: { streamSid: 'MZ_e2e', callSid: 'CA_e2e', customParameters: { token } } }));
    twilio.send(JSON.stringify({ event: 'media', streamSid: 'MZ_e2e', media: { timestamp: '0', payload: silence } }));
    await waitFor(() => link.of('replace_card').some((p) => (p.card as { state?: string }).state === 'talking'));
    // The default voice model, and no transcriber on it.
    await waitFor(() => model.got.some((e) => e.type === 'session.update'));
    const update = model.got.find((e) => e.type === 'session.update')!;
    expect(update.session.model).toBe('gpt-realtime-2.1');
    expect(JSON.stringify(update)).not.toMatch(/transcri/i);

    // 4. After report_outcome and the goodbye, Go hangs up through Twilio; Twilio closes the stream.
    await waitFor(() => {
      time.advance(500);
      return twilioReqs.some((r) => r.url.endsWith('/Calls/CA_e2e.json'));
    });
    expect(twilioReqs.find((r) => r.url.endsWith('/Calls/CA_e2e.json'))?.form.get('Status')).toBe('completed');
    twilio.close();

    // 5. The final card holds Go's side and the outcome; the outcome in the chat; the record line with the call card as proof.
    await waitFor(() => link.of('add_record_line').length === 1);
    const final = link.of('replace_card').at(-1)?.card as Record<string, unknown>;
    expect(final).toMatchObject({ call_id: callId, state: 'ended', outcome: 'Check-in at 10 am on 6 Nov is fine.' });
    expect(final.transcript).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.' }]);
    expect(link.of('post_message').at(-1)).toMatchObject({ text: 'Check-in at 10 am on 6 Nov is fine.', reply_to: 'm_300' });
    const cardPost = link.calls.findIndex((c) => c.method === 'post_message' && (c.params.card as { kind?: string } | undefined)?.kind === 'call');
    expect(cardPost).toBeGreaterThan(-1);
    expect(link.of('add_record_line')[0]).toMatchObject({ kind: 'agreed', text: 'Villa Sol: check-in at 10 am on 6 Nov is fine', person_ids: [] });

    // 6. Twilio's status callback is accepted only with Twilio's signature.
    const url = `https://brain.test/calls/twilio/status/${callId}`;
    const params = { AccountSid: 'AC_test', CallSid: 'CA_e2e', CallStatus: 'completed', CallDuration: '41' };
    const sig = createHmac('sha1', 'tok_test').update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k as keyof typeof params], url)).digest('base64');
    const post = (signature: string) => app.inject({
      method: 'POST',
      url: `/calls/twilio/status/${callId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(params).toString(),
    });
    expect((await post(sig)).statusCode).toBe(204);
    expect((await post('forged')).statusCode).toBe(403);

    h.stop();
    model.server.close();
    await app.close();
  });
  it('stopping Go ends a live call and waits until it is closed out', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const pack = goaPack({
      trip: goaTrip({ trip_id: 't_shutdown' }),
      messages: [msg({ id: 'm_400', seq: 400, by: 'p_arjun', text: '@Go ask the villa about check-in', mentionsGo: true })],
    });
    const { brain, app, reg, link } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' }, pack });
    // A voice model that says nothing, so the call stays live until Go stops.
    const quiet = new WebSocketServer({ port: 0 });
    let modelClosed = false;
    quiet.on('connection', (ws) => ws.on('close', () => { modelClosed = true; }));
    const forms: URLSearchParams[] = [];
    const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body ?? '')));
      return new Response(JSON.stringify({ sid: 'CA_shutdown', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const h = await startCalls(brain, {
      intervals: false, fetch: fetchFake, schedule: time.schedule,
      openVoice: () => new WebSocket(`ws://127.0.0.1:${(quiet.address() as AddressInfo).port}`),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const tool = reg.tools.find((t) => t.name === 'call_business')!;
    const out = (await tool.run(
      tool.input.parse({ business: 'Villa Sol', goal: 'Ask about check-in', announce: "I'll call Villa Sol about check-in." }),
      turnCtx({ link, pack, wake: [], turnId: 'turn_shutdown' }),
    )) as { call_id: string };
    time.advance(30_000);
    await h.tick();
    const token = /name="token" value="([^"]+)"/.exec(forms[0]?.get('Twiml') ?? '')?.[1] ?? '';
    const twilio = new WebSocket(`ws://127.0.0.1:${port}/calls/media/${out.call_id}`);
    let twilioClosed = false;
    twilio.on('close', () => { twilioClosed = true; });
    await new Promise((resolve) => twilio.once('open', resolve));
    twilio.send(JSON.stringify({ event: 'start', streamSid: 'MZ_stop', start: { streamSid: 'MZ_stop', callSid: 'CA_shutdown', customParameters: { token } } }));
    await waitFor(() => link.of('replace_card').some((p) => (p.card as { state?: string }).state === 'talking'));
    await waitFor(() => quiet.clients.size === 1);

    await h.stop();
    expect(await new CallStore(db.pool).get(out.call_id)).toMatchObject({ state: 'ended' });
    expect((link.of('replace_card').at(-1)?.card as { state?: string }).state).toBe('ended');
    await waitFor(() => twilioClosed && modelClosed);
    quiet.close();
    await app.close();
  });
});
