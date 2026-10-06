import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { signV1 } from '../testing/fake-v1.js';
import { makeTaskHarness, type TaskHarness } from '../testing/harness.js';
import { registerV1Webhooks, verifyV1Signature } from '../webhooks.js';

const SECRET = 'whsec_test_0123456789abcdef';
const OLD = 'whsec_old_0123456789abcdef';
let h: TaskHarness;
let app: FastifyInstance;
const apply = vi.fn(async () => undefined);

beforeAll(async () => {
  h = await makeTaskHarness();
  app = Fastify({ logger: false });
  await registerV1Webhooks(app, { secrets: [SECRET, OLD], events: h.eventStore, apply, now: h.lb.clock.now, log: h.lb.brain.log });
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const nowSec = () => Math.floor(h.lb.clock.now().getTime() / 1000);
const evt = (id: string) => ({ id, object: 'event', type: 'task.completed', mode: 'test', created_at: '2026-10-07T12:00:00Z', user_id: 'gotrip-1', task_id: 'task_9', conversation_id: 'conv_1', data: { status: 'completed' } });
const post = (body: string, signature: string) => app.inject({ method: 'POST', url: '/v1-webhooks', headers: { 'content-type': 'application/json', 'vestra-signature': signature }, payload: body });

describe('verifyV1Signature', () => {
  it('accepts a fresh signature from the current or the rolled secret, and refuses the rest', () => {
    const raw = JSON.stringify(evt('evt_1'));
    const t = nowSec();
    expect(verifyV1Signature(raw, signV1(SECRET, raw, t), [SECRET], t)).toBe('ok');
    expect(verifyV1Signature(raw, signV1(OLD, raw, t), [SECRET, OLD], t)).toBe('ok');
    expect(verifyV1Signature(raw, `${signV1('other', raw, t)},v1=${signV1(SECRET, raw, t).split('v1=')[1]}`, [SECRET], t)).toBe('ok');
    expect(verifyV1Signature(raw, signV1(SECRET, raw, t - 301), [SECRET], t)).toBe('stale');
    expect(verifyV1Signature(raw, signV1('other', raw, t), [SECRET], t)).toBe('mismatch');
    expect(verifyV1Signature(`${raw} `, signV1(SECRET, raw, t), [SECRET], t)).toBe('mismatch');
    expect(verifyV1Signature(raw, 'v1=abc', [SECRET], t)).toBe('malformed');
    expect(verifyV1Signature(raw, undefined, [SECRET], t)).toBe('missing');
  });
});

describe('POST /v1-webhooks', () => {
  it('applies a signed event once, with the task id from the envelope, and answers a repeat as a duplicate', async () => {
    const body = JSON.stringify(evt('evt_100'));
    const sig = signV1(SECRET, body, nowSec());
    expect((await post(body, sig)).statusCode).toBe(200);
    expect(apply).toHaveBeenCalledWith({ type: 'task.completed', data: { status: 'completed', task_id: 'task_9' }, conversationId: 'conv_1', source: 'webhook' });
    const again = await post(body, sig);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad signature without applying anything', async () => {
    const body = JSON.stringify(evt('evt_101'));
    expect((await post(body, signV1('wrong-secret-000000', body, nowSec()))).statusCode).toBe(401);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when applying fails, so Vestra sends it again, and the resend is applied', async () => {
    apply.mockRejectedValueOnce(new Error('database down'));
    const body = JSON.stringify(evt('evt_102'));
    expect((await post(body, signV1(SECRET, body, nowSec()))).statusCode).toBe(500);
    expect((await post(body, signV1(SECRET, body, nowSec()))).statusCode).toBe(200);
    expect(apply).toHaveBeenCalledTimes(3);
  });
});
