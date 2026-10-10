import { describe, expect, it } from 'vitest';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { flightsQuery, FlightsArgs } from '../../tools.js';
import { loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// Who flies and how, as ixigo's own search takes it (the 10 Oct atlas): children and infants beside the adults, the cabin
// by ixigo's own letters (e Economy, w Premium Economy, b Business; it sells no First), and a special fare
// (airlineFareType STUDENT, SENIOR_CITIZEN, ARMED_FORCES or DOCTOR), which ixigo's stream answers with only the flights
// that sell it.
const { book } = loadBook();
const STREAM = '/flights/v2/search/stream';
const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream';
const GIVEN = { from: 'Delhi', to: 'Goa', date: '2026-11-13' };

/** ixigo's 9 Oct stream, each fare its student fare. */
function studentStream(): string {
  const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: { flightJourneys: Array<{ flightFare: Array<Record<string, any>> }> } };
  const fares = value.data.flightJourneys[0]!.flightFare.map((f) => ({ ...f, fares: f.fares.map((x: Record<string, unknown>) => ({ ...x, fareType: 'STUDENT', fareDisplayText: 'Student Fare' })) }));
  return `data:${JSON.stringify({ ...value, data: { ...value.data, flightJourneys: [{ ...value.data.flightJourneys[0], flightFare: fares }] } })}\n\n`;
}

function rig(body: string) {
  let at = Date.parse('2026-10-10T07:00:00Z');
  const urls: string[] = [];
  const runner = {
    read: async (_trip: string, url: string, _plan: FetchPlan) => {
      urls.push(url);
      return { captures: [capture(STREAM, STREAM_URL, body)], finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date(at) });
  const ask = async (given: Record<string, unknown>) => {
    at += 21_000;
    const got = await engine.answer('flights.results', { ...GIVEN, ...given }, { tripId: 't_shape' });
    if (got.as !== 'options') throw new Error(got.as);
    return got.options;
  };
  return { urls, ask, engine };
}

describe("who flies and how, as ixigo's own search takes it", () => {
  it('opens the page for the children, infants, cabin and special fare asked, and says the fare is per adult then', async () => {
    const { urls, ask } = rig(studentStream());
    const options = await ask({ children: 2, infants: 1, cabin: 'business', special_fare: 'student' });
    expect(urls[0]).toContain('&adults=4&children=2&infants=1&class=b&');
    expect(urls[0]).toContain('&airlineFareType=STUDENT&');
    expect(options[0]!.priceNote).toBe('per adult, business, student fare');
    // Premium economy is ixigo's w.
    await ask({ cabin: 'premium_economy' });
    expect(urls[1]).toContain('&children=0&infants=0&class=w&');
  });

  it('asks for none of it unless asked: adults only, economy, the regular fare', async () => {
    const { urls, ask } = rig(fixture('flights-del-goi-2026-11-13.sse'));
    const options = await ask({});
    expect(urls[0]).toContain('&adults=4&children=0&infants=0&class=e&');
    expect(urls[0]).not.toContain('airlineFareType');
    expect(options[0]!.priceNote).toBe('per person');
  });

  it('seats one infant to an adult, as airlines do', async () => {
    const { urls, ask } = rig(fixture('flights-del-goi-2026-11-13.sse'));
    await ask({ adults: 1, infants: 3 });
    expect(urls[0]).toContain('&adults=1&children=0&infants=1&class=e&');
  });

  it("the link that stands in for the page is set the same way", async () => {
    const { engine } = rig(fixture('flights-del-goi-2026-11-13.sse'));
    const link = await engine.answer('flights.search', { ...GIVEN, children: 1, cabin: 'business', special_fare: 'senior_citizen' }, { tripId: 't_link' });
    expect(link.as === 'link' && link.link).toContain('&children=1&infants=0&class=b&');
    expect(link.as === 'link' && link.link).toContain('airlineFareType=SENIOR_CITIZEN');
  });

  it('search_flights takes them only as the ask says them, and hands them to the search', () => {
    const a = FlightsArgs.parse({ from: 'Delhi', to: 'Goa', date: '2026-11-13', travellers: 2, children: 2, infants: 1, cabin: 'business', special_fare: 'armed_forces' });
    expect(flightsQuery(a)).toMatchObject({ guests: 2, children: 2, infants: 1, cabin: 'business', specialFare: 'armed_forces' });
    expect(flightsQuery(FlightsArgs.parse({ from: 'Delhi', to: 'Goa', date: '2026-11-13' }))).not.toHaveProperty('cabin');
    expect(() => FlightsArgs.parse({ from: 'Delhi', to: 'Goa', date: '2026-11-13', cabin: 'first' })).toThrow();
  });
});
