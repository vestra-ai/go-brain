import { z } from 'zod';

/** Jev, the fast closed-question model. The names match Bash's client. */
export const ReflexEnv = z.object({
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  TYPESAFE_BASE_URL: z.url().default('https://api.typesafe.ai'),
  /** Pinned. A new version is a deliberate PR that re-records the test sets. */
  JEV_MODEL: z.string().min(1).default('jev-1.13.0'),
  /**
   * Which questions act live, "q1,q2,q3,q5,q7" (the switch's format); the rest run in shadow. A question named here acts
   * live only once its test set passes (reflex/live-gate.ts). "off" makes no Jev call at all.
   */
  REFLEX_LIVE: z.string().regex(/^(off|q(?:10|[1-9])(,q(?:10|[1-9]))*)?$/).default('q1,q4,q5,q6,q7,q8,q10'),
  /** How long a message waits for Jev before every question reads "unsure". */
  JEV_DEADLINE_MS: z.coerce.number().int().min(100).max(5_000).default(450),
  /** Calls per trip per UTC day before the reflex stops asking (0 means no cap). */
  JEV_DAILY_CALLS_PER_TRIP: z.coerce.number().int().min(0).default(5_000),
});
export type ReflexEnv = z.infer<typeof ReflexEnv>;
