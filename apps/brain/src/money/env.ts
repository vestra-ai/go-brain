import { z } from 'zod';

/** Lane D (P5): Go's side of the vault. Optional until P5 lands; P5 tightens them in this file. */
export const MoneyEnv = z.object({
  VAULT_URL: z.url().optional(),
  VAULT_SHARED_SECRET: z.string().min(32).optional(),
  PAY_RAIL: z.enum(['ixigo', 'stripe_test', 'fake']).optional(),
});
