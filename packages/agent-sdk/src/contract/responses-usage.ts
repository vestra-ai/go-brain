/**
 * responses-usage.ts — the ONE reader of an OpenAI Responses `usage` payload.
 *
 * Two lanes bill this wire: the runner's Responses transport (normalizeResponsesUsage)
 * and the server's composer (usageFromResponses). Each used to read the payload with
 * its own code, and they drifted: the composer pinned cache writes to 0 while the
 * transport billed them at 1.25x input, so every composer cache write on GPT-5.6+ was
 * priced as plain input. Both lanes now read the wire here and differ only in the
 * convention they stamp on the result.
 *
 * Pure, and typed `unknown` on purpose: `cache_write_tokens` (GPT-5.6+) is not in the
 * OpenAI SDK's `input_tokens_details` type, and the composer reads a raw SSE frame
 * that never passed through that type at all.
 */

/** A Responses usage payload as the wire reports it: INCLUSIVE input plus its two breakdowns. */
export interface ResponsesUsageReading {
  /** The whole prompt. Contains `cachedTokens` and `cacheWriteTokens` (OpenAI's convention). */
  inputTokens: number;
  /** Prompt tokens served from the cache, a breakdown OF `inputTokens`. */
  cachedTokens: number;
  /** Prompt tokens written to the cache (GPT-5.6+, billed at the row's write rate), a breakdown OF `inputTokens`. */
  cacheWriteTokens: number;
  /** Completion tokens. Already contains the reasoning tokens, which bill as output. */
  outputTokens: number;
  /** The reasoning share of `outputTokens`, for observability only. Never priced on its own. */
  reasoningTokens: number;
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Read a Responses `usage` payload. Verified live 2026-07-10: `cache_write_tokens`
 * is a breakdown of `input_tokens` like `cached_tokens` (a fresh 2,610-token prompt
 * reported written=2,607 within input). The breakdowns are clamped so they never sum
 * past the input they are part of: written first, then cached out of what remains,
 * so a malformed payload can never make a bucket negative.
 */
export function readResponsesUsage(usage: unknown): ResponsesUsageReading {
  const u = (usage ?? {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
    output_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const inputTokens = count(u.input_tokens);
  const cacheWriteTokens = Math.min(count(u.input_tokens_details?.cache_write_tokens), inputTokens);
  const cachedTokens = Math.min(count(u.input_tokens_details?.cached_tokens), inputTokens - cacheWriteTokens);
  return {
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: count(u.output_tokens),
    reasoningTokens: count(u.output_tokens_details?.reasoning_tokens),
  };
}
