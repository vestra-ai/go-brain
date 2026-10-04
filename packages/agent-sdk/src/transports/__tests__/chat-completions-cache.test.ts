import { describe, it, expect, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { mainRunCacheKey } from '../../engine/main-run-cache-key.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

const BASE = {
  system: 'you are a helper',
  tools: [] as ProviderTool[],
  history: [] as ProviderHistory,
  maxTokens: 4096,
};

/** A stub OpenAI client whose chat.completions.stream is a recordable spy. */
function stubClient() {
  const stream = vi.fn().mockReturnValue(
    (async function* () {
      /* no events — only the request body is asserted */
    })(),
  );
  return { stream, client: { chat: { completions: { stream } } } as unknown as OpenAI };
}

type ReqOptions = { signal?: unknown; headers?: Record<string, string> } | undefined;

/** Capture BOTH the request body (arg 0) and the per-request options (arg 1). */
function callFor(
  model: string,
  extra: Record<string, unknown> = {},
): { body: Record<string, unknown>; options: ReqOptions } {
  const { client, stream } = stubClient();
  const transport = new ChatCompletionsTransport({ client });
  transport.callModel({ ...BASE, model, ...extra });
  return {
    body: stream.mock.calls[0][0] as Record<string, unknown>,
    options: stream.mock.calls[0][1] as ReqOptions,
  };
}

function bodyFor(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return callFor(model, extra).body;
}

// ─── prompt_cache_key — provider-gated cache-affinity hint ──────────────────────
// Researched per-provider 2026-06-30: OpenAI accepts prompt_cache_key (first-party,
// never 400s) and it improves cache routing — it is the sole member of
// PROMPT_CACHE_KEY_PROVIDERS. Fireworks is EXCLUDED: it ignores the field, so its
// affinity rides the `x-session-affinity` header instead (asserted in the Fireworks
// suite). Forwarding is byte-identity safe: absent cacheKey ⇒ no key at all, and OpenAI
// never gets the header (mirrors the Responses arm's contract).
describe('ChatCompletionsTransport — prompt_cache_key (provider-gated affinity)', () => {
  it('spreads prompt_cache_key for an OpenAI model when cacheKey is present, and adds NO x-session-affinity header (that is the Fireworks-only mechanism)', () => {
    const { body, options } = callFor('gpt-5.5', { cacheKey: 'vestra:task-abc' });
    expect(body.prompt_cache_key).toBe('vestra:task-abc');
    expect(options?.headers).toBeUndefined();
  });

  it('omits prompt_cache_key entirely when no cacheKey is requested (byte-identity guard)', () => {
    const body = bodyFor('gpt-5.5');
    expect('prompt_cache_key' in body).toBe(false);
  });

  it('does NOT send prompt_cache_key for GLM — Fireworks ignores the field; affinity rides the header (see Fireworks suite)', () => {
    const { body, options } = callFor('glm-5.2', { cacheKey: 'vestra:task-abc' });
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers?.['x-session-affinity']).toBe('vestra:task-abc');
  });

  it('omits BOTH prompt_cache_key and the affinity header for a provider OUTSIDE the gate even when cacheKey is present', () => {
    // google is not in PROMPT_CACHE_KEY_PROVIDERS and is not Fireworks — an unknown
    // endpoint is never gambled into a strict-validation 400 (byte-identity for
    // ungated providers): no body key, no header.
    const { body, options } = callFor('gemini-3.8-flash', { cacheKey: 'vestra:task-abc' });
    expect('prompt_cache_key' in body).toBe(false);
    expect(options?.headers).toBeUndefined();
  });

  it('two DIFFERENT tasks for the same user+model put the SAME prompt_cache_key on the wire', () => {
    // The main run's key is user+model-scoped (mainRunCacheKey) — the whole
    // warm-shard fix: a NEW task's first message must route to the shard the
    // user's previous tasks warmed, not a fresh cold one. (OpenAI lane, body field.)
    const rt = makeRuntimeConfig({ systemPrompt: '', userId: 'user-1' });
    const a = bodyFor('gpt-5.5', { cacheKey: mainRunCacheKey(rt, 'task-aaa', 'gpt-5.5') });
    const b = bodyFor('gpt-5.5', { cacheKey: mainRunCacheKey(rt, 'task-bbb', 'gpt-5.5') });
    expect(a.prompt_cache_key).toBeDefined();
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  });
});

// ─── system-prefix mutation guard (parity with anthropic / responses arms) ──────
// OpenAI-compatible automatic prefix caching is byte-prefix-based, so a mutated
// system prefix silently routes to a fresh shard and reads nothing. Pin the first
// system prefix this instance sees; warn LOUD (once, non-fatal) on later drift.
// PURE — never throws. (Guards `system` only; the shared instance's tool-less
// side-calls are not measured — see guardSystemPrefix.)
describe('ChatCompletionsTransport — system-prefix mutation guard', () => {
  afterEach(() => vi.restoreAllMocks());

  function guardTransport(): ChatCompletionsTransport {
    return new ChatCompletionsTransport({ client: stubClient().client });
  }
  function call(t: ChatCompletionsTransport, system: string): void {
    t.callModel({ ...BASE, model: 'gpt-5.5', system });
  }

  it('does NOT warn when the system prefix is stable across calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'STABLE');
    call(t, 'STABLE');
    call(t, 'STABLE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE with [CACHE_PROMPT_MUTATED] when the system prefix drifts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'ORIGINAL');
    call(t, 'DRIFTED'); // first drift → exactly one warn
    call(t, 'DRIFTED'); // re-pinned → no further warn
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[CACHE_PROMPT_MUTATED]');
  });

  it('never throws (pure observation)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    expect(() => {
      call(t, 'A');
      call(t, 'B');
    }).not.toThrow();
  });
});

// ─── the guard is scoped PER CACHE ROUTE, not per instance ─────────────────────
// One transport instance serves a whole run, and a run's off-loop side-calls
// (compaction / suggestion / vision) each carry their OWN system prompt while the
// main loop carries the task's. A single pinned slot therefore read every switch
// between those lanes as drift — the 2026-08-24 burn log's four
// [CACHE_PROMPT_MUTATED] warns were all that, hashes ping-ponging pairwise. The
// pin is keyed by the call's cacheKey (the provider-side cache route), so lanes
// only ever measure themselves.
describe('ChatCompletionsTransport — prefix guard scoped per cache route', () => {
  afterEach(() => vi.restoreAllMocks());

  function guardTransport(): ChatCompletionsTransport {
    return new ChatCompletionsTransport({ client: stubClient().client });
  }
  function call(t: ChatCompletionsTransport, system: string, cacheKey?: string): void {
    t.callModel({ ...BASE, model: 'gpt-5.5', system, ...(cacheKey !== undefined && { cacheKey }) });
  }

  it('does NOT warn when two cache routes alternate on one shared instance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'SYSTEM A', 'route-a');
    call(t, 'SYSTEM B', 'route-b');
    call(t, 'SYSTEM A', 'route-a');
    call(t, 'SYSTEM B', 'route-b');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when a keyless side-call interleaves with a keyed main route', () => {
    // The exact burn-log shape: main turn (cacheKey) → compaction (no cacheKey,
    // COMPACTION_SYSTEM) → main turn again.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'MAIN SYSTEM', 'u-abc');
    call(t, 'COMPACTION SYSTEM');
    call(t, 'MAIN SYSTEM', 'u-abc');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns ONCE on real drift WITHIN one cache route, then re-pins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'ORIGINAL', 'route-a');
    call(t, 'OTHER LANE', 'route-b'); // a different route is never compared against
    call(t, 'DRIFTED', 'route-a'); // real mid-route drift → exactly one warn
    call(t, 'DRIFTED', 'route-a'); // re-pinned → silent
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[CACHE_PROMPT_MUTATED]');
  });

  it('preserves the old single-slot behaviour for calls that carry NO cacheKey', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    call(t, 'ORIGINAL');
    call(t, 'DRIFTED');
    call(t, 'DRIFTED');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest route past the cap — an evicted route re-pins SILENTLY, live routes still warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = guardTransport();
    for (let i = 0; i <= 256; i++) call(t, `SYSTEM ${i}`, `route-${i}`); // 257 distinct routes
    call(t, 'A WHOLLY DIFFERENT PREFIX', 'route-0'); // evicted ⇒ pinned afresh, no warn
    expect(warn).not.toHaveBeenCalled();
    call(t, 'DRIFTED', 'route-256'); // still pinned ⇒ real drift is still caught
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
