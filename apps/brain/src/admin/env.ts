import { z } from 'zod';

/** P7: the admin page and demo switches. Optional until P7 lands. */
export const AdminEnv = z.object({
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Which deployment this is: stage (brain) or rehearsal (brain-rehearsal). The rehearsal runner reads it. */
  GO_ROLE: z.enum(['stage', 'rehearsal', 'try']).optional(),
  /** Set by Railway; the role's fallback when GO_ROLE is not set. */
  RAILWAY_SERVICE_NAME: z.string().min(1).optional(),
});
