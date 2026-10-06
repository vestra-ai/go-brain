import { z } from 'zod';

/** P6: calls. Optional until P6 lands; P6 tightens them in this file. */
export const CallsEnv = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  CALLS_MODE: z.enum(['off', 'allowlist']).optional(),
  /** Comma-separated phone numbers Go may call this week. */
  CALLS_ALLOWLIST: z.string().optional(),
});
