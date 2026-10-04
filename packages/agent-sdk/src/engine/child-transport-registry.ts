/**
 * Per-child transport/model routing + single-shot fallback (Agent-v2 Task 10).
 *
 * An Agent-v2 batch child may request its OWN model/provider (`children[].model`
 * / `.provider`). This module resolves that request to a `{ transport, model }`
 * pair and provides the single-shot fallback the Agent tool wraps each child run
 * in.
 *
 * WHY THE TRANSPORT FACTORY IS INJECTED: the engine layer is provider-neutral and
 * NEVER imports a concrete provider transport — `AnthropicMessagesTransport` was
 * the documented "poison edge" (see engine/transport.ts UnsetTransport). The
 * product (apps/sandbox) owns the model→Transport construction
 * (`selectNativeTransport`) and injects it here as `ChildTransportFactory`, so the
 * 4-target provider roadmap (Anthropic / OpenAI Responses / Chat Completions (open
 * models) / Gemini) is reused, not reinvented. The resolved model id encodes the wire
 * dialect (claude-* → Anthropic, gpt-* → OpenAI Responses, glm-* → Chat
 * Completions, gemini-* → Gemini), so a model→Transport factory covers all four.
 */

import type { Transport } from './transport.js';

/** A child's per-run routing request (the Agent-v2 `children[]` overrides). */
export interface ChildModelOverride {
  /** Per-child model override; absent ⇒ inherit the parent model. */
  model?: string;
  /** Per-child provider override; presence (with or without `model`) triggers routing. */
  provider?: string;
}

/** A resolved transport + model pair the subagent loop runs on. */
export interface TransportModelPair {
  transport: Transport;
  model: string;
}

/**
 * Builds a Transport for a routed child model. Injected by the product layer
 * (apps/sandbox `selectNativeTransport`) because the engine never constructs a
 * concrete provider transport itself.
 */
export type ChildTransportFactory = (model: string) => Transport;

/**
 * Resolve a child's `{ transport, model }`.
 *
 *  - No `model`/`provider` override → the PARENT pair, returned VERBATIM (the same
 *    object reference), so a no-override child is byte-identical to Task 9 (parent
 *    transport + parent model, same billing).
 *  - Override present → a provider-specific pair: the resolved model (`override.model`
 *    falling back to the parent model) and the transport the injected factory builds
 *    for it. When no factory is wired (or none is needed), the parent transport is
 *    kept and only the model is re-stamped — in production the factory is always
 *    injected.
 */
export function resolveChildTransport(
  override: ChildModelOverride,
  parent: TransportModelPair,
  makeTransport?: ChildTransportFactory,
): TransportModelPair {
  if (!override.model && !override.provider) return parent;
  const model = override.model ?? parent.model;
  if (!makeTransport) return { transport: parent.transport, model };
  return { transport: makeTransport(model), model };
}

/** The outcome of a single-shot fallback run. */
export interface ChildFallbackResult<T> {
  value: T;
  /** True iff the primary attempt threw and the fallback attempt produced `value`. */
  usedFallback: boolean;
}

/**
 * Run a child once on `primaryModel`; on the FIRST throw, retry ONCE on
 * `fallbackModel` (mirrors the parent loop's single `cfg.retry.fallbackModel`
 * fallback in native-harness `startStreamWithRetry`).
 *
 *  - `primaryModel === fallbackModel` (a no-override child whose resolved model IS
 *    the parent model) → there is nothing distinct to fall back to: a single
 *    attempt, the throw rethrows (byte-identical to Task 9's no-retry behavior).
 *  - `shouldRetry(err) === false` → suppress the retry and rethrow (the caller uses
 *    this to never fall back on a user abort, mirroring native-harness which never
 *    retries an abort).
 */
export async function runChildWithFallback<T>(args: {
  run: (model: string) => Promise<T>;
  primaryModel: string;
  fallbackModel: string;
  shouldRetry?: (err: unknown) => boolean;
}): Promise<ChildFallbackResult<T>> {
  const { run, primaryModel, fallbackModel, shouldRetry } = args;
  try {
    return { value: await run(primaryModel), usedFallback: false };
  } catch (err) {
    if (primaryModel === fallbackModel || (shouldRetry && !shouldRetry(err))) throw err;
    return { value: await run(fallbackModel), usedFallback: true };
  }
}
