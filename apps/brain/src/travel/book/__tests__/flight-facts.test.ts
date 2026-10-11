import { describe, expect, it } from 'vitest';
import { subtitleFor } from '../../cards.js';
import { flightDetails } from '../../details.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { toResultOption } from '../../results.js';
import { loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The ixigo atlas (10 Oct): what ixigo's flight cards and filters say is in the stream Go already reads. The sample is
// ixigo's own Delhi to Goa stream (9 Oct, logged out, four flights), and one flight made from it that sells two fares,
// handbag-only and with a check-in bag, as international routes do (Delhi to Dubai, 10 Oct).
const { book } = loadBook();
const STREAM = '/flights/v2/search/stream';
const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream';

function stream(): string {
  const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: { flightJourneys: Array<{ flightFare: Array<Record<string, any>> }> } };
  const fares = value.data.flightJourneys[0]!.flightFare;
  const base = fares[0]!;
  const fare = base.fares[0];
  const two = {
    ...base, flightKeys: 'DEL-GOI-IX2000-13112026', isFreeMealAvailable: true,
    fares: [
      { ...fare, fareType: 'HAND_BAGGAGE_ONLY', fareDisplayText: 'Handbag Only Fare', fareDetails: { ...fare.fareDetails, displayFare: 7_800 },
        fareMetadata: [{ ...fare.fareMetadata[0], seatRemaining: 2, handBaggageOnly: true, baggageDetails: { checkInBaggage: '', checkInBaggageText: '', handBaggage: '7 kg per adult', handBaggageText: '' } }] },
      { ...fare, fareDetails: { ...fare.fareDetails, displayFare: 8_400 } },
    ],
  };
  return `data:${JSON.stringify({ ...value, data: { ...value.data, flightJourneys: [{ ...value.data.flightJourneys[0], flightFare: [...fares, two] }] } })}\n\n`;
}

async function flights() {
  const runner = { read: async (_trip: string, url: string, _plan: FetchPlan) => ({ captures: [capture(STREAM, STREAM_URL, stream())], finalUrl: url }) };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T06:00:00Z') });
  const got = await engine.answer('flights.results', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, { tripId: 't_flight_facts' });
  if (got.as !== 'options') throw new Error(got.as);
  return (title: string) => got.options.find((o) => o.title === title)!;
}

describe("a flight's bags, seats, meal, changes, offer and Lock Price, from ixigo's own stream", () => {
  it('reads Lock Price per fare: its fee a person, how long it holds, the cover, and every hold ixigo offers', async () => {
    const ix = (await flights())('Air-India Express IX1196');
    expect(ix.facts).toMatchObject({
      lock: 'Lock Price ₹659 a person, holds 96 h, covers a fare rise up to ₹4,000', lock_fee_minor: 65_900, lock_hours: 96, lock_cover_minor: 400_000,
      lock_options: '₹659 for 96 h, ₹739 for 168 h',
    });
    // The group's sheet: the fee for everyone the search was for, the hold and the cover.
    const details = flightDetails(toResultOption(ix as never), 4)!;
    expect(details.facts).toContainEqual({ label: 'Lock Price', value: '₹659 a person, ₹2,636 for 4, holds this fare 96 h' });
    expect(details.facts).toContainEqual({ label: 'If the fare rises', value: 'ixigo covers up to ₹4,000' });
  });

  it("reads the fare's bags, the saving the card shows, and its refund in ixigo's words", async () => {
    const ix = (await flights())('Air-India Express IX1196');
    expect(ix.facts).toMatchObject({
      fare_type: 'Regular Fare', cabin_bag: '7 kg per piece, 1 piece per adult', checkin_bag: '15 kg per adult',
      offer: 'Extra ₹740 off with a code', offer_minor: 74_000, refundable: 'PARTIALLY_REFUNDABLE',
    });
    // Seats unknown (0), no meal, non-stop: none of them said.
    expect(ix.facts).not.toHaveProperty('seats_left');
    expect(ix.facts).not.toHaveProperty('free_meal');
    expect(ix.facts).not.toHaveProperty('layover');
    const details = flightDetails(toResultOption(ix as never), 4)!;
    expect(details.facts).toContainEqual({ label: 'Check-in bag', value: '15 kg per adult' });
    expect(details.facts).toContainEqual({ label: 'Offer', value: 'Extra ₹740 off with a code' });
    expect(details.cancellation).toBe('Partially refundable');
  });

  it("names the airport each flight lands at, by ixigo's name and its code: Goa has two (p2's re-run #16, 11 Oct)", async () => {
    const find = await flights();
    expect(find('Air-India Express IX1196').facts['arrival_airport']).toBe('Dabolim (GOI)');
    const mopa = find('Air-India Express IX1108');
    expect(mopa.facts['arrival_airport']).toBe('Manohar (GOX)');
    expect(subtitleFor(toResultOption(mopa as never))).toBe('8:35 pm to 11:15 pm at Manohar (GOX), non-stop');
    // Through Mumbai, it lands where its last flight does.
    expect(find('IndiGo 6E328 + 6E5106').facts['arrival_airport']).toBe('Dabolim (GOI)');
  });

  it('says how few seats are left on the card, and where the plane changes', async () => {
    const find = await flights();
    // Four left: a highlight. Nine left: a fact, not a highlight.
    expect(find('IndiGo 6E5341').highlights).toContain('4 seats left');
    const stop = find('IndiGo 6E328 + 6E5106');
    expect(stop.facts).toMatchObject({ seats_left: 9, layover: 'Mumbai 3 h 15 m' });
    expect(stop.highlights).toEqual(['1 stop', '6 h 55 m']);
    expect(flightDetails(toResultOption(stop as never), 4)!.facts).toContainEqual({ label: 'Change of plane', value: 'Mumbai 3 h 15 m' });
  });

  it("a handbag-only fare says so, and what the same flight costs with a check-in bag; its free meal and seats too", async () => {
    const two = (await flights())('Air-India Express IX2000');
    // ixigo's shown fare stays the price: the handbag-only one.
    expect(two.priceMinor).toBe(780_000);
    expect(two.highlights).toEqual(['Non-stop', '2 h 40 m', '2 seats left', 'Cabin bag only']);
    expect(two.facts).toMatchObject({ fare_type: 'Handbag Only Fare', checkin_bag: 'none', with_checkin_bag_minor: 840_000, seats_left: 2, free_meal: true });
    const details = flightDetails(toResultOption(two as never), 4)!;
    expect(details.facts).toContainEqual({ label: 'Check-in bag', value: 'None on this fare' });
    expect(details.facts).toContainEqual({ label: 'With a check-in bag', value: '₹8,400 a person on this flight' });
    expect(details.facts).toContainEqual({ label: 'Meal', value: 'Free meal' });
  });
});
