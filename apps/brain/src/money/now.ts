import type { DeskItem } from '../desk/desk.js';
import type { NowProvider } from '../composer/context.js';
import type { Packs } from '../trips/pack.js';
import type pg from 'pg';
import { listForTrip } from './store.js';
import { failReasonWords, money } from './words.js';

const clock = (at: Date): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(at).toLowerCase();

/** "Right now": what is waiting on whom for money in this trip, and what the composer may do next. */
export function paymentsNow(d: { pool: pg.Pool; packs: Pick<Packs, 'get'>; now: () => Date }): NowProvider {
  return {
    name: 'payments',
    order: 40,
    async render(tripId: string, _wake: DeskItem[]): Promise<string | null> {
      const pack = await d.packs.get(tripId);
      const rows = await listForTrip(d.pool, tripId, 12);
      const nameOf = (id: string) => pack.trip.people.find((p) => p.person_id === id)?.name ?? 'someone';
      const since = d.now().getTime() - 24 * 3_600_000;
      const lines: string[] = [];

      for (const r of rows) {
        const amount = r.amount_minor !== null && r.currency ? money(r.amount_minor, r.currency) : '';
        if (r.state === 'waiting') {
          const until = r.approval_expires_at ? `; the approval runs out at ${clock(r.approval_expires_at)}` : '';
          lines.push(`- Waiting on ${r.payer_name} to approve ${amount} for ${r.label} on pay card ${r.card_id ?? ''}${until}.`);
          continue;
        }
        if (r.created_at.getTime() < since) continue;
        if (r.state === 'paid') lines.push(r.ticket_posted_at ? `- Paid and booked: ${r.label}, ${amount} by ${r.payer_name}.` : `- Paid: ${r.label}. The booking is being finished.`);
        if (r.state === 'failed') lines.push(`- Didn't go through: ${r.label} (${failReasonWords(r.fail_reason)}). Nothing was charged.`);
        if (r.state === 'declined') lines.push(`- ${r.payer_name} declined paying for ${r.label}. Don't ask again unless someone asks.`);
        if (r.state === 'expired') lines.push(`- The pay card for ${r.label} timed out. ${r.payer_name} can tap Start again on it.`);
      }

      for (const dec of pack.trip.decisions) {
        if (dec.kind !== 'choice' || dec.status !== 'closed') continue;
        if (rows.some((r) => r.decision_id === dec.decision_id && (r.state === 'asking' || r.state === 'waiting' || r.state === 'paid'))) continue;
        const m = dec.mandate;
        const win = dec.options[m?.choice_index ?? dec.result_index ?? -1];
        if (!win) continue;
        if (!m) {
          lines.push(`- Vote ${dec.decision_id} closed and ${win.label} won. Once the group says who pays, use set_mandate (the cap is the price plus a little, or a number they said).`);
          continue;
        }
        const payer = nameOf(m.payer_person_id);
        const declined = m.declined_at && (!m.confirmed_at || Date.parse(m.declined_at) > Date.parse(m.confirmed_at));
        if (declined) lines.push(`- ${payer} said not now to ${win.label}.`);
        else if (!m.confirmed_at) lines.push(`- Waiting on ${payer} to tap Yes, book it for ${win.label} (vote ${dec.decision_id}).`);
        else if (win.option_ref) lines.push(`- Ready to pay for ${win.label}: ${payer} said yes. ask_to_pay with decision_id ${dec.decision_id} and option_ref ${win.option_ref}.`);
        else lines.push(`- ${payer} said yes to ${win.label}, but Go has no offer to book for it.`);
      }

      if (lines.length === 0) return null;
      return [
        "Payments. Each one needs the Server's approval and the payer's own Face ID. Only ask_to_pay starts one; never ask anyone for card details.",
        ...lines.slice(0, 10),
      ].join('\n');
    },
  };
}
