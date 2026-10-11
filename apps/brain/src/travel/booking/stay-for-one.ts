/**
 * A trip of one books its stay the way a person books their own flight (Keshav, 12 Oct: "a trip of one never gets a vote;
 * their word is the decision"). With no vote there is no mandate, so the group's way (I'll book it, set_mandate, Yes, book
 * it) can't book it: their Choose this on the stays card is their pick, and the Server's personal approval for it
 * (contract 1.3: the option they tapped on Go's card, at most its price plus 5%) pays for it. Go checks the trip's ixigo
 * login (theirs to give, as the person booking), holds the stay (BOOKING: ixigo's own pages up to Pay, on the stage), and
 * posts their pay card (money's). Paid, the booking goes on the trip, their ticket card goes up, and Go wakes for their
 * flights, as a group's stay does (stayBooked).
 */
import type pg from 'pg';
import type { ServerLink } from '../../door/server-link.js';
import type { Log } from '../../log.js';
import { clip, formatInr } from '../cards.js';
import { stableId } from '../ids.js';
import type { IxigoLogin } from '../login.js';
import { TravelError } from '../mcp-travel.js';
import type { ResultsStore } from '../results.js';
import type { StoredOffer, Travel } from '../travel.js';
import { FARE_MOVE_OK, type TicketPay } from './flight-booking.js';

export interface StayForOneDeps {
  pool: pg.Pool;
  link: Pick<ServerLink, 'request'>;
  /** brain.travel, read when it books: the travel layer registers after this is made. */
  travel: () => Pick<Travel, 'offer' | 'hold' | 'confirm'> | undefined;
  login: Pick<IxigoLogin, 'ensure'>;
  /** Money's Pay, read when it books: money registers after travel. */
  pay: () => TicketPay | undefined;
  results: Pick<ResultsStore, 'offer'>;
  /** The stay booked: Go wakes for their flights (composer/wakes.ts, stay.booked). */
  stayBooked: (tripId: string, b: { bookingId: string; title: string }) => Promise<void>;
  log: Log;
}

export interface StayAsk {
  tapId: string;
  tripId: string;
  personId: string;
  name: string;
  /** The stay they chose, on the card they chose it on. */
  offer: StoredOffer;
}

export interface StayForOne {
  /** Books it behind the tap's answer; 'running' when this stay is being booked already. */
  start(ask: StayAsk): 'started' | 'running';
  /** The trip's ixigo login is in: a stay that waited on it is booked now (login.onLoggedIn). */
  resumeWaiting(tripId: string): void;
  /** Every booking started, done: for tests and a clean stop. */
  settled(): Promise<void>;
}

export function createStayForOne(d: StayForOneDeps): StayForOne {
  const running = new Map<string, Promise<void>>();
  /** A choice that waits on the trip's ixigo login, by trip: the newest one. */
  const waiting = new Map<string, StayAsk>();

  const say = (ask: StayAsk, text: string, step: string): Promise<unknown> =>
    d.link.request('post_message', { request_id: stableId('go_stay_one', ask.tapId, step), trip_id: ask.tripId, text: clip(text, 2000) });

  // Paid, through money (the vault's word, or the Server's payment.completed): the booking a stay's pay card was for.
  // Hooked on the first booking, since money registers after travel.
  let hooked = false;
  const hookPaid = (pay: TicketPay): void => {
    if (hooked) return;
    hooked = true;
    pay.onPaid(async ({ tripId, approvalId, railRef, bookingId }) => {
      const { rows } = await d.pool.query<{ hold_id: string | null; payer_person_id: string; amount_minor: string | null; currency: string | null; pick_option_id: string | null }>(
        `select hold_id, payer_person_id, amount_minor, currency, pick_option_id from payments where trip_id = $1 and approval_id = $2 and kind = 'ticket'`,
        [tripId, approvalId],
      );
      const row = rows[0];
      if (!row?.hold_id || !row.pick_option_id) return;
      // A flight's, a train's or a bus's ticket is its own flow's.
      const offer = await d.results.offer(row.pick_option_id);
      if (offer?.kind !== 'stay') return;
      const travel = d.travel();
      if (!travel) throw new Error('no travel layer to confirm a stay for one');
      // The Server's own booking when it paid on their tap (payment.completed): Go books nothing more.
      let booked = bookingId ?? null;
      let title = offer.title;
      let ref: string | null = null;
      let refundableUntil: string | null = null;
      let simulated = true;
      if (!booked) {
        const c = await travel.confirm(row.hold_id, { approvalId, railRef });
        ({ title, ref } = c);
        refundableUntil = c.refundableUntil ?? null;
        simulated = c.simulated === true;
        const added = await d.link.request('add_booking', {
          request_id: stableId('go_stay_one_booking', approvalId),
          trip_id: tripId,
          kind: 'stay',
          title: clip(c.title, 120),
          vendor: clip(c.vendor, 80),
          ref: clip(c.ref, 80),
          amount_minor: Number(row.amount_minor),
          currency: row.currency ?? 'INR',
          payer_person_id: row.payer_person_id,
          for_person_ids: [row.payer_person_id],
          approval_id: approvalId,
          ...(refundableUntil ? { refundable_until: refundableUntil } : {}),
          ...(c.startsAt ? { starts_at: c.startsAt } : {}),
          ...(c.endsAt ? { ends_at: c.endsAt } : {}),
          ...(c.place ? { place: c.place } : {}),
          ...(c.imageUrl ? { image_url: c.imageUrl } : {}),
        });
        booked = added.booking_id;
      }
      await pay.booked?.({ tripId, approvalId, bookingId: booked, title, ref, refundableUntil, simulated, personId: row.payer_person_id });
      await d.stayBooked(tripId, { bookingId: booked, title });
    });
  };

  async function book(ask: StayAsk): Promise<void> {
    const travel = d.travel();
    const pay = d.pay();
    const title = ask.offer.title;
    if (!travel || !pay?.requestTicketCard) {
      await say(ask, `Booking ${title} through Go isn't on here yet. Its ixigo page is on the card.`, 'off');
      return;
    }
    hookPaid(pay);
    const ref = await travel.offer(ask.offer.optionId);
    if (!ref?.offerId) {
      await say(ask, `${title} can't be booked through Go. Its ixigo page is on the card.`, 'unbookable');
      return;
    }
    // The trip's ixigo login, theirs to give as the one booking: its own card asks; a card already up gets its one line.
    const login = await d.login.ensure(ask.tripId, `Booking ${title}`, { booking: true, for: ask.personId });
    if (!login.ok) {
      waiting.set(ask.tripId, ask);
      if (login.line) await say(ask, login.line, 'login');
      return;
    }
    let hold;
    try {
      hold = await travel.hold(ref.offerId, { name: ask.name, personIds: [ask.personId] });
    } catch (err) {
      if (!(err instanceof TravelError)) throw err;
      // The hold's own login read refusing: its words are for the model, so the room hears it plainly.
      const words = err.code === 'refused' ? `Booking ${title} needs the trip's ixigo login first. Tap Choose this again once it's in.` : err.message;
      await say(ask, words, 'hold');
      return;
    }
    // The Server approves their pick up to its price on the card plus 5%: a stay that went up more is said, never paid.
    const picked = ref.priceMinor;
    if (picked !== null && hold.amountMinor > Math.round(picked * FARE_MOVE_OK)) {
      await say(ask, `${title} is ${formatInr(hold.amountMinor)} on ixigo now, up from ${formatInr(picked)} on the card, so I haven't booked it. Want me to look again at today's prices?`, 'moved');
      return;
    }
    const card = await pay.requestTicketCard(ask.tripId, {
      personId: ask.personId,
      cardId: ask.offer.cardId,
      optionId: ask.offer.optionId,
      amountMinor: hold.amountMinor,
      currency: hold.currency,
      purpose: clip(`${title}, for ${ask.name}`, 200),
      key: hold.holdId,
      trigger: ask.tapId,
    });
    if ('refused' in card && card.say) await say(ask, card.refused, 'refused');
  }

  function start(ask: StayAsk): 'started' | 'running' {
    const key = `${ask.tripId}|${ask.offer.optionId}`;
    if (running.has(key)) return 'running';
    const run = book(ask)
      .catch((err: unknown) => {
        d.log.error({ err: String(err).slice(0, 200), tripId: ask.tripId }, 'travel: booking a stay for one failed');
        return say(ask, `Booking ${ask.offer.title} stopped before the payment. Tap Choose this again to try once more.`, 'failed').catch(() => undefined);
      })
      .then(() => undefined)
      .finally(() => running.delete(key));
    running.set(key, run);
    return 'started';
  }

  return {
    start,
    resumeWaiting(tripId) {
      const ask = waiting.get(tripId);
      if (!ask) return;
      waiting.delete(tripId);
      start({ ...ask, tapId: `${ask.tapId}_in` });
    },
    async settled() {
      while (running.size) await Promise.all([...running.values()]);
    },
  };
}
