/**
 * error-authority.ts — the ONE classification policy, proved over a SYNTHETIC spec
 * so every assertion here is about the POLICY (order, scopes, raw stamping), never
 * about any real dialect's facts. The three real specs are pinned separately by
 * error-authority.conformance.test.ts and the existing termination suites.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyProviderError,
  retryAfterMs,
  RETRY_AFTER_CAP_MS,
  STREAM_SEVERED_SUBTYPE,
  type ProviderErrorSpec,
} from '../error-authority.js';

const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';

class FakeAbort extends Error {}
class FakeConn extends Error {}

/** A minimal dialect: enough facts to reach every policy step exactly once. */
const SPEC: ProviderErrorSpec = {
  name: 'anthropic',
  abortClasses: [FakeAbort],
  codeOf: (err) => {
    const c = (err as { code?: unknown } | null | undefined)?.code;
    return typeof c === 'string' ? c : undefined;
  },
  codes: {
    boom: { kind: 'model_unavailable' },
    quota: { kind: 'billing_error', statusFallback: 429 },
    sealed: { kind: 'model_error', subtype: 'invalid_encrypted_content', statusFallback: 400 },
  },
  codeFamilies: [
    { name: 'image_codes', test: (c) => c.includes('image'), kind: 'image_error', statusFallback: 400 },
  ],
  messageRules: [
    { name: 'first', on: [400], test: (m) => m.includes('ambiguous'), kind: 'billing_error', statusFallback: 400 },
    { name: 'second', on: [400], test: (m) => m.includes('ambiguous'), kind: 'context_exceeded', statusFallback: 400 },
    { name: 'anywhere', on: 'any', test: (m) => m.includes('body too big'), kind: 'context_exceeded', statusFallback: 413 },
    { name: 'statusless_only', on: [400, undefined], test: (m) => m.includes('overflowed'), kind: 'context_exceeded', statusFallback: 400 },
  ],
  terminalRules: [
    { name: 'schema', on: 'any', test: (m) => m.includes('schema'), kind: 'model_error', subtype: 'schema_error' },
  ],
  severance: {
    isAbort: (err) => err instanceof FakeAbort,
    isConnectionError: (err) => err instanceof FakeConn,
  },
};

const classify = (err: unknown, phase?: 'streaming' | 'tools') =>
  phase === undefined ? classifyProviderError(err, SPEC) : classifyProviderError(err, SPEC, phase);

afterEach(() => {
  delete process.env[FLAG];
});

describe('classifyProviderError — step 1: abort beats everything', () => {
  it('recognizes the spec abort class by instanceof (the class never sets .name)', () => {
    const out = classify(new FakeAbort('Request was aborted.'));
    expect(out).toEqual({ kind: 'user_aborted', abortPhase: 'streaming', raw: { subtype: 'aborted', errors: [] } });
  });

  it("carries the caller's phase", () => {
    expect(classify(new FakeAbort(), 'tools')).toMatchObject({ kind: 'user_aborted', abortPhase: 'tools' });
  });

  it("recognizes the platform AbortError by name — policy, not a spec fact", () => {
    expect(classify({ name: 'AbortError', message: 'This operation was aborted' }).kind).toBe('user_aborted');
  });

  it('an abort wins over a typed code, a status, and severance all at once', () => {
    process.env[FLAG] = 'true';
    const err = Object.assign(new FakeAbort('aborted'), { status: 429, code: 'quota' });
    expect(classify(err).kind).toBe('user_aborted');
  });

  it('a plain Error with abort wording is NOT an abort (message-sniffing is deliberately absent)', () => {
    expect(classify(new Error('Request was aborted.')).kind).toBe('model_error');
  });
});

describe('classifyProviderError — step 2: severance (flag-gated), exactly today\'s branch', () => {
  it('flag ON: the spec\'s connection wrapper classifies network_error with the stream_severed subtype and the message', () => {
    process.env[FLAG] = 'true';
    const out = classify(new FakeConn('conn died'));
    expect(out).toEqual({ kind: 'network_error', message: 'conn died', raw: { subtype: STREAM_SEVERED_SUBTYPE, errors: [] } });
  });

  it('flag OFF: the same error falls through the ladder to model_error (byte-identical to today)', () => {
    const out = classify(new FakeConn('conn died'));
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('model_error');
  });

  it('a status-bearing error is never a severance — the stronger signal wins', () => {
    process.env[FLAG] = 'true';
    const out = classify(Object.assign(new FakeConn('x'), { status: 503 }));
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw).toEqual({ subtype: 'server', errors: [], api_error_status: 503 });
  });
});

describe('classifyProviderError — step 2b: a 402 outranks every typed code', () => {
  // Staging 2026-10-01: Google answered an empty prepaid balance with HTTP 402 and the
  // body status RESOURCE_EXHAUSTED. Read code-first it classified rate_limited, was
  // retried six times, and the person was told the service was busy.
  it('a 402 carrying a code that maps elsewhere is still billing, stamped 402', () => {
    const out = classify({ status: 402, code: 'boom', message: 'prepaid credits depleted' });
    expect(out).toEqual({ kind: 'billing_error', raw: { subtype: 'billing', errors: [], api_error_status: 402 } });
  });

  it('a 402 carrying a code-family member is still billing', () => {
    expect(classify({ status: 402, code: 'invalid_image', message: 'x' }).kind).toBe('billing_error');
  });

  it('a 429 still yields to the code (a billing code on a 429 is billing; anything else on a 429 is a rate limit)', () => {
    expect(classify({ status: 429, code: 'quota', message: 'no funds' }).kind).toBe('billing_error');
    expect(classify({ status: 429, message: 'slow down' }).kind).toBe('rate_limited');
  });

  it('an abort still beats a 402', () => {
    expect(classify(Object.assign(new FakeAbort('aborted'), { status: 402 })).kind).toBe('user_aborted');
  });
});

describe('classifyProviderError — step 3: the typed-code table', () => {
  it('typed code BEATS status: a 500 carrying a billing code classifies billing, not server', () => {
    const out = classify({ status: 500, code: 'quota', message: 'no funds' });
    expect(out).toEqual({ kind: 'billing_error', raw: { subtype: 'billing', errors: [], api_error_status: 500 } });
  });

  it('a status-less code with a fallback stamps the fallback status', () => {
    const out = classify({ code: 'quota', message: 'no funds' });
    expect(out.raw).toEqual({ subtype: 'billing', errors: [], api_error_status: 429 });
  });

  it('a status-less code with NO fallback stamps api_error_type (the in-stream frame shape)', () => {
    const out = classify({ code: 'boom', message: 'Overloaded' });
    expect(out).toEqual({
      kind: 'model_unavailable',
      message: 'Overloaded',
      raw: { subtype: 'server', errors: [], api_error_type: 'boom' },
    });
  });

  it('a code row may override the kind\'s canonical subtype and still carry errors on model_error', () => {
    const out = classify({ code: 'sealed', message: 'bad blob' });
    expect(out).toEqual({
      kind: 'model_error',
      message: 'bad blob',
      raw: { subtype: 'invalid_encrypted_content', errors: ['bad blob'], api_error_status: 400 },
    });
  });

  it('a code FAMILY matches when no exact row does (the image-code family shape)', () => {
    const out = classify({ code: 'invalid_image_url', message: 'could not download' });
    expect(out).toEqual({
      kind: 'image_error',
      message: 'could not download',
      raw: { subtype: 'image_error', errors: ['could not download'], api_error_status: 400 },
    });
  });

  it('an exact row wins over a family', () => {
    const spec: ProviderErrorSpec = {
      ...SPEC,
      codes: { ...SPEC.codes, invalid_image_url: { kind: 'model_error' } },
    };
    expect(classifyProviderError({ code: 'invalid_image_url', message: 'x' }, spec).kind).toBe('model_error');
  });

  it('an unknown code falls through to the ladder', () => {
    expect(classify({ status: 429, code: 'never_heard_of_it' }).kind).toBe('rate_limited');
  });
});

describe('classifyProviderError — step 4: the shared status ladder', () => {
  it.each([
    [429, 'rate_limited', 'rate_limit'],
    [401, 'auth_error', 'auth'],
    [403, 'auth_error', 'auth'],
    [402, 'billing_error', 'billing'],
    [413, 'context_exceeded', 'context'],
  ] as const)('%i → %s', (status, kind, subtype) => {
    const out = classify({ status, message: 'm' });
    expect(out.kind).toBe(kind);
    expect(out.raw).toEqual({ subtype, errors: [], api_error_status: status });
  });

  it('kinds without a message field carry none (rate_limited has no message key)', () => {
    expect('message' in classify({ status: 429, message: 'slow down' })).toBe(false);
  });

  it('404 → model_unavailable with the message (after the message rules)', () => {
    const out = classify({ status: 404, message: 'no such model' });
    expect(out).toEqual({ kind: 'model_unavailable', message: 'no such model', raw: { subtype: 'server', errors: [], api_error_status: 404 } });
  });

  it('>=500 → model_unavailable', () => {
    expect(classify({ status: 529, message: 'Overloaded' })).toEqual({
      kind: 'model_unavailable',
      message: 'Overloaded',
      raw: { subtype: 'server', errors: [], api_error_status: 529 },
    });
  });
});

describe('classifyProviderError — step 5: message rules, in declared order, scope-gated', () => {
  it('two matching rules: the FIRST declared wins', () => {
    expect(classify({ status: 400, message: 'ambiguous wording' }).kind).toBe('billing_error');
  });

  it('a rule scoped to [400] does not fire on another status', () => {
    expect(classify({ status: 503, message: 'ambiguous wording' }).kind).toBe('model_unavailable');
  });

  it('a rule scoped to [400] does not fire status-less', () => {
    expect(classify({ message: 'ambiguous wording' }).kind).toBe('model_error');
  });

  it("an 'any'-scoped rule fires on statuses the ladder does not own (the body-too-large net)", () => {
    const out = classify({ status: 418, message: 'the body too big for the proxy' });
    expect(out.raw).toEqual({ subtype: 'context', errors: [], api_error_status: 418 });
  });

  it("an 'any'-scoped rule fires status-less and stamps its fallback", () => {
    const out = classify(new Error('the body too big for the proxy'));
    expect(out.raw).toEqual({ subtype: 'context', errors: [], api_error_status: 413 });
  });

  it('a [400, undefined]-scoped rule fires on both, and only those', () => {
    expect(classify({ status: 400, message: 'overflowed' }).kind).toBe('context_exceeded');
    expect(classify(new Error('context overflowed')).kind).toBe('context_exceeded');
    expect(classify({ status: 503, message: 'overflowed' }).kind).toBe('model_unavailable');
  });

  it('a 400 matching no rule falls through to model_error (the net is not widened)', () => {
    expect(classify({ status: 400, message: 'invalid parameter: foo' }).kind).toBe('model_error');
  });
});

describe('classifyProviderError — steps 7-9: network net, terminal rules, catch-all', () => {
  it.each(['fetch failed', 'connect ECONNRESET 1.2.3.4', 'ETIMEDOUT waiting', 'connect ECONNREFUSED 10.0.0.1:443', 'broken EPIPE', 'socket hang up', 'terminated', 'a network problem'])(
    'network wording %s → network_error (the ONE shared net)',
    (message) => {
      const out = classify(new Error(message));
      expect(out.kind).toBe('network_error');
      expect(out.raw).toEqual({ subtype: 'network', errors: [] });
    },
  );

  it('"exterminated" does not match the terminated token (word-bounded)', () => {
    expect(classify(new Error('exterminated')).kind).toBe('model_error');
  });

  it('a terminal rule refines the catch-all AFTER the network net (network wording wins)', () => {
    expect(classify(new Error('schema fetch failed')).kind).toBe('network_error');
  });

  it('a terminal rule stamps its subtype on the catch-all kind', () => {
    const out = classify(new Error('response_format schema rejected'));
    expect(out).toEqual({
      kind: 'model_error',
      message: 'response_format schema rejected',
      raw: { subtype: 'schema_error', errors: ['response_format schema rejected'] },
    });
  });

  it('unknown everything → model_error carrying the message in errors', () => {
    const out = classify(new Error('boom'));
    expect(out).toEqual({ kind: 'model_error', message: 'boom', raw: { subtype: 'model_error', errors: ['boom'] } });
  });

  it('a non-Error input stringifies for the message (never throws)', () => {
    expect(classify(42)).toMatchObject({ kind: 'model_error', message: '42' });
    expect(classify(null).kind).toBe('model_error');
    expect(classify(undefined).kind).toBe('model_error');
  });
});

describe('retryAfterMs — the Retry-After reader (delta-seconds, HTTP-date, retry-after-ms; capped)', () => {
  const at = (entries: Record<string, string>) => ({ headers: new Headers(entries) });

  it("delta-seconds: '3' → 3000", () => {
    expect(retryAfterMs(at({ 'retry-after': '3' }))).toBe(3000);
  });

  it("'120' → capped at RETRY_AFTER_CAP_MS", () => {
    expect(retryAfterMs(at({ 'retry-after': '120' }))).toBe(RETRY_AFTER_CAP_MS);
    expect(RETRY_AFTER_CAP_MS).toBe(30_000);
  });

  it('an HTTP-date 5s ahead → 5000 (measured against the injected clock)', () => {
    const now = () => Date.parse('2026-08-21T10:00:00Z');
    const date = new Date(Date.parse('2026-08-21T10:00:05Z')).toUTCString();
    expect(retryAfterMs(at({ 'retry-after': date }), now)).toBe(5000);
  });

  it('an HTTP-date in the past → undefined (stale hint, fall back to our backoff)', () => {
    const now = () => Date.parse('2026-08-21T10:00:00Z');
    const date = new Date(Date.parse('2026-08-21T09:59:00Z')).toUTCString();
    expect(retryAfterMs(at({ 'retry-after': date }), now)).toBeUndefined();
  });

  it('garbage → undefined', () => {
    expect(retryAfterMs(at({ 'retry-after': 'soonish' }))).toBeUndefined();
  });

  it("retry-after-ms wins over retry-after (both SDKs' precedence), and is capped too", () => {
    expect(retryAfterMs(at({ 'retry-after-ms': '1500', 'retry-after': '3' }))).toBe(1500);
    expect(retryAfterMs(at({ 'retry-after-ms': '99999999' }))).toBe(RETRY_AFTER_CAP_MS);
  });

  it('plain-object headers work (the duck-typed error shapes tests construct)', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2000);
  });

  it('no headers / no error → undefined', () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });
});
