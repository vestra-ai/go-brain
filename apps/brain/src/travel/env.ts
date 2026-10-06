import { z } from 'zod';

/**
 * Lane C (P4): the travel backend. P4 took this file over from P1's stub; P1's env.ts already merges this object's shape,
 * so it is never edited for a new variable. Every value is optional, and each one is also in apps/brain/.env.example.
 */
export const TravelEnv = z.object({
  /** Which backend answers travel searches. The TRAVEL_MODE switch can change it at runtime; it falls back to fake. */
  TRAVEL_MODE: z.enum(['ixigo', 'fake']).optional(),
  IXIGO_MCP_URL: z.url().optional(),
  IXIGO_MCP_TOKEN: z.string().min(1).optional(),
});

const TravelRuntime = TravelEnv.extend({ GO_PUBLIC_URL: z.url() });
export type TravelRuntime = z.infer<typeof TravelRuntime>;

/** What the travel lane reads from the merged env. */
export function readTravelEnv(env: unknown): TravelRuntime {
  return TravelRuntime.parse(env);
}
