/**
 * The retry boundary must re-ask a round whose FIRST stream read throws a
 * type-only transient frame (prod task b7867465, 2026-08-31): the openai SDK's
 * stream iterator threw `APIError { status: undefined, code: null, type:
 * 'service_unavailable_error' }` on the first read, startStreamWithRetry asked the
 * REAL classifier, got `model_error`, and rethrew — the whole turn burned on a
 * hiccup the provider itself labelled "Please retry."
 *
 * Drives startStreamWithRetry with the real OpenAI classifier and a transport whose
 * first attempt fails exactly the way production did.
 */
import { describe, it, expect } from 'vitest';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream } from '../transport.js';
import { startStreamWithRetry } from '../round-engine.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';

function serviceUnavailableFrame(): unknown {
  const err = new Error('Unable to verify model access right now. Please retry.') as Error & Record<string, unknown>;
  err.name = 'APIError';
  err.status = undefined;
  err.code = null;
  err.param = null;
  err.type = 'service_unavailable_error';
  err.error = { type: 'service_unavailable_error', code: null, message: err.message, param: null };
  return err;
}

/** A transport whose first stream read throws the production frame; the second streams normally. */
function hiccupTransport(): Transport & { attempts: number } {
  const t = {
    attempts: 0,
    api: 'openai_responses',
    provider: 'openai',
    defaultModel: () => 'gpt-5.6-luna',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: () => {},
    pushAssistant: () => {},
    pushToolResult: () => {},
    buildTools: (raw: unknown) => raw as unknown[],
    callModel: () => ({ attempt: ++t.attempts }) as unknown as ProviderStream,
    readStream: async function* (stream: unknown): AsyncIterable<StreamEvent> {
      if ((stream as { attempt: number }).attempt === 1) throw serviceUnavailableFrame();
      yield { kind: 'text', text: 'Found 2 PITR emails.' };
      yield { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    computeCostUsd: () => 0,
    classifyError: (err: unknown) => classifyOpenAIResponsesError(err),
  };
  return t as unknown as Transport & { attempts: number };
}

describe('startStreamWithRetry — a type-only service_unavailable frame is re-asked, not burned', () => {
  it('retries the round after the first read throws the production frame and streams the second attempt', async () => {
    const transport = hiccupTransport();
    const started = await startStreamWithRetry(
      { model: 'gpt-5.6-luna', maxTokens: 100, system: 's', tools: [], history: transport.emptyHistory() },
      transport,
      { retry: { maxAttempts: 4, backoffMs: 1 } },
    );
    const events: StreamEvent[] = [];
    for await (const ev of started.stream) events.push(ev);
    expect(transport.attempts).toBe(2);
    expect(events.map((e) => e.kind)).toEqual(['text', 'done']);
  });
});
