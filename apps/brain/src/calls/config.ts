// Calls: the settings, the allowlist, phone numbers, the public URLs, the voice model and the fixed numbers.
export const CALL_WINDOW_MS = 30_000;
export const CALL_CAP_MS = 240_000;
export const RING_TIMEOUT_S = 30;
/** Twilio's own hard limit, a backstop behind Go's 4 minute cap. */
export const TWILIO_TIME_LIMIT_S = 255;
export const CARD_GAP_MS = 3_000;
export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
/** gpt-live-1 over a plain WebSocket. Bash runs Live over WebRTC with a sideband, so the day-one check proves this URL. */
export const LIVE_URL = 'wss://api.openai.com/v1/live';
/** The default voice model: it has the "caller started speaking" event barge-in needs, and function tools. */
export const REALTIME_MODEL = 'gpt-realtime-2.1';
/** A voice both models have. */
export const REALTIME_VOICE = 'marin';
export const VOICE_MODEL = /^gpt-(realtime|live)(-[a-z0-9.]+)*$/;
/** A voice model, never a transcriber: Go hears with the voice model's own ears only (Keshav's ruling). */
export const isVoiceModel = (model: string): boolean => VOICE_MODEL.test(model) && !/transcri/i.test(model);
export type VoiceKind = 'realtime' | 'live';
export const voiceKind = (model: string): VoiceKind => (model.startsWith('gpt-live') ? 'live' : 'realtime');
export const E164 = /^\+[1-9]\d{6,14}$/;

export interface Callee { name: string | null; phone: string }

export interface CallsEnvInput {
  GO_PUBLIC_URL?: string | undefined;
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
  TWILIO_FROM?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  CALLS_ALLOWLIST?: string | undefined;
  CALLS_VOICE_MODEL?: string | undefined;
}

export interface CallsConfig {
  publicUrl: string | null;
  accountSid: string | null;
  authToken: string | null;
  from: string | null;
  openaiKey: string | null;
  /** CALLS_VOICE_MODEL when it names a voice model, else gpt-realtime-2.1. */
  voiceModel: string;
  allowlist: Callee[];
  /** Names of settings that are not set; calls refuse to start while any is missing. */
  missing: string[];
}

export function normalisePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164.test(withPlus) ? withPlus : null;
}

export function parseAllowlist(raw: string | undefined): Callee[] {
  if (!raw) return [];
  const out: Callee[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '';
    const phone = normalisePhone(eq > 0 ? entry.slice(eq + 1) : entry);
    if (phone) out.push({ name: name || null, phone });
  }
  return out;
}

export function loadCallsConfig(env: CallsEnvInput): CallsConfig {
  const v = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null);
  const publicUrl = v(env.GO_PUBLIC_URL)?.replace(/\/+$/, '') ?? null;
  const from = env.TWILIO_FROM ? normalisePhone(env.TWILIO_FROM) : null;
  const model = v(env.CALLS_VOICE_MODEL);
  const set: Record<string, string | null> = {
    GO_PUBLIC_URL: publicUrl,
    TWILIO_ACCOUNT_SID: v(env.TWILIO_ACCOUNT_SID),
    TWILIO_AUTH_TOKEN: v(env.TWILIO_AUTH_TOKEN),
    TWILIO_FROM: from,
    OPENAI_API_KEY: v(env.OPENAI_API_KEY),
  };
  return {
    publicUrl,
    accountSid: set.TWILIO_ACCOUNT_SID ?? null,
    authToken: set.TWILIO_AUTH_TOKEN ?? null,
    from,
    openaiKey: set.OPENAI_API_KEY ?? null,
    voiceModel: model && isVoiceModel(model) ? model : REALTIME_MODEL,
    allowlist: parseAllowlist(env.CALLS_ALLOWLIST),
    missing: Object.entries(set).filter(([, value]) => value === null).map(([key]) => key),
  };
}

/** A number given must be on the list; with no number, a listed name must match exactly (any case). */
export function findCallee(cfg: Pick<CallsConfig, 'allowlist'>, o: { business: string; phone?: string | undefined }): Callee | null {
  if (o.phone) {
    const phone = normalisePhone(o.phone);
    return phone ? (cfg.allowlist.find((c) => c.phone === phone) ?? null) : null;
  }
  const want = o.business.trim().toLowerCase();
  return cfg.allowlist.find((c) => c.name !== null && c.name.toLowerCase() === want) ?? null;
}

export const statusUrl = (publicUrl: string, callId: string): string => `${publicUrl}/calls/twilio/status/${callId}`;
export const mediaUrl = (publicUrl: string, callId: string): string => `wss://${new URL(publicUrl).host}/calls/media/${callId}`;
/** For logs: never a whole phone number. */
export const maskPhone = (phone: string): string => (phone.length <= 6 ? '***' : `${phone.slice(0, 3)}***${phone.slice(-3)}`);
/** For logs: every phone-like number in a text (an error from Twilio names the number it could not call) masked. */
export const maskNumbers = (text: string): string => text.replace(/\+?\d[\d\s\-().]{6,}\d/g, (n) => maskPhone(n.replace(/[\s\-().]/g, '')));
