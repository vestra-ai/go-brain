/**
 * LANE_FALLBACK_V1 (harness to nine, LOOP): the second route to the same provider.
 *
 * The model lanes ride the ai-proxy service while the API plane (VESTRA_SERVER_URL) still serves
 * the very same credential-proxy routes with the same sandbox token. `apiPlaneRoute` reads that
 * second route from the parsed URLs; each transport's `fallBackLane(model)` moves that model's
 * requests there, once. Reaches the PRIVATE getClient on purpose, as client-credential-refresh
 * does: the default factories are the line under test, and an injected mock would bypass them.
 *
 * The move holds LANE_FALLBACK_HOLD_MS, then requests go back to the lane (the API plane is the
 * deploy-kill seam); a provider the API plane does not serve (API_PLANE_SERVES: Meta) never moves.
 *
 * Revert proof: drop a transport's route read in its client build (or the Gemini fetch) and its
 * "the next request rides the API plane" case fails; drop the hold's lapse and the "back to the
 * lane" case fails; drop the per-provider declaration and the Meta case moves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicMessagesTransport, ChatCompletionsTransport, OpenAIResponsesTransport } from '../index.js';
import { GeminiInteractionsTransport } from '../gemini-interactions-transport.js';
import { apiPlaneRoute, API_PLANE_SERVES, LANE_FALLBACK_HOLD_MS } from '../lane-fallback.js';
import type { StreamEvent } from '../../engine/transport.js';

const LANE = 'https://ai-proxy.test';
const PLANE = 'https://api.test';

beforeEach(() => {
  vi.stubEnv('VESTRA_SERVER_URL', PLANE);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sandbox-token');
  vi.stubEnv('ANTHROPIC_BASE_URL', `${LANE}/api/proxy/anthropic`);
  vi.stubEnv('OPENAI_API_KEY', 'sandbox-token');
  vi.stubEnv('OPENAI_BASE_URL', `${LANE}/api/proxy/openai/v1`);
  vi.stubEnv('FIREWORKS_API_KEY', 'sandbox-token');
  vi.stubEnv('FIREWORKS_BASE_URL', `${LANE}/api/proxy/fireworks/inference/v1`);
  vi.stubEnv('GEMINI_AUTH_TOKEN', 'sandbox-token');
  vi.stubEnv('GEMINI_BASE_URL', `${LANE}/api/proxy/google`);
  vi.stubEnv('META_API_KEY', 'sandbox-token');
  vi.stubEnv('META_BASE_URL', `${LANE}/api/proxy/meta/v1`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('apiPlaneRoute: the same proxy path on the API plane, read from the parsed URLs', () => {
  it('a lane on ai-proxy has its second route on the API plane, path and suffix kept', () => {
    expect(apiPlaneRoute('anthropic', `${LANE}/api/proxy/anthropic`)).toBe(`${PLANE}/api/proxy/anthropic`);
    expect(apiPlaneRoute('fireworks', `${LANE}/api/proxy/fireworks/inference/v1`)).toBe(`${PLANE}/api/proxy/fireworks/inference/v1`);
  });

  it('the API plane\'s own path never leaks in: only its origin is used', () => {
    vi.stubEnv('VESTRA_SERVER_URL', `${PLANE}/`);
    expect(apiPlaneRoute('google', `${LANE}/api/proxy/google`)).toBe(`${PLANE}/api/proxy/google`);
  });

  it('no second route: a lane already on the API plane, a direct provider URL, no plane, no lane, an unparseable URL', () => {
    expect(apiPlaneRoute('anthropic', `${PLANE}/api/proxy/anthropic`)).toBeUndefined();
    expect(apiPlaneRoute('fireworks', 'https://api.fireworks.ai/inference/v1')).toBeUndefined();
    expect(apiPlaneRoute('anthropic', undefined)).toBeUndefined();
    expect(apiPlaneRoute('anthropic', 'not a url')).toBeUndefined();
    vi.stubEnv('VESTRA_SERVER_URL', '');
    expect(apiPlaneRoute('anthropic', `${LANE}/api/proxy/anthropic`)).toBeUndefined();
  });

  it('a provider the API plane does not serve (Meta: no key on staging\'s plane) has no second route, by declaration', () => {
    expect(API_PLANE_SERVES.meta).toBe(false);
    expect(apiPlaneRoute('meta', `${LANE}/api/proxy/meta/v1`)).toBeUndefined();
  });
});

describe('Anthropic Messages: fallBackLane moves the next request to the API plane, once', () => {
  const clientOf = (t: AnthropicMessagesTransport) => (t as unknown as { getClient(): Anthropic }).getClient();

  it('the next request rides the API plane with the same token, and a refresh keeps the route', () => {
    const t = new AnthropicMessagesTransport();
    expect(clientOf(t).baseURL).toBe(`${LANE}/api/proxy/anthropic`);
    expect(t.fallBackLane()).toBe(true);
    expect(clientOf(t).baseURL).toBe(`${PLANE}/api/proxy/anthropic`);
    expect(clientOf(t).authToken).toBe('sandbox-token');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sandbox-token-fresh');
    expect(clientOf(t).baseURL).toBe(`${PLANE}/api/proxy/anthropic`);
    expect(clientOf(t).authToken).toBe('sandbox-token-fresh');
  });

  it('a second call does not move again; a lane with no second route never moves', () => {
    const t = new AnthropicMessagesTransport();
    expect(t.fallBackLane()).toBe(true);
    expect(t.fallBackLane()).toBe(false);
    vi.stubEnv('ANTHROPIC_BASE_URL', `${PLANE}/api/proxy/anthropic`);
    const onPlane = new AnthropicMessagesTransport();
    expect(onPlane.fallBackLane()).toBe(false);
    expect(clientOf(onPlane).baseURL).toBe(`${PLANE}/api/proxy/anthropic`);
  });

  it('an injected client never moves', () => {
    const t = new AnthropicMessagesTransport({ client: {} as Anthropic });
    expect(t.fallBackLane()).toBe(false);
  });
});

describe('the OpenAI-compatible lanes: only the model\'s own provider moves', () => {
  const clientOf = (t: object, p: string) => (t as { getClient(p: string): OpenAI }).getClient(p);

  it('Responses (openai): the next request rides the API plane', () => {
    const t = new OpenAIResponsesTransport();
    expect(clientOf(t, 'openai').baseURL).toBe(`${LANE}/api/proxy/openai/v1`);
    expect(t.fallBackLane('gpt-5.6-sol')).toBe(true);
    expect(clientOf(t, 'openai').baseURL).toBe(`${PLANE}/api/proxy/openai/v1`);
    expect(t.fallBackLane('gpt-5.6-sol')).toBe(false);
  });

  it('Chat Completions (fireworks): fireworks moves, the openai lane on the same transport stays', () => {
    const t = new ChatCompletionsTransport();
    const openai = clientOf(t, 'openai');
    expect(t.fallBackLane('deepseek-v4-pro')).toBe(true);
    expect(clientOf(t, 'fireworks').baseURL).toBe(`${PLANE}/api/proxy/fireworks/inference/v1`);
    expect(clientOf(t, 'openai')).toBe(openai);
    expect(clientOf(t, 'openai').baseURL).toBe(`${LANE}/api/proxy/openai/v1`);
  });

  it('an injected client never moves', () => {
    const t = new ChatCompletionsTransport({ client: {} as OpenAI });
    expect(t.fallBackLane('deepseek-v4-pro')).toBe(false);
  });

  it('a Meta lane never moves: the backup holds no Meta key, so no switch is announced and the lane stays', () => {
    const t = new ChatCompletionsTransport();
    expect(t.fallBackLane('muse-spark-1.3')).toBe(false);
    expect(clientOf(t, 'meta').baseURL).toBe(`${LANE}/api/proxy/meta/v1`);
  });
});

describe('the move holds, then requests go back to the lane', () => {
  const clientOf = (t: object, p: string) => (t as { getClient(p: string): OpenAI }).getClient(p);

  it('after LANE_FALLBACK_HOLD_MS the next request rides the lane again, and a lane that still fails can move again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const t = new ChatCompletionsTransport();
    expect(t.fallBackLane('deepseek-v4-pro')).toBe(true);
    vi.setSystemTime(Date.now() + LANE_FALLBACK_HOLD_MS - 1);
    expect(clientOf(t, 'fireworks').baseURL).toBe(`${PLANE}/api/proxy/fireworks/inference/v1`);
    vi.setSystemTime(Date.now() + 1);
    expect(clientOf(t, 'fireworks').baseURL).toBe(`${LANE}/api/proxy/fireworks/inference/v1`);
    expect(t.fallBackLane('deepseek-v4-pro')).toBe(true);
    expect(clientOf(t, 'fireworks').baseURL).toBe(`${PLANE}/api/proxy/fireworks/inference/v1`);
  });

  it('a move given a deadline holds only until it (a session replaying its move), and a past one never moves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const t = new AnthropicMessagesTransport();
    const anthropicClient = () => (t as unknown as { getClient(): Anthropic }).getClient();
    expect(t.fallBackLane('any', Date.now() - 1)).toBe(false);
    expect(t.fallBackLane('any', Date.now() + 60_000)).toBe(true);
    expect(anthropicClient().baseURL).toBe(`${PLANE}/api/proxy/anthropic`);
    vi.setSystemTime(Date.now() + 60_000);
    expect(anthropicClient().baseURL).toBe(`${LANE}/api/proxy/anthropic`);
  });
});

describe('Gemini Interactions: the next request is POSTed to the API plane', () => {
  const SSE = [
    'data: {"event_type":"interaction.created","interaction":{"id":"i","status":"in_progress"}}',
    'data: {"event_type":"interaction.completed","interaction":{"id":"i","status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":1}}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const BASE = { system: 's', tools: [], history: [] as never, maxTokens: 64 };
  async function urlOfNextRequest(t: GeminiInteractionsTransport): Promise<string> {
    const fetchMock = vi.fn(async () => new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const out: StreamEvent[] = [];
    for await (const e of t.readStream(t.callModel({ ...BASE, model: 'm' }))) out.push(e);
    return (fetchMock.mock.calls[0] as unknown as [string])[0];
  }

  it('before: the lane; after the move: the same path on the API plane; once', async () => {
    const t = new GeminiInteractionsTransport();
    expect(await urlOfNextRequest(t)).toBe(`${LANE}/api/proxy/google/v1beta/interactions`);
    expect(t.fallBackLane()).toBe(true);
    expect(await urlOfNextRequest(t)).toBe(`${PLANE}/api/proxy/google/v1beta/interactions`);
    expect(t.fallBackLane()).toBe(false);
  });

  it('an injected stream never moves', () => {
    const t = new GeminiInteractionsTransport({ streamFactory: async function* () {} });
    expect(t.fallBackLane()).toBe(false);
  });
});
