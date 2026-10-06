import { z } from 'zod';

/** Lane C (P4): Vestra /v1. Optional until P4 lands; P4 tightens them in this file. */
export const TasksEnv = z.object({
  VESTRA_API_URL: z.url().optional(),
  /** Comma-separated key pool. */
  VESTRA_API_KEYS: z.string().min(1).optional(),
  VESTRA_WEBHOOK_SECRET: z.string().min(1).optional(),
  VESTRA_DEPLOYMENT_ID: z.string().min(1).optional(),
});
