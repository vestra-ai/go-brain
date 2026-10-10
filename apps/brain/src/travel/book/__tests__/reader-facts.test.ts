import { describe, expect, it } from 'vitest';
import { stayDetails } from '../../details.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { toResultOption } from '../../results.js';
import { loadBook } from '../book.js';
import { createEngine, type EngineAnswer } from '../engine.js';

// The ixigo atlas (10 Oct): what ixigo's own filters and cards say is in the list Go already reads. The stays sample is
// ixigo's own Anjuna list (8 Oct, logged out); the buses one is given the fields the live list had (flags, seat stats, the
// operators), no one's data.
const { book } = loadBook();

async function read(id: string, given: Record<string, unknown>, captures: ReturnType<typeof capture>[]) {
  const runner = { read: async (_trip: string, url: string, _plan: FetchPlan) => ({ captures, finalUrl: url }) };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T05:00:00Z') });
  const got: EngineAnswer = await engine.answer(id, given, { tripId: 't_facts' });
  if (got.as !== 'options') throw new Error(got.as);
  return got.options;
}

describe("a stay's offer, how it is paid and how scarce it is, from ixigo's own list", () => {
  const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
  const URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
  const anjuna = () => read('hotels.search', { place: 'Anjuna', check_in: '2026-11-06', check_out: '2026-11-09' }, [capture(SEARCH, URL, fixture('stays-anjuna-full.json'))]);

  it("says the coupon ixigo applied on its own with the price, as ixigo's card does", async () => {
    const options = await anjuna();
    const riva = options.find((o) => o.title === 'Riva Beach Resort')!;
    expect(riva.priceNote).toBe('per night, per room, IXIFIRST applied');
    expect(riva.facts).toMatchObject({ coupon: 'IXIFIRST', offer: 'Discount of ₹604 included. Coupon code IXIFIRST applied!', rooms_left: 12 });
    // A stay with no coupon says the price as ever.
    expect(options.find((o) => o.title === 'Citadines Arpora Nagoa Goa')!.priceNote).toBe('per night, per room');
    // The details sheet says the offer in ixigo's words.
    const details = stayDetails(toResultOption(riva as never), {}, 4, [])!;
    expect(details.facts).toContainEqual({ label: 'Offer', value: 'Discount of ₹604 included. Coupon code IXIFIRST applied!' });
  });

  // Phase 2, 10 Oct: on Keshav's logged-in browser, ixigo writes the offer with its hotel cash as a picture ("₹383
  // discount + <img …hotel-cash…>") and adds fareDetail.burnInfo, the person's own hotel cash: the offer reads as its
  // words, and the hotel cash never at all (the person's own wallet; a room's card is never private). (The shape is the
  // logged-in read's; the values here are the test's own.)
  it("reads a logged-in stay's offer as words, and never its hotel cash", async () => {
    const body = JSON.parse(fixture('stays-anjuna-full.json'));
    const riva = body.data.result.inventoryInfoList.find((h: { name: string }) => h.name === 'Riva Beach Resort');
    riva.fareDetail.offerMessage = '₹604 discount + <img src="https://images.ixigo.com/image/upload/accommodations/hotel-cash/cash.png"> ₹150';
    riva.fareDetail.burnInfo = [{ key: 'HOTEL_CASH', burnAmount: 150, totalAmount: 150, title: 'Hotel Cash', description: 'Use your hotel cash', summaryText: '₹150 hotel cash' }];
    const options = await read('hotels.search', { place: 'Anjuna', check_in: '2026-11-06', check_out: '2026-11-09' }, [capture(SEARCH, URL, JSON.stringify(body))]);
    const got = options.find((o) => o.title === 'Riva Beach Resort')!;
    expect(got.facts).toMatchObject({ coupon: 'IXIFIRST', offer: '₹604 discount' });
    expect(JSON.stringify(got)).not.toMatch(/<img|hotel-cash|hotel_cash|burn|₹150/i);
    expect(stayDetails(toResultOption(got as never), {}, 4, [])!.facts).toContainEqual({ label: 'Offer', value: '₹604 discount' });
    // Logged out, as ever: ixigo's own sentence, and no hotel cash.
    const out = (await anjuna()).find((o) => o.title === 'Riva Beach Resort')!;
    expect(out.facts['offer']).toBe('Discount of ₹604 included. Coupon code IXIFIRST applied!');
  });

  it('says which stays can be held with ₹0 now, and how few rooms are left', async () => {
    const options = await anjuna();
    const storii = options.find((o) => o.title.startsWith('Storii'))!;
    expect(storii.facts).toMatchObject({ book_with_zero: true });
    expect(options.find((o) => o.title === 'Riva Beach Resort')!.facts).toMatchObject({ book_with_zero: false, pay_at_hotel: false });
    const rofinos = options.find((o) => o.title === 'Rofinos Cottages')!;
    expect(rofinos.facts).toMatchObject({ rooms_left: 3, trending: '3 rooms left' });
    expect(rofinos.highlights).toContain('Only 3 rooms left');
    expect(stayDetails(toResultOption(rofinos as never), {}, 4, [])!.facts).toEqual(
      expect.arrayContaining([{ label: 'Pay', value: 'Book with ₹0 now' }, { label: 'Rooms left', value: 'Only 3 rooms left' }]),
    );
  });
});

describe("a bus's own filters' data, from ixigo's list: AC, sleeper, Volvo, women-safe boarding, berths, free cancellation, tracking", () => {
  const SERVICES = '/buslist/v3/services$';
  const URL = 'https://www.ixigo.com/buslist/v3/services';

  it('reads each bus as the page filters it, so the group can pick on any of it', async () => {
    const body = JSON.parse(fixture('buses-mumbai-goa.json')) as { services: Array<Record<string, unknown>>; operators?: Record<string, unknown> };
    const [first, second, third] = body.services;
    Object.assign(first!, {
      flags: { isVolvo: 1, isFcOperator: 1, isWomenSafeBoarding: 1, isTrackAvail: 1, isAssuredOperator: 0, isElectric: 0 },
      seatStats: { availableSeats: 31, seatsCapacity: 36, femaleAvailableCount: 4, singleBerthsCount: 9, windowSeatCount: 12 },
      viaPlaces: 'Panvel, Kolhapur',
      tags: [{ title: 'Most Trusted', value: 'x', type: 'TAG' }],
    });
    Object.assign(second!, { busTypeName: 'Non AC Seater (2 + 2)' });
    body.operators = { [String(third!['operatorId'])]: { travelerAgentName: 'MSRTC', isGovtOperator: '1', isRTC: 1 } };
    const options = await read('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, [capture(SERVICES, URL, JSON.stringify(body))]);
    expect(options[0]!.facts).toMatchObject({
      ac: true, sleeper: true, volvo: true, free_cancellation: true, women_safe_boarding: true, live_tracking: true,
      female_seats_left: 4, single_berths: 9, window_seats: 12, via: 'Panvel, Kolhapur', tags: 'Most Trusted',
    });
    expect(options[0]!.facts).not.toHaveProperty('assured');
    expect(options[0]!.highlights).toContain('Free cancellation');
    expect(options.find((o) => o.facts['bus_type'] === 'Non AC Seater (2 + 2)')!.facts).toMatchObject({ ac: false, seater: true });
    expect(options.filter((o) => o.facts['state_transport'] === true)).toHaveLength(body.services.filter((s) => s['operatorId'] === third!['operatorId']).length);
  });
});
