import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { LIVE_VIEW_FRESH_MS, liveSteps, ON_IT_QUIET_MS, openRecipeCards, startLiveSearch, type LiveSearch, type LiveSearchDeps } from '../live-search.js';
import { shownAfter } from '../recipes/backend.js';
import type { LiveFrame } from '../recipes/progress.js';

const RESULTS = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form';
const BOOKING = 'https://www.ixigo.com/flight/booking/1044/1q4hf09hp?fareKey=DEL-GOI-6E5341-06112026&providers=1044';
const jpeg = (n: number): string => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n, n]).toString('base64');
const frame = (at_ms: number, page_url: string, data = jpeg(at_ms % 250)): LiveFrame => ({ label: `at ${at_ms}`, at_ms, page_url, jpeg_base64: data });
/** A JPEG of n bytes after its header, and a results-page frame of it with Bash's label. */
const sized = (n: number): string => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 5)]).toString('base64');
const labelled = (label: string, at_ms: number, n: number): LiveFrame => ({ label, at_ms, page_url: RESULTS, jpeg_base64: sized(n) });

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
  // Keshav's live test, 10 Oct: "DIDN'T WORK · Searching flights on ixigo" over the link card that answered the group.
  it('ends calm and done when the search answered another way, saying how: never "Didn\'t work"', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_answered', ...FLIGHTS });
    live.progress({ type: 'answered', text: "Here's ixigo's page, set for 3 from Delhi" });
    await live.finish(true);
    expect(r.cards().at(-1)).toMatchObject({
      state: 'done',
      steps: [{ text: 'Opened ixigo flights', state: 'done' }, { text: "Here's ixigo's page, set for 3 from Delhi", state: 'done' }],
      fallback_text: "Here's ixigo's page, set for 3 from Delhi.",
    });
    expect(r.cards().some((c) => c.state === 'failed')).toBe(false);
  });

  // Staging, 10 Oct: the early plain read said "On it." at 2 s, and the model's search with ixigo's filters said it again at 12 s.
  it('says "On it." once an ask: a second card in the trip within a minute goes up with no words, and a later ask says it again', async () => {
    const r = room();
    let now = Date.parse('2026-10-07T09:00:00Z');
    const deps: LiveSearchDeps = { ...r.deps, now: () => new Date(now), saidOnIt: new Map() };
    await startLiveSearch(deps, 't_goa', { runKey: 'a', ...FLIGHTS }).finish(true);
    now += 10_000;
    await startLiveSearch(deps, 't_goa', { runKey: 'b', ...FLIGHTS }).finish(true);
    // Another trip's ask says its own.
    await startLiveSearch(deps, 't_other', { runKey: 'c', ...FLIGHTS }).finish(true);
    now += ON_IT_QUIET_MS;
    await startLiveSearch(deps, 't_goa', { runKey: 'd', ...FLIGHTS }).finish(true);
    const posts = r.sent.filter((s) => s.method === 'post_message');
    expect(posts.map((s) => s.params.text ?? null)).toEqual(['On it.', null, 'On it.', 'On it.']);
    // The quiet one is still a card the contract takes: a message needs text, a card, or both.
    expect(C.PostMessage.safeParse(posts[1]!.params).success).toBe(true);
  });

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

  it('ends on the largest picture Bash took once the results were in, over a bigger one under ixigo\'s dark popup', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k2c', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [labelled('browsing', 1800, 1400), labelled('captured', 2900, 1300), labelled('results', 3200, 700), labelled('results', 3800, 900), labelled('browsing', 4100, 1200)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(sized(900), 'base64')]);
  });

  it('with no results picture (buses, trains: nothing settles), takes the largest captured one over a bigger browsing one', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k2d', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [labelled('browsing', 1500, 1600), labelled('captured', 2400, 600), labelled('captured', 2500, 800), labelled('navigated', 900, 1100)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(sized(800), 'base64')]);
  });

  it('with neither, takes the largest picture of any label', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k2e', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [labelled('navigated', 600, 500), labelled('browsing', 1500, 1000), labelled('after-click', 2100, 700)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(sized(1000), 'base64')]);
  });

  it('never stores or shows a picture of a booking page, even the newest one', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k3', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [frame(1700, RESULTS), frame(5200, BOOKING), frame(5600, `${RESULTS}&loginVisible=true`)] });
    await live.finish(true);
    expect(r.stored).toEqual([Buffer.from(jpeg(1700 % 250), 'base64')]);
    for (const c of r.cards()) expect([null, RESULTS]).toContain(c.page_url ?? null);
  });

  // The stage's last picture is the card's (the look at the drawn page, after the card is done): never of a log in, a
  // payment, a sign-in service's or a traveller page, whatever the stage was left on.
  it("never takes the stage's last picture of a log in, payment, sign-in or traveller page as the card's", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k3s', ...FLIGHTS });
    live.progress({ type: 'frames', frames: [frame(1700, RESULTS)] });
    await live.finish(true);
    const kept = r.cards().at(-1)!.screenshot_url;
    for (const page of ['https://www.ixigo.com/login', 'https://www.ixigo.com/payments/abc', 'https://accounts.google.com/o/oauth2/auth', 'https://www.ixigo.com/flight/traveller-details?x=1', `${RESULTS}&loginVisible=true`]) {
      live.progress({ type: 'drawn', frames: [frame(6000, page, jpeg(77))] });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.stored).toEqual([Buffer.from(jpeg(1700 % 250), 'base64')]);
    expect(r.cards().at(-1)!.screenshot_url).toBe(kept);
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

  it("names a recipe's card by the recipe (the ixigo tool's runs): what Go checks, three plain steps, and how it ended", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_recipe', recipe: "A train's running status" });
    live.progress({ type: 'opening', recipeId: 'trains.running_status', url: 'https://www.ixigo.com/trains/12779/running-status' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().at(-1)).toMatchObject({
      title: "Checking ixigo: a train's running status", state: 'running',
      steps: [{ text: 'Opening ixigo', state: 'doing' }, { text: 'Reading the page', state: 'todo' }, { text: 'Answering', state: 'todo' }],
    });
    live.progress({ type: 'captured', ms: 2_000 });
    live.progress({ type: 'extracted', count: 1 });
    await live.finish(true);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', fallback_text: "Go checked a train's running status on ixigo." });
  });

  it("never fails on a pick: it says Go is choosing between ixigo's places, and the search after the pick ticks on in it", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_pick', kind: 'trains', query: { from: 'Jaipur', to: 'Udaipur', date: '2026-10-20' } });
    live.progress({ type: 'choosing', between: ['Udaipur City (UDZ)', 'Udaipur Junction (UDPU)'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().at(-1)).toMatchObject({
      state: 'running',
      steps: [
        { text: 'Choosing between Udaipur City (UDZ) and Udaipur Junction (UDPU)', state: 'doing' },
        { text: 'Opening ixigo trains', state: 'todo' },
        { text: 'Reading the results', state: 'todo' },
        { text: 'Picking the best trains', state: 'todo' },
      ],
    });
    // The search after the pick.
    live.progress({ type: 'opening', recipeId: 'trains.between', url: RESULTS });
    live.progress({ type: 'captured', ms: 900 });
    live.progress({ type: 'extracted', count: 25 });
    await live.finish(true);
    expect(r.cards().at(-1)!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(r.cards().some((c) => c.state === 'failed')).toBe(false);
    expect(new Set(r.cards().map((c) => c.card_id)).size).toBe(1);
  });

  it("says once that ixigo's login is open on Go's screen while the search waits for it, and ticks on once it runs", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_wait', kind: 'trains', query: { from: 'Delhi', to: 'Goa', date: '2026-11-06' } });
    live.progress({ type: 'waiting' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().at(-1)).toMatchObject({
      state: 'running',
      steps: [
        { text: "ixigo's login is open on Go's screen: this runs once it's done or Not now", state: 'doing' },
        { text: 'Opening ixigo trains', state: 'todo' },
        { text: 'Reading the results', state: 'todo' },
        { text: 'Picking the best trains', state: 'todo' },
      ],
    });
    live.progress({ type: 'captured', ms: 900 });
    live.progress({ type: 'extracted', count: 25 });
    await live.finish(true);
    expect(r.cards().at(-1)!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
  });

  // The App team's room, 11 Oct: asks close together each took Go's one screen, and the one before ended Stopped.
  it("says it is next in line while the ask before it has Go's screen, then opens its page and ends done, never stopped", async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_next', kind: 'buses', query: { from: 'Bangalore', to: 'Hyderabad', date: '2026-11-06' } });
    live.progress({ type: 'opening', recipeId: 'buses.between', url: RESULTS });
    live.progress({ type: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().at(-1)).toMatchObject({
      state: 'running',
      steps: [
        { text: 'Next in line, after the search before it', state: 'doing' },
        { text: 'Opening ixigo buses', state: 'todo' },
        { text: 'Reading the results', state: 'todo' },
        { text: 'Picking the best buses', state: 'todo' },
      ],
    });
    live.progress({ type: 'turn' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().at(-1)!.steps.map((s) => s.state)).toEqual(['done', 'doing', 'todo', 'todo']);
    live.progress({ type: 'captured', ms: 900 });
    live.progress({ type: 'extracted', count: 25 });
    await live.finish(true);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done' });
    expect(r.cards().at(-1)!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(r.cards().some((c) => c.state === 'failed')).toBe(false);
  });

  it('takes the page as ixigo drew it after the answer, on a card already done; never on a failed one (the 8 Oct demo)', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_drawn', ...FLIGHTS });
    const skeleton = sized(300);
    const list = sized(1200);
    live.progress({ type: 'frames', frames: [{ label: 'results', at_ms: 2600, page_url: RESULTS, jpeg_base64: skeleton }] });
    await live.finish(true);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: 'https://go.test/img/frame-1.jpg' });
    live.progress({ type: 'drawn', frames: [{ label: 'done', at_ms: 5200, page_url: RESULTS, jpeg_base64: list }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.stored.at(-1)).toEqual(Buffer.from(list, 'base64'));
    // Still done, every step ticked: only the picture moved on.
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: 'https://go.test/img/frame-2.jpg', page_url: RESULTS });
    expect(r.cards().at(-1)!.steps.every((s) => s.state === 'done')).toBe(true);

    const f = room();
    const failed = startLiveSearch(f.deps, 't_goa', { runKey: 'k_drawn_failed', ...FLIGHTS });
    failed.progress({ type: 'failed', code: 'timeout' });
    await failed.finish(false);
    const sentBefore = f.sent.length;
    failed.progress({ type: 'drawn', frames: [{ label: 'done', at_ms: 5200, page_url: RESULTS, jpeg_base64: list }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.stored).toEqual([]);
    expect(f.sent.length).toBe(sentBefore);
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

// The Server team's R7 (11 Oct): "your working card's steps arrive [...] Nothing is streamed today." The card carries a
// view-only page of Go's screen while it runs, and changes in the room at step changes only, never for a picture.
describe("the card's live view", () => {
  const viewing = (r: ReturnType<typeof room>, o: { slow?: Promise<void>; fail?: boolean; now?: () => Date } = {}) => {
    const made: string[] = [];
    const ended: string[] = [];
    const deps: LiveSearchDeps = {
      ...r.deps,
      ...(o.now ? { now: o.now } : {}),
      liveViewWaitMs: 50,
      liveView: async (tripId) => {
        made.push(tripId);
        const n = made.length;
        await o.slow;
        if (o.fail) throw new Error('Bash said no');
        return { id: `ses_${n}`, url: `https://bash.test/embed/browser?s=ses_${n}#token=t${n}`, expires_at: '2026-10-07T09:15:00.000Z' };
      },
      endView: async (id) => void ended.push(id),
    };
    return { deps, made, ended };
  };

  it('carries a view-only live_url from its first post, made as it starts; once done, the view ends and leaves the card', async () => {
    const r = room();
    const v = viewing(r);
    const live = startLiveSearch(v.deps, 't_goa', { runKey: 'k_live', ...FLIGHTS });
    // The first post goes once its view is in (it waits for it, briefly): an update that comes sooner folds into it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    live.progress({ type: 'captured', ms: 900 });
    await live.finish(true);
    expect(r.sent[0]!.method).toBe('post_message');
    expect(r.cards()[0]).toMatchObject({ state: 'running', live_url: 'https://bash.test/embed/browser?s=ses_1#token=t1' });
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', live_url: null });
    expect(v.made).toEqual(['t_goa']);
    expect(v.ended).toEqual(['ses_1']);
  });

  it('never holds "On it." for a slow live view: it rides the next step change; one that never opens leaves no live_url', async () => {
    const r = room();
    let open: () => void = () => undefined;
    const v = viewing(r, { slow: new Promise<void>((resolve) => { open = resolve; }) });
    const live = startLiveSearch(v.deps, 't_goa', { runKey: 'k_slow', ...FLIGHTS });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.cards()[0]).toMatchObject({ live_url: null });
    open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    live.progress({ type: 'captured', ms: 900 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.cards().at(-1)).toMatchObject({ state: 'running', live_url: 'https://bash.test/embed/browser?s=ses_1#token=t1' });
    await live.finish(true);

    const f = room();
    const nope = viewing(f, { fail: true });
    const failed = startLiveSearch(nope.deps, 't_goa', { runKey: 'k_noview', ...FLIGHTS });
    failed.progress({ type: 'captured', ms: 900 });
    await failed.finish(true);
    expect(f.cards().every((c) => (c as { live_url?: string | null }).live_url == null)).toBe(true);
    expect(f.warnings).toContain('travel: a live view did not open');
    expect(f.cards().at(-1)).toMatchObject({ state: 'done' });
  });

  it('is made again at the first step change once 10 minutes old (Bash gives 15), and the old one ends', async () => {
    const r = room();
    let now = Date.parse('2026-10-07T09:00:00Z');
    const v = viewing(r, { now: () => new Date(now) });
    const live = startLiveSearch(v.deps, 't_goa', { runKey: 'k_fresh', ...FLIGHTS });
    live.progress({ type: 'opening', recipeId: 'ixigo.flights', url: RESULTS });
    await new Promise((resolve) => setTimeout(resolve, 10));
    now += LIVE_VIEW_FRESH_MS;
    live.progress({ type: 'captured', ms: 900 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.cards().at(-1)).toMatchObject({ state: 'running', live_url: 'https://bash.test/embed/browser?s=ses_2#token=t2' });
    expect(v.ended).toEqual(['ses_1']);
    await live.finish(true);
    expect(v.ended).toEqual(['ses_1', 'ses_2']);
  });

  it('a picture while the card runs changes nothing in the room: the next step change carries it, and the done card keeps the last', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_quiet', ...FLIGHTS });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = r.sent.length;
    live.progress({ type: 'frames', frames: [frame(1700, RESULTS)] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.stored).toHaveLength(1);
    expect(r.sent.length).toBe(before);
    live.progress({ type: 'captured', ms: 900 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.cards().at(-1)).toMatchObject({ state: 'running', screenshot_url: 'https://go.test/img/frame-1.jpg', page_url: RESULTS });
    await live.finish(true);
    expect(r.cards().at(-1)).toMatchObject({ state: 'done', screenshot_url: 'https://go.test/img/frame-1.jpg' });
  });
});

// Exam #9, 10 Oct: Go answered "Paulo reaches Mapusa at 10:30 am…", while its two bus-stops cards said "On it." twice
// (posted 5 ms apart) and were left failed beside the answer when their pages timed out after it.
describe("an ask's cards and Go's answer", () => {
  const RECIPE = { recipe: "One bus's every pickup and drop point" };

  it('two cards of one ask posting at the same moment say "On it." once', async () => {
    const r = room({ delayMs: 20 });
    const deps: LiveSearchDeps = { ...r.deps, saidOnIt: new Map() };
    const a = startLiveSearch(deps, 't_goa', { runKey: 'turn_9|buses.stops|a', ...RECIPE });
    const b = startLiveSearch(deps, 't_goa', { runKey: 'turn_9|buses.stops|b', ...RECIPE });
    await Promise.all([a.finish(true), b.finish(true)]);
    expect(r.sent.filter((x) => x.method === 'post_message').map((x) => x.params.text ?? null)).toEqual(['On it.', null]);
  });

  it('a card whose post never reached the room gives "On it." back, so the next card says it', async () => {
    const said = new Map<string, number>();
    const down = room({ failPost: true });
    await startLiveSearch({ ...down.deps, saidOnIt: said }, 't_goa', { runKey: 'k_down', ...RECIPE }).finish(true);
    expect(said.has('t_goa')).toBe(false);
    const up = room();
    await startLiveSearch({ ...up.deps, saidOnIt: said }, 't_goa', { runKey: 'k_up', ...RECIPE }).finish(true);
    expect(up.sent[0]!.params.text).toBe('On it.');
  });

  // The lead, 11 Oct (Ankur's "hills"): a working card said Done over "Opening ixigo, Step 1 of 3" on a read that failed.
  // A failed read shows failed, whether or not Go answered without it.
  it('a card that failed stays failed when Go answers, its words saying Go answered without it', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_gap', ...RECIPE });
    await live.finish(false);
    expect(r.cards().at(-1)!.state).toBe('failed');
    live.answered();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const last = r.cards().at(-1)!;
    expect(last.state).toBe('failed');
    expect(last.steps.map((st) => st.state)).toEqual(['failed', 'todo', 'todo']);
    expect(last.fallback_text).toBe("Go answered; ixigo's page for one bus's every pickup and drop point didn't load.");
    expect(r.cards().map((c) => c.state)).not.toContain('done');
  });

  it('a card still running when Go answered ends as its read does: failed when it fails, done when it finishes', async () => {
    const r = room();
    const live = startLiveSearch(r.deps, 't_goa', { runKey: 'k_late', ...RECIPE });
    live.answered();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.cards().map((c) => c.state)).not.toContain('done');
    live.progress({ type: 'failed', code: 'unreachable' });
    await live.finish(false);
    const last = r.cards().at(-1)!;
    expect(r.cards().map((c) => c.state)).not.toContain('done');
    expect(last.state).toBe('failed');
    expect(last.fallback_text).toBe("Go answered; ixigo's page for one bus's every pickup and drop point didn't load.");
    // One that finishes well after the answer is simply done.
    const ok = room();
    const fine = startLiveSearch(ok.deps, 't_goa', { runKey: 'k_fine', ...RECIPE });
    fine.answered();
    await fine.finish(true);
    expect(ok.cards().at(-1)).toMatchObject({ state: 'done', fallback_text: "Go checked one bus's every pickup and drop point on ixigo." });
  });

  it("a turn that answered tells its own cards and its messages' early reads, and a run of it puts no card up after", () => {
    const told: string[] = [];
    const fake = (name: string): LiveSearch => ({ progress: () => undefined, finish: async () => undefined, answered: () => void told.push(name) });
    const cards = openRecipeCards();
    cards.card('t_goa', 'turn_9|buses.stops|{"bus":"a"}', () => fake('tool'));
    cards.card('t_goa', 'early:m_9|buses.stops', () => fake('early'));
    cards.card('t_goa', 'turn_8|buses.stops|{}', () => fake('other turn'));
    cards.card('t_other', 'turn_9|buses.stops|{}', () => fake('other trip'));
    cards.turnEnded({ tripId: 't_goa', turnId: 'turn_9', messageIds: ['m_9'], answered: true });
    expect(told).toEqual(['tool', 'early']);
    // A run of the answered turn that would show a card only now shows none.
    let made = 0;
    cards.card('t_goa', 'turn_9|buses.stops|{"bus":"b"}', () => {
      made += 1;
      return fake('late');
    });
    expect(made).toBe(0);
    // A turn that did not answer tells nothing, and lets its cards go.
    cards.turnEnded({ tripId: 't_goa', turnId: 'turn_8', messageIds: [], answered: false });
    cards.turnEnded({ tripId: 't_goa', turnId: 'turn_8', messageIds: [], answered: true });
    expect(told).toEqual(['tool', 'early']);
  });

  it('a delayed card its turn answered before it showed never shows', async () => {
    let made = 0;
    const live = shownAfter(10, () => {
      made += 1;
      return { progress: () => undefined, finish: async () => undefined, answered: () => undefined };
    });
    live.answered();
    live.progress({ type: 'opening', recipeId: 'buses.stops', url: 'https://www.ixigo.com/buses' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(made).toBe(0);
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
