import { describe, expect, it } from 'vitest';
import { signRequest, verifyRequest } from '../signing.js';

const secret = 'test-secret-not-real';
const body = JSON.stringify({ hello: 'goa' });

describe('request signing', () => {
  it('verifies what it signed', () => {
    const header = signRequest(body, secret, 1_000_000);
    expect(verifyRequest(body, header, secret, 1_000_010)).toEqual({ ok: true });
  });
  it('refuses a changed body', () => {
    const header = signRequest(body, secret, 1_000_000);
    expect(verifyRequest(body.replace('goa', 'gox'), header, secret, 1_000_000)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('refuses the wrong secret', () => {
    const header = signRequest(body, secret, 1_000_000);
    expect(verifyRequest(body, header, 'another-secret', 1_000_000)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('refuses a stale timestamp (replay)', () => {
    const header = signRequest(body, secret, 1_000_000);
    expect(verifyRequest(body, header, secret, 1_000_301)).toEqual({ ok: false, reason: 'stale' });
  });
  it('refuses a missing or malformed header', () => {
    expect(verifyRequest(body, undefined, secret)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyRequest(body, 't=abc,v1=zz', secret)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('will not sign with an empty secret', () => {
    expect(() => signRequest(body, '')).toThrow(/empty/);
  });
});
