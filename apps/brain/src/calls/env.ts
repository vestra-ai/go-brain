import { z } from 'zod';
import { isVoiceModel } from './config.js';

/** P6: calls. All optional: call_business is not offered while a setting is missing, and the room keeps working. */
export const CallsEnv = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  CALLS_MODE: z.enum(['off', 'allowlist']).optional(),
  /** Who Go may call this week: comma-separated `+E164` or `Name=+E164`, e.g. "Villa Sol=+919800000001". */
  CALLS_ALLOWLIST: z.string().optional(),
  /** The voice model on a call: gpt-realtime-2.1 when unset, gpt-live-1 for the day-one A/B. Never a transcriber. */
  CALLS_VOICE_MODEL: z.string().refine(isVoiceModel, 'a gpt-realtime or gpt-live voice model, never a transcriber').optional(),
});
