import type { DeskItem } from '../desk/desk.js';
import type { NowProvider } from '../composer/context.js';
import type { Packs } from '../trips/pack.js';
import type { Travel } from '../travel/travel.js';
import type pg from 'pg';
import type { Claims } from './claims.js';
import { whyNotBookable } from './mandate.js';
import { listForTrip } from './store.js';
import { failReasonWords, money } from './words.js';

const clock = (at: Date): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(at).toLowerCase();

/** "Right now": what is waiting on whom for money in this trip, and what the composer may do next. */
export function paymentsNow(d: { pool: pg.Pool; packs: Pick<Packs, 'get'>; now: () => Date; travel?: () => Travel | undefined; claims?: Claims }): NowProvider {
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
        // A traveller's own ticket (contract 1.2) has no pay card: their ticket's own card opened the vault's page.
        const ticket = r.kind === 'ticket';
        if (r.state === 'waiting') {
          const until = r.approval_expires_at ? `; the approval runs out at ${clock(r.approval_expires_at)}` : '';
          lines.push(
            ticket
              ? `- Waiting on ${r.payer_name} to pay ${amount} for their own ticket, ${r.label}, on the vault page their Pay opened${until}.`
              : `- Waiting on ${r.payer_name} to approve ${amount} for ${r.label} on pay card ${r.card_id ?? ''}, in this chat${until}. ` +
                "If they say they can't see it, or declined it by mistake, call ask_to_pay with again: true for a fresh one; say a fresh one is up only once it answers with its card.",
          );
          continue;
        }
        if (r.state === 'confirming') {
          lines.push(
            r.checking_at
              ? `- Go couldn't confirm ${r.payer_name}'s payment of ${amount} for ${r.label}; a person is checking it. Never start it again.`
              : `- The bank is still confirming ${r.payer_name}'s payment of ${amount} for ${r.label}. Never start it again; Go says when it's done.`,
          );
          continue;
        }
        if (r.created_at.getTime() < since) continue;
        if (r.state === 'paid' && ticket) {
          const test = r.payment_kind !== 'ixigo' ? ' A test payment: nothing was booked on ixigo.' : '';
          lines.push(`- Paid: ${r.label}, ${amount} by ${r.payer_name}, their own ticket.${test}`);
        } else if (r.state === 'paid') {
          lines.push(r.ticket_posted_at ? `- Paid and booked: ${r.label}, ${amount} by ${r.payer_name}.` : `- Paid: ${r.label}. The booking is being finished.`);
        }
        if (r.state === 'failed') lines.push(`- Didn't go through: ${r.label} (${failReasonWords(r.fail_reason)}). Nothing was charged.`);
        if (r.state === 'declined') {
          lines.push(`- ${r.payer_name} declined paying for ${r.label}. Don't ask again unless someone asks; declined by mistake, ask_to_pay sends a fresh card.`);
        }
        if (r.state === 'expired') {
          lines.push(
            ticket
              ? `- ${r.payer_name}'s payment page for ${r.label} timed out. Pay on their ticket's card starts a fresh one.`
              : `- The pay card for ${r.label} timed out. ${r.payer_name} can tap Start again on it.`,
          );
        }
      }

      for (const dec of pack.trip.decisions) {
        if (dec.kind !== 'choice' || dec.status !== 'closed') continue;
        if (rows.some((r) => r.decision_id === dec.decision_id && (r.state === 'asking' || r.state === 'waiting' || r.state === 'confirming' || r.state === 'paid'))) continue;
        const m = dec.mandate;
        const win = dec.options[m?.choice_index ?? dec.result_index ?? -1];
        if (!win) continue;
        if (!m) {
          // Something Go cannot book needs no payer: tell the composer before it asks the group who pays. A check that
          // failed just now proves nothing, so that falls through to the usual line.
          const cannot = d.travel ? await whyNotBookable({ travel: d.travel }, win, tripId) : null;
          if (cannot?.unbookable) {
            lines.push(`- Vote ${dec.decision_id} closed and ${win.label} won, but Go can't book it: don't ask who pays or use set_mandate. If it comes up, say: ${cannot.refused}`);
            continue;
          }
          // A stay is booked for all by whoever claims it (claims.ts): Go never picks the payer.
          const stay = d.claims && win.option_ref && (await d.travel?.()?.offer(win.option_ref).catch(() => null))?.kind === 'stay';
          // A trip of one: they pay and book for themselves, with no "for all" and nobody to split with.
          const only = pack.trip.people.length === 1 ? pack.trip.people[0] : undefined;
          if (only) {
            lines.push(`- Vote ${dec.decision_id} closed and ${win.label} won. ${only.name} travels alone and books it for themselves: when they want it, use set_mandate with payer ${only.person_id} (the cap is the price plus a little, or a number they said). Never say "for all", "everyone" or split.`);
            continue;
          }
          if (stay && d.claims) {
            const held = (await d.claims.get(tripId, dec.decision_id))?.personId;
            lines.push(
              held
                ? `- Vote ${dec.decision_id} closed and ${win.label} won. ${nameOf(held)} is booking it for all: use set_mandate with payer ${held} (the cap is the price plus a little, or a number they said).`
                : `- Vote ${dec.decision_id} closed and ${win.label} won. One person books it for all: whoever taps I'll book it on Go's card, or asks you to book it themselves (their ask is their claim: set_mandate with them as payer). Never pick who pays.`,
            );
            continue;
          }
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
