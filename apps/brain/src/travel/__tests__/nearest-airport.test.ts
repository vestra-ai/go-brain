import { describe, expect, it } from 'vitest';
import type { SideModel, SideRequest } from '../../memory/side-model.js';
import { createNearestAirport, noFlightsOfferFor, readNearest } from '../nearest-airport.js';

// Keshav, 12 Oct: "if there is no airport in source or destination, Sonnet should be smart enough to give the closest
// airport". The cases we know answer at once; any other place asks the side model, in strict JSON, once.
function sideSaying(...answers: Array<string | Error>) {
  const asked: SideRequest[] = [];
  const side: SideModel = {
    complete: async (req) => {
      asked.push(req);
      const a = answers.shift() ?? '{}';
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { side, asked };
}

describe('the nearest airport with flights', () => {
  it('reads the side model\'s answer only as a 3-letter code that is not the one searched, and a plain city', () => {
    expect(readNearest('{"city": "Chandigarh", "iata": "IXC", "road_hours": 7.2}', 'KUU')).toEqual({ city: 'Chandigarh', road: 'about 7 h' });
    expect(readNearest('Sure: {"city":"Dehradun","iata":"ded","road_hours":2.3}')).toEqual({ city: 'Dehradun', road: 'about 2.5 h' });
    expect(readNearest('{"city":"Kullu","iata":"KUU","road_hours":1}', 'KUU')).toBeNull();
    expect(readNearest('{"city":"Chandigarh","iata":"IXCC","road_hours":7}')).toBeNull();
    expect(readNearest('{"city":null,"iata":null,"road_hours":null}')).toBeNull();
    expect(readNearest('{"city":"<b>x</b>","iata":"IXC"}')).toBeNull();
    expect(readNearest('not json')).toBeNull();
    // A road that doesn't read is left out, never guessed.
    expect(readNearest('{"city":"Kochi","iata":"COK","road_hours":"four"}')).toEqual({ city: 'Kochi' });
  });

  it('answers the cases we know at once, asks the side model for any other place once, and keeps a miss a while', async () => {
    let at = Date.parse('2026-10-12T20:00:00Z');
    const { side, asked } = sideSaying('{"city":"Dehradun","iata":"DED","road_hours":3}', new Error('timeout'), '{"city":"Bagdogra","iata":"IXB","road_hours":3}');
    const nearest = createNearestAirport({ side: () => side, now: () => new Date(at) });
    expect(await nearest('Manali', { code: 'KUU', city: 'Kullu' })).toEqual({ city: 'Chandigarh', road: 'about 7 h' });
    expect(asked).toEqual([]);
    expect(await nearest('Mussoorie', { code: 'DED', city: 'Dehradun' })).toBeNull();
    expect(asked[0]).toMatchObject({ purpose: 'nearest_airport', maxTokens: 120, user: '{"place":"Mussoorie","not":"DED Dehradun"}' });
    expect(asked[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(await nearest('Rishikesh')).toBeNull();
    expect(await nearest('Rishikesh')).toBeNull();
    expect(asked).toHaveLength(2);
    // Ten minutes on, a miss is asked again.
    at += 11 * 60_000;
    expect(await nearest('Rishikesh')).toEqual({ city: 'Bagdogra', road: 'about 3 h' });
    expect(await nearest('Rishikesh')).toEqual({ city: 'Bagdogra', road: 'about 3 h' });
    expect(asked).toHaveLength(3);
  });

  it('offers what it found for the trip\'s end, else the home\'s, else the bus', async () => {
    const none = { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'Chopta', code: 'DED', city: 'Dehradun' } };
    const found = await noFlightsOfferFor('Delhi', 'Chopta', '2026-11-13', none, async (place) => (place === 'Chopta' ? { city: 'Pantnagar', road: 'about 6 h' } : null));
    expect(found.text).toBe(
      "ixigo has no flights from Delhi to Dehradun (Chopta's airport) on Fri 13 Nov. Should I look at flights to Pantnagar, the nearest airport with flights? It's about 6 h by road to Chopta.",
    );
    expect(found.replies[0]).toEqual({ label: 'Yes, Pantnagar', text: 'My flights to Pantnagar, the nearest airport to Chopta' });
    const bus = await noFlightsOfferFor('Delhi', 'Chopta', '2026-11-13', none, async () => null);
    expect(bus).toEqual({ text: expect.stringContaining('I can look for a bus from Delhi to Chopta instead'), replies: [] });
  });
});
