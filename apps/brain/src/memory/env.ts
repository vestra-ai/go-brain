import { z } from 'zod';

/** Lane B (P2): memory (the fold's budgets, the side passes' quiet spells). Empty until P2 fills it; env.ts already merges it. */
export const MemoryEnv = z.object({});
