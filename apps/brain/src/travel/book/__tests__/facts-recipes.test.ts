import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../../composer/tools.js';
import { matches, type Capture, type FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { readBodyAs } from '../bodies.js';
import { BOOK_DIR, checkRecipe, loadBook } from '../book.js';
import type { ResultsStore } from '../../results.js';
import { createEngine } from '../engine.js';
import { ixigoTool } from '../tool.js';

// The facts recipes for a stay's own page, its place's filters and offers, ixigo's trip explorer, its help centre and its
// offers pages, each read from its own sample: the address each opens, what its fetch keeps, and the facts it answers.
// The samples are ixigo's own answers, recorded logged out on 7 and 8 Oct 2026, trimmed, with no guest's name in them.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const IXIGO = 'https://www.ixigo.com';

function engineWith(answer: (url: string, plan: FetchPlan) => Capture[], fast?: (call: { url: string; method: string; headers?: Record<string, string> }) => Capture) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures: answer(url, plan), finalUrl: url };
    },
    ...(fast
      ? {
          pageFetch: async (_trip: string, call: { url: string; method: string; headers?: Record<string, string> }) => {
            calls.push(call);
            return fast(call);
          },
        }
      : {}),
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
  return { engine, runs, calls };
}

/** One recipe's facts, from the calls its page sent. */
async function facts(id: string, inputs: Record<string, unknown>, captures: Capture[]) {
  const { engine, runs } = engineWith(() => captures);
  const got = await engine.answer(id, inputs, { tripId: 't_goa' });
  if (got.as !== 'facts') throw new Error('not facts');
  return { ...got, runs };
}

/** A stay's own page as a hotels.search option links it (Assagao, 6 to 9 Nov, two guests). */
const stayPage = (id: number, locationId: number, name: string): string =>
  `${IXIGO}/hotels/${id}/details?locationId=${locationId}&locationName=Assagao&locationType=C&masterLocationId=2149139&countryId=1` +
  `&checkinDate=06112026&checkoutDate=09112026&adultCount=2&roomCount=1&childCount=0&searchLocationId=78550&hotelInfoToken=true%7C2022%7C1` +
  `&hName=${encodeURIComponent(name)}`;
const HIGH_FIVE = stayPage(4395492, 2701789, 'High Five Hotels Phase 2');
const MOJIGAO = stayPage(37957, 116466, 'Mojigao - Eco Resort');
const HOTEL_API = `${IXIGO}/accommodation-search/api/v1`;

describe("a stay's own page", () => {
  it("hotels.details opens the stay's page as it was linked, and answers its rules, amenities, what is nearby, the map and the photos", async () => {
    const got = await facts('hotels.details', { hotel: HIGH_FIVE }, [
      capture('/accommodation-search/api/v1/accommodations/details$', `${HOTEL_API}/accommodations/details`, sample('hotels.details.json')),
      capture('/accommodation-search/api/v1/maps/location$', `${HOTEL_API}/maps/location`, sample('hotels.details.map.json')),
    ]);
    expect(got.page).toBe(HIGH_FIVE);
    expect(got.runs[0]!.plan.capture).toEqual([
      { match: '/accommodation-search/api/v1/accommodations/details$', required: true },
      { match: '/accommodation-search/api/v1/maps/location$', required: false },
    ]);
    expect(got.title).toBe('High Five Hotels Phase 2');
    expect(got.rows).toHaveLength(1);
    const stay = got.rows[0]!;
    expect(stay).toMatchObject({ name: 'High Five Hotels Phase 2', area: 'Bouta Waddo', town: 'Assagao', stars: 4, check_in_from: '12:00', check_out_by: '11:00', lat: 15.60148811340332 });
    // No rating yet (no reviews), and the stay's own address is never read.
    expect(stay).not.toHaveProperty('rating_out_of_10');
    expect(stay).not.toHaveProperty('address');
    expect(stay['house_rules']).toContain('Property Policies: Primary Guest should be 18+ years of age');
    expect(stay['house_rules']).toContain('Property Announcements: This property will not accommodate hen, stag or similar parties. Please note that any changes in tax structure due to government policies will result in revised taxes, which will be applicable to all reservations and will be charged additionally during check out.');
    expect((stay['amenities'] as string[]).slice(0, 3)).toEqual(['Swimming pool', 'Wi-Fi in public areas', 'Restaurants']);
    // The page lists Shubadra twice: once here.
    expect((stay['nearby'] as string[]).slice(0, 2)).toEqual(['Shubadra, 0.1 km', 'Sub Centre, assagao, 0.7 km']);
    expect(stay['map']).toMatch(/^https:\/\/images\.ixigo\.com\/hotels\/images\/mapImages\/location_map_2701789_H_/);
    expect((stay['photos'] as string[])[1]).toMatch(/^Swimming pool: https:\/\/q-xx\.bstatic\.com\//);
  });

  it('hotels.rooms answers each rate a night with its taxes, cancellation, meals and how it is paid, read from the call for that stay only', async () => {
    const zero = await facts('hotels.rooms', { hotel: MOJIGAO }, [
      capture('/rooms$', `${HOTEL_API}/accommodations/details/37957/rooms`, sample('hotels.rooms.json')),
    ]);
    expect(zero.runs[0]!.plan.capture).toEqual([{ match: '/accommodations/details/37957/rooms$', required: true }]);
    expect(zero.title).toBe('Rooms at Mojigao - Eco Resort');
    expect(zero.rows).toHaveLength(2);
    expect(zero.rows[0]).toMatchObject({
      about_room: '50 sq. mt., 1 double bed, Garden view, Sleeps 2',
      rate: 'Room With Free Cancellation, Breakfast',
      price_per_night: '₹13,440 a room plus ₹3,591 taxes and fees',
      before_discount: '₹14,794',
      cancellation: 'Free Cancellation till 02 Nov 11:59 PM',
      meals: ['Breakfast'],
      pay: 'book with ₹0 now, pay later',
      rooms_left: 'Only 1 room left',
      recommended: true,
    });
    expect(zero.rows[0]!['room']).toMatch(/^Queen Cottage with Balcony/);
    const atHotel = await facts('hotels.rooms', { hotel: HIGH_FIVE }, [
      capture('/rooms$', `${HOTEL_API}/accommodations/details/4395492/rooms`, sample('hotels.rooms.pay-at-hotel.json')),
    ]);
    expect(atHotel.rows.map((r) => `${r['room']}: ${r['price_per_night']}, ${r['pay']}`)).toEqual([
      'Family Room: ₹2,775 a room plus ₹375 taxes and fees, pay at the hotel',
      'Executive Suite: ₹5,447 a room plus ₹736 taxes and fees, pay at the hotel',
    ]);
    // Another stay's rooms are never read as this one's.
    await expect(facts('hotels.rooms', { hotel: MOJIGAO }, [
      capture('/rooms$', `${HOTEL_API}/accommodations/details/4395492/rooms`, sample('hotels.rooms.pay-at-hotel.json')),
    ])).rejects.toThrow(/did not send/);
  });

  it("hotels.reviews answers the latest reviews, each guest's rating, kind of trip and words, never a name", async () => {
    const got = await facts('hotels.reviews', { hotel: MOJIGAO }, [
      capture('/x', `${HOTEL_API}/accommodations/reviews/aiReviews/37957`, sample('hotels.reviews.json')),
    ]);
    expect(got.title).toBe('Reviews of Mojigao - Eco Resort');
    expect(got.rows).toHaveLength(4);
    expect(got.rows[1]).toEqual({ rating_out_of_10: 10, guests: 'Solo Traveller', when: 'Sep 2026', title: 'Beautiful Nature Retreat', said: 'Stunning resort nestled completely in nature. The food was also excellent.' });
    expect(JSON.stringify(got.rows)).not.toMatch(/reviewer/i);
  });

  it('hotels.similar answers the stays ixigo shows like it, and nothing when ixigo has none', async () => {
    const got = await facts('hotels.similar', { hotel: MOJIGAO }, [
      capture('/x', `${HOTEL_API}/accommodations/recommendation/similar/37957`, sample('hotels.similar.json')),
    ]);
    expect(got.title).toBe('Stays like Mojigao - Eco Resort');
    expect(got.rows[0]).toEqual({
      name: 'Siolim House', area: 'Assagao', kind: 'Hotel', stars: 4, rating_out_of_10: 9.2, reviews: 345,
      price_per_night: '₹10,573 a room plus ₹2,793 taxes and fees', free_cancellation: true, breakfast: true, distance: '2.80 km from this hotel',
    });
    expect(got.rows.map((r) => r['name'])).toEqual(['Siolim House', 'Dia BNB', 'Unseen Boutique Hotel, Assagao']);
    const none = await facts('hotels.similar', { hotel: HIGH_FIVE }, [capture('/x', `${HOTEL_API}/accommodations/recommendation/similar/4395492`, '{"data":{}}')]);
    expect(none.rows).toEqual([]);
  });
});

describe('a stay from search results', () => {
  it("takes the stay as an option of the trip's results: the tool opens that option's own page", async () => {
    const { engine, runs } = engineWith(() => [capture('/x', `${HOTEL_API}/accommodations/reviews/aiReviews/37957`, sample('hotels.reviews.json'))]);
    const results = {
      get: async (tripId: string, id: string) => (tripId === 't_goa' && id === 'r_ab12' ? { options: [{ sourceUrl: HIGH_FIVE }, { sourceUrl: MOJIGAO }] } : null),
    } as unknown as Pick<ResultsStore, 'get'>;
    const tool = ixigoTool({ book, engine, results, live: () => true })!;
    expect(tool.description).toContain('- hotels.reviews: What guests said about a stay');
    expect(tool.description).toContain('hotel (an option from search results, written results_id#n, like r_ab12#2)');
    const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;
    const out = (await tool.run({ recipe: 'hotels.reviews', inputs: { hotel: 'r_ab12#2' } }, turn)) as { facts: unknown[]; source: string; title: string };
    expect(runs.map((r) => r.url)).toEqual([MOJIGAO]);
    expect(out).toMatchObject({ title: 'Reviews of Mojigao - Eco Resort', source: MOJIGAO });
    expect(out.facts).toHaveLength(4);
  });
});

describe("a place's stays", () => {
  const DATES = { check_in: '2026-11-06', check_out: '2026-11-09' };
  const results = (place: string, id: number, type: string, master: number) =>
    `${IXIGO}/hotels/search/result?locationId=${id}&locationName=${place}&locationType=${type}&masterLocationId=${master}&countryId=1` +
    '&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=2&childCount=0';

  it("hotels.search_filters opens the place's results and answers how many stays each filter has, the price bands in rupees", async () => {
    // The sample is Assagao's results page; Anjuna is a place Go already knows.
    const got = await facts('hotels.search_filters', { place: 'Anjuna', ...DATES }, [
      capture('/x', `${IXIGO}/accommodation-search/api/v2/accommodations/search/metadata`, sample('hotels.search_filters.json')),
    ]);
    expect(got.page).toBe(results('Anjuna', 1026, 'C', 50347));
    expect(got.title).toBe('Stays in Anjuna, by filter');
    expect(got.rows[0]).toEqual({ group: 'Stays found', count: 28 });
    expect(got.rows).toContainEqual({ group: 'Popular Areas', options: ['Bouta Waddo: 14', 'Assagao: 13', 'Mazal Waddo: 1'] });
    expect(got.rows).toContainEqual({ group: 'Payment Mode', options: ['Prepaid: 25', 'Pay At Hotel: 3', 'Book with ₹0 payment: 4'] });
    // Options with no stays are left out (no lunch or dinner here).
    expect(got.rows).toContainEqual({ group: 'Meals', options: ['Breakfast Included: 18'] });
    expect(got.rows.at(-1)).toEqual({
      group: 'Price a night',
      options: ['₹1,600 to ₹1,800: 2', '₹2,500 to ₹3,000: 2', '₹3,500 to ₹4,000: 1', '₹5,000 to ₹6,000: 2', '₹7,000 to ₹8,000: 1', '₹8,000 to ₹9,000: 1'],
    });
  });

  it("hotels.offers answers the offers over the place's stays, each with its code and terms page", async () => {
    const got = await facts('hotels.offers', { place: 'Goa', ...DATES }, [
      capture('/x', `${IXIGO}/upahaar-inventory/api/deals?productType=HOTELS&source=SRP&isProductOnly=true&journeyType=DOMESTIC`, sample('hotels.offers.json')),
    ]);
    expect(got.page).toBe(results('Goa', 32, 'S', 48569));
    expect(got.rows).toHaveLength(5);
    expect(got.rows[0]).toEqual({ offer: 'Flat 15% Off up to ₹1,500 on Domestic Hotels with AU Bank Credit Cards', code: 'AUSFD', terms: `${IXIGO}/offers/ausfd_hotels` });
  });

  it('hotels.search asks ixigo for paying at the hotel or nothing now, and orders the list by the codes the page has', async () => {
    const { engine, runs } = engineWith(() => [
      capture('/accommodation-search/api/v3/accommodations/search$', `${IXIGO}/accommodation-search/api/v3/accommodations/search`, fixture('stays-goa-page1.json')),
    ]);
    const page = async (conditions: string[], sort?: string) =>
      (await engine.answer('hotels.search', { place: 'Anjuna', ...DATES, ...(sort ? { sort } : {}) }, { tripId: 't_goa', conditions })) as { page: string };
    expect((await page(['pay_at_hotel'])).page).toBe(`${results('Anjuna', 1026, 'C', 50347)}&filters=PT_PAY_AT_HOTEL`);
    expect((await page(['book_with_zero', 'free_cancellation'], 'SC_P_LH')).page).toBe(`${results('Anjuna', 1026, 'C', 50347)}&filters=MP_FC%2CPT_BOOK_WITH_ZERO_PAYMENT&sort=SC_P_LH`);
    // A sort the page has no code for adds nothing to the address.
    expect((await page([], 'cheapest&x=1')).page).toBe(results('Anjuna', 1026, 'C', 50347));
    expect(runs).toHaveLength(3);
  });
});

describe("ixigo's trip explorer", () => {
  it('plan.explore opens /plan for the city and month, and reads its places from the page itself', async () => {
    const got = await facts('plan.explore', { origin: 'Delhi', month: '2026-12-12' }, [capture('/x', `${IXIGO}/plan?origin=Delhi&travelMonth=december`, sample('plan.explore.html'))]);
    expect(got.page).toBe(`${IXIGO}/plan?origin=Delhi&travelMonth=december`);
    expect(got.runs[0]!.plan).toEqual({ capture: [{ match: '/plan?origin=', required: true, max_bytes: 1_000_000 }] });
    expect(got.title).toBe('Where to go from Delhi in December');
    expect(got.rows.map((r) => r['place'])).toEqual([
      'Denpasar, Bali, Indonesia', 'Agra, Uttar Pradesh, India', 'Chandpur, Chittagong, Bangladesh', 'Neemrana, Rajasthan, India', 'Alwar, Rajasthan, India', 'Bangladesh, Asia, Bangladesh',
    ]);
    expect(got.rows[1]).toEqual({
      place: 'Agra, Uttar Pradesh, India', getting_there: 'Prices starting from ₹170', stay_a_night: 'about ₹2,000', trip_estimate: 'about ₹9,000 for 3 nights',
      weather: '15 to 24 C', good_for: ['family', 'friends', 'solo'], guide: 'agra',
    });
    expect(got.rows[0]).toMatchObject({ visa_on_arrival: true });
  });

  it("plan.explore clicks a theme's chip and reads the explorer's call it makes", async () => {
    const got = await facts('plan.explore', { origin: 'New Delhi', month: '2026-10-20', theme: 'Beaches' }, [
      capture('/x', `${IXIGO}/plan?origin=New%20Delhi&travelMonth=october`, sample('plan.explore.html')),
      capture('/x', `${IXIGO}/itinerary-planner/api/explore?origin=new-delhi&offset=0&limit=15&travelMonth=OCT&category=BEACHES`, sample('plan.explore.beaches.json')),
    ]);
    expect(got.runs[0]!.plan).toMatchObject({
      capture: [{ match: '/plan?origin=', required: true, max_bytes: 1_000_000 }, { match: '/itinerary-planner/api/explore?', required: true }],
      steps: [{ op: 'click', text: 'Beaches' }, { op: 'wait_for', match: '/itinerary-planner/api/explore?' }],
    });
    expect(got.title).toBe('Where to go from New Delhi in October, beaches');
    expect(got.rows.map((r) => r['place'])).toEqual(['Denpasar, Bali, Indonesia', 'Devgad, Maharashtra, India', 'Chandpur, Chittagong, Bangladesh', 'Tajpur, West Bengal, India']);
    expect(got.rows[1]).toMatchObject({ getting_there: 'Prices starting from ₹10,041', weather: '23 to 35 C', guide: 'devgad' });
    // A theme the page has no chip for clicks nothing: the page's own list.
    const snow = await facts('plan.explore', { origin: 'Delhi', month: '2026-12-12', theme: 'snow' }, [capture('/x', `${IXIGO}/plan?origin=Delhi&travelMonth=december`, sample('plan.explore.html'))]);
    expect(snow.runs[0]!.plan).not.toHaveProperty('steps');
    expect(snow.title).toBe('Where to go from Delhi in December');
  });

  it("plan.top_locations answers the planner's popular places", async () => {
    const got = await facts('plan.top_locations', {}, [capture('/x', `${IXIGO}/itinerary-planner/api/itinerary/getTopLocations?country=IN`, sample('plan.top_locations.json'))]);
    expect(got.page).toBe(`${IXIGO}/plan`);
    expect(got.rows.slice(0, 3)).toEqual([{ place: 'Jaipur, Rajasthan, India' }, { place: 'Agra, Uttar Pradesh, India' }, { place: 'Udaipur, Rajasthan, India' }]);
  });
});

describe("ixigo's help centre", () => {
  const QUESTIONS = `${IXIGO}/support/helpcenter/api/v1/questions/general?tags=`;

  it('help.services answers the topics, each with the name help.faq takes', async () => {
    const got = await facts('help.services', {}, [capture('/x', `${IXIGO}/support/helpcenter/api/v1/service`, sample('help.services.json'))]);
    expect(got.rows).toHaveLength(9);
    expect(got.rows[1]).toEqual({ topic: 'ixigo money', about: 'View ixigo money transaction details and rules', faq: 'money-faq' });
  });

  it("help.faq clicks the topic's card, keeps only that topic's answers, and reads them as text", async () => {
    const got = await facts('help.faq', { topic: 'Money-FAQ' }, [capture('/x', `${QUESTIONS}money-faq`, sample('help.faq.money.json'))]);
    expect(got.runs[0]!.plan).toEqual({
      capture: [{ match: '/support/helpcenter/api/v1/questions/general?tags=money-faq', required: true }],
      steps: [{ op: 'click', text: 'View ixigo money transaction details and rules' }],
    });
    expect(got.title).toBe("ixigo's answers on money-faq");
    expect(got.rows[2]).toEqual({
      question: 'Checking ixigo money balance',
      answer: 'You can check your ixigo money balance via your ixigo account. Simply select the "ixigo money" option from the main menu of the ixigo website or ixigo app.',
    });
    expect(got.rows[0]!['answer']).toMatch(/^ixigo money is our virtual currency where the value of 1 ixigo money = Rs\.1\. Users can enjoy the following benefits: For Flight bookings:/);
    // A topic ixigo doesn't list reads as About ixigo, which the page answers as it opens: no click.
    const { engine, runs } = engineWith(() => [capture('/x', `${QUESTIONS}about-ixigo`, sample('help.faq.money.json'))]);
    expect(await engine.answer('help.faq', { topic: 'refunds' }, { tripId: 't_goa' })).toMatchObject({ title: "ixigo's answers on about-ixigo" });
    expect(runs[0]!.plan).toEqual({ capture: [{ match: '/support/helpcenter/api/v1/questions/general?tags=about-ixigo', required: true }] });
  });

  it("help.faq at the fast speed asks for the topic's answers straight away, with ixigo's two client headers", async () => {
    const { engine, runs, calls } = engineWith(() => [], (call) => capture('/x', call.url, sample('help.faq.money.json')));
    const got = await engine.answer('help.faq', { topic: 'money-faq' }, { tripId: 't_goa' });
    expect(calls).toEqual([{ url: '/support/helpcenter/api/v1/questions/general?tags=money-faq', method: 'GET', headers: { ixisrc: 'ixiweb', clientid: 'ixiweb' } }]);
    expect(runs).toEqual([]);
    expect(got).toMatchObject({ as: 'facts', page: `${IXIGO}/support`, rows: expect.arrayContaining([expect.objectContaining({ question: 'Checking ixigo money balance' })]) });
  });

  it('help.downtime says plainly whether anything is down', async () => {
    const got = await facts('help.downtime', {}, [capture('/x', `${IXIGO}/support/helpcenter/api/v1/downtime?ongoing=true`, sample('help.downtime.json'))]);
    expect(got.rows).toEqual([{ anything_down: false, notices: [] }]);
  });
});

describe("ixigo's offers pages", () => {
  it("reads an older Next.js page's __NEXT_DATA__, its credentials dropped, and refuses a page without one", () => {
    const page = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apiKey: 'k', data: { offers: [{ offerCode: 'AUSFD', uuid: 'u' }] } } } })}</script></body></html>`;
    expect(readBodyAs(page, 'next_data', 'the offers')).toEqual({ props: { pageProps: { data: { offers: [{ offerCode: 'AUSFD' }] } } } });
    expect(() => readBodyAs('<html><body>no data</body></html>', 'next_data', 'the offers')).toThrow(/shape Go does not read/);
  });

  it('offers.list answers the counts, the banks with offers, and the first offers and sales, each with its name for the next recipe', async () => {
    const got = await facts('offers.list', {}, [capture('/x', `${IXIGO}/offers`, sample('offers.list.html'))]);
    expect(got.page).toBe(`${IXIGO}/offers`);
    expect(got.rows[0]).toEqual({ offers_on_ixigo: 71, by_journey: ['domestic: 48', 'international: 46'] });
    expect((got.rows[1]!['banks_with_offers'] as string[]).slice(0, 2)).toEqual(['AU Bank: 12', 'RBL Bank: 10']);
    expect(got.rows[2]).toEqual({
      sale: 'Grand Travel Fest: Flat 15% on Hotels with RBL and AU Bank Credit Cards', for: ['hotels'], banks: ['AU Bank', 'RBL Bank'], until: '10 Oct 2026', campaign: 'grandtravelfest',
    });
    expect(got.rows[5]).toEqual({ offer: 'Get Flat 10% Off on Domestic Hotels with RBL Bank Credit Cards', code: 'IXRBLD', for: 'hotels', bank: 'RBL Bank', until: '30 Nov 2026', details: 'IXRBLD' });
    expect(got.rows).toHaveLength(11);
  });

  it('offers.list at the fast speed asks for every domestic offer at once, and reads it the same way as the page', async () => {
    const { engine, runs, calls } = engineWith(() => [], (call) => capture('/x', call.url, sample('offers.list.fast.json')));
    const got = await engine.answer('offers.list', {}, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    expect(calls).toEqual([{ url: '/upahaar-inventory/api/offers/v2/list?journeyType=DOMESTIC&page=1&limit=50', method: 'GET', headers: { ixisrc: 'ixiweb', clientid: 'ixiweb' } }]);
    expect(runs).toEqual([]);
    expect(got.rows[0]).toEqual({ offers_on_ixigo: 49 });
    expect(got.rows.slice(2).map((o) => o['code'] ?? o['campaign'])).toEqual(['grandtravelfest', 'grandtravelfest_', 'FLAT80', 'hsbc_flight', 'IDFCEMI3', 'IXAXIS']);
    expect(engine.stats()).toEqual([expect.objectContaining({ recipe: 'offers.list', speed: 'fast', runs: 1, failed: 0 })]);
  });

  it("offers.details opens the offer's own page, from its name or its link, and answers its terms one line an item", async () => {
    const got = await facts('offers.details', { offer: 'https://www.ixigo.com/offers/hdfc-campaign_hotels' }, [capture('/x', `${IXIGO}/offers/hdfc-campaign_hotels`, sample('offers.details.html'))]);
    expect(got.page).toBe(`${IXIGO}/offers/hdfc-campaign_hotels`);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/offers/hdfc-campaign_hotels$', required: true, max_bytes: 1_000_000 }]);
    expect(got.rows[0]).toMatchObject({
      offer: 'Get flat 50% Off with HDFC Bank Mastercard Debit Cards', code: 'IXIHDFC3', for: 'hotels', bank: 'HDFC Bank', from: '7 Jul 2026', until: '7 Oct 2026',
      about: ['Flat 50% Off up to ₹500 with HDFC Bank Mastercard Debit Cards.', 'This offer is valid once per user during the offer period.', 'This offer is valid only on Pay Now bookings.', 'This offer is valid only for new users.'],
    });
    expect(got.rows[0]!['how_to_use']).toContain('Apply coupon code IXIHDFC3.');
    expect(got.rows[0]!['terms']).toContain('Discount is applicable as Flat 50% off up to ₹500 on eligible hotel bookings.');
  });

  it("offers.campaign answers the sale's offers", async () => {
    const got = await facts('offers.campaign', { campaign: 'grandtravelfest' }, [capture('/x', `${IXIGO}/offers/campaigns/grandtravelfest`, sample('offers.campaign.html'))]);
    expect(got.page).toBe(`${IXIGO}/offers/campaigns/grandtravelfest`);
    expect(got.rows.map((r) => `${r['code']} ${r['bank']} ${r['until']}`)).toEqual(['AUSFD AU Bank 10 Oct 2026', 'RBLD RBL Bank 10 Oct 2026', 'AUSFN AU Bank 10 Oct 2026', 'RBLN RBL Bank 10 Oct 2026']);
  });
});

describe('the fast speed', () => {
  it("asks for the page's own call with ixigo's two client headers only, and each recipe's read takes that call", () => {
    const fast = (id: string) => book.get(id)!.fast;
    const CLIENT = { ixisrc: 'ixiweb', clientid: 'ixiweb' };
    for (const id of ['help.services', 'help.downtime', 'help.faq', 'hotels.offers', 'offers.list']) expect(fast(id)?.headers, id).toEqual(CLIENT);
    for (const id of ['help.services', 'help.downtime', 'hotels.offers', 'offers.list', 'plan.top_locations']) {
      expect(matches(book.get(id)!.read!.rows.from, `${IXIGO}${fast(id)!.url}`), id).toBe(true);
    }
    // The ones by name ask for the same address their read takes.
    expect(fast('help.faq')!.url).toBe(book.get('help.faq')!.read!.rows.from);
    expect(fast('offers.details')).toMatchObject({ url: '/offers/{$slug}', format: 'next_data' });
    expect(fast('offers.campaign')).toMatchObject({ url: '/offers/campaigns/{$slug}', format: 'next_data' });
    // A stay's own page and the explorer have no fast call yet: their calls need a body, or a theme's click.
    for (const id of ['hotels.details', 'hotels.rooms', 'hotels.reviews', 'hotels.similar', 'hotels.search_filters', 'plan.explore']) expect(fast(id), id).toBeUndefined();
  });
});

describe("a recipe's inputs", () => {
  it('refuses a key the format does not know: an unquoted description with a comma is cut, never read cut', () => {
    const file = readFileSync(`${BOOK_DIR}plan/explore.yaml`, 'utf8').replace(
      'about: "the city the group would start from, such as Delhi or Bengaluru" }',
      'about: the city the group would start from, such as Delhi or Bengaluru }',
    );
    expect(checkRecipe('plan/explore.yaml', file)).toEqual({ problems: ['plan/explore.yaml: inputs.origin: Unrecognized key: "such as Delhi or Bengaluru"'] });
  });
});
