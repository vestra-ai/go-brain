import { describe, expect, it } from 'vitest';
import { createJev, JEV_MODEL, JEV_WARM_SOCKETS, type JevFetch, type JevRequestInit, type JevResponse } from '../jev.js';

function response(status: number, body: unknown, headers: Record<string, string> = {}): JevResponse & { cancelled: boolean } {
  const r = {
    cancelled: false,
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: { cancel: async () => { r.cancelled = true; } },
  };
  return r;
}

function recordingFetch(answer: (url: string, init: JevRequestInit) => Promise<JevResponse>) {
  const calls: Array<{ url: string; init: JevRequestInit }> = [];
  const f: JevFetch = (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { f, calls };
}

const cfg = { apiKey: 'test-key', baseUrl: 'https://jev.example/', model: JEV_MODEL };
const questions = { q1_chatter: { type: 'noul' as const, instructions: 'Chatter?', criteria: { true: 'yes', false: 'no' } } };

describe('createJev().ask', () => {
  it('makes no request without a key', async () => {
    const { f, calls } = recordingFetch(async () => response(200, { answers: {} }));
    const res = await createJev({ ...cfg, apiKey: undefined }, f).ask({ state: {}, questions, deadlineMs: 450 });
    expect(res).toMatchObject({ ok: false, fault: 'no_api_key' });
    expect(calls).toHaveLength(0);
  });

  it('posts the pinned model with criteria at the top level and reads the answers', async () => {
    const { f, calls } = recordingFetch(async () =>
      response(200, { answers: { q1_chatter: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 812 } }, { 'x-envoy-upstream-service-time': '97' }),
    );
    const res = await createJev(cfg, f).ask({ state: { message: 'haha' }, questions, deadlineMs: 450 });
    expect(res).toMatchObject({ ok: true, answers: { q1_chatter: { type: 'noul', noul: 0.91 } }, inputTokens: 812, serverMs: 97 });
    expect(calls[0]!.url).toBe('https://jev.example/v1/systemone');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
    const sent = JSON.parse(calls[0]!.init.body!) as { model: string; questions: Record<string, { criteria: unknown }> };
    expect(sent.model).toBe('jev-1.13.0');
    expect(sent.questions.q1_chatter!.criteria).toEqual({ true: 'yes', false: 'no' });
  });

  it('reads a missing timing header as null, not zero', async () => {
    const { f } = recordingFetch(async () => response(200, { answers: {} }));
    const res = await createJev(cfg, f).ask({ state: {}, questions, deadlineMs: 450 });
    expect(res).toMatchObject({ ok: true, serverMs: null, inputTokens: 0 });
  });

  it('returns http_error with the status and drains the body', async () => {
    const r = response(403, { error: 'busy' });
    const { f } = recordingFetch(async () => r);
    const res = await createJev(cfg, f).ask({ state: {}, questions, deadlineMs: 450 });
    expect(res).toMatchObject({ ok: false, fault: 'http_error', status: 403 });
    expect(r.cancelled).toBe(true);
  });

  it('returns bad_response for a body that will not parse or has no answers', async () => {
    const a = await createJev(cfg, recordingFetch(async () => response(200, new Error('bad json'))).f).ask({ state: {}, questions, deadlineMs: 450 });
    const b = await createJev(cfg, recordingFetch(async () => response(200, { usage: {} })).f).ask({ state: {}, questions, deadlineMs: 450 });
    expect(a).toMatchObject({ ok: false, fault: 'bad_response' });
    expect(b).toMatchObject({ ok: false, fault: 'bad_response' });
  });

  it('gives up at its own deadline with timeout', async () => {
    const hang: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const started = Date.now();
    const res = await createJev(cfg, hang).ask({ state: {}, questions, deadlineMs: 30 });
    expect(res).toMatchObject({ ok: false, fault: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads a caller abort as transport_error', async () => {
    const hang: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 5);
    const res = await createJev(cfg, hang).ask({ state: {}, questions, deadlineMs: 5_000, signal: caller.signal });
    expect(res).toMatchObject({ ok: false, fault: 'transport_error' });
  });
});

describe('keep-warm', () => {
  it('touches the line with concurrent unbilled GETs and no key', async () => {
    const { f, calls } = recordingFetch(async () => response(200, null));
    const jev = createJev(cfg, f);
    jev.startKeepWarm();
    jev.stopKeepWarm();
    expect(calls).toHaveLength(JEV_WARM_SOCKETS);
    for (const c of calls) {
      expect(c.url).toBe('https://jev.example/');
      expect(c.init.method).toBe('GET');
      expect(c.init.redirect).toBe('manual');
      expect(c.init.headers).toBeUndefined();
    }
  });

  it('does not warm without a key', () => {
    const { f, calls } = recordingFetch(async () => response(200, null));
    const jev = createJev({ ...cfg, apiKey: undefined }, f);
    jev.startKeepWarm();
    jev.stopKeepWarm();
    expect(calls).toHaveLength(0);
  });
});
