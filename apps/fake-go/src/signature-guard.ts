// Checks the signature on the socket upgrade, and accepts each (t, v1) once.
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

export class SignatureGuard {
  /** "t:v1" of every signature accepted, with its t. */
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  check(header: string | string[] | undefined, target: string, nowSeconds: number): GuardResult {
    if (Array.isArray(header)) return refuse('malformed');
    const verdict = verifyRequest({ method: 'GET', target, body: '' }, header, this.secret, nowSeconds);
    if (!verdict.ok) return refuse(verdict.reason);
    for (const [key, t] of this.used) if (t + MAX_SKEW_SECONDS < nowSeconds) this.used.delete(key);
    // Keyed on the values, not the header text, so the same signature with its fields swapped is still a repeat.
    const t = Number(/(?:^|,)\s*t=(\d+)/.exec(header ?? '')?.[1]);
    const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header ?? '')?.[1] ?? '';
    const key = `${t}:${v1}`;
    if (this.used.has(key)) return refuse('replayed');
    this.used.set(key, t);
    return { ok: true };
  }
}
