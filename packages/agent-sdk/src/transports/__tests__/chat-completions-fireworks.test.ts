import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { normalizeChatUsage } from '../chat-completions-messages.js';
import type { NormalizedUsage, ProviderHistory, ProviderTool } from '../../engine/transport.js';
import type { ModelProvider } from '../../contract/model-capabilities.js';
import { computeOpenAIResponsesCostUsd } from '../openai-responses-pricing.js';
import { mainRunCacheKey } from '../../engine/main-run-cache-key.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';

const BASE = {
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

/** Stub exposing both chat.completions.stream (the path used) and .create (asserted unused). */
function stubClient() {
  const create = vi.fn();
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no chunks — only the request body is asserted */
    })(),
  );
  return { create, stream, client: { chat: { completions: { create, stream } } } as unknown as OpenAI };
}

type ReqOptions = { signal?: unknown; headers?: Record<string, string> } | undefined;

/** Capture BOTH the request body (arg 0) and the per-request options (arg 1). */
function callFor(
  model: string,
  extra: Record<string, unknown> = {},
): { body: Record<string, unknown>; options: ReqOptions } {
  const { client, stream } = stubClient();
  new ChatCompletionsTransport({ client }).callModel({ ...BASE, model, ...extra });
  return {
    body: stream.mock.calls[0][0] as Record<string, unknown>,
    options: stream.mock.calls[0][1] as ReqOptions,
  };
}

function bodyFor(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return callFor(model, extra).body;
}

// Fireworks behaves as a normal OpenAI-compatible Chat Completions endpoint (live-probed
// 2026-06-30: it ACCEPTS stream_options and emits NO usage chunk without it). Its two
// Fireworks-specific seams: the short-canonical-id → wire-slug rewrite, and cache affinity
// via the `x-session-affinity` HTTP header (Fireworks ignores the prompt_cache_key body
// field; its serverless tier round-robins replicas and "caching only works within 1 replica").
describe('ChatCompletionsTransport — Fireworks (GLM + DeepSeek V4) wire path', () => {
  it('routes BOTH Pro and Flash to the "fireworks" lane (the 08-17 reversal — no direct lane)', () => {
    const calls: ModelProvider[] = [];
    const createClient = vi.fn((p: ModelProvider) => {
      calls.push(p);
      return stubClient().client;
    });
    new ChatCompletionsTransport({ createClient }).callModel({ ...BASE, model: 'deepseek-v4-pro' });
    new ChatCompletionsTransport({ createClient }).callModel({ ...BASE, model: 'deepseek-v4-flash' });
    expect(calls).toEqual(['fireworks', 'fireworks']);
  });

  it('uses .stream() WITH stream_options (Fireworks requires it for the usage chunk; omitting it silently bills $0)', () => {
    const { client, create, stream } = stubClient();
    new ChatCompletionsTransport({ client }).callModel({ ...BASE, model: 'deepseek-v4-pro' });
    expect(create).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('rewrites the short canonical id to the full Fireworks wire slug (Flash + GLM; Pro asserted above)', () => {
    // V4 Flash's 0731 build was retired by Fireworks (404, 2026-09-26): a task still on the
    // id rides V4.1 Flash's slug instead of dying on the wire.
    expect((bodyFor('deepseek-v4-flash') as { model?: string }).model).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
    // GLM's Fireworks slug spells the version `5p2` (not `5.2`).
    expect((bodyFor('glm-5.2') as { model?: string }).model).toBe('accounts/fireworks/models/glm-5p2');
    // V4.1 Flash's slug spells the version `v4p1`; the fallback prefix would 404.
    expect((bodyFor('deepseek-v4.1-flash') as { model?: string }).model).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
  });

  it('sends reasoning_effort, and routes cache affinity to the x-session-affinity HEADER — not the prompt_cache_key body field (Fireworks ignores it)', () => {
    const { body, options } = callFor('deepseek-v4-flash', { cacheKey: 'vestra:task-1' });
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe('high');
    // #1499's prompt_cache_key is a no-op on Fireworks and a strict-schema-400 risk — omitted.
    expect('prompt_cache_key' in body).toBe(false);
    // The stable user+model key pins the session to one replica so the growing prefix stays cached.
    expect(options?.headers?.['x-session-affinity']).toBe('vestra:task-1');
  });

  it('Pro rides the Fireworks path: 0813 wire slug, reasoning_effort high, x-session-affinity header (like GLM)', () => {
    const { body, options } = callFor('deepseek-v4-pro', { cacheKey: 'vestra:task-9' });
    expect((body as { model?: string }).model).toBe('accounts/fireworks/models/deepseek-v4-pro-0813');
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe('high');
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers?.['x-session-affinity']).toBe('vestra:task-9');
    expect((body as { stream_options?: unknown }).stream_options).toEqual({ include_usage: true });
  });

  it('GLM rides the SAME Fireworks path: id-rewritten, reasoning_effort + stream_options + x-session-affinity header (no prompt_cache_key body)', () => {
    const { client, create, stream } = stubClient();
    new ChatCompletionsTransport({ client }).callModel({ ...BASE, model: 'glm-5.2', cacheKey: 'vestra:task-2' });
    expect(create).not.toHaveBeenCalled();
    const body = stream.mock.calls[0][0] as Record<string, unknown>;
    const options = stream.mock.calls[0][1] as ReqOptions;
    expect(body.model).toBe('accounts/fireworks/models/glm-5p2');
    expect(body.reasoning_effort).toBe('high');
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers?.['x-session-affinity']).toBe('vestra:task-2');
    expect(body.stream_options).toEqual({ include_usage: true });
    // The retired Z.ai seam is gone: no `thinking` body knob, no strict override.
    expect(body.thinking).toBeUndefined();
  });

  it('WITHOUT a cacheKey sends NO affinity header and does not crash (legacy/absent userId)', () => {
    const { body, options } = callFor('deepseek-v4-flash');
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers).toBeUndefined();
  });

  it('two DIFFERENT tasks for the same user+model pin the SAME x-session-affinity header (the multi-replica warm-shard fix)', () => {
    // The main run's key is user+model-scoped (mainRunCacheKey): a NEW task's first
    // request must pin to the replica the user's previous tasks warmed, or Fireworks
    // ("caching only works within 1 replica") re-prefills the whole prompt cold.
    const rt = makeRuntimeConfig({ systemPrompt: '', userId: 'user-1' });
    const a = callFor('glm-5.2', { cacheKey: mainRunCacheKey(rt, 'task-aaa', 'glm-5.2') });
    const b = callFor('glm-5.2', { cacheKey: mainRunCacheKey(rt, 'task-bbb', 'glm-5.2') });
    expect(a.options?.headers?.['x-session-affinity']).toBeDefined();
    expect(a.options?.headers?.['x-session-affinity']).toBe(b.options?.headers?.['x-session-affinity']);
  });
});

// Locks the DeepSeek rates + proves a real turn bills a NON-ZERO, rate-correct cost — the
// "no silent $0" guard the review asked for (the silent-$0 risk was sending no usage chunk).
describe('openai-pricing — DeepSeek V4 on Fireworks (cost from usage)', () => {
  const u = (over: Partial<NormalizedUsage>): NormalizedUsage =>
    ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...over }) as NormalizedUsage;

  it('prices a DeepSeek Pro input-only turn at the invoiced Fireworks rate', () => {
    expect(computeOpenAIResponsesCostUsd(u({ inputTokens: 1_000_000 }), 'deepseek-v4-pro')).toBeCloseTo(1.32, 6);
  });

  it('discounts cached input (Pro cache-hit $0.044 — input/30 on the invoice)', () => {
    // EXCLUSIVE shape (2026-08-04): a fully-cached 1M prompt is 0 plain + 1M cached.
    const allCache = u({ inputTokens: 0, cacheReadInputTokens: 1_000_000 });
    expect(computeOpenAIResponsesCostUsd(allCache, 'deepseek-v4-pro')).toBeCloseTo(0.044, 6);
  });

  it('Flash is far cheaper than Pro for the same usage', () => {
    const usage = u({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const pro = computeOpenAIResponsesCostUsd(usage, 'deepseek-v4-pro');
    const flash = computeOpenAIResponsesCostUsd(usage, 'deepseek-v4-flash');
    expect(flash).toBeLessThan(pro);
    expect(flash).toBeCloseTo(1.5, 6); // 0.30 input + 1.20 output (V4.1 Flash's card since 2026-10-01)
  });

  it('does NOT fail closed to gpt-5.5 ($5/M input)', () => {
    expect(computeOpenAIResponsesCostUsd(u({ inputTokens: 1_000_000 }), 'deepseek-v4-pro')).not.toBeCloseTo(5, 6);
  });
});

// RECORDED WIRE PAYLOADS, not invented ones. Captured 2026-08-12 from a live
// api.fireworks.ai streamed turn (stream_options.include_usage, 8.5k-token repeated
// prefix, x-session-affinity pinned) — the exact object normalizeChatUsage receives at
// chat-completions-messages.ts:281.
//
// These settle a live question about this lane: DeepSeek's FIRST-PARTY API spells cache
// reads `prompt_cache_hit_tokens`, so a normalizer that only reads OpenAI's
// `prompt_tokens_details.cached_tokens` would score every hit as a miss. We serve DeepSeek
// **through Fireworks**, never through api.deepseek.com, and Fireworks normalizes to the
// OpenAI spelling — the probe saw only {prompt_tokens, completion_tokens, total_tokens,
// prompt_tokens_details.cached_tokens} and no `prompt_cache_hit_tokens` on either model.
// Reading the DeepSeek spelling here would be dead code; these fixtures are what would
// have to change first if that ever stopped being true.
describe('normalizeChatUsage — recorded Fireworks payloads (2026-08-12 live probe)', () => {
  // GLM 5.2, second turn on a pinned replica: 8547 of 8554 prompt tokens served from cache.
  const GLM_CACHED = {
    prompt_tokens: 8554,
    completion_tokens: 16,
    total_tokens: 8570,
    prompt_tokens_details: { cached_tokens: 8547 },
  } as OpenAI.Completions.CompletionUsage;

  // DeepSeek V4 Flash, same experiment: 2652 of 8163 cached (coarser block granularity).
  const DEEPSEEK_CACHED = {
    prompt_tokens: 8163,
    completion_tokens: 16,
    total_tokens: 8179,
    prompt_tokens_details: { cached_tokens: 2652 },
  } as OpenAI.Completions.CompletionUsage;

  it('splits the GLM payload EXCLUSIVELY — input is the remainder, never the whole prompt', () => {
    expect(normalizeChatUsage(GLM_CACHED)).toEqual({
      inputTokens: 7, // 8554 − 8547, NOT 8554
      outputTokens: 16,
      cacheReadInputTokens: 8547,
      cacheCreationInputTokens: 0,
    });
  });

  it('splits the DeepSeek payload the same way (no prompt_cache_hit_tokens on this lane)', () => {
    expect(normalizeChatUsage(DEEPSEEK_CACHED)).toEqual({
      inputTokens: 5511, // 8163 − 2652
      outputTokens: 16,
      cacheReadInputTokens: 2652,
      cacheCreationInputTokens: 0,
    });
  });

  it('reports NO cache-creation tokens — the billing rate for them is pinned 0 upstream', () => {
    // credit.service.ts pins model:*:cache_create_per_mtok = 0 for this lane. That is only
    // honest while the wire truly reports no write bucket; if this ever goes non-zero the
    // charge would silently vanish at $0.
    expect(normalizeChatUsage(GLM_CACHED).cacheCreationInputTokens).toBe(0);
    expect(normalizeChatUsage(DEEPSEEK_CACHED).cacheCreationInputTokens).toBe(0);
  });

  it('bills the cached GLM turn far below the same turn priced as fresh input', () => {
    // The whole point of the affinity header: proof the discount reaches the meter.
    const cached = computeOpenAIResponsesCostUsd(normalizeChatUsage(GLM_CACHED), 'glm-5.2');
    const asFresh = computeOpenAIResponsesCostUsd(
      { inputTokens: 8554, outputTokens: 16, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } as NormalizedUsage,
      'glm-5.2',
    );
    expect(cached).toBeLessThan(asFresh);
    // Input $1.40/M vs cached $0.14/M ⇒ the prompt side costs ~10x less.
    expect(asFresh / cached).toBeGreaterThan(3);
  });

  it('a COLD turn reports zero cached tokens and bills the full prompt as input', () => {
    const cold = { ...GLM_CACHED, prompt_tokens_details: { cached_tokens: 0 } } as OpenAI.Completions.CompletionUsage;
    expect(normalizeChatUsage(cold).inputTokens).toBe(8554);
    expect(normalizeChatUsage(cold).cacheReadInputTokens).toBe(0);
  });
});
