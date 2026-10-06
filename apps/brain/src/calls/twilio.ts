// Twilio Programmable Voice over its REST API: place a call that streams to Go, hang up, check that a
// status callback really came from Twilio. No SDK: two form posts with Basic auth.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreateCall {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  timeLimitS: number;
  ringTimeoutS: number;
}

export interface TwilioClient {
  createCall(p: CreateCall): Promise<{ sid: string }>;
  hangUp(sid: string): Promise<void>;
}

export class TwilioError extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
    this.name = 'TwilioError';
  }
}

export function twilioClient(o: { accountSid: string; authToken: string; fetch?: typeof fetch; baseUrl?: string }): TwilioClient {
  const base = `${o.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
  const authorization = `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`;
  const send = o.fetch ?? fetch;

  async function post(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await send(`${base}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok) {
      throw new TwilioError(res.status, typeof body.code === 'number' ? body.code : null, typeof body.message === 'string' ? body.message : `Twilio answered ${res.status}`);
    }
    return body;
  }

  return {
    async createCall(p) {
      const form = new URLSearchParams({
        To: p.to,
        From: p.from,
        Twiml: p.twiml,
        StatusCallback: p.statusCallback,
        StatusCallbackMethod: 'POST',
        TimeLimit: String(p.timeLimitS),
        Timeout: String(p.ringTimeoutS),
        Record: 'false',
      });
      for (const event of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', event);
      const body = await post('/Calls.json', form);
      if (typeof body.sid !== 'string') throw new TwilioError(502, null, 'Twilio answered without a call sid');
      return { sid: body.sid };
    },
    async hangUp(sid) {
      await post(`/Calls/${encodeURIComponent(sid)}.json`, new URLSearchParams({ Status: 'completed' }));
    },
  };
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Connects the call's audio to Go's media socket. The one-use token rides as a custom parameter. */
export function streamTwiml(o: { url: string; token: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(o.url)}"><Parameter name="token" value="${xml(o.token)}"/></Stream></Connect></Response>`;
}

/** Twilio signs the exact URL it called plus the sorted form parameters (HMAC-SHA1, base64). */
export function verifyTwilioSignature(authToken: string | null, url: string, params: Record<string, string>, header: string | string[] | undefined): boolean {
  if (!authToken) return false;
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const signed = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', authToken).update(Buffer.from(signed, 'utf-8')).digest('base64');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TwilioOutcome = 'ringing' | 'answered' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled' | 'other';

export function twilioOutcome(status: string): TwilioOutcome {
  switch (status) {
    case 'queued':
    case 'initiated':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'answered';
    case 'completed':
      return 'completed';
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no_answer';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'other';
  }
}
