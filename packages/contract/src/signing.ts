import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The Server signs the request that opens the socket to Go (GET /v1/socket) with this header.
 * Everything after that travels on the open socket and is not signed again.
 *
 *   x-go-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, signing string)>
 *
 * The signing string is four parts joined by a newline:
 *
 *   <t>\n<METHOD>\n<target>\n<raw body>
 *
 * - METHOD is upper case: GET for the socket.
 * - target is the path plus the query string exactly as sent, e.g. /v1/socket or /v1/socket?instance=server-1
 * - raw body is the exact bytes sent, or nothing for a request without a body (the socket has none).
 *
 * The signature is good for 300 seconds, and Go accepts each one once: a second upgrade with
 * the same t and v1 is refused. Both sides share one secret, GO_SIGNING_SECRET.
 */
export const SIGNATURE_HEADER = 'x-go-signature';
export const MAX_SKEW_SECONDS = 300;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface SignedRequest {
  method: string;
  /** Path plus query string, exactly as sent. */
  target: string;
  /** The exact body bytes, or '' when there is no body. */
  body: string | Uint8Array;
}

function mac(secret: string, t: number, req: SignedRequest): Buffer {
  if (!secret) throw new Error('GO_SIGNING_SECRET is empty');
  return createHmac('sha256', secret)
    .update(`${t}\n${req.method.toUpperCase()}\n${req.target}\n`)
    .update(req.body)
    .digest();
}

/** The value for the x-go-signature header. */
export function signRequest(req: SignedRequest, secret: string, now: number = nowSeconds()): string {
  return `t=${now},v1=${mac(secret, now, req).toString('hex')}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function verifyRequest(
  req: SignedRequest,
  header: string | undefined,
  secret: string,
  now: number = nowSeconds(),
): VerifyResult {
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
  const expected = mac(secret, t, req);
  const got = Buffer.from(v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
