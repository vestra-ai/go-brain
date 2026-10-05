// Checks the signature on the socket upgrade, and accepts each signature once.
// The used signatures are kept in memory, so a restart forgets them. That is fine for the fake Go (a replay
// would have to come within 300 seconds of a restart); the real Go keeps them in Postgres.
import { MAX_SKEW_SECONDS, verifyRequest } from '@go/contract';

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' | 'replayed'; message: string };

const MESSAGES = {
  missing: 'the x-go-signature header is missing',
  malformed: 'the x-go-signature header is malformed',
  stale: 'the signature is more than 300 seconds old or ahead: check the clock',
  mismatch: 'the signature does not match: check GO_SIGNING_SECRET, and sign the full target with its query string',
  replayed: 'signature already used',
} as const;

const refuse = (reason: keyof typeof MESSAGES): GuardResult => ({ ok: false, reason, message: MESSAGES[reason] });

/** The header's fields, read exactly the way verifyRequest reads them: the last of a repeated field wins. */
function signatureFields(header: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return fields;
}

export class SignatureGuard {
  /** The v1 of every signature accepted, with its t. */
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  check(header: string | string[] | undefined, target: string, nowSeconds: number): GuardResult {
    if (Array.isArray(header)) return refuse('malformed');
    const verdict = verifyRequest({ method: 'GET', target, body: '' }, header, this.secret, nowSeconds);
    if (!verdict.ok) return refuse(verdict.reason);
    for (const [v1, t] of this.used) if (t + MAX_SKEW_SECONDS < nowSeconds) this.used.delete(v1);
    // Keyed on v1 alone: the HMAC already binds t and the target, so one v1 is one signature. Read from the
    // fields verifyRequest just checked, so extra fields or a different order cannot make a used one look new.
    const fields = signatureFields(header ?? '');
    const v1 = fields.get('v1') ?? '';
    if (this.used.has(v1)) return refuse('replayed');
    this.used.set(v1, Number(fields.get('t')));
    return { ok: true };
  }
}
