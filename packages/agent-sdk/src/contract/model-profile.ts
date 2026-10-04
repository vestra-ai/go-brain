/**
 * The (model, transport) capacity profile, read off the capability registry.
 * Kept in its own module because model-capabilities.ts is at its size ratchet
 * (moved out verbatim when Sonnet 5.5 and Grok 4.7 were seeded, 2026-09-29).
 */
import { resolveCapabilities, type ModelCapabilities, type WireApi } from './model-capabilities.js';

/**
 * Phase 4 (§1.7 AC-R4) — the model-aware Harness-Profile's capacity view,
 * KEYED `(model, transport)`. EXTENDS this same registry (no second source of
 * truth): `resolveCapabilities` already carries `contextWindow`/`maxOutputTokens`/
 * `tokenizerId` per model; this adds the transport dimension the design doc
 * requires so offload/compaction/routing can ask "what can THIS model do on
 * THIS wire dialect" instead of assuming a model's data applies to any
 * transport it might be routed through.
 */
export interface ModelProfile {
  modelId: string;
  transport: WireApi;
  contextWindowTokens: number;
  maxOutputTokens: number;
  tokenizerId: ModelCapabilities['tokenizerId'];
  /** 'exact' — resolved from the model's own wire dialect. 'fallback' — the
   *  requested transport is NOT how this model actually speaks; no real data
   *  exists for that pair, so a conservative floor stands in (never a guess). */
  source: 'exact' | 'fallback';
}

/** Conservative floor for a (model, transport) pair with no real data (AC-R4). */
const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8192;

/** The wire dialect a model's capacity data was actually authored against. */
function nativeTransportOf(caps: ModelCapabilities): WireApi {
  if (caps.api) return caps.api;
  switch (caps.provider) {
    case 'anthropic':
      return 'anthropic_messages';
    case 'openai':
      return 'openai_responses';
    case 'fireworks':
      return 'openai_chat_completions';
    case 'google':
      return 'gemini_interactions';
    case 'meta':
      return 'openai_responses';
    case 'xai':
      return 'openai_chat_completions';
    case 'deepseek':
      // DeepSeek first-party (official API, OpenAI format) — same breadth
      // dialect as the Fireworks lane that served these models before.
      return 'openai_chat_completions';
    default: {
      // Exhaustiveness guard — a future ModelProvider member must be mapped.
      const _exhaustive: never = caps.provider;
      throw new Error(`nativeTransportOf: unmapped provider ${String(_exhaustive)}`);
    }
  }
}

/**
 * Resolve the capacity Profile for `modelId` on `transport` (default: the
 * model's own native transport). A `transport` that does NOT match the model's
 * native wire dialect has no real capacity data for that pair — rather than
 * guess, this returns a conservative floor and reports it via `onFallback`
 * (default `console.warn`) so a missing (model, transport) entry is always
 * OBSERVABLE, never a silent wrong answer (AC-R4). Never throws.
 */
export function resolveModelProfile(
  modelId: string,
  transport?: WireApi,
  onFallback: (message: string) => void = (message) => console.warn(message),
): ModelProfile {
  const caps = resolveCapabilities(modelId);
  const nativeTransport = nativeTransportOf(caps);
  const requestedTransport = transport ?? nativeTransport;

  if (requestedTransport === nativeTransport) {
    return {
      modelId: caps.id,
      transport: nativeTransport,
      contextWindowTokens: caps.contextWindow,
      maxOutputTokens: caps.maxOutputTokens,
      tokenizerId: caps.tokenizerId,
      source: 'exact',
    };
  }

  onFallback(
    `resolveModelProfile: no capacity data for (${modelId}, ${requestedTransport}) — ` +
      `"${caps.id}" natively speaks ${nativeTransport}. Falling back to a conservative floor.`,
  );
  return {
    modelId: caps.id,
    transport: requestedTransport,
    contextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    tokenizerId: caps.tokenizerId,
    source: 'fallback',
  };
}
