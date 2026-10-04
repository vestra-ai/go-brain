import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signSpendApproval, verifySpendApproval, type SpendApprovalClaims } from '../spend-approval.js';

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pub: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const claims = (over: Partial<SpendApprovalClaims> = {}): SpendApprovalClaims => ({
  iss: 'go-server', aud: 'go-brain-vault', jti: 'approval-0001', trip_id: 'trip-goa', decision_id: 'dec-villa',
  payer_member_id: 'mem-rahul', payer_vestra_user_id: 'user-rahul', amount_minor: 5_420_000, currency: 'INR',
  merchant: 'ixigo', purpose: 'Villa Sol, 3 nights', iat: 1_000_000, exp: 1_000_300, ...over,
});

describe('spend approval', () => {
  it('verifies a fresh approval and returns its claims', () => {
    const k = keys();
    const token = signSpendApproval(claims(), k.priv);
    const r = verifySpendApproval(token, k.pub, 1_000_010);
    expect(r).toEqual({ ok: true, claims: claims() });
  });
  it('refuses an expired approval', () => {
    const k = keys();
    expect(verifySpendApproval(signSpendApproval(claims(), k.priv), k.pub, 1_000_300)).toEqual({ ok: false, reason: 'expired' });
  });
  it('refuses one signed by another key', () => {
    const a = keys(); const b = keys();
    expect(verifySpendApproval(signSpendApproval(claims(), a.priv), b.pub, 1_000_010)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('refuses a raised amount (tampered claims)', () => {
    const k = keys();
    const [h, , s] = signSpendApproval(claims(), k.priv).split('.');
    const forged = Buffer.from(JSON.stringify(claims({ amount_minor: 99_999_999 }))).toString('base64url');
    expect(verifySpendApproval(`${h}.${forged}.${s}`, k.pub, 1_000_010)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('will not sign an approval that lives longer than ten minutes', () => {
    const k = keys();
    expect(() => signSpendApproval(claims({ exp: 1_000_000 + 601 }), k.priv)).toThrow();
  });
  it('refuses garbage', () => {
    const k = keys();
    expect(verifySpendApproval('not.a.token!', k.pub)).toEqual({ ok: false, reason: 'malformed' });
  });
});
