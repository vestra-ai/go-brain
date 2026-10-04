/**
 * thinking-support — per-model config resolution for extended thinking
 * (Anthropic) and reasoning (OpenAI Responses), driven by the @bash/shared model
 * capability registry.
 *
 * The transports request thinking/reasoning ONLY when:
 *   1. the run's model's registry `thinking.mode` is a thinking/reasoning mode
 *      (NOT 'none'), and
 *   2. the per-arm enable flag is ON (default ON; an env flag lets a founder kill
 *      it without a redeploy).
 *
 * Each Anthropic `mode` maps to a DISTINCT wire shape (getting it wrong is a hard
 * 400, not a soft mislabel — verified against the SDK + Anthropic docs):
 *   - 'enabled'    thinking:{type:'enabled', budget_tokens:N} + interleaved beta,
 *                  PLUS output_config:{effort} iff the model supports the effort
 *                  param (registry `thinking.effort` present). Haiku/Sonnet 4.5
 *                  have no effort → omit output_config; Opus 4.5 has effort → send.
 *   - 'adaptive'   thinking:{type:'adaptive'} (NO budget) + output_config:{effort}
 *                  (effort always present). NO interleaved beta. (Opus 4.8/4.7/4.6,
 *                  Sonnet 4.6 — these 400 on thinking:{type:'enabled'}.)
 *   - 'always_on'  send NO `thinking` field (thinking is always on; a
 *                  thinking:{type:'disabled'} is rejected) + output_config:{effort}.
 *                  (Fable 5, Mythos 5, Mythos Preview.)
 *   - 'none'       null (no thinking field at all).
 *   - 'reasoning'  OpenAI mode — the Anthropic resolver returns null; handled by
 *                  the OpenAI resolver below.
 *
 * Pure + env-driven (no network, no SDK import) so it unit-tests trivially and the
 * Claude SDK arm is never touched (this module is only consumed by the native,
 * openai_responses and gemini_interactions transports, all gated behind
 * ENABLE_NATIVE_RUNTIME).
 */

import { resolveCapabilities } from '../contract/model-capabilities.js';

/** Anthropic extended-thinking budget. Cost-aware default; NOT max_tokens. */
const DEFAULT_THINKING_BUDGET = 4000;
/** Anthropic API floor: budget_tokens must be ≥ 1024. */
const MIN_THINKING_BUDGET = 1024;
/** Keep the budget strictly below max_tokens, with headroom for the actual answer. */
const BUDGET_HEADROOM = 1024;

/** The interleaved-thinking beta — lets thinking occur BETWEEN tool calls in the loop. */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/** True when an env flag is explicitly set to a falsey value ('off'|'0'|'false'|'no'). */
function envDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

/** The effort levels the Anthropic output_config.effort field accepts. */
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The resolved Anthropic thinking config, OR null to omit thinking entirely.
 *
 * Each field is present only when the model's mode requires it:
 *   - `thinking`     present for 'enabled' (manual budget) and 'adaptive'
 *                    ({type:'adaptive'}); ABSENT for 'always_on' (send no field).
 *   - `outputConfig` present whenever the model supports the effort param.
 *   - `beta`         present only for 'enabled' (the interleaved-thinking header).
 */
export interface AnthropicThinkingConfig {
  thinking?:
    | { type: 'enabled'; budget_tokens: number; display: 'summarized' }
    | { type: 'adaptive'; display: 'summarized' };
  outputConfig?: { effort: AnthropicEffort };
  /** The anthropic-beta header value to send (interleaved thinking, 'enabled' only). */
  beta?: string;
}

/**
 * Compute the manual thinking budget for an 'enabled' model. Defaults to
 * DEFAULT_THINKING_BUDGET, overridable via NATIVE_THINKING_BUDGET, always clamped
 * to [MIN, maxTokens - headroom) so it never violates budget_tokens < max_tokens.
 */
function resolveBudget(maxTokens: number): number {
  const raw = Number(process.env.NATIVE_THINKING_BUDGET);
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_THINKING_BUDGET;
  // Upper bound: strictly below max_tokens (leave headroom for the answer). Never
  // below MIN. If max_tokens is pathologically small the floor wins (the API will
  // still 400, but that's a caller misconfig, not a thinking bug).
  const upper = Math.max(MIN_THINKING_BUDGET, maxTokens - BUDGET_HEADROOM);
  return Math.min(Math.max(requested, MIN_THINKING_BUDGET), upper);
}

/**
 * Resolve the Anthropic thinking config for a run, or null to OMIT thinking.
 *
 * Registry-driven: `resolveCapabilities(model).thinking.{mode,effort}` selects the
 * wire shape per the mode table in the module doc. null when the model's mode is
 * 'none' (or 'reasoning', which is OpenAI's), OR when NATIVE_THINKING is disabled.
 */
export function resolveAnthropicThinking(
  model: string,
  maxTokens: number,
): AnthropicThinkingConfig | null {
  if (envDisabled(process.env.NATIVE_THINKING)) return null;

  const { mode, effort } = resolveCapabilities(model).thinking;
  // effort is one of low|medium|high|max|xhigh — all valid output_config.effort
  // members in the installed SDK; cast narrows the optional-undefined off.
  const outputConfig = effort ? { effort: effort as AnthropicEffort } : undefined;

  // display:'summarized' is PINNED explicitly on both thinking shapes. The API
  // docs claim it is the default, but on 2026-07-08 the effective default for
  // `adaptive` flipped to the `omitted` form (signature_delta only, no
  // thinking_delta text) with no code change on our side — every Anthropic
  // model lost visible thinking on both surfaces overnight. Never rely on a
  // provider-side default for a user-visible contract. (The OpenAI arm pins
  // its analogue the same way: summary:'auto' in resolveOpenAIReasoning.)
  switch (mode) {
    case 'enabled':
      return {
        thinking: { type: 'enabled', budget_tokens: resolveBudget(maxTokens), display: 'summarized' },
        ...(outputConfig ? { outputConfig } : {}),
        beta: INTERLEAVED_THINKING_BETA,
      };
    case 'adaptive':
      // No budget_tokens, no interleaved beta. effort is always present here.
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(outputConfig ? { outputConfig } : {}),
      };
    case 'always_on':
      // Thinking is always on for these models ({type:'disabled'} is rejected) —
      // but sending NO thinking field leaves `display` at the per-model default,
      // which is 'omitted' on the newest models (Fable/Mythos): thinking streams
      // as signature-only with EMPTY text and the user sees nothing (07-09: the
      // display pin fixed adaptive models while Fable stayed dark — this branch
      // was the hole). These models ACCEPT the adaptive-shaped config
      // (probe-verified via the production proxy, 07-09), and it is the only
      // vehicle for display, so pin it here exactly like the branches above.
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(outputConfig ? { outputConfig } : {}),
      };
    case 'none':
    case 'reasoning':
    default:
      return null;
  }
}

/**
 * The resolved OpenAI reasoning config (Shared.Reasoning shape: effort + summary).
 *
 * REASON-1: `effort` accepts `xhigh`/`max` as input (env override or registry);
 *            both normalize to `xhigh` — the SDK-typed top tier, honored on the
 *            wire by the GPT-5.6 family (probes 2026-08-06 echoed both `max`
 *            and `xhigh` back verbatim). It reaches the wire only for models
 *            whose registry `effortCeiling` is 'max'; everywhere else it clamps
 *            DOWN to `high`.
 * REASON-3: `summary` is OPTIONAL — always sent for OpenAI.
 */
export interface OpenAIReasoningConfig {
  /** OpenAI vocab: minimal|low|medium|high|xhigh ('xhigh' = the top tier the
   *  pinned SDK types; the API treats 'max' as its alias). */
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Ask the API to stream a human-readable reasoning summary. ALWAYS sent for
   * OpenAI.
   */
  summary?: 'auto';
}

/**
 * Resolve the OpenAI reasoning config for a run, or null to OMIT it.
 *
 * Registry-driven: reasoning ONLY when `resolveCapabilities(model).thinking.mode
 * === 'reasoning'`. null otherwise OR when OPENAI_REASONING is disabled.
 *
 * REASON-2: effort default + ceiling clamp: default medium; `minimal`
 *   normalizes to `low`, `max` to `xhigh`; the result clamps DOWN to the
 *   model's `thinking.effortCeiling` (absent ⇒ 'high', the safe pre-max
 *   vocabulary — superseded models never see a tier they might 400 on).
 *
 * REASON-3: summary is always sent for OpenAI.
 */
export function resolveOpenAIReasoning(model: string): OpenAIReasoningConfig | null {
  if (envDisabled(process.env.OPENAI_REASONING)) return null;

  const caps = resolveCapabilities(model);
  if (caps.thinking.mode !== 'reasoning') return null;

  // OpenAI reasoning-effort vocabulary (minimal|low|medium|high|xhigh).
  // `minimal` normalizes to `low`; `max` to `xhigh` (top-tier aliases).
  type Effort = 'low' | 'medium' | 'high' | 'xhigh';
  const normalize = (e: string): Effort | null => {
    const v = e.trim().toLowerCase();
    if (v === 'minimal') return 'low';
    if (v === 'max') return 'xhigh';
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') return v;
    return null;
  };

  // Clamp to the model's registry-declared ceiling — the top tier reaches the
  // wire only for models verified to honor it (effortCeiling:'max'); everything
  // else rounds down to high, exactly the pre-max behavior.
  const allowTop = caps.thinking.effortCeiling === 'max';
  const clamp = (e: Effort): Effort => (e === 'xhigh' && !allowTop ? 'high' : e);

  const providerDefault: Effort = 'medium';

  const registryEffort = caps.thinking.effort ? normalize(caps.thinking.effort) : null;
  const envRaw = process.env.OPENAI_REASONING_EFFORT;
  const envEffort = envRaw ? normalize(envRaw) : null;
  const requested: Effort = envEffort ?? registryEffort ?? providerDefault;

  const effort = clamp(requested);

  // OpenAI always sends the reasoning summary.
  return { effort, summary: 'auto' };
}

/**
 * The resolved Gemini Interactions thinking config, or null to OMIT both fields.
 *
 * Registry-driven: thinking ONLY when `resolveCapabilities(model).thinking.mode ===
 * 'reasoning'`, and the GEMINI_THINKING kill switch is not off. The Interactions
 * vocabulary is minimal|low|medium|high; the registry's `max`/`xhigh` clamp DOWN
 * to high. `thinking_summaries:'auto'` is what makes `thought_summary` deltas exist
 * on the wire — without it the desk's thinking pill sits static for the whole
 * reasoning gap.
 */
export interface GeminiThinkingConfig {
  thinking_level: 'minimal' | 'low' | 'medium' | 'high';
  thinking_summaries: 'auto';
}

export function resolveGeminiThinking(model: string): GeminiThinkingConfig | null {
  if (envDisabled(process.env.GEMINI_THINKING)) return null;

  const caps = resolveCapabilities(model);
  if (caps.thinking.mode !== 'reasoning') return null;

  type Level = GeminiThinkingConfig['thinking_level'];
  const normalize = (e: string): Level | null => {
    const v = e.trim().toLowerCase();
    if (v === 'max' || v === 'xhigh') return 'high';
    if (v === 'minimal' || v === 'low' || v === 'medium' || v === 'high') return v;
    return null;
  };

  const registryLevel = caps.thinking.effort ? normalize(caps.thinking.effort) : null;
  const envRaw = process.env.GEMINI_THINKING_LEVEL;
  const envLevel = envRaw ? normalize(envRaw) : null;
  return { thinking_level: envLevel ?? registryLevel ?? 'medium', thinking_summaries: 'auto' };
}
