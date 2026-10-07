import { describe, expect, it } from 'vitest';
import { V1Error, createV1Client } from '../v1-client.js';

const K = (c: string) => `vk_test_${c.repeat(43)}`;
const KEYS = [K('a'), K('b'), K('c')];
const ADMIN = K('z');

interface Seen { url: URL; method: string; headers: Record<string, string>; body: unknown }
function fakeFetch(answer: (seen: Seen, n: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(seen);
    return answer(seen, calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const keyOf = (s: Seen) => s.headers.authorization?.replace('Bearer ', '');

function clockAndSleep() {
  const t = { now: 1_000_000, slept: [] as number[] };
  return { t, nowMs: () => t.now, sleep: async (ms: number) => { t.slept.push(ms); t.now += ms; } };
}

describe('requests', () => {
  it('spreads requests round the key pool', async () => {
    const { f, calls } = fakeFetch(() => json(200, { ok: true }));
    const v1 = createV1Client({ baseUrl: 'https://api.test/', keys: KEYS, fetch: f });
    for (let i = 0; i < 4; i += 1) await v1.call('GET', '/v1/conversations/conv_1');
    expect(calls.map(keyOf)).toEqual([K('a'), K('b'), K('c'), K('a')]);
    expect(calls[0]!.url.toString()).toBe('https://api.test/v1/conversations/conv_1');
  });

  it("rests a key for its Retry-After and moves to the next key at once", async () => {
    const c = clockAndSleep();
    const { f, calls } = fakeFetch((_s, n) => (n === 1 ? json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '2' }) : json(200, {})));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f, nowMs: c.nowMs, sleep: c.sleep });
    await v1.call('GET', '/v1/tasks/task_1');
    await v1.call('GET', '/v1/tasks/task_1');
    await v1.call('GET', '/v1/tasks/task_1');
    expect(calls.map(keyOf)).toEqual([K('a'), K('b'), K('c'), K('b')]);
    expect(c.t.slept).toEqual([]);
  });

  it('waits out the shortest rest when every key rests, and gives up when the wait is too long', async () => {
    const c = clockAndSleep();
    const { f } = fakeFetch((_s, n) => (n <= 2 ? json(429, { error: { code: 'rate_limited' } }, { 'retry-after': '1' }) : json(200, { ok: 1 })));
    const two = createV1Client({ baseUrl: 'https://api.test', keys: KEYS.slice(0, 2), fetch: f, nowMs: c.nowMs, sleep: c.sleep });
    expect(await two.call('GET', '/v1/x')).toEqual({ ok: 1 });
    expect(c.t.slept).toEqual([1000]);
    const slow = fakeFetch(() => json(429, { error: { code: 'rate_limited' } }, { 'retry-after': '30' }));
    const one = createV1Client({ baseUrl: 'https://api.test', keys: KEYS.slice(0, 1), fetch: slow.f, nowMs: c.nowMs, sleep: c.sleep });
    await expect(one.call('GET', '/v1/x')).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('retries a write only when it carries an idempotency key, and sends the key', async () => {
    const c = clockAndSleep();
    const keyed = fakeFetch((_s, n) => (n === 1 ? json(503, { error: { code: 'database_unavailable' } }) : json(201, { id: 'conv_1' })));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: keyed.f, nowMs: c.nowMs, sleep: c.sleep });
    expect(await v1.call('POST', '/v1/conversations', { body: { user_id: 'u' }, idempotencyKey: 'go-conv-u' })).toEqual({ id: 'conv_1' });
    expect(keyed.calls).toHaveLength(2);
    expect(keyed.calls[1]!.headers['idempotency-key']).toBe('go-conv-u');
    expect(keyed.calls[1]!.body).toEqual({ user_id: 'u' });
    const bare = fakeFetch(() => json(503, { error: { code: 'database_unavailable' } }));
    const v2 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: bare.f, nowMs: c.nowMs, sleep: c.sleep });
    await expect(v2.call('POST', '/v1/sessions', { body: {} })).rejects.toMatchObject({ status: 503, code: 'database_unavailable' });
    expect(bare.calls).toHaveLength(1);
  });

  it('waits and sends again when the conversation is busy', async () => {
    const c = clockAndSleep();
    const { f, calls } = fakeFetch((_s, n) => (n === 1 ? json(409, { error: { code: 'conversation_busy' } }) : json(202, { id: 'turn_1' })));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f, nowMs: c.nowMs, sleep: c.sleep });
    expect(await v1.call('POST', '/v1/conversations/conv_1/messages', { body: {}, idempotencyKey: 'go-msg-1' })).toEqual({ id: 'turn_1' });
    expect(calls).toHaveLength(2);
    expect(c.t.slept).toEqual([1000]);
  });

  it('uses the admin key only for admin calls, and refuses one when there is no admin key', async () => {
    const { f, calls } = fakeFetch(() => json(200, {}));
    await createV1Client({ baseUrl: 'https://api.test', keys: KEYS, adminKey: ADMIN, fetch: f }).call('POST', '/v1/users', { admin: true, body: {} });
    expect(keyOf(calls[0]!)).toBe(ADMIN);
    await expect(createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f }).call('POST', '/v1/users', { admin: true })).rejects.toMatchObject({ code: 'admin_key_missing' });
  });

  it("turns /v1's error body into a V1Error with its code", async () => {
    const { f } = fakeFetch(() => json(402, { error: { type: 'cap_reached', code: 'wallet_empty', message: 'Top up.' } }));
    const err = await createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f }).call('POST', '/v1/x', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(V1Error);
    expect(err).toMatchObject({ status: 402, code: 'wallet_empty', message: 'Top up.' });
  });

  it("keeps the rest of /v1's error object, such as a timed-out browser fetch's partial result", async () => {
    const partial = { final_url: 'https://www.ixigo.com/x', elapsed_ms: 8000, woke: true, captures: [] };
    const { f, calls } = fakeFetch(() => json(504, { error: { type: 'upstream', code: 'timeout', message: 'Too slow.', request_id: 'req_1', partial } }));
    const err = await createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f }).call('POST', '/v1/users/u1/browser/fetch', { body: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 504, code: 'timeout', detail: { request_id: 'req_1', partial } });
    // A write with no idempotency key is never sent twice.
    expect(calls).toHaveLength(1);
  });
});

const frame = (seq: number, type: string, data: object) => `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, data, created_at: '2026-10-07T12:00:00Z' })}\n\n`;
const sse = (chunks: string[], keepOpen = false) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        if (!keepOpen) c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

describe('streams', () => {
  it('opens from the start (after=0) or from Last-Event-ID, and yields frames', async () => {
    const { f, calls } = fakeFetch(() => sse([frame(1, 'task.started', { task_id: 'task_1' }), frame(2, 'task.progress', { task_id: 'task_1', todos: [] })]));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f });
    const s = await v1.stream('/v1/conversations/conv_1/events', { lastEventId: null });
    const got = [];
    for await (const fr of s.frames) got.push(fr);
    expect(got.map((g) => [g.id, g.event])).toEqual([[1, 'task.started'], [2, 'task.progress']]);
    expect(calls[0]!.url.searchParams.get('after')).toBe('0');
    expect(calls[0]!.headers.accept).toBe('text/event-stream');
    await v1.stream('/v1/conversations/conv_1/events', { lastEventId: 7 });
    expect(calls[1]!.headers['last-event-id']).toBe('7');
    expect(calls[1]!.url.searchParams.has('after')).toBe(false);
  });

  it('puts a stream on the key with the fewest open, counts them, and frees them on close', async () => {
    const { f } = fakeFetch(() => sse([], true));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS.slice(0, 2), fetch: f, maxStreamsPerKey: 1 });
    const a = await v1.stream('/v1/conversations/c1/events', { lastEventId: 0 });
    const b = await v1.stream('/v1/conversations/c2/events', { lastEventId: 0 });
    expect([a.keyIndex, b.keyIndex]).toEqual([0, 1]);
    expect(v1.openStreams()).toEqual([1, 1]);
    await expect(v1.stream('/v1/conversations/c3/events', { lastEventId: 0 })).rejects.toMatchObject({ code: 'too_many_streams' });
    a.close();
    b.close();
    expect(v1.openStreams()).toEqual([0, 0]);
  });

  it('moves to another key when /v1 says a key has too many streams, and says stream_expired on 410', async () => {
    const busy = fakeFetch((s) => (keyOf(s) === K('a') ? json(429, { error: { code: 'too_many_streams' } }) : sse([], true)));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS.slice(0, 2), fetch: busy.f });
    const s = await v1.stream('/v1/conversations/c1/events', { lastEventId: 3 });
    expect(s.keyIndex).toBe(1);
    s.close();
    const gone = fakeFetch(() => json(410, { error: { code: 'stream_expired', message: 'too old' } }));
    await expect(createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: gone.f }).stream('/v1/conversations/c1/events', { lastEventId: 1 })).rejects.toMatchObject({ status: 410, code: 'stream_expired' });
  });

  it('gives up on a stream that says nothing at all, not even a ping', async () => {
    const { f } = fakeFetch(() => sse([], true));
    const v1 = createV1Client({ baseUrl: 'https://api.test', keys: KEYS, fetch: f });
    const s = await v1.stream('/v1/conversations/c1/events', { lastEventId: 0, quietMs: 30 });
    const read = async () => {
      for await (const f of s.frames) void f;
    };
    await expect(read()).rejects.toMatchObject({ code: 'stream_quiet' });
    expect(v1.openStreams()[s.keyIndex]).toBe(0);
  });
});
