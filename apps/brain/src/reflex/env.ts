import { z } from 'zod';

/** Lane B (P2): Jev. Optional until P2 lands; P2 tightens them in this file. */
export const ReflexEnv = z.object({
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  TYPESAFE_BASE_URL: z.url().optional(),
  JEV_MODEL: z.string().min(1).optional(),
  /** The Jev questions acting live, e.g. "q1,q2,q3"; the rest run in shadow; "off" makes no Jev call. Also a switch. */
  REFLEX_LIVE: z.string().optional(),
});
