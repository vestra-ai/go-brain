/**
 * PR3 3a — context-overflow must survive the #1110 status-less error-surfacing path.
 *
 * The #1110 fix re-throws a proxy SSE failure (`response.failed` / top-level
 * `error`) as a plain Error carrying the JSON error `code` but NO http `status`.
 * `classifyOpenAIResponsesError` gated its context-overflow branch on
 * `status === 400`, so a `context_length_exceeded` arriving with status=undefined
 * fell through to a generic `model_error` — stripping the Compact/Continue
 * recovery UX, which keys off the `context_exceeded` classification.
 *
 * Fix: a code-first `code === 'context_length_exceeded'` check (mirroring the
 * quota/rate code-first branches), plus relaxing the wording-match regex branch
 * to fire on `(status === 400 || status === undefined)`.
 */
import { describe, it, expect } from 'vitest';
import { classifyOpenAIResponsesError } from '../openai-responses-termination.js';

describe('classifyOpenAIResponsesError — context overflow on the status-less path (3a)', () => {
  it('maps code:context_length_exceeded → context_exceeded even when status is undefined', () => {
    // The re-thrown proxy SSE failure: code present, http status ABSENT.
    const out = classifyOpenAIResponsesError({
      code: 'context_length_exceeded',
      message: 'This model\'s maximum context length is 272000 tokens.',
    });
    expect(out.kind).toBe('context_exceeded');
  });

  it('maps a status-less context-WORDING error (no code) → context_exceeded', () => {
    // A bare Error('…maximum context length is N tokens') with no status/code
    // must still classify as context-exceeded (relaxed regex branch).
    const out = classifyOpenAIResponsesError(
      new Error('This model\'s maximum context length is 200000 tokens, however you requested 250000.'),
    );
    expect(out.kind).toBe('context_exceeded');
  });

  it('still maps a status:400 context error → context_exceeded (no regression)', () => {
    const out = classifyOpenAIResponsesError({
      status: 400,
      message: 'prompt is too long: context window exceeded',
    });
    expect(out.kind).toBe('context_exceeded');
  });

  // ── Negative / regression: a genuine NON-context error must NOT be swept into
  //    context_exceeded by the relaxed (status===undefined) branch. ─────────────
  it('a status-less, non-context error stays a model_error (relaxed branch is wording-gated)', () => {
    const out = classifyOpenAIResponsesError(
      new Error('the server had an internal hiccup parsing your request'),
    );
    expect(out.kind).toBe('model_error');
  });

  it('a genuine non-context 400 (e.g. validation) still falls through to model_error', () => {
    const out = classifyOpenAIResponsesError({
      status: 400,
      message: 'invalid value for parameter temperature',
    });
    expect(out.kind).toBe('model_error');
  });

  it('an unrelated code (insufficient_quota) is unaffected — still billing_error', () => {
    const out = classifyOpenAIResponsesError({ code: 'insufficient_quota', message: 'quota' });
    expect(out.kind).toBe('billing_error');
  });
});

describe('classifyOpenAIResponsesError — 413 request-body overflow → context_exceeded (stamp-incident parity)', () => {
  // The letterhead fix (#1194 Net 3) taught classifyAnthropicError that a 413
  // "Request body is too large" is a CONTEXT overflow, not a model failure. This
  // mirror never got that branch, so the stamp incident (7 recalled reference
  // images ≈ 5.3MB base64 vs the proxy's 1MiB Fastify default) surfaced as a
  // dead-end model_error whose Try-again could never succeed — the oversized
  // transcript is persisted, so every retry replays it.
  it('maps a 413 (request body too large) → context_exceeded', () => {
    const out = classifyOpenAIResponsesError({ status: 413, message: 'Request body is too large' });
    expect(out.kind).toBe('context_exceeded');
    expect(out.raw.api_error_status).toBe(413);
  });

  it('maps the stamp-incident leaked shape (status + SDK-stringified body) → context_exceeded', () => {
    const out = classifyOpenAIResponsesError({ status: 413, message: '413 "Request body is too large"' });
    expect(out.kind).toBe('context_exceeded');
  });

  it('maps code:request_too_large on the status-less SSE re-throw path → context_exceeded', () => {
    const out = classifyOpenAIResponsesError({ code: 'request_too_large', message: 'payload too large' });
    expect(out.kind).toBe('context_exceeded');
  });

  it('maps a status-less wording-only body-too-large error → context_exceeded', () => {
    const out = classifyOpenAIResponsesError(new Error('Request body is too large'));
    expect(out.kind).toBe('context_exceeded');
  });

  it('does NOT sweep a generic 400 mentioning "large" without the body wording (stays model_error)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: 'the requested output is large' });
    expect(out.kind).toBe('model_error');
  });
});

describe('classifyOpenAIResponsesError — invalid_encrypted_content (PR4 cross-issuer recovery)', () => {
  // A reasoning blob minted by a different Responses endpoint can't be decrypted →
  // 400 invalid_encrypted_content. The issuer-guard drops stamped foreign blobs
  // proactively, but an UNSTAMPED (legacy) blob can still slip through. Tag a DISTINCT
  // subtype so startStreamWithRetry can recover (disable replay + retry) instead of
  // treating it as a dead model_error.
  it('maps code:invalid_encrypted_content → model_error with subtype invalid_encrypted_content', () => {
    const out = classifyOpenAIResponsesError({ status: 400, code: 'invalid_encrypted_content', message: 'bad blob' });
    expect(out.kind).toBe('model_error');
    expect(out.raw?.subtype).toBe('invalid_encrypted_content');
  });

  it('maps a status-less wording-only invalid_encrypted_content → the same subtype', () => {
    const out = classifyOpenAIResponsesError(
      new Error('Invalid value for reasoning.encrypted_content: invalid_encrypted_content'),
    );
    expect(out.kind).toBe('model_error');
    expect(out.raw?.subtype).toBe('invalid_encrypted_content');
  });
});

describe('classifyOpenAIResponsesError — strict-schema 400 sub-branch (3b defense-in-depth)', () => {
  // If a strict-schema 400 ever slips past the fail-closed preflight, it must
  // surface as a CLEAR schema error. We keep kind:'model_error' (so it inherits
  // the existing Retry UX) but stamp a DISTINCT raw.subtype so telemetry / the
  // terminal-reason surface can tell a schema 400 from a generic model failure.
  it('a strict-schema validation 400 → model_error with raw.subtype "schema_error" (carries the wording)', () => {
    const out = classifyOpenAIResponsesError({
      status: 400,
      message:
        "Invalid schema for response_format 'structured_output': 'required' is required to be supplied and to be an array including every key in properties.",
    });
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('schema_error');
    // The schema wording is preserved on the message (Retry UX shows it).
    expect(out.kind === 'model_error' && /schema/i.test(out.message)).toBe(true);
  });

  it('a status-less json_schema/response_format failure → model_error subtype "schema_error" (not swept into context)', () => {
    const out = classifyOpenAIResponsesError(
      new Error('response_format json_schema rejected: additionalProperties must be false'),
    );
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('schema_error');
  });

  it('a plain non-schema model error keeps the generic subtype "model_error" (sub-branch is wording-gated)', () => {
    const out = classifyOpenAIResponsesError(new Error('the model produced an unparseable response'));
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('model_error');
  });
});

// PR-ERR-1 — the two new producers: 404 → model_unavailable (audit S6) and a
// wording/code-gated image_error (audit S7). Both must leave every existing branch
// (billing/rate/auth/context/quota/schema) untouched.
describe('classifyOpenAIResponsesError — 404 model-not-found → model_unavailable (S6)', () => {
  it('maps a 404 (unknown/unentitled model id) → model_unavailable (was model_error)', () => {
    const out = classifyOpenAIResponsesError({ status: 404, message: 'The model `gpt-5.9` does not exist or you do not have access to it.' });
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw.subtype).toBe('server');
    expect(out.raw.api_error_status).toBe(404);
    expect('message' in out).toBe(true);
  });

  it('does NOT reclassify other statuses — a 401 stays auth_error', () => {
    const out = classifyOpenAIResponsesError({ status: 401, message: 'Unauthorized' });
    expect(out.kind).toBe('auth_error');
  });

  it('a >=500 still maps to model_unavailable (no regression)', () => {
    const out = classifyOpenAIResponsesError({ status: 503, message: 'Service unavailable' });
    expect(out.kind).toBe('model_unavailable');
    expect(out.raw.api_error_status).toBe(503);
  });
});

describe('classifyOpenAIResponsesError — image rejection → image_error (S7)', () => {
  it('maps a 400 image-rejection (wording) → image_error', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: 'You uploaded an unsupported image. Please make sure your image is a valid PNG, JPEG, GIF, or WebP.' });
    expect(out.kind).toBe('image_error');
    expect(out.raw.subtype).toBe('image_error');
    expect(out.raw.api_error_status).toBe(400);
    if (out.kind === 'image_error') expect(out.message).toContain('unsupported image');
  });

  it('maps an image error code on the status-less SSE re-throw path → image_error', () => {
    // #1110 path: code present, http status ABSENT (e.g. proxy SSE response.failed).
    const out = classifyOpenAIResponsesError({ code: 'invalid_image_url', message: 'Error while downloading the image from the URL.' });
    expect(out.kind).toBe('image_error');
    expect(out.raw.subtype).toBe('image_error');
  });

  it('maps a "Could not process image" 400 → image_error', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: 'Could not process image, please try a different file.' });
    expect(out.kind).toBe('image_error');
  });

  // Regression — the image gate is tight and MUST NOT catch generic 400s.
  it('does NOT map a generic validation 400 → image_error (stays model_error)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: 'Invalid parameter: temperature must be between 0 and 2' });
    expect(out.kind).toBe('model_error');
  });

  it('does NOT map a context 400 → image_error (stays context_exceeded)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: "This model's maximum context length is 128000 tokens" });
    expect(out.kind).toBe('context_exceeded');
  });

  it('does NOT map a schema 400 → image_error (stays model_error/schema_error)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: "Invalid schema for response_format 'x': 'required' must be supplied." });
    expect(out.kind).toBe('model_error');
    expect(out.raw.subtype).toBe('schema_error');
  });

  it('does NOT map a 400 that only mentions "image" without a rejection verb (stays model_error)', () => {
    const out = classifyOpenAIResponsesError({ status: 400, message: 'the image was attached at position 1' });
    expect(out.kind).toBe('model_error');
  });
});
