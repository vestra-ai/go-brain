import { z } from 'zod';

/** Lane B (P2): memory. The fold's budgets (in estimated tokens) and the quiet spells before side passes run. */
export const MemoryEnv = z.object({
  FOLD_AT_TOKENS: z.coerce.number().int().min(5_000).default(60_000),
  STORY_TOKENS: z.coerce.number().int().min(500).default(5_000),
  CHAT_HARD_CAP_TOKENS: z.coerce.number().int().min(10_000).default(90_000),
  NOTES_QUIET_MS: z.coerce.number().int().min(1_000).default(20_000),
  FOLD_QUIET_MS: z.coerce.number().int().min(1_000).default(60_000),
});
