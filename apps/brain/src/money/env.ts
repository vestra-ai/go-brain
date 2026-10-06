import { z } from 'zod';

/**
 * Lane D (P5): Go's side of the vault. P5 took this file over from P1's stub; P1's env.ts already merges this object's
 * shape, so it is never edited for a new variable. Every value is optional (money stays off until the vault is set),
 * and each one is also in apps/brain/.env.example. The vault's own settings live in apps/vault, never here.
 */
export const MoneyEnv = z.object({
  /** The vault's address, https://vault.<Go's domain>. */
  VAULT_URL: z.url().optional(),
  /** Signs every call between Go and the vault, both ways; the same value is on the vault's service. */
  VAULT_SHARED_SECRET: z.string().min(32).optional(),
  /** The rail a hold is paid on when the PAY_RAIL switch holds no value of its own. */
  PAY_RAIL: z.enum(['ixigo', 'stripe_test', 'fake']).optional(),
});

/** What money needs to turn on, or null while the vault is not set. */
export function readMoneyEnv(env: {
  VAULT_URL?: string | undefined;
  VAULT_SHARED_SECRET?: string | undefined;
}): { VAULT_URL: string; VAULT_SHARED_SECRET: string } | null {
  if (!env.VAULT_URL || !env.VAULT_SHARED_SECRET) return null;
  return { VAULT_URL: env.VAULT_URL, VAULT_SHARED_SECRET: env.VAULT_SHARED_SECRET };
}
