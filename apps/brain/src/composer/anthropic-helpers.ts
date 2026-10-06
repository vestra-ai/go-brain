// Pricing, usage and error helpers taken from Vestra's agent loop.
import { APIUserAbortError } from '@anthropic-ai/sdk';

/** Anthropic's usage on the wire. `cache_creation` splits the cache writes by how long they live: 5 minutes or 1 hour. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

/** The same usage in Go's field names. The 5m/1h split rides along only when the wire carried it. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
}

export function normalizeAnthropicUsage(u: AnthropicUsage): NormalizedUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    ...(u.cache_creation
      ? {
          cacheCreation5mInputTokens: u.cache_creation.ephemeral_5m_input_tokens ?? 0,
          cacheCreation1hInputTokens: u.cache_creation.ephemeral_1h_input_tokens ?? 0,
        }
      : {}),
  };
}

type Rate = { in: number; out: number; cacheRead: number; cacheWrite: number };

/**
 * USD per million tokens for the models Go runs (COMPOSER_MODEL and SIDE_MODEL), from Anthropic's pricing page.
 * cacheWrite is the 5-minute write, 1.25x input; a 1-hour write is 2x input.
 */
const RATES: ReadonlyArray<{ match: string; rate: Rate }> = [
  { match: 'haiku', rate: { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 } }, // claude-haiku-4-5
  { match: 'sonnet-5', rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 } }, // claude-sonnet-5-5, priced as Sonnet 5
];
/** Any other model is priced at the Sonnet tier, so an estimate is never free. */
const OTHER_RATE: Rate = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const ONE_HOUR_WRITE_INPUT_MULTIPLE = 2;
const M = 1_000_000;

function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  return RATES.find((r) => m.includes(r.match))?.rate ?? OTHER_RATE;
}

/**
 * What one request cost in USD. When the wire splits the cache writes into 5-minute and 1-hour, the split decides the
 * price and the total is ignored; without it every write is priced as a 5-minute write.
 */
export function computeAnthropicCostUsd(u: AnthropicUsage, model: string): number {
  const r = rateFor(model);
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const hasSplit = w5m > 0 || w1h > 0;
  const write5m = hasSplit ? w5m : (u.cache_creation_input_tokens ?? 0);
  const write1h = hasSplit ? w1h : 0;
  return (
    (u.input_tokens * r.in +
      u.output_tokens * r.out +
      (u.cache_read_input_tokens ?? 0) * r.cacheRead +
      write5m * r.cacheWrite +
      write1h * r.in * ONE_HOUR_WRITE_INPUT_MULTIPLE) / M
  );
}

/** What the composer needs to know about a model: its canonical id and its longest answer. */
export interface ModelCapabilities {
  id: string;
  maxOutputTokens: number;
}

const MODELS: ReadonlyArray<{ match: string; caps: ModelCapabilities }> = [
  { match: 'sonnet-5-5', caps: { id: 'claude-sonnet-5-5', maxOutputTokens: 128_000 } },
  { match: 'haiku-4-5', caps: { id: 'claude-haiku-4-5', maxOutputTokens: 64_000 } },
];

/** Dated and [1m] ids resolve to their model; any other id keeps its own name and a careful 8,192-token answer. */
export function resolveCapabilities(modelId: string): ModelCapabilities {
  const lower = modelId.toLowerCase();
  const hit = MODELS.find((m) => lower.includes(m.match));
  return hit ? { ...hit.caps } : { id: lower, maxOutputTokens: 8192 };
}

export type ErrorKind =
  | 'user_aborted' | 'rate_limited' | 'auth_error' | 'billing_error' | 'context_exceeded' | 'model_unavailable'
  | 'network_error' | 'request_invalid' | 'image_error' | 'model_error';

/** Anthropic's error types, from an HTTP error or an error frame in the stream (which has no status). */
const CODES: Readonly<Record<string, ErrorKind>> = {
  overloaded_error: 'model_unavailable',
  api_error: 'model_unavailable',
  timeout_error: 'model_unavailable',
  not_found_error: 'model_unavailable',
  rate_limit_error: 'rate_limited',
  authentication_error: 'auth_error',
  permission_error: 'auth_error',
  billing_error: 'billing_error',
  request_too_large: 'context_exceeded',
  payload_too_large: 'context_exceeded',
};

/**
 * Anthropic answers 400 invalid_request_error for several different failures, and only the message tells them apart.
 * The order matters: too many images is a context overflow, and must come before the image rule's wider net.
 */
const MESSAGE_RULES: ReadonlyArray<{ on: 'any' | readonly number[]; kind: ErrorKind; test: (m: string) => boolean }> = [
  { on: [400], kind: 'request_invalid', test: (m) => /\bthinking\b/i.test(m) && /cannot be modified|must remain as they were|invalid signature/i.test(m) },
  { on: 'any', kind: 'context_exceeded', test: (m) => /request body is too large|payload too large/i.test(m) },
  { on: [400], kind: 'billing_error', test: (m) => /credit balance is too low/i.test(m) },
  { on: [400], kind: 'context_exceeded', test: (m) => /too long|context|maximum.*tokens/i.test(m) },
  {
    on: [400],
    kind: 'context_exceeded',
    test: (m) => /too many images|maximum of \d+ images|images?\s+(is|are)\s+allowed|images?\s+per\s+request/i.test(m),
  },
  {
    on: [400],
    kind: 'image_error',
    test: (m) => /\bimage\b/i.test(m) && /could not process|unsupported|invalid|exceeds|does not match|too large|unable to/i.test(m),
  },
];

const NETWORK_WORDING = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|socket hang up|\bterminated\b/i;

/** The error's Anthropic type: on the error itself, inside the body's envelope, or on a bare legacy body. */
function codeOf(err: unknown): string | undefined {
  const e = err as { type?: unknown; error?: { type?: unknown; error?: { type?: unknown } } } | null | undefined;
  const t = e?.type ?? e?.error?.error?.type ?? e?.error?.type;
  return typeof t === 'string' ? t : undefined;
}

/** What kind of failure a thrown Anthropic error (or an abort) is. Never throws. */
export function classifyAnthropicError(err: unknown): { kind: ErrorKind } {
  const e = err as { status?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (err instanceof APIUserAbortError || e?.name === 'AbortError') return { kind: 'user_aborted' };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 402) return { kind: 'billing_error' };
  const code = codeOf(err);
  if (code !== undefined && Object.prototype.hasOwnProperty.call(CODES, code)) return { kind: CODES[code] as ErrorKind };
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 401 || status === 403) return { kind: 'auth_error' };
  if (status === 413) return { kind: 'context_exceeded' };
  for (const rule of MESSAGE_RULES) {
    if ((rule.on === 'any' || (status !== undefined && rule.on.includes(status))) && rule.test(message)) return { kind: rule.kind };
  }
  if (status === 404 || (status !== undefined && status >= 500)) return { kind: 'model_unavailable' };
  if (NETWORK_WORDING.test(message)) return { kind: 'network_error' };
  return { kind: 'model_error' };
}
