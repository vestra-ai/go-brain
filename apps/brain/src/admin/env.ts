import { z } from 'zod';

/** P7: the admin page and demo switches. Optional until P7 lands. */
export const AdminEnv = z.object({
  ADMIN_TOKEN: z.string().min(16).optional(),
});
