/**
 * Taps on Go's options cards. A shared thing's card is its vote since rev 5 (votes.ts): the App's Vote goes to the Server,
 * and "See more" puts more of the same search on a new card in the same vote. On cards from before, "Put it to a vote"
 * opens the vote in code (fast and once). "I'll take this" goes on the
 * desk, so the composer answers the person in the room, except on a ticket (a flight, train or bus fare: PERSONAL_KINDS),
 * which is the picker's own: Go posts their own confirm at once, "Book it" or "Change", for them alone, never a vote, and
 * keeps it as their pick (picks.ts), which a flight's heads-up watches.
 * "Book it" opens ixigo's page for the flight set for one traveller, where they book it (Go pays for no ticket yet); "Change"
 * goes on the desk. "See on ixigo" opens the option's own ixigo.com page; "Flights
 * from my city", on the card of each home city's ways there, opens the flights from the tapper's own city; "Add my
 * budget" opens the App's own budget sheet.
 */
import type * as C from '@go/contract';
import type { Brain } from '../app.js';
import type { CardTapParams } from '../door/methods.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { PAY_FLIGHT, type FlightBooking } from './booking/flight-booking.js';
import { BOOK_MINE, budgetSheet, buildConfirmMineCard, buildOptionsCard, CHANGE_MINE, clip, ixigoPage, PERSONAL_KINDS } from './cards.js';
import { stableId } from './ids.js';
import type { Images } from './images.js';
import { recordPick, wayOf } from './picks.js';
import { MORE_CARD, unseenNumbers, type ResultsStore } from './results.js';
import { cardPicks } from './tools.js';
import type { StoredOffer } from './travel.js';
import { addToVote, openVoteFromCard, VOTE_MOST } from './votes.js';

export interface TravelTapDeps {
  results: ResultsStore;
  pool: Brain['pool'];
  /** Go booking a person's own flight itself (BOOKING, booking/flight-booking.ts); absent, "Book it" opens ixigo. */
  booking?: Pick<FlightBooking, 'onFor' | 'start' | 'pay'>;
  /** A person's name in the trip, for the room's words about their booking. */
  nameOf?: (tripId: string, personId: string) => Promise<string>;
  link: Brain['door']['link'];
  desk: Brain['desk'];
  now: () => Date;
  log: Brain['log'];
  /** Go's image cache, for the photos on a "See more" card; absent, See more is refused. */
  images?: Images;
}

/** How long the App may hold an ixigo page it was told to open: the time its prices count as fresh. */
export const OPEN_FOR_MS = 10 * 60_000;

export function registerTravelTaps(taps: Brain['taps'], d: TravelTapDeps): void {
  // The searches whose "See more" is running: a second tap meanwhile (a double tap, two people, another card of the same
  // search) would add the same stays again.
  const moreRunning = new Set<string>();

  taps.on('options', 'vote', async (tap) => {
    const row = await d.results.card(tap.trip_id, tap.card_id);
    if (!row) return { result: 'refused', toast: 'Those options are no longer here' };
    if (row.decisionId) return { result: 'done', toast: 'Already up for a vote' };
    if (PERSONAL_KINDS.has(row.optionKind)) return { result: 'refused', toast: "A ticket is each person's own: tap I'll take this" };
    const failed = () =>
      d.desk.put({
        id: `travel:vote_failed:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
        payload: { source: 'options', action: 'vote_failed', cardId: tap.card_id, personId: tap.person_id },
      });
    // Outside a turn, ids come from the tap, so a repeat does each write once.
    const opening = async (): Promise<void> => {
      const r = await openVoteFromCard(
        { results: d.results, link: d.link, now: d.now },
        { tripId: tap.trip_id, cardId: tap.card_id, key: tap.tap_id, requestId: stableId('go_tap', tap.tap_id, 'vote'), voteCardId: stableId('c_vote', tap.tap_id) },
      );
      if (r.ok) {
        await d.link.request('post_message', { trip_id: tap.trip_id, request_id: stableId('go_tap', tap.tap_id, 'vote_card'), card: r.voteCard });
        return;
      }
      if (r.reason !== 'already_voting' && r.reason !== 'personal') await failed();
    };
    // The vote opens after the answer: two requests to the Server must not hold the 3 s tap answer.
    void opening()
      .catch(async (err: unknown) => {
        d.log.error({ err, cardId: tap.card_id }, 'travel: opening a vote from a tap failed');
        await failed();
      });
    return { result: 'done', toast: 'Putting it to a vote' };
  });

  taps.on('options', 'pick', async (tap) => {
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.cardId !== tap.card_id || offer.tripId !== tap.trip_id) return { result: 'refused', toast: 'That option is no longer available' };
    // A ticket is the picker's own: their confirm goes up at once, for them alone, with no vote and no model round.
    const row = await d.results.card(tap.trip_id, tap.card_id);
    const shown = row?.card.options.find((o) => o.option_id === offer.optionId);
    if (row && shown && PERSONAL_KINDS.has(row.optionKind)) {
      // Their pick, one per way they travel: a later one the same way replaces it. A failed write never fails the tap.
      await recordPick(d.pool, {
        tripId: tap.trip_id, personId: tap.person_id, kind: row.optionKind as 'flight' | 'train' | 'bus', way: wayOf(shown.journey),
        optionId: offer.optionId, title: shown.title, journey: shown.journey ?? null, pickedAt: d.now(),
      }).catch((err: unknown) => d.log.error({ err, cardId: tap.card_id }, "travel: keeping a person's pick failed"));
      const card = buildConfirmMineCard({ cardId: stableId('c_mine', tap.tap_id), personId: tap.person_id, optionKind: row.optionKind, checkedAt: offer.checkedAt, option: shown });
      // Posted after the answer, as a vote is: a request to the Server must not hold the 3 s tap answer.
      void d.link.request('post_message', { trip_id: tap.trip_id, request_id: stableId('go_tap', tap.tap_id, 'mine'), card, visible_to_person_ids: [tap.person_id] })
        .catch((err: unknown) => d.log.error({ err, cardId: tap.card_id }, "travel: posting a person's own confirm failed"));
      return { result: 'done', toast: "It's yours to confirm" };
    }
    await d.desk.put({
      id: `travel:pick:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
      payload: { source: 'options', action: 'pick', cardId: tap.card_id, optionId: offer.optionId, n: offer.n, title: offer.title, personId: tap.person_id },
    });
    return { result: 'done', toast: 'Noted. Go will reply in the room.' };
  });

  // A person's own confirm (a ticket they picked): only they may answer it.
  const mine = async (tap: CardTapParams, card: C.Card): Promise<{ refused: string } | { offer: StoredOffer }> => {
    const forWho = 'for_person_ids' in card ? (card.for_person_ids ?? []) : [];
    if (!forWho.includes(tap.person_id)) return { refused: 'This one is for someone else to confirm' };
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.tripId !== tap.trip_id) return { refused: 'That option is no longer available' };
    return { offer };
  };
  // "Book it": ixigo's page for this flight, set for one traveller, where they book it themselves. Go pays for no ticket
  // yet (a fare is per person, and the Server's approval needs a group vote until its personal form, ask B8, is agreed).
  taps.on('options', BOOK_MINE, async (tap, card) => {
    const m = await mine(tap, card);
    if ('refused' in m) return { result: 'refused', toast: m.refused };
    // Go books it itself, on the stage, up to ixigo's pay button (BOOKING): the tap answers at once, the booking goes on.
    if (d.booking && m.offer.kind === 'flight' && m.offer.sourceUrl && (await d.booking.onFor(tap.trip_id))) {
      const name = (await d.nameOf?.(tap.trip_id, tap.person_id).catch(() => null)) ?? 'you';
      await d.booking.start({ tapId: tap.tap_id, tripId: tap.trip_id, personId: tap.person_id, name, offer: m.offer, choice: 'basic' });
      return { result: 'done', toast: "Go is booking it on the trip's computer" };
    }
    const url = ixigoPage(forOne(m.offer.sourceUrl));
    if (!url) return { result: 'refused', toast: 'This option has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });
  // "Change": Go shows them other tickets, in the room, theirs to pick.
  taps.on('options', CHANGE_MINE, async (tap, card) => {
    const m = await mine(tap, card);
    if ('refused' in m) return { result: 'refused', toast: m.refused };
    await d.desk.put({
      id: `travel:change:${tap.tap_id}`, tripId: tap.trip_id, kind: 'tap', ref: tap.card_id, dueAt: d.now(),
      payload: { source: 'options', action: 'change_mine', cardId: tap.card_id, optionId: m.offer.optionId, title: m.offer.title, kind: m.offer.kind, personId: tap.person_id },
    });
    return { result: 'done', toast: 'Go will find you another' };
  });

  // Pay on a flight Go booked up to ixigo's pay button (booking/flight-booking.ts): the vault's pay page for its traveller
  // alone, through the Server's approval for a person's own ticket.
  taps.on('notice', PAY_FLIGHT, async (tap, card) => {
    if (!('for_person_ids' in card ? (card.for_person_ids ?? []) : []).includes(tap.person_id)) return { result: 'refused', toast: 'This one is for someone else to pay' };
    if (!d.booking) return { result: 'refused', toast: 'Paying for a ticket through Go opens soon' };
    return d.booking.pay({ tripId: tap.trip_id, cardId: tap.card_id, personId: tap.person_id, tapId: tap.tap_id });
  });
  // The flights link card: its own ixigo page, from the card itself.
  taps.on('notice', 'see_on_ixigo', async (_tap, card) => {
    const url = card.kind === 'notice' ? ixigoPage(card.source?.url) : null;
    if (!url) return { result: 'refused', toast: 'This card has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });

  // "See more" (rev 5 R4): up to 10 more of the same search that no card has shown, on a new card in the same vote. The
  // tap answers at once and the card follows; with nothing new left, the vote closed or full, a toast says so instead.
  taps.on('options', 'more_options', async (tap) => {
    const row = await d.results.card(tap.trip_id, tap.card_id);
    const set = row ? await d.results.get(tap.trip_id, row.resultsId) : null;
    const decisionId = row?.card.decision_id ?? null;
    const images = d.images;
    if (!row || !set || !decisionId || !images) return { result: 'refused', toast: 'Those options are no longer here' };
    if (moreRunning.has(set.resultsId)) return { result: 'done', toast: 'More are on the way' };
    // Claimed before anything waits, until its card is up or it gives up: a second tap meanwhile never adds the same stays.
    moreRunning.add(set.resultsId);
    let running = false;
    try {
      const unseen = unseenNumbers(set, await d.results.shownFrom(tap.trip_id, set.resultsId));
      if (unseen.length === 0) return { result: 'done', toast: "That's everything ixigo listed for this search" };
      const trip = await d.link.request('read_trip', { trip_id: tap.trip_id });
      const vote = trip.decisions.find((x) => x.decision_id === decisionId);
      if (vote?.status !== 'open') return { result: 'done', toast: 'The vote has closed' };
      if (vote.options.length >= VOTE_MOST) return { result: 'done', toast: `This vote has ${VOTE_MOST} options, the most one vote takes` };
      const numbers = unseen.slice(0, Math.min(10, VOTE_MOST - vote.options.length));
      const people = typeof set.query['guests'] === 'number' ? set.query['guests'] : trip.people.length;
      // Outside a turn, ids come from the tap, so a repeat does each write once.
      const cardId = stableId(MORE_CARD, tap.tap_id);
      const more = async (): Promise<void> => {
        let added = false;
        try {
          const picks = await cardPicks(set, numbers, cardId, people, { images });
          const title = `More: ${row.title.replace(/^More: /, '')}`;
          const card = buildOptionsCard({ cardId, title, optionKind: row.optionKind, checkedAt: set.checkedAt, picks });
          await d.results.saveCard({ cardId, tripId: tap.trip_id, resultsId: set.resultsId, title: card.title, optionKind: row.optionKind, card }, picks, set.checkedAt);
          await addToVote({ results: d.results, link: d.link }, { tripId: tap.trip_id, cardId, decisionId, requestId: stableId('go_more', tap.tap_id) });
          added = true;
          // Its own "See more" while the search has more and the vote has room after these.
          const left = unseen.length > numbers.length && vote.options.length + numbers.length < VOTE_MOST;
          const voting = await d.results.setCardDecision(tap.trip_id, cardId, decisionId, left);
          if (voting) await d.link.request('post_message', { trip_id: tap.trip_id, request_id: stableId('go_more_card', tap.tap_id), card: voting });
        } catch (err) {
          // Options that never joined the vote were never shown: the next See more offers them again.
          if (!added) await d.results.dropCard(tap.trip_id, cardId).catch(() => undefined);
          throw err;
        } finally {
          moreRunning.delete(set.resultsId);
        }
      };
      // The card goes up after the answer: a page of photos and two requests to the Server must not hold the 3 s tap answer.
      running = true;
      void more().catch((err: unknown) => d.log.error({ err, cardId: tap.card_id }, 'travel: See more failed'));
      return { result: 'done' };
    } finally {
      if (!running) moreRunning.delete(set.resultsId);
    }
  });

  // A card of stays from before rev 5 shows a few: this opens the whole list the search read on ixigo.com.
  taps.on('options', 'see_all', async (tap) => {
    const row = await d.results.card(tap.trip_id, tap.card_id);
    const set = row ? await d.results.get(tap.trip_id, row.resultsId) : null;
    const url = ixigoPage(set?.page ?? null);
    if (!url) return { result: 'refused', toast: 'This list has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });

  // The ways there: the flights from the tapper's own home city, else from the first city on the card.
  taps.on('options', 'flights_home', async (tap) => {
    const row = await d.results.card(tap.trip_id, tap.card_id);
    const set = row ? await d.results.get(tap.trip_id, row.resultsId) : null;
    const ways = set?.query['ways_there'] as { flights?: Record<string, string>; home_of?: Record<string, string> } | undefined;
    const flights = ways?.flights ?? {};
    const home = ways?.home_of?.[tap.person_id];
    const url = ixigoPage((home ? flights[home] : undefined) ?? Object.values(flights)[0] ?? null);
    if (!url) return { result: 'refused', toast: 'This card has no flights page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });

  // "Add my budget" on a stays card from before rev 4 (no card asks any more): the App's budget sheet for the trip, the
  // group's one budget now (a go:// link, contract 1.1 A4), opened in place.
  taps.on('options', 'add_budget', async (tap) => ({
    result: 'open', url: budgetSheet(tap.trip_id), expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString(),
  }));

  taps.on('options', 'open', async (tap) => {
    const offer = tap.option_id ? await d.results.offer(tap.option_id) : null;
    if (!offer || offer.cardId !== tap.card_id || offer.tripId !== tap.trip_id) return { result: 'refused', toast: 'That option is no longer here' };
    const url = ixigoPage(offer.sourceUrl);
    if (!url) return { result: 'refused', toast: 'This option has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });
}

/** An ixigo results page set for one traveller: a ticket confirmed by its own person is booked for them alone. */
export function forOne(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('adults')) return url;
    u.searchParams.set('adults', '1');
    u.searchParams.set('children', '0');
    u.searchParams.set('infants', '0');
    return u.toString();
  } catch {
    return url;
  }
}

/** How an options tap reads in "why Go woke". Null for taps from other cards. */
export function renderOptionsTap(item: DeskItem, pack: TripPack): string | null {
  const p = item.payload as { source?: string; action?: string; cardId?: string; optionId?: string; title?: string; personId?: string };
  if (p.source !== 'options') return null;
  const who = pack.trip.people.find((x) => x.person_id === p.personId)?.name ?? 'Someone';
  if (p.action === 'pick') {
    return `${who} tapped "I'll take this" on "${clip(p.title ?? 'an option', 80)}" (option ${p.optionId}, card ${p.cardId}). Reply in the room: confirm it for them, or if the group should agree first, offer put_to_vote with card_id ${p.cardId}.`;
  }
  if (p.action === 'change_mine') {
    return `${who} tapped "Change" on their own ${(p as { kind?: string }).kind ?? 'ticket'}, "${clip(p.title ?? 'an option', 80)}": they want another. Find them other ones from their own city with the search tool and show them; it is their own pick, never a vote.`;
  }
  if (p.action === 'vote_failed') {
    return `${who} tapped "Put it to a vote" on card ${p.cardId}, but opening the vote failed. Try put_to_vote with card_id ${p.cardId}, or say in one line that it did not work.`;
  }
  return null;
}
