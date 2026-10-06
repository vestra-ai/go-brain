import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { signVaultCall, VAULT_SIGNATURE_HEADER } from './signed.js';

export type PaymentKind = 'fake' | 'stripe_test' | 'ixigo';
export type PayLinkRefusal =
  | 'bad_approval'
  | 'expired'
  | 'wrong_trip'
  | 'wrong_payer'
  | 'currency_mismatch'
  | 'over_amount'
  | 'hold_expiring'
  | 'rail_not_ready'
  | 'used'
  | 'unavailable';

const KNOWN: ReadonlySet<string> = new Set<PayLinkRefusal>([
  'bad_approval', 'expired', 'wrong_trip', 'wrong_payer', 'currency_mismatch', 'over_amount', 'hold_expiring', 'rail_not_ready', 'used',
]);

export interface PayLinkInput {
  approval: string;
  approvalId: string;
  tripId: string;
  payerPersonId: string;
  payerName: string;
  hold: { holdId: string; amountMinor: number; currency: string; merchant: string; paymentKind: PaymentKind; expiresAt: string };
}

export interface VaultClient {
  homeLink(i: { personId: string; start: 'home' | 'add_card' | 'add_login' }): Promise<{ url: string; expiresAt: string }>;
  payLink(i: PayLinkInput, o?: { timeoutMs?: number }): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; reason: PayLinkRefusal }>;
  bothKeys(): Promise<{ chargedApprovalIds: string[]; withoutBothKeys: number }>;
  /** Stops every pay link for an approval Go let go, so no page can pay with it. Safe to repeat. */
  voidPayLinks(approvalId: string): Promise<void>;
}

const LinkAnswer = z.object({ url: z.url({ protocol: /^https?$/ }), expires_at: z.iso.datetime({ offset: true }) });
const Refusal = z.object({ error: z.object({ reason: z.string() }) });
const BothKeys = z.object({ charged_approval_ids: z.array(z.string()), without_both_keys: z.int().nonnegative() });

export function vaultClient(o: { baseUrl: string; secret: string; fetch?: typeof fetch; now?: () => Date; timeoutMs?: number }): VaultClient {
  const send = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const base = o.baseUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, timeoutMs: number): Promise<{ status: number; data: unknown }> {
    // A fresh nonce in every call keeps two identical calls in the same second from looking like a replay.
    const nonce = randomBytes(8).toString('hex');
    const target = method === 'GET' ? `${path}?n=${nonce}` : path;
    const text = body ? JSON.stringify({ ...body, nonce }) : '';
    const headers: Record<string, string> = { [VAULT_SIGNATURE_HEADER]: signVaultCall(o.secret, method, target, text, now()) };
    if (text) headers['content-type'] = 'application/json';
    const res = await send(`${base}${target}`, { method, headers, ...(text ? { body: text } : {}), signal: AbortSignal.timeout(timeoutMs) });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  return {
    async homeLink(i) {
      const r = await call('POST', '/internal/links', { person_id: i.personId, start: i.start }, o.timeoutMs ?? 1_500);
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
      const link = LinkAnswer.parse(r.data);
      return { url: link.url, expiresAt: link.expires_at };
    },
    async payLink(i, opts) {
      try {
        const r = await call(
          'POST',
          '/internal/pay-links',
          {
            approval: i.approval,
            approval_id: i.approvalId,
            trip_id: i.tripId,
            payer_person_id: i.payerPersonId,
            payer_name: i.payerName,
            hold: {
              hold_id: i.hold.holdId,
              amount_minor: i.hold.amountMinor,
              currency: i.hold.currency,
              merchant: i.hold.merchant,
              payment_kind: i.hold.paymentKind,
              expires_at: i.hold.expiresAt,
            },
          },
          opts?.timeoutMs ?? o.timeoutMs ?? 2_000,
        );
        if (r.status === 200) {
          const link = LinkAnswer.parse(r.data);
          return { ok: true, url: link.url, expiresAt: link.expires_at };
        }
        if (r.status === 409) {
          const refusal = Refusal.safeParse(r.data);
          const reason = refusal.success && KNOWN.has(refusal.data.error.reason) ? (refusal.data.error.reason as PayLinkRefusal) : 'unavailable';
          return { ok: false, reason };
        }
        return { ok: false, reason: 'unavailable' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async voidPayLinks(approvalId) {
      const r = await call('POST', '/internal/pay-links/void', { approval_id: approvalId }, o.timeoutMs ?? 2_000);
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
    },
    async bothKeys() {
      const r = await call('GET', '/internal/both-keys', null, o.timeoutMs ?? 2_000);
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
      const b = BothKeys.parse(r.data);
      return { chargedApprovalIds: b.charged_approval_ids, withoutBothKeys: b.without_both_keys };
    },
  };
}
