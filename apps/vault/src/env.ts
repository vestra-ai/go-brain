import { createPublicKey } from 'node:crypto';
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
  return parsed.data;
}
