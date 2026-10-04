/**
 * One retry authority (H9 W2 Task 4): with the SDKs' own retries OFF
 * (maxRetries: 0 — see client-max-retries.test.ts), startStreamWithRetry is the
 * only place a model call is retried, so it must honour Retry-After itself: the
 * hint STRETCHES the linear backoff (never shrinks it), capped at
 * RETRY_AFTER_CAP_MS, and the default budget absorbs the SDK layer's former two
 * silent attempts. Proved over the REAL OpenAI classifier and a real APIError
 * carrying the header — the wire shape, not a synthetic kind.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { APIError as OpenAIAPIError } from 'openai';
import { startStreamWithRetry } from '../round-engine.js';
import { RETRY_AFTER_CAP_MS } from '../error-authority.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import type { ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

const doneEv: StreamEvent = { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };

function transportFailing(errs: unknown[]): Transport & { calls: number } {
  const holder = {
    calls: 0,
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    callModel(): ProviderStream {
      holder.calls += 1;
      if (holder.calls <= errs.length) throw errs[holder.calls - 1];
      return [doneEv] as unknown as ProviderStream;
    },
    readStream: async function* (stream: ProviderStream): AsyncIterable<StreamEvent> {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    classifyError: (err: unknown) => classifyOpenAIResponsesError(err),
  };
  return holder as unknown as Transport & { calls: number };
}

const params = (t: Transport, signal?: AbortSignal) => ({
  model: 'm',
  maxTokens: 100,
  system: 's',
  tools: [] as never[],
  history: t.emptyHistory(),
  ...(signal !== undefined ? { signal } : {}),
});

const err429 = (retryAfter: string) =>
  OpenAIAPIError.generate(429, { error: { message: 'Rate limit reached' } }, undefined, new Headers({ 'retry-after': retryAfter }));

afterEach(() => {
  vi.useRealTimers();
});

it("honours Retry-After: a '2' header stretches attempt 1's backoff to 2000 ms", async () => {
  vi.useFakeTimers();
  const t = transportFailing([err429('2')]);
  const p = startStreamWithRetry(params(t), t, {});
  await vi.advanceTimersByTimeAsync(0);
  expect(t.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(t.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.calls).toBe(2);
  const started = await p;
  expect(started.model).toBe('m');
});

it("caps the hint: a '999' header waits exactly RETRY_AFTER_CAP_MS, never longer", async () => {
  vi.useFakeTimers();
  const t = transportFailing([err429('999')]);
  const p = startStreamWithRetry(params(t), t, {});
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_CAP_MS - 1);
  expect(t.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.calls).toBe(2);
  await p;
});

it("never SHRINKS the backoff: a '0' hint keeps the 750 ms linear wait", async () => {
  vi.useFakeTimers();
  const t = transportFailing([err429('0')]);
  const p = startStreamWithRetry(params(t), t, {});
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(749);
  expect(t.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.calls).toBe(2);
  await p;
});

it("the default budget is 4 attempts — absorbing the SDK layer's former 2 silent retries", async () => {
  vi.useFakeTimers();
  const t = transportFailing([err429('0'), err429('0'), err429('0'), err429('0'), err429('0')]);
  const settled = startStreamWithRetry(params(t), t, {}).then(
    () => 'resolved' as const,
    (e: unknown) => e,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(t.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(750);
  expect(t.calls).toBe(2);
  await vi.advanceTimersByTimeAsync(1500);
  expect(t.calls).toBe(3);
  await vi.advanceTimersByTimeAsync(2250);
  expect(t.calls).toBe(4);
  const out = await settled;
  expect(out).toBeInstanceOf(Error);
  expect(t.calls).toBe(4);
});

it('an abort during a hinted backoff still wins: no further calls, AbortError out', async () => {
  vi.useFakeTimers();
  const ac = new AbortController();
  const t = transportFailing([err429('20')]);
  const settled = startStreamWithRetry(params(t, ac.signal), t, {}).then(
    () => 'resolved' as const,
    (e: unknown) => e,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(t.calls).toBe(1);
  ac.abort();
  await vi.advanceTimersByTimeAsync(0);
  const out = await settled;
  expect(out).toMatchObject({ name: 'AbortError' });
  expect(t.calls).toBe(1);
});
