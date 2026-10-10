/**
 * Taps on Go's options cards. "Put it to a vote" opens the vote in code (fast and once); "I'll take this" goes on the
 * desk, so the composer answers the person in the room, except on a ticket (a flight, train or bus fare: PERSONAL_KINDS),
 * which is the picker's own: Go posts their own confirm at once, "Book it" or "Change", for them alone, never a vote.
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
import { BOOK_MINE, budgetSheet, buildConfirmMineCard, CHANGE_MINE, clip, ixigoPage, PERSONAL_KINDS } from './cards.js';
import { stableId } from './ids.js';
import type { ResultsStore } from './results.js';
import type { StoredOffer } from './travel.js';
import { openVoteFromCard } from './votes.js';

export interface TravelTapDeps {
  results: ResultsStore;
  link: Brain['door']['link'];
  desk: Brain['desk'];
  now: () => Date;
  log: Brain['log'];
}

/** How long the App may hold an ixigo page it was told to open: the time its prices count as fresh. */
export const OPEN_FOR_MS = 10 * 60_000;

export function registerTravelTaps(taps: Brain['taps'], d: TravelTapDeps): void {
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
      const card = buildConfirmMineCard({ cardId: stableId('c_mine', tap.tap_id), personId: tap.person_id, optionKind: row.optionKind, checkedAt: offer.checkedAt, option: shown });
      // Posted after the answer, as a vote is: a request to the Server must not hold the 3 s tap answer.
      void d.link.request('post_message', { trip_id: tap.trip_id, request_id: stableId('go_tap', tap.tap_id, 'mine'), card })
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

  // The flights link card: its own ixigo page, from the card itself.
  taps.on('notice', 'see_on_ixigo', async (_tap, card) => {
    const url = card.kind === 'notice' ? ixigoPage(card.source?.url) : null;
    if (!url) return { result: 'refused', toast: 'This card has no ixigo page' };
    return { result: 'open', url, expires_at: new Date(d.now().getTime() + OPEN_FOR_MS).toISOString() };
  });

  // A card of stays shows a few: this opens the whole list the search read on ixigo.com.
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

  // "Add my budget": the App's own budget sheet for the trip (a go:// link, contract 1.1 A4), opened in place.
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
