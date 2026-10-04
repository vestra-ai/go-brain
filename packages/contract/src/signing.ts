import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Every request between go-server and go-brain carries this header, both directions:
 *   x-go-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Sign and verify the RAW body bytes (as sent), never a re-serialized object.
 */
export const SIGNATURE_HEADER = 'x-go-signature';
export const MAX_SKEW_SECONDS = 300;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function mac(secret: string, t: number, rawBody: string): Buffer {
  if (!secret) throw new Error('go signing secret is empty');
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
}

export function signRequest(rawBody: string, secret: string, now: number = nowSeconds()): string {
  return `t=${now},v1=${mac(secret, now, rawBody).toString('hex')}`;
}

export type VerifyRequestResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function verifyRequest(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now: number = nowSeconds(),
): VerifyRequestResult {
  if (!header) return { ok: false, reason: 'missing' };
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = Number(fields.get('t'));
  const v1 = fields.get('v1') ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
  if (Math.abs(now - t) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  const expected = mac(secret, t, rawBody);
  const got = Buffer.from(v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
