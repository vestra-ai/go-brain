import { describe, expect, it } from 'vitest';
import type { ResultsStore } from '../results.js';
import { searchAnswer } from '../tools.js';

// A long route's flights stream past what Bash keeps (Delhi to Dubai, 10 Oct: 2.1 MB): the reader takes the whole events
// before the cut, and the group hears these are the first ixigo sent, never the whole list.
describe('a flights list ixigo sent cut short', () => {
  const flight = (n: number) => ({
    kind: 'flight' as const, title: `IndiGo 6E${100 + n}`, priceMinor: 800_000 + n * 1_000, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
    journey: { mode: 'flight' as const, origin: { name: 'New Delhi', code: 'DEL' }, destination: { name: 'Dubai', code: 'DXB' }, depart_at: '2026-11-13T07:00:00+05:30', arrive_at: '2026-11-13T09:30:00+05:30', number: `6E${100 + n}` },
  });
  const results = { save: async () => ({ resultsId: 'r_cut' }) } as unknown as ResultsStore;
  const now = () => new Date('2026-10-10T06:00:00Z');

  it('says in the summary and the line that these are the first it sent, and where the whole list is', async () => {
    const found = { results: [1, 2, 3, 4].map(flight), checkedAt: '2026-10-10T06:00:00.000Z', found: 4, cut: true as const };
    const out = await searchAnswer('flights', { from: 'Delhi', to: 'Dubai', date: '2026-11-13' }, found, 't_cut', { results, now });
    expect(out.summary).toContain("ixigo's list came cut short: these are from the first 4 it sent, not all of them.");
    expect(out.note).toContain('Say in the line that you picked these from the first 4 ixigo sent, and offer to look at more.');
    // Keshav's ruling: ixigo's page is never the answer, so the line never sends anyone there for the rest.
    expect(out.note).not.toContain("ixigo's page");
    // A whole list says nothing of it.
    const { cut: _cut, ...all } = found;
    const whole = await searchAnswer('flights', { from: 'Delhi', to: 'Dubai', date: '2026-11-13' }, all, 't_cut', { results, now });
    expect(whole.summary).not.toContain('cut short');
    expect(whole.note).not.toContain('first 4');
  });
});
