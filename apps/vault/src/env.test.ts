import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readVaultEnv, VaultEnv } from './env.js';

const spendPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const good: Record<string, string> = {
  VAULT_DATABASE_URL: 'postgres://vault@localhost/vault',
  VAULT_MASTER_KEY: randomBytes(32).toString('base64'),
  GO_SPEND_PUBLIC_KEY: spendPem,
  VAULT_SHARED_SECRET: 'v'.repeat(40),
  VAULT_PUBLIC_URL: 'https://vault.go.example/',
  WEBAUTHN_RP_ID: 'vault.go.example',
  WEBAUTHN_ORIGIN: 'https://vault.go.example',
  STRIPE_SECRET_KEY: 'sk_test_51abc',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_51abc',
  GO_CALLBACK_URL: 'https://brain.go.example',
};

describe('readVaultEnv', () => {
  it('reads good settings, trims the public URL and defaults the port', () => {
    const env = readVaultEnv(good);
    expect(env.VAULT_PUBLIC_URL).toBe('https://vault.go.example');
    expect(env.PORT).toBe(8080);
  });

  it('refuses a live Stripe secret key and never prints it', () => {
    const live = 'sk_live_51SECRETVALUE';
    let message = '';
    try {
      readVaultEnv({ ...good, STRIPE_SECRET_KEY: live });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('STRIPE_SECRET_KEY is a live key');
    expect(message).not.toContain('SECRETVALUE');
  });

  it('refuses a live publishable key and a restricted live key', () => {
    expect(() => readVaultEnv({ ...good, STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).toThrow(/live key/);
    expect(() => readVaultEnv({ ...good, STRIPE_SECRET_KEY: 'rk_live_x' })).toThrow(/live key/);
  });

  it('refuses a key that is not a Stripe test key at all', () => {
    expect(() => readVaultEnv({ ...good, STRIPE_SECRET_KEY: 'whatever' })).toThrow(/test keys only/);
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => readVaultEnv({ ...good, VAULT_MASTER_KEY: randomBytes(31).toString('base64') })).toThrow(/VAULT_MASTER_KEY/);
  });

  it('refuses a spend key that is not Ed25519', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => readVaultEnv({ ...good, GO_SPEND_PUBLIC_KEY: ec })).toThrow(/GO_SPEND_PUBLIC_KEY/);
  });

  it('refuses a short shared secret', () => {
    expect(() => readVaultEnv({ ...good, VAULT_SHARED_SECRET: 'short' })).toThrow(/VAULT_SHARED_SECRET/);
  });
});

describe('apps/vault/.env.example', () => {
  it('names every setting the vault reads, and holds no secret value', () => {
    const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const named = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    for (const key of Object.keys(VaultEnv.shape)) expect(named, key).toContain(key);
    for (const key of ['VAULT_MASTER_KEY', 'VAULT_SHARED_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY']) {
      expect(text).toMatch(new RegExp(`^#?\\s*${key}=\\s*(#.*)?$`, 'm'));
    }
  });
});
