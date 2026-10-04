/**
 * Sibling lane (2026-09-05). Meta's contributor door answered "model not found" on
 * ~40% of requests while the model behind it was fine; the standard door never
 * missed. The registry names the standard door as the contributor row's
 * `unavailableSibling`, and startStreamWithRetry: (1) gives a flapping PICKED door
 * eight fast tries, (2) then serves the round on the sibling, announced once on the
 * thinking rail and billed at the PICKED model. Proved over the REAL OpenAI
 * classifier and a real 404 model_not_found APIError — the wire shape, not a
 * synthetic kind.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { APIError as OpenAIAPIError } from 'openai';
import { startStreamWithRetry, SIBLING_LANE_RETRY, SIBLING_LANE_NOTE } from '../round-engine.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import type { ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

const PICKED = 'muse-spark-1.3-contributor';
const SIBLING = 'muse-spark-1.3';
const doneEv: StreamEvent = { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };

const notFound = () =>
  OpenAIAPIError.generate(
    404,
    { error: { message: 'The requested model was not found.', code: 'model_not_found', type: 'invalid_request_error' } },
    undefined,
    new Headers(),
  );
const rateLimited = () =>
  OpenAIAPIError.generate(429, { error: { message: 'Rate limit reached' } }, undefined, new Headers());

/** A transport whose failures are scripted PER MODEL and per call index (1-based). */
function transport(fail: (model: string, nth: number) => unknown | undefined): Transport & { calls: string[] } {
  const holder = {
    calls: [] as string[],
    api: 'fake',
    provider: 'fake',
    defaultModel: () => PICKED,
    emptyHistory: () => [] as unknown as ProviderHistory,
    callModel(p: { model: string }): ProviderStream {
      holder.calls.push(p.model);
      const nth = holder.calls.filter((m) => m === p.model).length;
      const err = fail(p.model, nth);
      if (err) throw err;
      return [doneEv] as unknown as ProviderStream;
    },
    readStream: async function* (stream: ProviderStream): AsyncIterable<StreamEvent> {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    classifyError: (err: unknown) => classifyOpenAIResponsesError(err),
  };
  return holder as unknown as Transport & { calls: string[] };
}

const params = (t: Transport, model = PICKED) => ({
  model,
  maxTokens: 100,
  system: 's',
  tools: [] as never[],
  history: t.emptyHistory(),
});

/** Drive fake timers until the promise settles; returns the fake-clock ms it took. */
async function settle<T>(p: Promise<T>): Promise<{ result: PromiseSettledResult<T>; elapsedMs: number }> {
  const t0 = Date.now();
  let settled: PromiseSettledResult<T> | undefined;
  p.then((v) => { settled = { status: 'fulfilled', value: v }; }, (e) => { settled = { status: 'rejected', reason: e }; });
  while (settled === undefined) await vi.advanceTimersByTimeAsync(50);
  return { result: settled, elapsedMs: Date.now() - t0 };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startStreamWithRetry — the sibling lane', () => {
  it('a picked door that never answers gets EIGHT fast tries (~8.4 s), then the round moves to the sibling, announced once, billed as the picked model', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport((model) => (model === PICKED ? notFound() : undefined));
    const { result, elapsedMs } = await settle(startStreamWithRetry(params(t), t, {}));
    expect(result.status).toBe('fulfilled');
    const started = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof startStreamWithRetry>>>).value;
    expect(t.calls.filter((m) => m === PICKED)).toHaveLength(SIBLING_LANE_RETRY.maxAttempts);
    expect(t.calls.filter((m) => m === SIBLING)).toHaveLength(1);
    // 300 ms linear over seven waits: 300 × (1+…+7) = 8400 ms.
    expect(elapsedMs).toBe(SIBLING_LANE_RETRY.backoffMs * 28);
    expect(started.model).toBe(SIBLING);
    expect(started.billedAs).toBe(PICKED);
    const events = await drain(started.stream);
    expect(events.slice(0, 2)).toEqual([{ kind: 'thinking_start' }, { kind: 'thinking', text: SIBLING_LANE_NOTE }]);
    expect(events[2]).toEqual(doneEv);
  });

  it('a flap that clears on the third try never leaves the picked door: no announcement, no billedAs', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport((model, nth) => (model === PICKED && nth <= 2 ? notFound() : undefined));
    const { result } = await settle(startStreamWithRetry(params(t), t, {}));
    expect(result.status).toBe('fulfilled');
    const started = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof startStreamWithRetry>>>).value;
    expect(t.calls).toEqual([PICKED, PICKED, PICKED]);
    expect(started.model).toBe(PICKED);
    expect(started.billedAs).toBeUndefined();
    expect(await drain(started.stream)).toEqual([doneEv]);
  });

  it('a RATE LIMIT on the picked door keeps the default four-try budget and never moves lanes (the sibling is 12.5× the price)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport((model) => (model === PICKED ? rateLimited() : undefined));
    const { result } = await settle(startStreamWithRetry(params(t), t, {}));
    expect(result.status).toBe('rejected');
    expect(t.calls).toEqual([PICKED, PICKED, PICKED, PICKED]);
  });

  it('a model with NO sibling keeps the default four tries on "model not found" and fails honestly', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport(() => notFound());
    const { result } = await settle(startStreamWithRetry(params(t, 'gpt-5.6-luna'), t, {}));
    expect(result.status).toBe('rejected');
    expect(t.calls).toEqual(['gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna']);
  });

  it('the sibling door failing too is terminal: its own default budget, then no second switch', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport(() => notFound());
    const { result } = await settle(startStreamWithRetry(params(t), t, {}));
    expect(result.status).toBe('rejected');
    expect(t.calls.filter((m) => m === PICKED)).toHaveLength(SIBLING_LANE_RETRY.maxAttempts);
    expect(t.calls.filter((m) => m === SIBLING)).toHaveLength(4);
    expect(t.calls).toHaveLength(SIBLING_LANE_RETRY.maxAttempts + 4);
  });

  it('a configured cfg.retry.fallbackModel still applies AFTER the sibling (the empty-round ladder\'s escape hatch is untouched)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = transport((model) => (model === 'other-model' ? undefined : notFound()));
    const { result } = await settle(startStreamWithRetry(params(t), t, { retry: { fallbackModel: 'other-model' } }));
    expect(result.status).toBe('fulfilled');
    const started = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof startStreamWithRetry>>>).value;
    expect(started.model).toBe('other-model');
    // The configured fallback is a different model, not a sibling door: no subsidy.
    expect(started.billedAs).toBeUndefined();
  });
});
