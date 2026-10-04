/**
 * openai-endpoints.ts — WHICH endpoint, and whose key, each provider's
 * OpenAI-compatible traffic goes to. ONE TABLE, TOTAL over `ModelProvider`.
 *
 * WHY A TABLE AND NOT TWO `if` CHAINS. Selection one layer up is already data:
 * `TRANSPORT_REGISTRY` (wire dialect → transport) and `DEFAULT_DIALECT_BY_PROVIDER`
 * (provider → its house dialect) are both `Record<…>` over their union, so a
 * provider added to the capability contract cannot compile until someone says which
 * wire it speaks. The ENDPOINT layer was still control flow, in two copies, and it
 * was NOT total: `defaultChatClientFor` and `defaultClientFor` each ended in an
 * unguarded `// 'openai' (and any other value)` arm. A provider added to
 * `ModelProvider` therefore compiled clean and SILENTLY BORROWED `OPENAI_API_KEY`
 * and api.openai.com — a wrong-lane call with someone else's credentials, which is
 * exactly the class the dialect table exists to prevent, one layer down. (The live
 * instance of that class: the old four-arm selector read `caps.provider` where its
 * siblings read `caps.api`, and the 'meta' row fell through to Anthropic.)
 *
 * As data, adding a provider is one row and tsc does the remembering.
 *
 * The two copies also disagreed by construction — chat-completions knew
 * fireworks/xai, responses knew meta, and each silently returned an OpenAI client
 * for the other's providers. An endpoint is a PROVIDER fact, not a dialect fact, so
 * ONE table serves both transports and the disagreement cannot recur.
 *
 * If a provider ever needs DIFFERENT endpoints per dialect (Fireworks also fronts an
 * Anthropic-shaped wire), this row grows a per-dialect split. Nothing needs it
 * today, so nothing models it today.
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { ModelProvider } from '../contract/model-capabilities.js';
import { warmClientOptions } from './warm-connections.js';

/** A provider reachable over an OpenAI-compatible wire. */
export interface OpenAICompatibleEndpoint {
  /** Env var holding the credential. In production this is the per-user sandbox
   *  token, not a real provider key — the credential proxy injects the real one. */
  readonly keyEnv: string;
  /** Env var overriding the base URL — the server credential proxy in production. */
  readonly baseEnv: string;
  /**
   * The vendor's direct endpoint, used when `baseEnv` is unset. ABSENT means send
   * NO `baseURL` at all and let the OpenAI SDK use its own default
   * (api.openai.com) — the byte-identical shape of the former `'openai'` arm.
   */
  readonly defaultBase?: string;
}

/**
 * A provider with NO OpenAI-compatible endpoint. Reaching one means a capability
 * row routed a model to an OpenAI transport for a provider that cannot serve it —
 * a programmer error, not a recoverable runtime condition. The reason is thrown
 * verbatim, so the failure names itself instead of arriving as somebody else's 401.
 */
export interface NoOpenAILane {
  readonly noLane: string;
}

export type ProviderEndpoint = OpenAICompatibleEndpoint | NoOpenAILane;

/**
 * THE ENDPOINT TABLE — total over `ModelProvider` by construction. A new provider
 * in the capability contract fails to compile here until someone decides where its
 * requests go, exactly as it already fails to compile in
 * `DEFAULT_DIALECT_BY_PROVIDER` until someone decides which wire it speaks. Both
 * layers, or neither: that is the whole point of this file.
 */
export const OPENAI_COMPATIBLE_ENDPOINTS: Readonly<Record<ModelProvider, ProviderEndpoint>> =
  Object.freeze({
    // No `defaultBase`: unset OPENAI_BASE_URL sends no baseURL at all.
    openai: { keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL' },
    // Open-model lane (GLM 5.2 + DeepSeek V4 + future open models). Its own key +
    // base so concurrent GPT and open-model sessions in one process never share a
    // base URL. FIREWORKS_BASE_URL points at the credential proxy in production.
    fireworks: {
      keyEnv: 'FIREWORKS_API_KEY',
      baseEnv: 'FIREWORKS_BASE_URL',
      defaultBase: 'https://api.fireworks.ai/inference/v1',
    },
    // xAI direct lane (Grok) — Chat-Completions-compatible at api.x.ai.
    xai: { keyEnv: 'XAI_API_KEY', baseEnv: 'XAI_BASE_URL', defaultBase: 'https://api.x.ai/v1' },
    // Meta Model API (muse-spark-1.1) — Responses-compatible at api.meta.ai.
    meta: { keyEnv: 'META_API_KEY', baseEnv: 'META_BASE_URL', defaultBase: 'https://api.meta.ai/v1' },
    // The direct DeepSeek lane was REMOVED 2026-08-17 (Google Limited Use:
    // DeepSeek's ToS reserve training rights, so no user data may reach
    // api.deepseek.com). DeepSeek models ride the 'fireworks' provider (US hosting,
    // no-training terms). Loud throw, never a silent fallback to the wrong
    // credentials — this row is the one the old chain already got right, and the
    // reason the rest of the table now exists.
    deepseek: {
      noLane:
        "The 'deepseek' provider lane was removed (2026-08-17, Google Limited Use); deepseek models ride the 'fireworks' provider",
    },
    // Anthropic and Google speak their own wires (anthropic_messages / gemini) and
    // are served by their own transports, which never call this factory. Under the
    // old `else` arm they silently received an OpenAI client pointed at
    // api.openai.com with OPENAI_API_KEY; saying so out loud is the fix.
    anthropic: {
      noLane:
        "The 'anthropic' provider has no OpenAI-compatible endpoint: its models ride the anthropic_messages dialect (AnthropicMessagesTransport)",
    },
    google: {
      noLane:
        "The 'google' provider has no OpenAI-compatible endpoint: its models ride the gemini_interactions dialect (GeminiInteractionsTransport; the legacy gemini dialect is GeminiTransport)",
    },
  });

/** A credential's sha256, never the secret itself: what a client memo keys and compares on. */
function credentialKey(secret: string | undefined): string | undefined {
  return secret === undefined ? undefined : createHash('sha256').update(secret).digest('hex');
}

/**
 * The key (credentialKey) of the credential `openAIClientFor(provider)` would build a client with
 * right now (undefined for a provider with no lane). The transports key their client memo on it: a
 * warm run outlives the runner's token, and the refresh swaps process.env, never a client already built.
 */
export function openAICredentialKey(provider: ModelProvider): string | undefined {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  return 'noLane' in endpoint ? undefined : credentialKey(process.env[endpoint.keyEnv]);
}

/** The base URL `openAIClientFor(provider)` builds against from the ambient env (undefined: the SDK default). */
export function openAILaneBase(provider: ModelProvider): string | undefined {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  if ('noLane' in endpoint) return undefined;
  const envBase = process.env[endpoint.baseEnv];
  return (envBase ? envBase : undefined) ?? endpoint.defaultBase;
}

/**
 * Build an OpenAI-compatible client from the ambient credentials for one PROVIDER.
 *
 * One process serves many concurrent sessions, so the base URL + key are chosen
 * per-model at transport time, never via a single shared OPENAI_BASE_URL. Lazy: a
 * missing key throws inside `callModel`, where `run()` classifies it.
 *
 * An EMPTY base-url env var is treated as unset on every lane. The two former arms
 * disagreed here — the `'openai'` arm tested truthiness (empty ⇒ omit) while the
 * vendor arms used `??` (empty ⇒ `baseURL: ''`, a broken base that reaches no
 * vendor). One reading, and it is the safe one.
 */
export function openAIClientFor(provider: ModelProvider, baseOverride?: string): OpenAI {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  if ('noLane' in endpoint) throw new Error(endpoint.noLane);

  const apiKey = process.env[endpoint.keyEnv];
  // LANE_FALLBACK_V1: a session that moved off its lane passes the same route on the API plane.
  const baseURL = baseOverride ?? openAILaneBase(provider);

  return new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    // One retry authority: the engine's startStreamWithRetry (round-engine.ts) — SDK retries would stack under it and run blind to our abort signal.
    maxRetries: 0,
    // WARM_CONNECTIONS_V1: the shared keep-alive pool. Off: no key at all.
    ...warmClientOptions(),
  });
}
