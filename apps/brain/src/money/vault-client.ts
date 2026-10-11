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

/** A person's travel details as on their ID, kept in their vault: only ever typed into a booking's own form. */
export interface TravelDetails {
  firstName: string;
  lastName: string;
  gender: 'male' | 'female';
  /** YYYY-MM-DD. */
  dob: string;
  /** Their IRCTC user ID, for a train ticket's own form on ixigo (never its password); absent until they add it. */
  irctcUserId?: string;
}

export interface VaultClient {
  /** display embedded: the home the App frames (the vault answers 409 for any other start); sheet, the default: the browser sheet. */
  homeLink(i: { personId: string; start: 'home' | 'add_card' | 'add_login' | 'add_travel'; display?: 'sheet' | 'embedded' }): Promise<{ url: string; expiresAt: string }>;
  /**
   * A person's travel details for a ticket of their own Go is booking (booking.travellerPersonId is them; the vault refuses
   * anyone else; booking.ref is the flight booking's run id), or null when they kept none. The values go only into the booking's own form: never a log line, the
   * model, memory, a card or a picture.
   */
  travelDetails(i: { tripId: string; personId: string; booking: { ref: string; travellerPersonId: string; purpose: string } }): Promise<TravelDetails | null>;
  /** A refusal's `detail` says why, in words for the logs and the payments row (never for the room). */
  payLink(
    i: PayLinkInput,
    o?: { timeoutMs?: number },
  ): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; reason: PayLinkRefusal; detail?: string }>;
  bothKeys(): Promise<{ chargedApprovalIds: string[]; withoutBothKeys: number }>;
  /** Stops every pay link for an approval Go let go, so no page can pay with it. Safe to repeat. */
  voidPayLinks(approvalId: string): Promise<void>;
}

const LinkAnswer = z.object({ url: z.url({ protocol: /^https?$/ }), expires_at: z.iso.datetime({ offset: true }) });
const Refusal = z.object({ error: z.object({ reason: z.string(), detail: z.string().max(300).optional() }) });
const BothKeys = z.object({ charged_approval_ids: z.array(z.string()), without_both_keys: z.int().nonnegative() });
const TravelAnswer = z.object({
  first_name: z.string().min(1), last_name: z.string().min(1), gender: z.enum(['male', 'female']), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  irctc_user_id: z.string().min(1).max(60).nullish(),
});

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
      const r = await call('POST', '/internal/links', { person_id: i.personId, start: i.start, display: i.display }, o.timeoutMs ?? 1_500);
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
          const detail = refusal.success ? refusal.data.error.detail : undefined;
          return { ok: false, reason, ...(detail ? { detail } : {}) };
        }
        return { ok: false, reason: 'unavailable', detail: `the vault answered ${r.status}` };
      } catch (e) {
        return { ok: false, reason: 'unavailable', detail: `the vault could not be reached${e instanceof Error ? `: ${e.message.slice(0, 120)}` : ''}` };
      }
    },
    async voidPayLinks(approvalId) {
      const r = await call('POST', '/internal/pay-links/void', { approval_id: approvalId }, o.timeoutMs ?? 2_000);
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
    },
    async travelDetails(i) {
      const r = await call(
        'POST',
        '/internal/travel-details',
        { trip_id: i.tripId, person_id: i.personId, booking: { ref: i.booking.ref, traveller_person_id: i.booking.travellerPersonId, purpose: i.booking.purpose } },
        o.timeoutMs ?? 2_000,
      );
      if (r.status === 404) return null;
      // Never the answer in an error: its values are the person's.
      if (r.status === 403) throw new Error("the vault reads a person's travel details only for a ticket of their own");
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
      const t = TravelAnswer.safeParse(r.data);
      if (!t.success) throw new Error('the vault answered travel details in a shape Go does not read');
      return { firstName: t.data.first_name, lastName: t.data.last_name, gender: t.data.gender, dob: t.data.dob, ...(t.data.irctc_user_id ? { irctcUserId: t.data.irctc_user_id } : {}) };
    },
    async bothKeys() {
      const r = await call('GET', '/internal/both-keys', null, o.timeoutMs ?? 2_000);
      if (r.status !== 200) throw new Error(`the vault answered ${r.status}`);
      const b = BothKeys.parse(r.data);
      return { chargedApprovalIds: b.charged_approval_ids, withoutBothKeys: b.without_both_keys };
    },
  };
}
