import { describe, expect, it } from 'vitest';
import type { FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import type { ResultsStore } from '../../results.js';
import { searchAnswer } from '../../tools.js';
import { loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// ixigo's Smart Lock (the 10 Oct atlas, his logged-in browser): on a one-way domestic search the stream's later event
// carries data.smartLockDetails, an ixigo agent that watches the route and locks a flight within a budget, for a fee. Go
// says it for the route as ixigo's, for the person to set up on ixigo; it sets nothing.
const { book } = loadBook();
const STREAM = '/flights/v2/search/stream';
const STREAM_URL = 'https://www.ixigo.com/flights/v2/search/stream';
const SMART_LOCK = {
  titleHtml: 'Fly in less than ${highlightText}', highlightText: '₹7,800', cta: 'Set Smart Lock', flightsCount: 137, position: 3,
  description: 'Scans flight prices 24*7 & locks the preferred flight within your budget', iconUrl: 'https://images.ixigo.com/x.png', footerTextHtmls: [],
};

/** ixigo's Delhi to Goa stream as two events, the second with Smart Lock when given (a logged-in browser's). */
function stream(lock?: Record<string, unknown>): string {
  const value = JSON.parse(fixture('flights-del-goi-2026-11-13.sse').trim().slice('data:'.length)) as { data: Record<string, unknown> };
  const last = lock ? { ...value, data: { ...value.data, smartLockDetails: lock } } : value;
  return `data:${JSON.stringify(value)}\n\ndata:${JSON.stringify(last)}\n\n`;
}

async function flights(body: string) {
  const runner = { read: async (_trip: string, url: string, _plan: FetchPlan) => ({ captures: [capture(STREAM, STREAM_URL, body)], finalUrl: url }) };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-10T06:00:00Z') });
  const got = await engine.answer('flights.results', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, { tripId: 't_smart_lock' });
  if (got.as !== 'options') throw new Error(got.as);
  return got;
}

describe("ixigo's Smart Lock, said for the route", () => {
  it('reads it from the event that carries it: ixigo offers it, the person sets it up on ixigo, Go never does', async () => {
    const got = await flights(stream(SMART_LOCK));
    expect(got.options.length).toBeGreaterThan(0);
    expect(got.notes).toHaveLength(1);
    const note = got.notes![0]!;
    expect(note).toContain('ixigo offers its Smart Lock on this route');
    expect(note).toContain("ixigo's pitch here: fly in less than ₹7,800");
    expect(note).toContain('The person sets it up themselves');
    expect(note).toContain('Go never sets it');
    // None of ixigo's own words reach the model: only the amount's digits.
    expect(note).not.toContain('Scans flight prices');
  });

  it("reads the amount's digits from a stream Chrome mis-decoded, and leaves the amount out when it has none", async () => {
    const misread = await flights(stream({ ...SMART_LOCK, highlightText: 'â‚¹7,800' }));
    expect(misread.notes![0]).toContain('fly in less than ₹7,800');
    const none = await flights(stream({ ...SMART_LOCK, highlightText: '' }));
    expect(none.notes![0]).toContain('within a budget the person sets. The person');
    expect(none.notes![0]).not.toContain('₹');
  });

  it('says nothing when the stream has no Smart Lock (logged out, a round trip, abroad)', async () => {
    const got = await flights(stream());
    expect(got.options.length).toBeGreaterThan(0);
    expect(got).not.toHaveProperty('notes');
  });

  it("puts it in the search's summary, with the model told to say it as ixigo's to set", async () => {
    const got = await flights(stream(SMART_LOCK));
    const results = { save: async (s: Record<string, unknown>) => ({ ...s, resultsId: 'r_lock1' }) } as unknown as ResultsStore;
    const found = { results: got.options, checkedAt: got.checkedAt, page: got.page, notes: got.notes! };
    const a = await searchAnswer('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-13' }, found as never, 't_smart_lock', { results, now: () => new Date('2026-10-10T06:00:00Z') });
    expect(a.summary).toContain('ixigo offers its Smart Lock on this route');
    expect(a.note).toContain("as ixigo's to set, never Go's");
  });
});
