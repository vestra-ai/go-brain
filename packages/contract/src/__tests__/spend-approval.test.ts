import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signSpendApproval, verifySpendApproval, type SpendApprovalClaims } from '../spend-approval.js';

const vector = JSON.parse(readFileSync(new URL('../../test-vectors/spend-approval.json', import.meta.url), 'utf8')) as {
  private_key_pem: string; public_key_pem: string; claims: SpendApprovalClaims; token: string; verify_at: number;
};
const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pub: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const claims = (over: Partial<SpendApprovalClaims> = {}): SpendApprovalClaims => ({ ...vector.claims, ...over });
const at = vector.verify_at;

describe('spend approval', () => {
  it('reproduces the shared test vector exactly (Ed25519 is deterministic)', () => {
    expect(signSpendApproval(vector.claims, vector.private_key_pem)).toBe(vector.token);
  });
  it('verifies the shared test vector and returns its claims', () => {
    expect(verifySpendApproval(vector.token, vector.public_key_pem, at)).toEqual({ ok: true, claims: vector.claims });
  });
  it('refuses an expired approval', () => {
    expect(verifySpendApproval(vector.token, vector.public_key_pem, vector.claims.exp)).toEqual({ ok: false, reason: 'expired' });
  });
  it('refuses one issued in the future', () => {
    expect(verifySpendApproval(vector.token, vector.public_key_pem, vector.claims.iat - 31)).toEqual({ ok: false, reason: 'not_yet_valid' });
  });
  it('refuses one signed by another key', () => {
    const b = keys();
    expect(verifySpendApproval(vector.token, b.pub, at)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('refuses a raised amount (tampered claims)', () => {
    const [h, , s] = vector.token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ amount_minor: 99_999_999 }))).toString('base64url');
    expect(verifySpendApproval(`${h}.${forged}.${s}`, vector.public_key_pem, at)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('will not sign an approval that lives longer than ten minutes', () => {
    const k = keys();
    expect(() => signSpendApproval(claims({ exp: vector.claims.iat + 601 }), k.priv)).toThrow();
  });
  it('refuses garbage', () => {
    expect(verifySpendApproval('not.a.token!', vector.public_key_pem)).toEqual({ ok: false, reason: 'malformed' });
  });
});
