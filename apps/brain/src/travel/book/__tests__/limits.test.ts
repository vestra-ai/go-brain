import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { evaluate, peaks, STEP_LIMIT } from '../expr.js';
import type { RecipeFile } from '../format.js';

// The evaluation budget, measured on the book's heaviest reads: every recipe's expressions stay a small part of
// STEP_LIMIT, so the budget never fails a real read, however busy the process; and a runaway expression fails, always.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const now = () => new Date('2026-10-07T12:00:00Z');

function engineWith(answer: (url: string) => Capture[], pageFetch?: () => Promise<Capture>) {
  const runner = {
    read: async (_t: string, url: string, _plan: FetchPlan) => ({ captures: answer(url), finalUrl: url }),
    ...(pageFetch ? { pageFetch } : {}),
  };
  return createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now });
}

/** A recipe's own expressions (its list, each, keep and lets), and the most steps and ms any one took to evaluate. */
function measured(r: RecipeFile): { steps: number; ms: number } {
  const sources = [r.read?.rows.list, r.read?.rows.unique, ...Object.values(r.read?.also ?? {}).map((a) => a.value), r.fast?.list, r.fast?.each, ...Object.values(r.let ?? {})];
  if (r.answer.as === 'options' || r.answer.as === 'facts') sources.push(r.answer.each);
  if (r.answer.as === 'options') sources.push(r.answer.keep);
  let steps = 0;
  let ms = 0;
  for (const s of sources) {
    const p = s ? peaks.get(s) : undefined;
    if (p) {
      steps = Math.max(steps, p.steps);
      ms = Math.max(ms, p.ms);
    }
  }
  return { steps, ms };
}

describe('the evaluation budget', () => {
  it("keeps every heavy read a small part of the step budget, with the numbers in CI's log", async () => {
    // trains.between at the page speed: 60 options from 26 trains (CSMT to MAO), seats and Tatkal folded in.
    await engineWith(() => [
      capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/CSMT/MAO?date=2026-10-08&languageCode=en', fixture('trains-csmt-mao-between.json')),
      capture('/api/v3/trains/availability', 'https://www.ixigo.com/api/v3/trains/availability', fixture('trains-csmt-mao-availability.json')),
    ]).answer('trains.between', { from: 'Mumbai', to: 'Goa', date: '2026-10-08' }, { tripId: 't_limits' });
    // trains.between and trains.confirm_chance at the fast speed: confirmtkt's own call, every train and class.
    const confirmtkt = 'https://ixigotrainsapi.confirmtkt.com/api/v1/trains/search?sourceStationCode=SBC&destinationStationCode=MAS';
    const fast = engineWith(() => [], async () => capture('fast', confirmtkt, sample('trains.between.page.json')));
    await fast.answer('trains.between', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_limits' });
    await fast.answer('trains.confirm_chance', { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' }, { tripId: 't_limits' });
    // buses.between: every bus from its lowest seat fare after ixigo's offer.
    await engineWith(() => [
      capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services/meta/105', '{"status":"success","meta":{}}'),
      capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json')),
    ]).answer('buses.between', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { tripId: 't_limits' });
    // hotels.search: two pages of stays.
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const URL = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    await engineWith(() => [capture(SEARCH, URL, fixture('stays-goa-page1.json')), capture(SEARCH, URL, fixture('stays-goa-page2.json'))]).answer(
      'hotels.search', { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, { tripId: 't_limits' },
    );
    // plan.destination: a whole guide page's flight payload, found through its widgets.
    await engineWith((url) => [capture('/plan/goa$', url, sample('plan.destination.html'))]).answer('plan.destination', { place: 'Goa' }, { tripId: 't_limits' });

    const rows = ['trains.between', 'trains.confirm_chance', 'buses.between', 'hotels.search', 'plan.destination'].map((id) => ({ id, ...measured(book.get(id)!) }));
    // The evidence, for whoever sets the budget next: the most steps and milliseconds one evaluation took.
    console.log(`evaluation peaks (STEP_LIMIT ${STEP_LIMIT}):\n${rows.map((r) => `  ${r.id}: ${r.steps} steps, ${r.ms.toFixed(1)} ms`).join('\n')}`);
    for (const r of rows) {
      expect(r.steps, r.id).toBeGreaterThan(0);
      expect(r.steps, r.id).toBeLessThan(STEP_LIMIT / 10);
    }
  });

  it('fails a runaway expression on its steps, the same on a busy process as an idle one, as a TravelError', async () => {
    const runaway = '$count([1..1000].($count([1..1000].($ * 2))))';
    const err = await evaluate(runaway, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TravelError);
    expect((err as TravelError).message).toContain('GO_STEPS');
    // Each evaluation counts its own steps: the next one starts at nothing and finishes.
    expect(await evaluate('$count([1..1000].($ * 2))', null)).toBe(1000);
  });
});
