/**
 * Writes test-vectors/*.json: fixed inputs and the exact outputs both the TypeScript and the Python
 * helpers must produce. Run once when the signing rules change; CI checks both languages against
 * these files. The secret and key below are for tests only and sign nothing real.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signRequest } from '../src/signing.js';
import { signSpendApproval, type SpendApprovalClaims } from '../src/spend-approval.js';

const dir = fileURLToPath(new URL('../test-vectors/', import.meta.url));
mkdirSync(dir, { recursive: true });

const secret = 'test-only-go-signing-secret';
const t = 1791190800; // 2026-10-05T07:00:00Z
const requests = [
  { name: 'event with a JSON body', method: 'POST', target: '/v1/events',
    body: '{"event_id":"ev_01","trip_id":"t_goa","seq":42,"occurred_at":"2026-10-05T07:00:00Z","type":"person.left","data":{"person_id":"p_kabir"}}' },
  { name: 'GET with a query string and no body', method: 'GET', target: '/brain/v1/trips/t_goa/messages?after_seq=40&limit=50', body: '' },
  { name: 'body with non-ASCII characters (sign the UTF-8 bytes)', method: 'POST', target: '/brain/v1/trips/t_goa/messages',
    body: '{"request_id":"rq_7","text":"Villa Sol, ₹54,200 for 3 nights 🌴"}' },
];
writeFileSync(`${dir}signing.json`, JSON.stringify({
  secret, t, max_skew_seconds: 300,
  cases: requests.map((r) => ({ ...r, header: signRequest(r, secret, t) })),
}, null, 2) + '\n');

// Ed25519 test key from a fixed 32-byte seed (PKCS#8 prefix for Ed25519 + the seed).
const seed = Buffer.alloc(32, 7);
const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
const privatePem = priv.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = createPublicKey(priv).export({ format: 'pem', type: 'spki' }).toString();
const claims: SpendApprovalClaims = {
  iss: 'go-server', aud: 'go-brain-vault', jti: 'ap_01JA7Q3V8Z', trip_id: 't_goa', decision_id: 'd_villa',
  payer_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna',
  purpose: 'Villa Sol, 3 nights, 6 to 9 Nov', refundable_until: '2026-11-01T18:29:59Z', iat: t, exp: t + 600,
};
writeFileSync(`${dir}spend-approval.json`, JSON.stringify({
  note: 'TEST KEY ONLY. Claims are listed in the order the signer serialises them (compact JSON, no spaces).',
  private_key_pem: privatePem, public_key_pem: publicPem, claims,
  token: signSpendApproval(claims, privatePem), verify_at: t + 60,
}, null, 2) + '\n');
console.log(`wrote ${dir}signing.json and spend-approval.json`);
