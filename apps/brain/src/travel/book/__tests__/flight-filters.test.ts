import { describe, expect, it } from 'vitest';
import { createOffers } from '../../recipes/offers.js';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The ixigo atlas (10 Oct): ixigo's flight filters are all in the page, never in its stream, which holds every fare. Its
// own list of them is in the stream (tripFilter, journeyFilter), so Go keeps it per route for the model, applies the ones
// the ask names to the stream's flights, and writes them into the page's address, where the stage shows them ticked. The
// sample is ixigo's own Delhi to Goa stream (9 Oct, four flights), given the filter lists the live stream had.
const { book } = loadBook();
const STREAM = '/flights/v2/search/stream';
const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream';
const GIVEN = { from: 'Delhi', to: 'Goa', date: '2026-11-13' };

function stream(): string {
  const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: Record<string, any> & { flightJourneys: Array<Record<string, any>> } };
  const journey = value.data.flightJourneys[0]!;
  const fares = (journey['flightFare'] as Array<Record<string, any>>).map((f) => {
    // The stop through Mumbai, as an abroad stream names it; Mopa's flight non-refundable; one flight with a free meal.
    if (f['flightKeys'].includes('*')) return { ...f, flightFilter: [{ ...f['flightFilter'][0], layoverAirports: ['BOM'] }] };
    if (f['flightKeys'].includes('IX1108')) return { ...f, refundableType: 'NON_REFUNDABLE' };
    if (f['flightKeys'].includes('6E5341')) return { ...f, isFreeMealAvailable: true };
    return f;
  });
  const data = {
    ...value.data,
    airportDetails: { ...value.data['airportDetails'], BOM: { airportName: 'Chhatrapati Shivaji Maharaj International Airport', city: 'Mumbai' } },
    tripFilter: {
      minPrice: 8_630, maxPrice: 10_000,
      freeMealsFilter: { available: true, text: 'Free meal available' },
      nonRefundableFilter: { available: true, value: 'NON_REFUNDABLE', text: 'Hide Non Refundable flights' },
      baggageFilter: [{ available: true, value: 'REGULAR', fare: 8_630, text: 'Cabin + Check-in baggage' }],
      stopsFilter: [{ stopText: 'Non-Stop', fare: 8_630, count: 3 }, { stopText: '1 Stop', fare: 9_422, count: 1 }, { stopText: '2+ Stops', fare: 0, count: 0 }],
      airlineMap: { IX: { name: 'Air-India Express', fare: 8_630, count: 2 }, '6E': { name: 'IndiGo', fare: 9_000, count: 2 } },
    },
    flightJourneys: [{
      ...journey,
      journeyFilter: [{
        departureAirports: [{ airportCode: 'DEL', count: 4, minFare: 8_630, distance: 0 }],
        arrivalAirports: [{ airportCode: 'GOI', count: 3, minFare: 8_630, distance: 0 }, { airportCode: 'GOX', count: 1, minFare: 9_000, distance: 39 }],
        layoverAirports: [{ airportCode: 'BOM', count: 1, minFare: 9_422 }],
      }],
      flightFare: fares,
    }],
  };
  return `data:${JSON.stringify({ ...value, data })}\n\n`;
}

function rig() {
  // flights.results loads one page across every trip each 20 s (pace): each ask here comes past it.
  let at = Date.parse('2026-10-10T06:00:00Z');
  const now = () => new Date(at);
  const offers = createOffers({ now });
  const reads: string[] = [];
  const plans: FetchPlan[] = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      reads.push(url);
      plans.push(plan);
      return { captures: [capture(STREAM, STREAM_URL, stream())], finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now, offers });
  const titles = async (siteFilters: string[]) => {
    at += 21_000;
    const got = await engine.answer('flights.results', GIVEN, { tripId: 't_filters', siteFilters });
    if (got.as !== 'options') throw new Error(got.as);
    return { titles: got.options.map((o) => o.title), site: got.site };
  };
  return { offers, reads, plans, titles };
}

describe("ixigo's own flight filters: kept per route from its stream, applied by Go, shown on ixigo's page", () => {
  it("keeps the route's list from the stream itself, with no second copy of the stream; the first ask waits for it", async () => {
    const { offers, plans, reads, titles } = rig();
    const first = await titles(['IndiGo']);
    // No list yet: every flight, the page as a person opens it, and the name waits for the list this read brought.
    expect(first.titles).toHaveLength(4);
    expect(first.site).toMatchObject({ filtered: [], unknown: ['IndiGo'], listed: false });
    expect(reads[0]).not.toContain('airlines=');
    expect(plans[0]!.capture.filter((c) => c.match === STREAM)).toHaveLength(1);
    expect(offers.get('flights.results', 'DEL-GOI')?.offers).toEqual([
      { kind: 'filter', group: 'Stops', name: 'Non-Stop', code: 'stops:0' },
      { kind: 'filter', group: 'Stops', name: '1 Stop', code: 'stops:1' },
      { kind: 'filter', group: 'Airlines', name: 'Air-India Express', code: 'airlines:IX' },
      { kind: 'filter', group: 'Airlines', name: 'IndiGo', code: 'airlines:6E' },
      { kind: 'filter', group: 'Departure airport', name: 'DEL Delhi Indira Gandhi International Airport', code: 'departureAirports:DEL' },
      { kind: 'filter', group: 'Arrival airport', name: 'GOI Dabolim International Airport', code: 'arrivalAirports:GOI' },
      { kind: 'filter', group: 'Arrival airport', name: 'GOX Manohar International Airport', code: 'arrivalAirports:GOX' },
      { kind: 'filter', group: 'Layover city', name: 'Mumbai (BOM)', code: 'layoverAirports:BOM' },
      { kind: 'filter', group: 'Baggage', name: 'Cabin + Check-in baggage', code: 'baggage:REGULAR' },
      { kind: 'filter', group: 'Meal', name: 'Free meal available', code: 'freeMeal:true' },
      { kind: 'filter', group: 'Refund', name: 'Hide Non Refundable flights', code: 'refundable:true' },
    ]);
    expect(offers.forTrip('t_filters').map((l) => l.about)).toEqual(['flights DEL to GOI']);
  });

  it("applies the names the ask means to the stream's flights, and writes them into ixigo's page as its own params", async () => {
    const { reads, titles } = rig();
    await titles([]);
    // One airline.
    expect((await titles(['IndiGo'])).titles).toEqual(['IndiGo 6E328 + 6E5106', 'IndiGo 6E5341']);
    expect(reads.at(-1)).toContain('&airlines=6E&');
    // Two params: every one must hold. Two values of one param: either will do, as ixigo's "IX,6E".
    const both = await titles(['IndiGo', 'Non-Stop']);
    expect(both.titles).toEqual(['IndiGo 6E5341']);
    expect(both.site).toMatchObject({ filtered: expect.arrayContaining(['IndiGo', 'Non-Stop']), unknown: [], listed: true });
    expect(reads.at(-1)).toContain('stops=0');
    expect((await titles(['IndiGo', 'Air-India Express', '1 Stop'])).titles).toEqual(['IndiGo 6E328 + 6E5106']);
    expect(reads.at(-1)).toContain('airlines=6E,IX');
  });

  it('lands at Mopa, changes planes in Mumbai, hides non-refundable fares, has a free meal, takes a check-in bag', async () => {
    const { reads, titles } = rig();
    await titles([]);
    expect((await titles(['GOX Manohar International Airport'])).titles).toEqual(['Air-India Express IX1108']);
    expect(reads.at(-1)).toContain('arrivalAirports=GOX');
    expect((await titles(['Mumbai (BOM)'])).titles).toEqual(['IndiGo 6E328 + 6E5106']);
    expect(reads.at(-1)).toContain('layoverAirports=BOM');
    expect((await titles(['Hide Non Refundable flights'])).titles).not.toContain('Air-India Express IX1108');
    expect(reads.at(-1)).toContain('refundable=true');
    expect((await titles(['Free meal available'])).titles).toEqual(['IndiGo 6E5341']);
    expect(reads.at(-1)).toContain('freeMeal=true');
    expect((await titles(['Cabin + Check-in baggage'])).titles).toHaveLength(4);
    // Nothing fits: no flights, said as none, never a read that failed.
    expect((await titles(['GOX Manohar International Airport', 'Hide Non Refundable flights'])).titles).toEqual([]);
  });
});
