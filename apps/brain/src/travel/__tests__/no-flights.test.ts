import { describe, expect, it } from 'vitest';
import type { FetchPlan } from '../recipes/recipe.js';
import { capture } from '../recipes/__tests__/fixtures.js';
import type { TurnCtx } from '../../composer/tools.js';
import { airportWords, nearestWithFlights, noFlightsLine, noFlightsOffer } from '../answer.js';
import { loadBook } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import type { ResultsStore } from '../results.js';
import { renderSearchWake, searchWakeAnswer } from '../search-wake.js';
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

  it("offers the nearest airport with flights, one tap, with the road when the place's own words found it", () => {
    const MANALI = { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'Manali', code: 'KUU', city: 'Kullu' } };
    expect(noFlightsOffer('Delhi', 'Manali', '2026-11-13', MANALI)).toEqual({
      text:
        "ixigo has no flights from Delhi to Kullu (Manali's airport) on Fri 13 Nov. Should I look at flights to Chandigarh, the nearest airport with " +
        "flights? It's about 7 h by road to Manali.",
      replies: [
        { label: 'Yes, Chandigarh', text: 'My flights to Chandigarh, the nearest airport to Manali' },
        { label: 'A bus instead', text: 'A bus from Delhi to Manali instead' },
      ],
    });
    // Kasol searched at Kullu: Chandigarh by the airport, with no road said (Manali's 7 h is not Kasol's).
    expect(noFlightsOffer('Delhi', 'Kasol', '2026-11-13', { ...MANALI, to: { words: 'Kasol', code: 'KUU', city: 'Kullu' } }).text).toMatch(/Should I look at flights to Chandigarh, the nearest airport with flights\?$/);
    // The home's end: no flights from Coorg's airport as ixigo searched it (Mysore): Mangalore, from Coorg.
    const home = noFlightsOffer('Coorg', 'Delhi', '2026-11-13', { from: { words: 'Coorg', code: 'MYQ', city: 'Mysore' }, to: { words: 'Delhi', code: 'DEL', city: 'New Delhi' } });
    expect(home.text).toBe(
      "ixigo has no flights from Mysore (Coorg's airport) to Delhi on Fri 13 Nov. Should I look at flights from Mangalore, the nearest airport with flights? It's about 4 h by road from Coorg.",
    );
    expect(home.replies[0]).toEqual({ label: 'Yes, Mangalore', text: 'My flights from Mangalore, the nearest airport to Coorg' });
    // Munnar already searched at Kochi: nothing nearer to offer.
    expect(nearestWithFlights('Munnar', { code: 'COK', city: 'Kochi' })).toBeNull();
    // Never the airport it already searched (Varkala at Thiruvananthapuram), and a place we know nothing nearer for: the bus.
    expect(nearestWithFlights('Varkala', { code: 'TRV', city: 'Thiruvananthapuram' })).toBeNull();
    expect(noFlightsOffer('Delhi', 'Goa', '2026-11-13', { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'Goa', code: 'GOI', city: 'Goa' } })).toEqual({
      text: 'ixigo has no flights from Delhi to Goa on Fri 13 Nov. I can look for a bus from Delhi to Goa instead: just say "bus".',
      replies: [],
    });
  });

  it("answers one route's search with the offer and its taps for the caller: never \"couldn't load\", nothing saved", async () => {
    const saved: unknown[] = [];
    const results = { save: async (x: unknown) => (saved.push(x), { resultsId: 'r_none' }) } as unknown as ResultsStore;
    const found = {
      results: [], checkedAt: '2026-10-12T07:00:00.000Z', found: 0,
      none: { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'Manali', code: 'KUU', city: 'Kullu' } },
    };
    const out = await searchAnswer('flights', { from: 'Delhi', to: 'Manali', date: '2026-11-13' }, found, 't_none', { results, now: () => new Date('2026-10-12T07:00:00Z') });
    expect(out.summary).toBe(
      "ixigo has no flights from Delhi to Kullu (Manali's airport) on Fri 13 Nov. Should I look at flights to Chandigarh, the nearest airport with flights? It's about 7 h by road to Manali.",
    );
    expect(out.replies?.map((r) => r.label)).toEqual(['Yes, Chandigarh', 'A bus instead']);
    expect(out.note).toContain('its choices are under your message as buttons already, never list them.');
    expect(`${out.summary} ${out.note}`).not.toMatch(/couldn't load|try again in/);
    expect(saved).toEqual([]);
  });

  it("puts a finished search's own line up with its taps and no model call, or tells the model to when it can't", async () => {
    const payload = {
      source: 'travel_search', search: 'flights from Delhi to Manali', count: 0, resultsId: null, error: null, summary: 'x',
      line: 'ixigo has no flights from Delhi to Kullu (Manali\'s airport) on Fri 13 Nov. Should I look at flights to Chandigarh?',
      replies: [{ label: 'Yes, Chandigarh', text: 'My flights to Chandigarh' }, { label: 'A bus instead', text: 'A bus instead' }],
    };
    const item = { id: 'search:t_none:x', tripId: 't_none', kind: 'search' as const, ref: 'flights', dueAt: new Date(), payload };
    const ctx = { lines: [] as string[], answered: false } as unknown as TurnCtx;
    expect(await searchWakeAnswer({} as never)({ tripId: 't_none', wake: [item], ctx } as never)).toBe(true);
    expect([ctx.lines, ctx.quickReplies, ctx.answered]).toEqual([[payload.line], payload.replies, true]);
    expect(renderSearchWake(item)).toContain('Put its choices up with offer_replies: <data>Yes, Chandigarh</data>, <data>A bus instead</data>.');
    expect(renderSearchWake(item)).not.toContain("didn't load");
  });
});
