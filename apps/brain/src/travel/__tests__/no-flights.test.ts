import { describe, expect, it } from 'vitest';
import type { FetchPlan } from '../recipes/recipe.js';
import { capture } from '../recipes/__tests__/fixtures.js';
import { airportWords, noFlightsLine } from '../answer.js';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import type { ResultsStore } from '../results.js';
import { searchAnswer } from '../tools.js';

// Prod, 12 Oct (trip t_f0b08c1cdb0f7420): ixigo answered Delhi to Kullu (Manali's airport) on 13 Nov with 200 and one
// event, {"errors":{"code":201,"message":"No flights found"}}, 59 bytes. Go read it as a page that didn't load, said "I
// couldn't load your flights from Delhi just now; I'll try again in a minute", and tried again for 20 minutes.
const NONE_BODY = 'data:{"errors":{"code":201,"message":"No flights found"}}\n\n';
const STREAM = '/flights/v2/search/stream';
const { book } = loadBook();

function engineOn(body: string) {
  const runner = { read: async (_trip: string, url: string, _plan: FetchPlan) => ({ captures: [capture(STREAM, `https://www.ixigo.com${STREAM}`, body)], finalUrl: url }) };
  return createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-12T07:00:00Z') });
}

describe('ixigo\'s own "No flights found"', () => {
  it('reads as an answer with no flights and says so, with where from and to as ixigo searched them', async () => {
    const got = await engineOn(NONE_BODY).answer('flights.results', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, { tripId: 't_none' });
    expect(got).toMatchObject({ as: 'options', options: [], none: { from: { words: 'Delhi', code: 'DEL' }, to: { words: 'Goa', code: 'GOI' } } });
  });

  it('is never a stream that read nothing: that stays a page with no flights read, not none', async () => {
    const got = await engineOn('data:{"data":{"flightJourneys":[]}}\n\n').answer('flights.results', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, { tripId: 't_empty' });
    expect(got).toMatchObject({ as: 'options', options: [] });
    expect(got).not.toHaveProperty('none');
  });

  it("names the airport by the words people use, and the bus as the next step", () => {
    expect(airportWords({ words: 'Manali', city: 'Kullu' })).toBe("Kullu (Manali's airport)");
    expect(airportWords({ words: 'Delhi', city: 'New Delhi' })).toBe('Delhi');
    expect(noFlightsLine('Delhi', 'Manali', '2026-11-13', { from: { words: 'Delhi', city: 'New Delhi' }, to: { words: 'Manali', city: 'Kullu' } })).toBe(
      'ixigo has no flights from Delhi to Kullu (Manali\'s airport) on Fri 13 Nov. I can look for a bus from Delhi to Manali instead: just say "bus".',
    );
    // With no airport known for an end, its words.
    expect(noFlightsLine('Delhi', 'Manali', '2026-11-13', {})).toContain('ixigo has no flights from Delhi to Manali on Fri 13 Nov.');
  });

  it('answers one route\'s search with the line as it is: never "couldn\'t load", never a try again, nothing saved', async () => {
    const saved: unknown[] = [];
    const results = { save: async (x: unknown) => (saved.push(x), { resultsId: 'r_none' }) } as unknown as ResultsStore;
    const found = {
      results: [], checkedAt: '2026-10-12T07:00:00.000Z', found: 0,
      none: { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'Manali', code: 'KUU', city: 'Kullu' } },
    };
    const out = await searchAnswer('flights', { from: 'Delhi', to: 'Manali', date: '2026-11-13' }, found, 't_none', { results, now: () => new Date('2026-10-12T07:00:00Z') });
    expect(out).toMatchObject({ count: 0, summary: expect.stringContaining("ixigo has no flights from Delhi to Kullu (Manali's airport) on Fri 13 Nov.") });
    expect(`${out.summary} ${out.note}`).not.toMatch(/couldn't load|didn't load it|try again in/);
    expect(out.note).toContain("never that it didn't load, and never that you'll try again");
    expect(saved).toEqual([]);
  });
});
