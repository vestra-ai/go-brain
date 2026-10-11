import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { signRequest, signSpendApproval, type SpendApprovalClaims } from '@go/contract';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { VaultEnv } from '../env.js';

interface SpendVector {
  private_key_pem: string;
  public_key_pem: string;
  claims: SpendApprovalClaims;
  token: string;
  verify_at: number;
}

let vector: SpendVector | null = null;

/** The contract's spend approval test vector (TEST KEY ONLY). */
export function spendVector(): SpendVector {
  vector ??= JSON.parse(
    readFileSync(new URL('../../../../packages/contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'),
  ) as SpendVector;
  return vector;
}

export const TEST_SHARED_SECRET = 'test-only-vault-shared-secret-0123456789';

export function testVaultEnv(over: Partial<VaultEnv> = {}): VaultEnv {
  return {
    PORT: 0,
    VAULT_DATABASE_URL: 'postgres://unused',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    GO_SPEND_PUBLIC_KEY: spendVector().public_key_pem,
    VAULT_SHARED_SECRET: TEST_SHARED_SECRET,
    VAULT_PUBLIC_URL: 'https://vault.test',
    WEBAUTHN_RP_ID: 'vault.test',
    WEBAUTHN_ORIGIN: 'https://vault.test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
    GO_CALLBACK_URL: 'https://brain.test',
    // Tests sign with the contract's test key, so readVaultEnv would allow the fake rail only; tests build the env directly.
    VAULT_RAILS: ['fake', 'stripe_test'],
    VAULT_FRAME_ORIGINS: ['https://app.test', 'http://localhost:3000'],
    ...over,
  };
}

/** A spend approval signed with the test key: the guide's villa claims, changed by `over`, lasting 600 s unless `exp` says otherwise. */
export function signTestApproval(over: Partial<SpendApprovalClaims> = {}): string {
  const v = spendVector();
  const iat = over.iat ?? v.claims.iat;
  return signSpendApproval({ ...v.claims, ...over, iat, exp: over.exp ?? iat + 600 }, v.private_key_pem);
}

/** Signs any claims with the test key, skipping the contract's checks, to build tokens the vault must refuse. */
export function signRawApproval(claims: Record<string, unknown>): string {
  const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
  const head = b64(JSON.stringify({ alg: 'EdDSA', typ: 'go-spend+jws' }));
  const body = b64(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(spendVector().private_key_pem));
  return `${head}.${body}.${b64(sig)}`;
}

/** Calls an internal route the way Go does: JSON body, signed with the shared secret. */
export function signedInject(
  app: FastifyInstance,
  o: { method: 'GET' | 'POST'; url: string; body?: unknown; now: Date; secret?: string; header?: string },
): Promise<LightMyRequestResponse> {
  const payload = o.body === undefined ? '' : JSON.stringify(o.body);
  const header =
    o.header ?? signRequest({ method: o.method, target: o.url, body: payload }, o.secret ?? TEST_SHARED_SECRET, Math.floor(o.now.getTime() / 1000));
  return app.inject({
    method: o.method,
    url: o.url,
    headers: { 'x-vault-signature': header, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}
