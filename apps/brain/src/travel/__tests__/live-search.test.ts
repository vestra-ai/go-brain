import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { liveSteps, startLiveSearch, type LiveSearchDeps } from '../live-search.js';
import type { LiveFrame } from '../recipes/progress.js';

const RESULTS = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form';
const BOOKING = 'https://www.ixigo.com/flight/booking/1044/1q4hf09hp?fareKey=DEL-GOI-6E5341-06112026&providers=1044';
const jpeg = (n: number): string => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n, n]).toString('base64');
const frame = (at_ms: number, page_url: string, data = jpeg(at_ms % 250)): LiveFrame => ({ label: `at ${at_ms}`, at_ms, page_url, jpeg_base64: data });

interface Sent { method: string; params: { request_id?: string; text?: string; card: C.Card } }

/** The Server, as the live card sees it: every request recorded, each answered after `delayMs` (or never, when hung). */
function room(o: { delayMs?: number; hang?: boolean; failPost?: boolean } = {}) {
  const sent: Sent[] = [];
  const stored: Buffer[] = [];
  const warnings: string[] = [];
  const deps: LiveSearchDeps = {
    link: {
      request: (async (method: string, params: Sent['params']) => {
        sent.push({ method, params: structuredClone(params) });
        if (o.hang) return new Promise(() => undefined);
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        if (o.failPost && method === 'post_message') throw new Error('the Server is down');
        return {};
      }) as unknown as LiveSearchDeps['link']['request'],
    },
    images: {
      putBytes: async (bytes) => {
        stored.push(Buffer.from(bytes));
        return `https://go.test/img/frame-${stored.length}.jpg`;
      },
    },
    now: () => new Date('2026-10-07T09:00:00Z'),
    log: { warn: (_obj, msg) => void warnings.push(msg) },
    finishWaitMs: 300,
  };
  const cards = () => sent.map((s) => C.WorkingCard.parse(s.params.card));
  return { sent, stored, warnings, deps, cards };
}

const FLIGHTS = { kind: 'flights' as const, query: { from: 'Delhi', to: 'Goa', date: '2026-11-06', departAfter: '18:00', mustHave: ['non_stop' as const] } };

describe('the live search card', () => {
  it('posts at once with "On it." and the planned steps, the first one under way', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'ixigo.flights|DEL|GOI|2026-11-06|4@1', ...FLIGHTS });
    await live.finish(true);
    const first = r.sent[0]!;
    expect(first.method).toBe('post_message');
    expect(first.params.text).toBe('On it.');
    expect(first.params.request_id).toMatch(/^go_live_[0-9a-f]{24}$/);
    expect(r.cards()[0]).toMatchObject({
      kind: 'working',
      title: 'Searching flights on ixigo',
      state: 'running',
      steps: [
        { text: 'Opening ixigo flights', state: 'doing' },
        { text: 'Reading the results', state: 'todo' },
        { text: 'Picking flights: leaving after 6:00 pm, non-stop', state: 'todo' },
      ],
      actions: [],
    });
  });

  it('ticks its steps as the run reports, and is done, every step ticked, before finish resolves', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k1', ...FLIGHTS });
    live.progress({ type: 'opening', recipeId: 'ixigo.flights', url: RESULTS });
    live.progress({ type: 'captured', ms: 1400 });
    live.progress({ type: 'extracted', count: 134 });
    await live.finish(true);
    const last = r.cards().at(-1)!;
    expect(r.sent.at(-1)!.method).toBe('replace_card');
    expect(last).toMatchObject({ state: 'done', fallback_text: 'Go searched flights on ixigo.' });
    expect(last.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    // One card throughout.
    expect(new Set(r.cards().map((c) => c.card_id)).size).toBe(1);
  });

  it("shows the newest picture of a results page, re-hosted, with the page's address", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k2', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [frame(400, 'https://www.ixigo.com/flights'), frame(1700, RESULTS)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(jpeg(1700 % 250), 'base64')]);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: 'https://go.test/img/frame-1.jpg', page_url: RESULTS });
  });

  it('ends on the most drawn picture, the largest JPEG, not the newest: ixigo\'s grey loading list comes last (re-drill 6)', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k2b', ...FLIGHTS });
    const drawn = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 7)]).toString('base64');
    const loading = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]).toString('base64');
    live.progress({ type: 'frames', frames: [frame(1200, RESULTS, loading), frame(2600, RESULTS, drawn), frame(3100, RESULTS, loading)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(drawn, 'base64')]);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', page_url: RESULTS });
  });

  it('never stores or shows a picture of a booking page, even the newest one', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k3', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [frame(1700, RESULTS), frame(5200, BOOKING), frame(5600, `${RESULTS}&loginVisible=true`)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(jpeg(1700 % 250), 'base64')]);
    for (const c of r.cards()) expect([null, RESULTS]).toContain(c.page_url ?? null);
  });

  it('shows nothing when every frame is a page Go may not show, or not a JPEG, or too big', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k4', ...FLIGHTS });
    live.progress({
      type: 'frames',
      frames: [
        frame(100, BOOKING),
        frame(200, RESULTS, Buffer.from('<html>not a picture</html>').toString('base64')),
        frame(300, RESULTS, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64')),
      ],
    });
    await live.finish(true);
    expect(r.stored).toEqual([]);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: null, page_url: null });
  });

  it('a failed run marks the card failed at the step it was on, and a later finish keeps it failed', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k5', ...FLIGHTS });
    live.progress({ type: 'captured', ms: 900 });
    live.progress({ type: 'failed', code: 'timeout' });
    await live.finish(true);
    const last = r.cards().at(-1)!;
    expect(last).toMatchObject({ state: 'failed', fallback_text: "Go couldn't search flights on ixigo." });
    expect(last.steps.map((s) => s.state)).toEqual(['done', 'failed', 'todo']);
  });

  it('folds updates that come while one is on its way into the newest, and keeps them in order', async () => {
    const r = room({ delayMs: 30 });
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k6', ...FLIGHTS });
    live.progress({ type: 'captured', ms: 900 });
    live.progress({ type: 'extracted', count: 12 });
    live.progress({ type: 'frames', frames: [frame(1700, RESULTS)] });
    await live.finish(true);
    expect(r.sent[0]!.method).toBe('post_message');
    expect(r.sent.slice(1).every((s) => s.method === 'replace_card')).toBe(true);
    expect(r.sent.length).toBeLessThanOrEqual(4);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: 'https://go.test/img/frame-1.jpg' });
  });

  it('never holds the options card for long when the Server does not answer', async () => {
    const r = room({ hang: true });
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k7', ...FLIGHTS });
    const started = Date.now();
    await live.finish(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('sends nothing more for a card the Server never took, and the run goes on', async () => {
    const r = room({ failPost: true });
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k8', ...FLIGHTS });
    live.progress({ type: 'captured', ms: 900 });
    await live.finish(true);
    expect(r.sent.map((s) => s.method)).toEqual(['post_message']);
    expect(r.warnings).toContain('travel: a live search card update failed');
  });

  it('a prefetch and the tool that share one run share one card id; another run gets another', async () => {
    const idOf = async (runKey: string): Promise<string> => {
      const r = room();
      await startLiveSearch(r.deps, 't_goa', { runKey, ...FLIGHTS }).finish(true);
      return r.cards()[0]!.card_id;
    };
    expect(await idOf('same')).toBe(await idOf('same'));
    expect(await idOf('other')).not.toBe(await idOf('same'));
  });
});

describe('the planned steps', () => {
  it('say what is being picked, in the words a search result uses', () => {
    expect(liveSteps('stays', { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'], maxPriceMinor: 1_000_000 })).toEqual([
      'Opening ixigo hotels',
      'Reading the results',
      'Picking hotels: at most ₹10,000 a night, with a pool',
    ]);
    expect(liveSteps('buses', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' })[2]).toBe('Picking the best buses');
  });
});
