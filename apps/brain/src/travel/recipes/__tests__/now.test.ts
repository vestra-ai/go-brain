import { describe, expect, it, vi } from 'vitest';
import type { DeskItem } from '../../../desk/desk.js';
import type { TravelOption, TravelSearch } from '../../travel.js';
import type { EarlySearch } from '../early.js';
import { EARLY_WAIT_MS, earlySearchNow } from '../now.js';

const flight = (title: string, priceMinor: number, dep: string): TravelOption => ({
  kind: 'flight', title, priceMinor, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=09102026',
  journey: { mode: 'flight', origin: { name: 'New Delhi (DEL)', code: 'DEL' }, destination: { name: 'Goa (GOI)', code: 'GOI' }, depart_at: `2026-10-09T${dep}:00+05:30`, arrive_at: '2026-10-09T23:30:00+05:30', stops: 0 },
});
const FOUND: TravelSearch = { checkedAt: '2026-10-07T12:00:00.000Z', found: 2, results: [flight('IndiGo 6E 5341', 789_600, '18:10'), flight('Air India AI 2981', 809_300, '19:45')] };
const QUERY = { from: 'delhi', to: 'goa', date: '2026-10-09' };
const wakeFor = (messageId: string, seq: number): DeskItem => ({
  id: `msg:t_goa:${messageId}`, tripId: 't_goa', kind: 'message', ref: messageId, dueAt: new Date(), payload: { messageId, seq, namesGo: true },
});

function world(search: Promise<TravelSearch> | null) {
  const saved: unknown[] = [];
  const waits: number[] = [];
  const early = { searchFor: (tripId: string, messageId: string): EarlySearch | null => (search && tripId === 't_goa' && messageId === 'm_57' ? { kind: 'flights', query: QUERY, search } : null) };
  const results = {
    save: vi.fn(async (s: Record<string, unknown>) => {
      saved.push(s);
      return { ...s, resultsId: 'r_early1' } as never;
    }),
  };
  const now = earlySearchNow({ early, results, now: () => new Date('2026-10-07T12:00:01Z'), wait: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 5)); } });
  return { now, saved, waits, results };
}

describe('the early search block', () => {
  it("hands the turn its search's answer, so the one call is show_options; the results are data, the instructions are not", async () => {
    const w = world(Promise.resolve(FOUND));
    const block = (await w.now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(w.now).toMatchObject({ name: 'travel search', order: 35 });
    expect(block).toContain('Already searched for #57, checked just now: results_id r_early1, 2 options.');
    expect(block).toContain('show_options');
    const [before, fenced] = block.split('<data source="search results">');
    expect(before).not.toContain('IndiGo');
    expect(fenced).toContain('2 flights from delhi to goa on 2026-10-09: ₹7,896 to ₹8,093 per person.');
    expect(fenced).toContain('"title":"IndiGo 6E 5341"');
    expect(w.saved).toEqual([expect.objectContaining({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: QUERY })]);
  });

  it('saves one set per message, however often the turn runs', async () => {
    const w = world(Promise.resolve(FOUND));
    await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    expect(w.results.save).toHaveBeenCalledTimes(1);
  });

  it('names a search still running after 4 s, and the search tool joins it', async () => {
    const w = world(new Promise<TravelSearch>(() => undefined));
    const block = await w.now.render('t_goa', [wakeFor('m_57', 57)]);
    expect(w.waits).toEqual([EARLY_WAIT_MS]);
    expect(block).toBe('The search for #57 (flights from delhi to goa on 2026-10-09) started early and is still running: call the search tool as usual, and it joins that search.');
  });

  it('says nothing for a search that failed, for a message that started none, or for a wake that is not a message', async () => {
    const failed = world(Promise.reject(new Error('ixigo took too long')));
    expect(await failed.now.render('t_goa', [wakeFor('m_57', 57)])).toBeNull();
    const none = world(Promise.resolve(FOUND));
    expect(await none.now.render('t_goa', [wakeFor('m_58', 58)])).toBeNull();
    expect(await none.now.render('t_goa', [{ ...wakeFor('m_57', 57), kind: 'tap' }])).toBeNull();
    expect(none.results.save).not.toHaveBeenCalled();
  });

  it('says what the summary says when nothing came back', async () => {
    const w = world(Promise.resolve({ checkedAt: '2026-10-07T12:00:00.000Z', found: 0, results: [] }));
    const block = (await w.now.render('t_goa', [wakeFor('m_57', 57)]))!;
    expect(block).toContain('nothing to show');
    expect(block).toContain('Nothing came back: there are no flights from delhi to goa on 2026-10-09 at all.');
    expect(w.results.save).not.toHaveBeenCalled();
  });
});
