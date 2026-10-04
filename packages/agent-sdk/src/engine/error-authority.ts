/**
 * error-authority.ts — ONE "what is this error, and do we retry it" policy for every
 * provider lane.
 *
 * Adding a provider means supplying a spec, never re-deciding the policy, and never
 * adding a branch beside the rail. A classification bug fixed here is fixed on every
 * lane; a fix proposed inside a transport's classifier is the smell this module exists
 * to end. The shape is severed-recognizer.ts's, generalized: the POLICY (order, the
 * status ladder, the one network net) lives here once; the per-SDK FACTS (abort
 * classes, how to read the typed code, the code table, the prose rules, the severance
 * spec) are DATA each dialect supplies as a ProviderErrorSpec. Until this module the
 * two real classifier bodies were copies ("Mirrors classifyAnthropicError exactly …
 * this mirror had missed it"), Gemini borrowed the ANTHROPIC one (wrong SDK's
 * classes), and a fix could land in one arm and miss the default one — the disease.
 *
 * The policy order, each step owed to a real incident:
 *   1 abort           — clean stop, recognized by CLASS (neither SDK's abort wrapper
 *                       sets `.name`; the platform AbortError name check is policy).
 *   2 severance       — flag-gated; a transport-layer disconnect is retryable
 *                       (incident a7ea0665; staging task 47faf57f).
 *   2b HTTP 402       — Payment Required has exactly one meaning on every lane: the
 *                       provider account behind our key is out of credit. It outranks
 *                       the typed code, because a code can name a FAMILY that a 402
 *                       narrows: Google answers an empty prepaid balance with HTTP 402
 *                       and the body status RESOURCE_EXHAUSTED, the same code it puts on
 *                       a per-minute limit. Read code-first, the dead key classified
 *                       rate_limited, was retried six times, and the person was told
 *                       "Service is busy" (staging 2026-10-01, tasks 59284c91, 65ec2807).
 *   3 typed code      — the SDK's structured code/type. BEFORE the rest of the status
 *                       ladder: a quota error arrives status-less with only a code
 *                       (OpenAI SSE re-throw), an overload arrives status-less with only
 *                       a type (Anthropic in-stream frame), and when both are present
 *                       the code is the more specific fact (triage 2026-08-19; W1-C).
 *                       A 429 stays below it on purpose: OpenAI sends insufficient_quota
 *                       on a 429, and only the code says the credit is gone.
 *   4 status ladder A — 429 / 401 / 403 / 413: statuses with one meaning.
 *   5 message rules   — the documented prose exception, carried VERBATIM per dialect
 *                       as named, scope-gated rules (Anthropic returns 400
 *                       invalid_request_error for credit/context/image failures with
 *                       only the message to distinguish them). Before 404/5xx so the
 *                       any-status nets (body-too-large on a 5xx proxy reply) keep
 *                       today's win.
 *   6 status ladder B — 404 / >=500 → model_unavailable.
 *   7 network wording — the ONE net. undici/node wordings (`terminated`, `socket
 *                       hang up`, ECONNREFUSED…) are lane-independent; keeping this
 *                       per-dialect is exactly how the 08-19 fix reached one arm and
 *                       missed the others.
 *   8 terminal rules  — refinements of the catch-all (distinct raw.subtype, kind
 *                       stays model_error), AFTER the net so wording overlaps keep
 *                       today's resolution.
 *   9 model_error.
 *
 * Raw-byte compatibility is a hard constraint (journal consumers): every stamp here
 * reproduces what the two live classifiers wrote — `api_error_status` wherever one
 * was stamped (with each row's historical fallback when the error carries none), the
 * Anthropic arm's `api_error_type` for a status-less typed frame whose row declares
 * no fallback, `errors: [message]` only on image_error/model_error. classify NEVER
 * throws: it runs inside the terminal catch that must always produce a turn_end.
 */
import type { TerminationRaw, TurnOutcome } from '../contract/turn-outcome.js';
import { severedStreamRetryEnabled, networkWaitEnabled } from '../policy/feature-flags.js';
import { isSeveredStream, type SeveranceSpec } from './severed-recognizer.js';

/** raw.subtype stamped on a severed classification (flag ON) — the engine's re-issue key. */
export const STREAM_SEVERED_SUBTYPE = 'stream_severed';

/**
 * Follow-up B item 3 — raw.subtype for a BODYLESS 5xx ("502 status code (no body)"): an
 * edge or proxy answering for an upstream that is briefly gone. It kept the model_unavailable
 * kind (and so the Retry UX) but carries its own tag, the way invalid_encrypted_content does,
 * because the retry boundary owes this class a different amount of patience.
 */
export const BODYLESS_5XX_SUBTYPE = 'bodyless_5xx';

/**
 * What a bodyless 5xx waits between attempts, in ms — the generic linear backoff
 * (750, 1500, 2250) spends its three retries inside five seconds, which is shorter than an
 * edge takes to come back, so the turn died having barely waited (staging 6cffd831,
 * b2d2b365). Three entries because three is the retry budget: a fourth attempt would fall
 * through to the linear backoff, which is the right answer for a caller that raised the cap.
 */
export const BODYLESS_5XX_BACKOFF_MS: readonly number[] = [1_000, 3_000, 8_000];

/** The error subset of TurnOutcome a thrown-error classification can produce. */
export type ClassifiedErrorKind =
  | 'rate_limited'
  | 'auth_error'
  | 'billing_error'
  | 'context_exceeded'
  | 'model_unavailable'
  | 'image_error'
  | 'request_invalid'
  | 'model_error'
  | 'network_error';

/**
 * Where a classification lands: the kind plus the raw-telemetry facts.
 * `subtype` overrides the kind's canonical raw.subtype (OpenAI's
 * invalid_encrypted_content / schema_error ride model_error with their own tag —
 * startStreamWithRetry keys its one-time recovery on the former).
 * `statusFallback` is the api_error_status stamped when the error carries no HTTP
 * status — each row's value is the status the same failure wears when it DOES
 * arrive over HTTP (quota 429, context 400, body cap 413, overload 503), kept
 * per-row because the live classifiers stamped exactly these.
 */
export interface ErrorRule {
  readonly kind: ClassifiedErrorKind;
  readonly subtype?: string;
  readonly statusFallback?: number;
}

/**
 * A named prose rule. `on` scopes it to the statuses whose bodies actually carry the
 * wording (`undefined` = status-less; 'any' = the nets that fire at any status, e.g.
 * body-too-large, which a proxy can return as 413 OR pass through inside a 5xx).
 * Scope is part of the carried-over behavior, not a new invention: today's arms gate
 * each net on exactly these statuses.
 */
export interface MessageRule extends ErrorRule {
  readonly name: string;
  readonly on: 'any' | ReadonlyArray<number | undefined>;
  readonly test: (message: string) => boolean;
}

/**
 * A structured-code FAMILY (e.g. OpenAI stamps invalid_image / invalid_image_url /
 * invalid_image_format / image_parse_error / … — an open set matched by shape).
 * Consulted only after the exact rows. This tests the CODE, never prose.
 */
export interface CodeFamilyRule extends ErrorRule {
  readonly name: string;
  readonly test: (code: string) => boolean;
}

/** The per-SDK FACTS a dialect supplies. No policy lives here — see classifyProviderError. */
export interface ProviderErrorSpec {
  /** Dialect label for docs/telemetry — never branched on. */
  readonly name: 'anthropic' | 'openai' | 'gemini';
  /** SDK abort wrapper classes (instanceof); the platform AbortError name check is policy. */
  readonly abortClasses: ReadonlyArray<new (...a: never[]) => unknown>;
  /** Read the SDK's structured code/type from a thrown error, or undefined. */
  readonly codeOf: (err: unknown) => string | undefined;
  /** Structured code → rule. Consulted BEFORE the status ladder. */
  readonly codes: Readonly<Record<string, ErrorRule>>;
  /** Code families, after the exact rows. */
  readonly codeFamilies?: ReadonlyArray<CodeFamilyRule>;
  /** Prose rules between ladder A and 404/5xx, in declared order — first match wins. */
  readonly messageRules: ReadonlyArray<MessageRule>;
  /** Prose refinements of the terminal catch-all, after the network net. */
  readonly terminalRules?: ReadonlyArray<MessageRule>;
  /** The dialect's severance facts (severed-recognizer.ts owns the policy). */
  readonly severance: SeveranceSpec;
}

/**
 * The ONE network-wording net. The union of what the two arms had grown separately:
 * the base four were Anthropic's; `ECONNREFUSED|EPIPE|socket hang up|terminated`
 * came from the OpenAI arm's 2026-08-19 triage (undici's wording when the upstream
 * closes pre-commit) and now cover every lane — the Anthropic arm classifying
 * undici's `terminated` as terminal model_error was the drift this module ends.
 */
const NETWORK_WORDING =
  /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed|socket hang up|\bterminated\b/i;

type RawExtra = Partial<TerminationRaw> & { api_error_type?: string };

function raw(subtype: string, extra: RawExtra = {}): TerminationRaw {
  return { subtype, errors: [], ...extra };
}

/**
 * Build the outcome for a rule hit. The per-kind shape is fixed by the TurnOutcome
 * union: message only on the kinds that declare it, `errors: [message]` only on
 * image_error/model_error (both live arms' convention).
 */
function outcomeFor(rule: ErrorRule, message: string, extra: RawExtra): TurnOutcome {
  const kind = rule.kind;
  switch (kind) {
    case 'rate_limited':
      return { kind, raw: raw(rule.subtype ?? 'rate_limit', extra) };
    case 'auth_error':
      return { kind, raw: raw(rule.subtype ?? 'auth', extra) };
    case 'billing_error':
      return { kind, raw: raw(rule.subtype ?? 'billing', extra) };
    case 'context_exceeded':
      return { kind, raw: raw(rule.subtype ?? 'context', extra) };
    case 'model_unavailable':
      return { kind, message, raw: raw(rule.subtype ?? 'server', extra) };
    case 'network_error':
      return { kind, message, raw: raw(rule.subtype ?? 'network', extra) };
    case 'image_error':
      return { kind, message, raw: raw(rule.subtype ?? 'image_error', { ...extra, errors: [message] }) };
    case 'request_invalid':
      // Carries `errors: [message]` like its neighbours: the provider's prose is
      // the only thing that says WHICH message index and WHICH block failed, and
      // that is the whole diagnostic.
      return { kind, message, raw: raw(rule.subtype ?? 'request_invalid', { ...extra, errors: [message] }) };
    case 'model_error':
      return { kind, message, raw: raw(rule.subtype ?? 'model_error', { ...extra, errors: [message] }) };
  }
}

function appliesTo(on: MessageRule['on'], status: number | undefined): boolean {
  return on === 'any' || on.includes(status);
}

/**
 * A prose rule stamps api_error_status ONLY when it declares a fallback (the
 * schema_error refinement historically stamped nothing, even on a 400 — bytes kept).
 */
function proseStamp(rule: MessageRule, status: number | undefined): RawExtra {
  return rule.statusFallback === undefined ? {} : { api_error_status: status ?? rule.statusFallback };
}

/** Map a thrown provider error (or abort) into a terminal TurnOutcome. Never throws. */
export function classifyProviderError(
  err: unknown,
  spec: ProviderErrorSpec,
  phase: 'streaming' | 'tools' = 'streaming',
): TurnOutcome {
  const e = err as { status?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (spec.abortClasses.some((C) => err instanceof C) || e?.name === 'AbortError') {
    return { kind: 'user_aborted', abortPhase: phase, raw: raw('aborted') };
  }
  // Flag OFF ⇒ dead branch ⇒ classification byte-identical to the pre-flag world.
  // Safe this early: the recognizer refuses anything carrying an HTTP status, so
  // every stronger signal below still wins.
  if (severedStreamRetryEnabled() && isSeveredStream(err, spec.severance)) {
    return { kind: 'network_error', message, raw: raw(STREAM_SEVERED_SUBTYPE) };
  }
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 402) return outcomeFor({ kind: 'billing_error' }, message, { api_error_status: 402 });
  const code = spec.codeOf(err);
  if (code !== undefined) {
    // Own-property guard: `codes` is a plain object and the code comes off the wire —
    // 'constructor' must not resolve to Function on the never-throw path.
    const rule = Object.prototype.hasOwnProperty.call(spec.codes, code)
      ? spec.codes[code]
      : spec.codeFamilies?.find((f) => f.test(code));
    if (rule) {
      const s = status ?? rule.statusFallback;
      return outcomeFor(rule, message, s !== undefined ? { api_error_status: s } : { api_error_type: code });
    }
  }
  if (status === 429) return outcomeFor({ kind: 'rate_limited' }, message, { api_error_status: 429 });
  if (status === 401 || status === 403) return outcomeFor({ kind: 'auth_error' }, message, { api_error_status: status });
  if (status === 413) return outcomeFor({ kind: 'context_exceeded' }, message, { api_error_status: 413 });
  for (const rule of spec.messageRules) {
    if (appliesTo(rule.on, status) && rule.test(message)) return outcomeFor(rule, message, proseStamp(rule, status));
  }
  if (status === 404) return outcomeFor({ kind: 'model_unavailable' }, message, { api_error_status: 404 });
  if (status !== undefined && status >= 500) {
    return outcomeFor({ kind: 'model_unavailable' }, message, { api_error_status: status });
  }
  if (NETWORK_WORDING.test(message)) {
    return { kind: 'network_error', message, raw: raw('network') };
  }
  for (const rule of spec.terminalRules ?? []) {
    if (appliesTo(rule.on, status) && rule.test(message)) return outcomeFor(rule, message, proseStamp(rule, status));
  }
  return { kind: 'model_error', message, raw: raw('model_error', { errors: [message] }) };
}

/** How long a Retry-After hint may stretch one backoff — a mid-task turn must not park for minutes. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** Case-insensitive header read off a Headers instance or the plain objects tests construct. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === 'function') {
    const v = h.get(name);
    return typeof v === 'string' ? v : undefined;
  }
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name) {
      const v = h[k];
      return typeof v === 'string' ? v : undefined;
    }
  }
  return undefined;
}

/**
 * Retry-After → ms, or undefined. Reads `retry-after-ms` first, then `retry-after`
 * (delta-seconds or HTTP-date) — the same precedence both provider SDKs applied in
 * the retry layer this engine switched off (anthropic client.js:633/641, openai
 * client.js:541/549), so turning `maxRetries: 0` loses no header handling. A past
 * date is a stale hint → undefined (our linear backoff applies). Capped: a provider
 * asking for minutes must surface as a failed turn, not a silent park.
 */
export function retryAfterMs(err: unknown, now: () => number = Date.now): number | undefined {
  const headers = (err as { headers?: unknown } | null | undefined)?.headers;
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms !== undefined) {
    const n = Number.parseFloat(ms);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, RETRY_AFTER_CAP_MS);
  }
  const ra = headerValue(headers, 'retry-after');
  if (ra === undefined) return undefined;
  if (/^\s*\d+\s*$/.test(ra)) return Math.min(Number.parseInt(ra, 10) * 1000, RETRY_AFTER_CAP_MS);
  const date = Date.parse(ra);
  if (Number.isNaN(date)) return undefined;
  const delta = date - now();
  if (delta < 0) return undefined;
  return Math.min(delta, RETRY_AFTER_CAP_MS);
}

/**
 * How long the retry boundary waits before the next attempt, and whether the provider's
 * own hint stretched it. The whole policy lives here, beside the header reader and the cap
 * it is bounded by, rather than in the loop that sleeps: "how long do we wait for this
 * error" is the same question as "do we retry it", and the loop should only ask.
 *
 * Three inputs, in the order they win:
 *  - the BODYLESS 5xx schedule, when this outcome's subtype names that class. An edge
 *    answered for an upstream that is briefly gone, and coming back takes seconds; the
 *    generic linear backoff spent its whole budget in under five, so the turn died having
 *    barely waited (staging 6cffd831, b2d2b365). Past the schedule's length — a caller that
 *    raised maxAttempts — it falls through to the linear backoff, which is the right answer
 *    for a budget this class was never sized for.
 *  - the linear backoff otherwise: attempt N waits `linearBackoffMs * N`.
 *  - the provider's Retry-After, which STRETCHES either (never shrinks it) and is capped.
 *    With both SDKs at `maxRetries: 0` this is the only sleep between attempts, so ignoring
 *    the header would hammer a throttling upstream at our own cadence.
 */
export function retryWaitMs(
  err: unknown,
  subtype: string | undefined,
  attempt: number,
  linearBackoffMs: number,
): { waitMs: number; hinted: number | undefined } {
  const hinted = retryAfterMs(err);
  const scheduled = subtype === BODYLESS_5XX_SUBTYPE ? BODYLESS_5XX_BACKOFF_MS[attempt - 1] : undefined;
  const waitMs = Math.min(Math.max(scheduled ?? linearBackoffMs * attempt, hinted ?? 0), RETRY_AFTER_CAP_MS);
  return { waitMs, hinted };
}

// ── RETRY_BY_CAUSE_V1: what each failure is owed, by cause ─────────────────────────────────

/**
 * Why an attempt failed, in the terms that decide what the retry boundary owes it. The
 * per-provider tables are the ProviderErrorSpecs above (Anthropic, OpenAI and the lanes on its
 * envelope such as Fireworks, Gemini): they already turn each provider's wire facts into a
 * kind, so the cause is read off that kind rather than kept in a second table that would have
 * to agree with the first. One provider fact the kind cannot express is refined below: Google
 * sends a daily quota and a per-minute limit as the same RESOURCE_EXHAUSTED.
 */
export type RetryCause = 'usage_limit' | 'rate_limit' | 'overload' | 'dropped_connection';

const CAUSE_OF_KIND: Partial<Record<TurnOutcome['kind'], RetryCause>> = {
  billing_error: 'usage_limit',
  rate_limited: 'rate_limit',
  model_unavailable: 'overload',
  network_error: 'dropped_connection',
};

/**
 * What each cause is owed. A usage limit does not lift in seconds, so another attempt only
 * spends the person's wait. A rate limit and a dropped connection are not the model's fault,
 * so the fallback model is not theirs; an overload is, and keeps today's bounded schedule
 * before moving there.
 */
export const RETRY_CAUSE_POLICY: Readonly<Record<RetryCause, { readonly retry: boolean; readonly fallback: boolean }>> = {
  usage_limit: { retry: false, fallback: false },
  rate_limit: { retry: true, fallback: false },
  overload: { retry: true, fallback: true },
  dropped_connection: { retry: true, fallback: false },
};

/**
 * A rate limit's attempt budget when the caller set none. Six attempts put the unhinted
 * jitter ceilings at 0.5, 1, 2, 4 and 8 s (about 15 s at most), room for a burst limit to
 * clear; a per-minute window is covered by the provider's own hint, which every retry honours.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 6;

/** Full-jitter exponential backoff base: attempt N waits a uniform draw below 500 ms × 2^(N-1). */
export const JITTER_BASE_MS = 500;

const GOOGLE_QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure';
const GOOGLE_RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';

/**
 * The google.rpc.Status `details` a Gemini lane carries: both Gemini transports lift them off
 * the raw error body (gemini-transport.ts geminiErrorDetails) onto the thrown error's
 * `details`. Any other error has none, which leaves the kind's cause standing.
 */
function googleErrorDetails(err: unknown): ReadonlyArray<Record<string, unknown>> {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  return Array.isArray(details)
    ? details.filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
    : [];
}

/** A QuotaFailure naming a per-day quota (quotaId `…PerDay…`): the day's allowance is spent. */
function isDailyQuota(details: ReadonlyArray<Record<string, unknown>>): boolean {
  return details.some(
    (d) =>
      d['@type'] === GOOGLE_QUOTA_FAILURE &&
      Array.isArray(d.violations) &&
      d.violations.some((v: unknown) => {
        const id = (v as { quotaId?: unknown } | null | undefined)?.quotaId;
        return typeof id === 'string' && id.includes('PerDay');
      }),
  );
}

/** Google's RetryInfo.retryDelay (a protobuf Duration, `"33s"`) → ms, capped like Retry-After. */
function googleRetryDelayMs(details: ReadonlyArray<Record<string, unknown>>): number | undefined {
  const delay = details.find((d) => d['@type'] === GOOGLE_RETRY_INFO)?.retryDelay;
  if (typeof delay !== 'string' || !/^\d+(\.\d+)?s$/.test(delay)) return undefined;
  return Math.min(Number.parseFloat(delay) * 1000, RETRY_AFTER_CAP_MS);
}

/**
 * NETWORK_WAIT_V1 (Codex core/src/responses_retry.rs: a failed connection on the sampling
 * request retries with no attempt cap, 5 s doubling to 60 s, "Reconnecting... waiting for
 * network"). Once a dropped connection has used the cause's own bounded schedule, the main
 * loop's request keeps waiting for the network instead of ending the turn: the Nth such wait
 * is 5 s doubled N-1 times, capped at 60 s. Nothing answered, so there is no hint to read.
 */
export const NETWORK_WAIT_FIRST_MS = 5_000;
export const NETWORK_WAIT_MAX_MS = 60_000;
export function networkWaitMs(n: number): number {
  return Math.min(NETWORK_WAIT_FIRST_MS * 2 ** Math.max(0, n - 1), NETWORK_WAIT_MAX_MS);
}

/**
 * NETWORK_WAIT_V1: the longest the waits may run, from the first one. Codex's waits are for a
 * person whose own machine is offline; ours hold a metered box awake on our infrastructure (a
 * turn in flight keeps its work hold, vetoes the upgrade drain, and its live lines keep the
 * server's stalled-turn watchdog from ever firing), so past this the request ends exactly as an
 * exhausted one does: the turn ends as a network error, which the person sees in plain words
 * with Retry.
 */
export const NETWORK_WAIT_CEILING_MS = 12 * 60_000;

/**
 * NETWORK_WAIT_V1: how long a model request may take to answer, its response headers (the SDKs
 * stop the timer there, so a stream's body is never timed). The SDK default is ten minutes, so a
 * proxy that took the connection and never answered meant ten silent minutes between waits.
 */
export const MODEL_RESPONSE_TIMEOUT_MS = 120_000;

/** The SDK request option a model stream carries: the response timeout under NETWORK_WAIT_V1, else nothing (byte-identical). */
export function modelResponseTimeout(): { timeout?: number } {
  return networkWaitEnabled() ? { timeout: MODEL_RESPONSE_TIMEOUT_MS } : {};
}

/** The cause of one failed attempt, or undefined for a failure no retry can help. Never throws. */
export function retryCause(outcome: TurnOutcome, err: unknown): RetryCause | undefined {
  const cause = CAUSE_OF_KIND[outcome.kind];
  if (cause === 'rate_limit' && isDailyQuota(googleErrorDetails(err))) return 'usage_limit';
  return cause;
}

/**
 * How long a retried cause waits before the next attempt.
 *  - overload: exactly today's retryWaitMs (linear, the bodyless 5xx schedule, Retry-After).
 *  - rate limit: the provider's hint when it sent one (Retry-After, or Google's RetryInfo),
 *    else full jitter, so parallel sessions sharing one key do not retry in lockstep.
 *  - dropped connection: the same jitter; nothing answered, so there is no hint to read.
 */
export function causeWaitMs(
  cause: RetryCause,
  err: unknown,
  subtype: string | undefined,
  attempt: number,
  linearBackoffMs: number,
  random: () => number = Math.random,
): { waitMs: number; hinted: number | undefined } {
  if (cause === 'overload') return retryWaitMs(err, subtype, attempt, linearBackoffMs);
  const hinted = cause === 'rate_limit' ? (retryAfterMs(err) ?? googleRetryDelayMs(googleErrorDetails(err))) : undefined;
  if (hinted !== undefined && hinted > 0) return { waitMs: hinted, hinted };
  const ceiling = Math.min(JITTER_BASE_MS * 2 ** (attempt - 1), RETRY_AFTER_CAP_MS);
  return { waitMs: Math.floor(random() * ceiling), hinted: undefined };
}
