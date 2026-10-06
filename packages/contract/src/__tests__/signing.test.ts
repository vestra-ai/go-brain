import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signRequest, verifyRequest } from '../signing.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/signing.json', import.meta.url), 'utf8')) as {
  secret: string; t: number; cases: { name: string; method: string; target: string; body: string; header: string }[];
};
const { secret, t } = vectors;
const req = { method: 'POST', target: '/v1/events', body: JSON.stringify({ hello: 'goa' }) };

describe('request signing', () => {
  for (const c of vectors.cases) {
    it(`matches the shared test vector: ${c.name}`, () => {
      expect(signRequest(c, secret, t)).toBe(c.header);
      expect(verifyRequest(c, c.header, secret, t + 10)).toEqual({ ok: true });
    });
  }
  it('signs the body bytes the same as the body string', () => {
    const c = vectors.cases[2]!;
    expect(signRequest({ ...c, body: new TextEncoder().encode(c.body) }, secret, t)).toBe(c.header);
  });
  it('refuses a changed body', () => {
    const header = signRequest(req, secret, t);
    expect(verifyRequest({ ...req, body: req.body.replace('goa', 'gox') }, header, secret, t)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('refuses the same signature on another route or method', () => {
    const header = signRequest(req, secret, t);
    expect(verifyRequest({ ...req, target: '/v1/links' }, header, secret, t)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyRequest({ ...req, method: 'PUT' }, header, secret, t)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('treats the method case-insensitively', () => {
    expect(verifyRequest({ ...req, method: 'post' }, signRequest(req, secret, t), secret, t)).toEqual({ ok: true });
  });
  it('refuses the wrong secret', () => {
    expect(verifyRequest(req, signRequest(req, secret, t), 'another-secret', t)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('refuses a stale timestamp, either way', () => {
    const header = signRequest(req, secret, t);
    expect(verifyRequest(req, header, secret, t + 301)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyRequest(req, header, secret, t - 301)).toEqual({ ok: false, reason: 'stale' });
  });
  it('refuses a missing or malformed header', () => {
    expect(verifyRequest(req, undefined, secret)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyRequest(req, 't=abc,v1=zz', secret)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('will not sign with an empty secret', () => {
    expect(() => signRequest(req, '')).toThrow(/empty/);
  });
});
