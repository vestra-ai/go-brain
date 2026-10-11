import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const masterKey = z.string().refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
  message: 'VAULT_MASTER_KEY must be 32 bytes in base64 (openssl rand -base64 32)',
});

const ed25519Pem = z.string().refine(
  (v) => {
    try {
      return createPublicKey(v).asymmetricKeyType === 'ed25519';
    } catch {
      return false;
    }
  },
  { message: 'GO_SPEND_PUBLIC_KEY must be the Server\'s Ed25519 public key in PEM' },
);

const httpUrl = z.url({ protocol: /^https?$/ }).transform((v) => v.replace(/\/+$/, ''));

/** The App's origins, the only ones that may frame an embedded vault page (rev 5 R8). */
export const APP_FRAME_ORIGINS = 'https://go-frontend-three.vercel.app http://localhost:3000 http://localhost:3002';
const frameOrigins = z
  .string()
  .default(APP_FRAME_ORIGINS)
  .transform((v) => v.split(/[\s,]+/).filter(Boolean))
  .pipe(z.array(z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i, 'each frame origin is a scheme and a host, with no path')).min(1));

const RAILS = ['fake', 'stripe_test', 'ixigo'] as const;
const rails = z
  .string()
  .default('fake,stripe_test')
  .transform((v) => v.split(',').map((r) => r.trim()).filter((r) => r !== ''))
  .pipe(z.array(z.enum(RAILS, { message: 'VAULT_RAILS lists fake, stripe_test or ixigo, joined by commas' })).min(1));

/** The vault's own settings. Nothing here is shared with Go except VAULT_SHARED_SECRET. */
export const VaultEnv = z.object({
  PORT: z.coerce.number().int().nonnegative().default(8080),
  VAULT_DATABASE_URL: z.string().min(1),
  VAULT_MASTER_KEY: masterKey,
  GO_SPEND_PUBLIC_KEY: ed25519Pem,
  VAULT_SHARED_SECRET: z.string().min(32, 'VAULT_SHARED_SECRET must be at least 32 characters (openssl rand -hex 32)'),
  VAULT_PUBLIC_URL: httpUrl,
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGIN: httpUrl,
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_test_/, 'the vault takes Stripe test keys only (sk_test_ or rk_test_)'),
  STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_test_/, 'the vault takes Stripe test keys only (pk_test_)'),
  GO_CALLBACK_URL: httpUrl,
  /** The rails this vault pays on. With the contract's test spend key, fake only. */
  VAULT_RAILS: rails,
  /** Space- or comma-separated: the App's origins, which may frame the unlock and approve pages. */
  VAULT_FRAME_ORIGINS: frameOrigins,
});
export type VaultEnv = z.infer<typeof VaultEnv>;

/** Reads and checks the settings. Refuses live Stripe keys by name, without printing them. */
export function readVaultEnv(source: Record<string, string | undefined> = process.env): VaultEnv {
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'] as const) {
    if (/_live_/.test(source[name] ?? '')) {
      throw new Error(`Refusing to start: ${name} is a live key. The vault takes test cards only.`);
    }
  }
  const parsed = VaultEnv.safeParse(source);
  if (!parsed.success) throw new Error(`The vault's settings are wrong:\n${z.prettifyError(parsed.error)}`);
  if (isTestSpendKey(parsed.data.GO_SPEND_PUBLIC_KEY) && parsed.data.VAULT_RAILS.some((r) => r !== 'fake')) {
    throw new Error(
      "Refusing to start: GO_SPEND_PUBLIC_KEY is the contract's test key, which anyone can sign approvals with. With it the vault pays on the fake rail only (VAULT_RAILS=fake).",
    );
  }
  return parsed.data;
}

const TEST_VECTOR = new URL('../../../packages/contract/test-vectors/spend-approval.json', import.meta.url);

/** True when the key is the contract's published test key, whose private half is in the repo. Fails closed. */
export function isTestSpendKey(pem: string): boolean {
  let testPem: string;
  try {
    testPem = (JSON.parse(readFileSync(TEST_VECTOR, 'utf8')) as { public_key_pem: string }).public_key_pem;
  } catch {
    throw new Error(`Refusing to start: cannot read the contract's test key (${TEST_VECTOR.pathname}) to check GO_SPEND_PUBLIC_KEY against it`);
  }
  const der = (key: string) => createPublicKey(key).export({ type: 'spki', format: 'der' });
  return der(pem).equals(der(testPem));
}
