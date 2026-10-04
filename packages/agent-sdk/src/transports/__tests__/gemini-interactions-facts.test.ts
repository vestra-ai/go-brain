import { describe, it, expect } from 'vitest';
import { GEMINI_ERROR_SPEC, GEMINI_SEVERANCE_SPEC, geminiCanonicalCode, resolveGeminiRate } from '../gemini-transport.js';
import { classifyProviderError } from '../../engine/error-authority.js';
import {
  GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE,
  STREAM_END_SENTINELS,
  isSeveredStream,
} from '../../engine/severed-recognizer.js';

describe('Gemini 3.8 Flash rate row', () => {
  it('resolves to an explicit, verified row ahead of the provisional flash family', () => {
    const r = resolveGeminiRate('gemini-3.8-flash');
    expect(r.isFallback).toBe(false);
    expect(r.matched).toBe('3.8-flash');
    expect(r.price).toMatchObject({ inPerM: 0.75, cachedPerM: 0.075, outPerM: 3.75, verifiedAt: '2026-09-03' });
    expect(r.price.sources.join(' ')).toMatch(/ai\.google\.dev\/gemini-api\/docs\/pricing/);
    expect(r.price.sources.join(' ')).toMatch(/2027-01-01/);
  });

  it('the provisional 2.5 family rows are byte-identical', () => {
    expect(resolveGeminiRate('gemini-2.5-flash')).toMatchObject({ matched: 'flash', price: { inPerM: 0.3, outPerM: 2.5 } });
    expect(resolveGeminiRate('gemini-2.5-flash-lite')).toMatchObject({ matched: 'flash-lite' });
    expect(resolveGeminiRate('gemini-2.5-pro')).toMatchObject({ matched: 'pro' });
  });
});

describe('Gemini error spec — the Interactions in-stream code vocabulary', () => {
  it('GATEWAY_TIMEOUT (the streaming `error` event) classifies model_unavailable', () => {
    const err = Object.assign(new Error('Deadline expired before operation could complete.'), { code: 'GATEWAY_TIMEOUT' });
    expect(classifyProviderError(err, GEMINI_ERROR_SPEC, 'streaming').kind).toBe('model_unavailable');
  });

  it('the REST body lift is exported for the Interactions transport (object and array forms)', () => {
    expect(geminiCanonicalCode('{"error":{"code":429,"message":"x","status":"RESOURCE_EXHAUSTED"}}')).toBe('RESOURCE_EXHAUSTED');
    expect(geminiCanonicalCode('[{"error":{"status":"UNAVAILABLE"}}]')).toBe('UNAVAILABLE');
    expect(geminiCanonicalCode('<html>proxy</html>')).toBeUndefined();
  });
});

describe('Gemini Interactions severance sentinel', () => {
  it('is registered so EVERY lane re-issues the round instead of dying model_error', () => {
    expect(STREAM_END_SENTINELS).toContain(GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE);
    expect(isSeveredStream(new Error(GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE), GEMINI_SEVERANCE_SPEC)).toBe(true);
  });
});
