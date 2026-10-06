// The try room's settings, all from the environment, so it runs as a Railway service. GO_SIGNING_SECRET and
// TRY_PASSCODE live only in Railway's variables, never in the repo or a log.
import { z } from 'zod';
import { DEFAULT_CAPS } from './caps.js';
import { SIMULATED_LINE } from './words.js';

const count = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

export const TryEnv = z.object({
  /** Go's base URL, e.g. https://brain-rehearsal.up.railway.app. The socket goes to its /v1/socket. */
  GO_URL: z.string().regex(/^(https?|wss?):\/\/\S+$/, 'GO_URL must start with https://, http://, wss:// or ws://'),
  /** The secret Go and the Server share. The try room signs its socket to Go with it, on the server side only. */
  GO_SIGNING_SECRET: z.string().min(32, 'GO_SIGNING_SECRET must be at least 32 characters'),
  /** What a visitor types to get in. The visit cookie's key is made from it. */
  TRY_PASSCODE: z.string().min(8, 'TRY_PASSCODE must be at least 8 characters'),
  PORT: z.coerce.number().int().positive().default(8080),
  TRY_DAILY_GO_ASKS: count(DEFAULT_CAPS.dailyGoAsks),
  TRY_DAILY_MESSAGES: count(DEFAULT_CAPS.dailyMessages),
  TRY_SESSION_GO_ASKS: count(DEFAULT_CAPS.sessionGoAsks),
  TRY_DAILY_TRIPS: count(DEFAULT_CAPS.dailyTrips),
  /** The line about what is simulated. Change it here when a part goes live. */
  TRY_SIMULATED_LINE: z.string().min(1).max(300).default(SIMULATED_LINE),
  /** The try room's name in Go's socket (?instance=). */
  TRY_INSTANCE: z.string().regex(/^[a-z0-9-]{1,40}$/).default('try-room'),
});
export type TryEnv = z.infer<typeof TryEnv>;
