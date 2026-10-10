import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { Currency, Id, IsoDateTime, PositiveAmountMinor } from './common.js';

/**
 * The signed spend approval: the Server's half of the two keys.
 *
 * The Server runs the spend check and signs this with its Ed25519 private key. Go's vault
 * pays only with a valid, unexpired, unused approval AND the payer's own passkey (Face ID). Neither
 * key is the model's word. One use: the vault records `jti` and refuses it a second time, and
 * The Server marks it used when Go records the booking.
 *
 * Wire format (a compact JWS):
 *   base64url(header JSON) "." base64url(claims JSON) "." base64url(Ed25519 signature over the first two parts)
 * with header exactly {"alg":"EdDSA","typ":"go-spend+jws"}.
 */
export const MAX_APPROVAL_TTL_SECONDS = 600;

/**
 * Which payment the claims are for: a group's vote (decision_id), or 1.2's ticket (for_person_id, whose traveller is
 * the payer). Null when they say exactly one; else what is wrong.
 */
export function spendFormProblem(c: {
  decision_id?: string | null | undefined;
  for_person_id?: string | null | undefined;
  kind?: string | null | undefined;
  payer_person_id: string;
}): string | null {
  const vote = c.decision_id != null;
  const ticket = c.for_person_id != null;
  if (vote === ticket) return 'exactly one of decision_id and for_person_id';
  if (ticket && c.payer_person_id !== c.for_person_id) return "a ticket's payer is the person it is for";
  if (vote && c.kind != null) return 'a group approval has no kind';
  return null;
}
const ALLOWED_CLOCK_SKEW_SECONDS = 30;
const HEADER = { alg: 'EdDSA', typ: 'go-spend+jws' } as const;

export const SpendApprovalClaims = z
  .object({
    iss: z.literal('server'),
    aud: z.literal('go-vault'),
    jti: z.string().min(8).max(64),
    trip_id: Id,
    /** The group's vote. Exactly one of decision_id and for_person_id. */
    decision_id: Id.nullish(),
    /** 1.2, a ticket: the traveller it is for, who is always the payer. */
    for_person_id: Id.nullish(),
    kind: z.literal('ticket').nullish(),
    payer_person_id: Id,
    /** The most this payment may be. */
    amount_minor: PositiveAmountMinor,
    currency: Currency,
    merchant: z.string().min(1).max(120),
    purpose: z.string().min(1).max(200),
    /** When free cancellation ends, if it does. */
    refundable_until: IsoDateTime.nullish(),
    iat: z.int(),
    exp: z.int(),
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= MAX_APPROVAL_TTL_SECONDS, {
    message: `exp must be after iat and at most ${MAX_APPROVAL_TTL_SECONDS} seconds later`,
  })
  .refine((c) => spendFormProblem(c) === null, { message: 'a group approval names its vote; a ticket names its traveller, who is the payer' })
  .meta({
    id: 'SpendApprovalClaims',
    description:
      "What the Server signs. exp is at most 600 seconds after iat. A group approval carries decision_id; 1.2's ticket approval carries for_person_id (and kind \"ticket\") instead, and its payer is that person.",
  });
export type SpendApprovalClaims = z.infer<typeof SpendApprovalClaims>;

const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

export function signSpendApproval(claims: SpendApprovalClaims, privateKeyPem: string): string {
  const checked = SpendApprovalClaims.parse(claims);
  const head = b64(JSON.stringify(HEADER));
  const body = b64(JSON.stringify(checked));
  const sig = sign(null, Buffer.from(`${head}.${body}`), createPrivateKey(privateKeyPem));
  return `${head}.${body}.${b64(sig)}`;
}

export type VerifySpendApprovalResult =
  | { ok: true; claims: SpendApprovalClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'invalid_claims' | 'expired' | 'not_yet_valid' };

export function verifySpendApproval(
  token: string,
  publicKeyPem: string,
  now: number = Math.floor(Date.now() / 1000),
): VerifySpendApprovalResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [head, body, sig] = parts as [string, string, string];
  let header: unknown;
  let raw: unknown;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (JSON.stringify(header) !== JSON.stringify(HEADER)) return { ok: false, reason: 'malformed' };
  const good = verify(null, Buffer.from(`${head}.${body}`), createPublicKey(publicKeyPem), Buffer.from(sig, 'base64url'));
  if (!good) return { ok: false, reason: 'bad_signature' };
  const claims = SpendApprovalClaims.safeParse(raw);
  if (!claims.success) return { ok: false, reason: 'invalid_claims' };
  if (claims.data.iat > now + ALLOWED_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet_valid' };
  if (claims.data.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: claims.data };
}
