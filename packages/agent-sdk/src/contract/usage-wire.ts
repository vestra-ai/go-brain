/**
 * usage-wire.ts — the AGENT_USAGE `usage` object, both ends of it, in one place (C5).
 *
 * The token ledger is three hops: a transport turns the provider's usage into a
 * NormalizedUsage (one convention: input EXCLUSIVE of the cache buckets), the sandbox
 * sink turns that into this snake_case wire object, and the server writes it verbatim to
 * task_turn_usage and prices it for the re-priced turn total. The two mappings used to
 * live in the sandbox sink and the server re-price service, so nothing could check the
 * whole path from the provider's numbers to the ledger row and the billed dollar. Here
 * both are pure functions the sink, the server and one test share (engine
 * usage-ledger.provider-truth.test.ts: the provider's numbers in, the same numbers on the
 * row, and the server's price equal to the runner's claim, on every transport).
 *
 * Moved verbatim: the sink's object (apps/sandbox stream/harness-sink.ts) and the
 * server's normalizeAgentUsage (apps/server services/turn-reprice.service.ts).
 */
import type { NormalizedUsage } from './events.js';
import type { NormalizedTokenUsage } from './usage-pricing.js';

/** The AGENT_USAGE / AGENT_OFFLOOP_USAGE `usage` object. */
export interface AgentUsageWire {
  input_tokens?: number;
  /**
   * ONE-CONVENTION marker (2026-08-04): present+true when input_tokens is EXCLUSIVE of
   * the cache buckets (every arm, current bundles). Absent on events from not-yet-upgraded
   * sandboxes, whose OpenAI-family input_tokens still INCLUDES the breakdowns.
   */
  input_tokens_exclusive?: boolean;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  orchestration_input_tokens?: number;
  orchestration_input_cached_tokens?: number;
  orchestration_output_tokens?: number;
  /** Observability only: already inside output_tokens on every provider, never priced. */
  reasoning_tokens?: number;
}

/** The sink's mapping: NormalizedUsage → the wire. Optional fields ride only when the arm set them. */
export function toAgentUsageWire(u: NormalizedUsage): AgentUsageWire {
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
    cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
    // Anthropic's 5m/1h split of the cache writes, so a 1-hour write bills 2x input
    // instead of the 5m 1.25x. Only the Anthropic arm sets these.
    ...((u.cacheCreation5mInputTokens !== undefined || u.cacheCreation1hInputTokens !== undefined) && {
      cache_creation: {
        ephemeral_5m_input_tokens: u.cacheCreation5mInputTokens ?? 0,
        ephemeral_1h_input_tokens: u.cacheCreation1hInputTokens ?? 0,
      },
    }),
    input_tokens_exclusive: true,
    ...(u.orchestrationInputTokens !== undefined && { orchestration_input_tokens: u.orchestrationInputTokens }),
    ...(u.orchestrationInputCachedTokens !== undefined && { orchestration_input_cached_tokens: u.orchestrationInputCachedTokens }),
    ...(u.orchestrationOutputTokens !== undefined && { orchestration_output_tokens: u.orchestrationOutputTokens }),
    ...(u.reasoningTokens !== undefined && { reasoning_tokens: u.reasoningTokens }),
  };
}

/**
 * The server's mapping: the wire → the pricer's shape. Null when the message carries
 * buckets whose billing semantics the server cannot vouch for (orchestration_*: no live
 * producer; whether they add to input_tokens is unknowable here, so the turn falls back
 * to the claimed figure rather than risk a wrong charge either way). reasoning_tokens are
 * already inside output_tokens: carried for observability, never priced separately.
 */
export function tokenUsageFromWire(usage: AgentUsageWire): NormalizedTokenUsage | null {
  if (
    usage.orchestration_input_tokens !== undefined ||
    usage.orchestration_input_cached_tokens !== undefined ||
    usage.orchestration_output_tokens !== undefined
  ) {
    return null;
  }
  const split5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const split1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    ...(split5m > 0 ? { cacheWrite5mTokens: split5m } : {}),
    ...(split1h > 0 ? { cacheWrite1hTokens: split1h } : {}),
  };
}
