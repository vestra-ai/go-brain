import { z } from 'zod';

/** Lane C (P4): the travel backend. Optional until P4 lands; P4 tightens them in this file. */
export const TravelEnv = z.object({
  TRAVEL_MODE: z.enum(['ixigo', 'fake']).optional(),
  IXIGO_MCP_URL: z.url().optional(),
  IXIGO_MCP_TOKEN: z.string().min(1).optional(),
});
