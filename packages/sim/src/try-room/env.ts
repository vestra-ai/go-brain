// The try room's settings, all from the environment, so it runs as a Railway service. GO_SIGNING_SECRET, TRY_PASSCODE
// and TRY_COOKIE_SALT live only in Railway's variables, never in the repo or a log.
import { z } from 'zod';
import { DEFAULT_CAPS } from './caps.js';

const count = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

export const TryEnv = z.object({
  /** Go's base URL, such as https://<Go's domain>. The socket goes to its /v1/socket. */
  GO_URL: z.string().regex(/^(https?|wss?):\/\/\S+$/, 'GO_URL must start with https://, http://, wss:// or ws://'),
  /** The secret Go and the Server share. The try room signs its socket to Go with it, on the server side only. */
  GO_SIGNING_SECRET: z.string().min(32, 'GO_SIGNING_SECRET must be at least 32 characters'),
  /** What a visitor types to get in. The visit cookie's key is made from it and TRY_COOKIE_SALT. */
  TRY_PASSCODE: z.string().min(20, 'TRY_PASSCODE must be at least 20 characters'),
  /** Random and secret, at least 32 characters (openssl rand -hex 32). It keeps a leaked cookie from being used to test passcode guesses. */
  TRY_COOKIE_SALT: z.string().min(32, 'TRY_COOKIE_SALT must be at least 32 characters: make it with openssl rand -hex 32'),
  PORT: z.coerce.number().int().positive().default(8080),
  /** What can wake Go's model per UTC day, across every visitor: messages, votes, taps, yes or no, new trips. */
  TRY_DAILY_TURNS: count(DEFAULT_CAPS.dailyTurns),
  /** Everything sent into the room per UTC day, reactions included. */
  TRY_DAILY_MESSAGES: count(DEFAULT_CAPS.dailyMessages),
  /** One visit's share of TRY_DAILY_TURNS, keyed to its cookie, so one visit cannot use up the day. */
  TRY_VISIT_TURNS: count(DEFAULT_CAPS.visitTurns),
  /** The line about what is real and what is simulated. Leave it out for the room's own: SIMULATED_LINE, or LIVE_LINE with TRY_LIVE=1. */
  TRY_SIMULATED_LINE: z.string().min(1).max(300).optional(),
  /** The try room's name in Go's socket (?instance=). */
  TRY_INSTANCE: z.string().regex(/^[a-z0-9-]{1,40}$/).default('try-room'),
  /** 1: Go Live, the page's second column with the trip's recipe runs and the pages they opened (Go's /v1/live). */
  TRY_LIVE: z.enum(['0', '1']).default('0'),
});
export type TryEnv = z.infer<typeof TryEnv>;
