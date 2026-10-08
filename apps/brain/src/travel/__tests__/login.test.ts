import { readFileSync } from 'node:fs';
import type * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createSetup } from '../../trips/setup.js';
import type { CardTapParams, CardTapResult } from '../../door/methods.js';
import { fakeLink, fakePacks, goaPack, goaTrip, msg } from '../../proactive/fakes.js';
import type { TaskBrief } from '../../tasks/tasks.js';
import { BOOK_DIR, checkRecipe, loadBook, type Book } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import type { DeskItem } from '../../desk/desk.js';
import { createIxigoLogin, HANDOFF_MS, HANDOFF_PAGE_MS, HELLO_WAIT_MS, LOGIN_TAB, LOGIN_URL, RECHECK_MS, renderLoginResume, USERINFO } from '../login.js';
import { TravelError } from '../mcp-travel.js';
import { capture } from '../recipes/__tests__/fixtures.js';
import { IXIGO, type FetchPlan } from '../recipes/recipe.js';

// Keshav, 8 Oct: "when the trip creates, that's when we [make] the ixigo connection, and all the warming should happen;
// connection as in ixigo should be logged in, so prompt someone to login". The organizer is asked right after setup warms
// ixigo; their own tap opens ixigo's log in in front on Go's screen, with no model; ixigo's own answer, by its status, says whether the
// browser is logged in; and nothing of the account ever reaches Go.
const NOW = new Date('2026-10-08T06:00:00Z');

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

let trips = 0;

/**
 * One trip (the Goa five, Rahul organizing), its chat, the trip's browser and the jobs lane, all recorded. The trip says it
 * was made on 5 Oct, as the sim's Goa trip always does: nothing here goes by that. Waits for Go's hello move the clock.
 */
/** opened: ixigo's userinfo status on the log in page the hand-off opens (403 by default: logged out), 'timeout' for a
 *  page that caught nothing in its time, 'refused' for a hand-off Bash would not open. */
function world(o: { live?: boolean; greeted?: boolean; paused?: string[]; statuses?: Array<number | 'timeout'>; opened?: number | 'timeout' | 'refused' } = {}) {
  trips += 1;
  const tripId = `t_login_${trips}`;
  const clock = { now: NOW };
  const link = fakeLink();
  const base = goaTrip({ trip_id: tripId });
  const trip = goaTrip({ trip_id: tripId, people: base.people.map((p) => ({ ...p, go_paused: o.paused?.includes(p.person_id) ?? false })) });
  const hello = msg({ by: 'go', text: 'Hey all, I am Go.' });
  const packs = fakePacks(goaPack({ trip, messages: o.greeted === false ? [] : [hello] }));
  const greet = (): void => packs.set(goaPack({ trip, messages: [hello] }));
  const looks: number[] = [];
  const hooks: { onSleep?: (n: number) => void; onHandOff?: () => void | Promise<void> } = {};
  const statuses = [...(o.statuses ?? [])];
  const reads: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      reads.push({ url, plan });
      if (plan.capture[0]?.match !== USERINFO) return { captures: [], finalUrl: url };
      const s = statuses.shift() ?? 'timeout';
      if (s === 'timeout') throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
      return { captures: [capture(USERINFO, `${IXIGO}${USERINFO}`, '{', s)], finalUrl: url };
    },
    handOff: async (_trip: string, url: string, plan: FetchPlan, ho: { keepOpenMs: number; tab: string; check?: { url: string; method: string } }) => {
      handOffs.push({ url, plan, o: ho });
      await hooks.onHandOff?.();
      const s = o.opened ?? 403;
      if (s === 'refused') throw new TravelError('refused', 'Bash would not open the page.');
      return { captures: s === 'timeout' ? [] : [capture('check', `${IXIGO}${USERINFO}`, '{', s)] };
    },
    release: async (_trip: string, tab: string) => {
      releases.push(tab);
    },
    // "I'm logged in" asks ixigo from inside the log in page: the same statuses, in turn.
    tabCall: async (_trip: string, tab: string, call: { url: string; method: string }, keepOpenMs: number) => {
      tabCalls.push({ tab, call, keepOpenMs });
      const s = statuses.shift() ?? 'timeout';
      if (s === 'timeout') throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
      return capture('tab_call', `${IXIGO}${USERINFO}`, '{', s);
    },
  };
  const tabCalls: Array<{ tab: string; call: { url: string; method: string }; keepOpenMs: number }> = [];
  const handOffs: Array<{ url: string; plan: FetchPlan; o: { keepOpenMs: number; tab: string } }> = [];
  const releases: string[] = [];
  const sessions: Array<[string, string]> = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const screen = async (trip: string, mode: 'view' | 'control') => {
    sessions.push([trip, mode]);
    return { url: `https://screen.example/${mode}`, expires_at: '2026-10-08T06:15:00.000Z' };
  };
  const starts: TaskBrief[] = [];
  const handoffs: Array<[string, string]> = [];
  const stops: string[] = [];
  const tasks = {
    start: async (_trip: string, brief: TaskBrief) => {
      starts.push(brief);
      return { taskId: `gt_login_${starts.length}`, cardId: `c_work_${starts.length}` };
    },
    handoff: async (taskId: string, outcome: 'done' | 'could_not' | 'not_now') => {
      handoffs.push([taskId, outcome]);
    },
    stop: async (taskId: string) => {
      stops.push(taskId);
    },
  };
  const wakes: DeskItem[] = [];
  const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { wakes.push({ id: item.id ?? '', ...item }); } };
  const login = createIxigoLogin({
    pool: db.pool, link, packs, runner: () => runner, tasks: () => tasks, screen: () => screen, desk, live: () => o.live !== false, now: () => clock.now,
    log: { warn: () => undefined, info: () => undefined },
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      looks.push(ms);
      hooks.onSleep?.(looks.length);
    },
    later: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  const handlers = new Map<string, (tap: CardTapParams, card: C.Card) => Promise<CardTapResult>>();
  login.registerTaps({ on: (kind, action, h) => handlers.set(`${kind}:${action}`, h) });
  let tapN = 0;
  const tap = async (action: string, personId: string, payload?: Record<string, unknown>): Promise<CardTapResult> => {
    tapN += 1;
    const params = { tap_id: `tap_${tapN}`, trip_id: tripId, card_id: 'c_login', action_id: action, person_id: personId, ...(payload ? { payload } : {}) };
    const out = await handlers.get(`notice:${action}`)!(params as CardTapParams, {} as C.Card);
    await login.settled();
    return out;
  };
  const cards = (): C.Card[] => [...link.of('post_message').flatMap((p) => (p.card ? [p.card as C.Card] : [])), ...link.of('replace_card').map((p) => p.card as C.Card)];
  const last = (): C.Card & { kind: 'notice' } => cards().at(-1) as C.Card & { kind: 'notice' };
  const state = async (): Promise<string | undefined> =>
    (await db.pool.query<{ state: string }>('select state from ixigo_logins where trip_id = $1', [tripId])).rows[0]?.state;
  const parked = async (): Promise<unknown> =>
    (await db.pool.query<{ parked: unknown }>('select parked from ixigo_logins where trip_id = $1', [tripId])).rows[0]?.parked ?? null;
  return {
    tripId, trip, clock, link, reads, statuses, starts, handoffs, stops, handOffs, releases, sessions, timers, tabCalls, wakes, login, tap, last, state, parked,
    greet, looks, hooks, setup: () => login.setupStep.run(tripId),
  };
}

const STATUS_PLAN = { capture: [{ match: USERINFO, required: true, max_bytes: 1 }], timeoutMs: 12_000 };

describe('the ixigo login, asked at setup', () => {
  it("waits for Go's hello, looking every second, then asks; with no hello in 20 s, setup tries again later", async () => {
    const w = world({ greeted: false });
    w.hooks.onSleep = (n) => {
      if (n === 3) w.greet();
    };
    await w.setup();
    expect(w.looks).toEqual([1_000, 1_000, 1_000]);
    expect(w.link.of('post_message')).toHaveLength(1);

    const never = world({ greeted: false });
    await expect(never.setup()).rejects.toThrow(/greet/);
    expect(never.looks.reduce((a, b) => a + b, 0)).toBe(HELLO_WAIT_MS);
    expect(never.link.of('post_message')).toEqual([]);
    expect(await never.state()).toBeUndefined();
  });

  it('asks the organizer once Go has greeted the trip: one line naming them, and the card pinned to them with buttons only they see', async () => {
    const w = world();
    await w.setup();
    const [post] = w.link.of('post_message');
    expect(post).toMatchObject({
      trip_id: w.tripId,
      text: "Rahul, link ixigo for the trip: one login on the trip's computer, about a minute.",
      mentions: ['p_rahul'],
    });
    expect(post!['card']).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, kind: 'notice', for_person_ids: ['p_rahul'], title: 'Link ixigo for this trip',
      actions: [
        { action_id: 'ixigo_login', label: 'Log in to ixigo', style: 'primary', only_for_person_ids: ['p_rahul'] },
        { action_id: 'ixigo_not_now', label: 'Not now', style: 'secondary', only_for_person_ids: ['p_rahul'] },
      ],
    });
    expect((post!['card'] as { body: string }).body).toContain('Go never sees the number or the code');
    expect((post!['card'] as { body: string }).body).toContain("the group never sees its details");
    expect(await w.state()).toBe('asked');
    // Setup again (a retry, a restart): no second ask.
    await w.setup();
    expect(w.link.of('post_message')).toHaveLength(1);
  });

  it('is one setup flow at trip.created: the box started, the prompt right after the hello, then ixigo warmed; a warm that fails never holds the prompt', async () => {
    const w = world();
    const setup = createSetup({ pool: db.pool, log: silentLog, now: () => w.clock.now });
    const ran: string[] = [];
    let warmed = false;
    setup.addStep({ name: 'brain.ready', run: async () => { ran.push('ready'); } });
    setup.addStep({ name: 'travel.computer', after: 'brain.ready', run: async () => { ran.push('computer'); } });
    setup.addStep({ ...w.login.setupStep, run: async (tripId) => { ran.push('login'); await w.login.setupStep.run(tripId); } });
    setup.addStep({ name: 'travel.ixigo_warm', after: 'travel.computer', run: async () => { ran.push('warm'); if (!warmed) throw new Error('ixigo did not answer'); } });
    expect(w.login.setupStep.after).toBe('travel.computer');
    // The warm failed this pass, after the prompt went out.
    await setup.ensureTrip(w.tripId);
    expect(ran).toEqual(['ready', 'computer', 'login', 'warm']);
    expect(w.link.of('post_message')).toHaveLength(1);
    warmed = true;
    await setup.ensureTrip(w.tripId);
    expect(ran).toEqual(['ready', 'computer', 'login', 'warm', 'warm']);
    expect(w.link.of('post_message')).toHaveLength(1);
    expect(setup.isReady(w.tripId)).toBe(true);
  });

  it("asks the first person who hasn't paused Go when the organizer has", async () => {
    const w = world({ paused: ['p_rahul'] });
    await w.setup();
    expect(w.link.of('post_message')[0]).toMatchObject({ text: "Priya, link ixigo for the trip: one login on the trip's computer, about a minute.", mentions: ['p_priya'] });
    expect(w.last()).toMatchObject({ for_person_ids: ['p_priya'], actions: [{ only_for_person_ids: ['p_priya'] }, { only_for_person_ids: ['p_priya'] }] });
  });

  it('asks nothing while Go does not browse ixigo.com itself', async () => {
    const w = world({ live: false });
    await w.setup();
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.calls).toEqual([]);
    expect(await w.state()).toBeUndefined();
  });
});

describe("a trip's first search, with no login asked for yet", () => {
  // Keshav, 8 Oct: "if there is no login on ixigo in a group, it should first proactively prompt for that". A trip Go held
  // before the prompt came at setup (its setup step done long ago) is asked when its first search starts.
  it('asks once, beside the search, and never again: not at a second search, nor when two start at once', async () => {
    const w = world();
    w.login.nudge(w.tripId);
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.of('post_message')).toHaveLength(1);
    expect(w.link.of('post_message')[0]).toMatchObject({ text: "Rahul, link ixigo for the trip: one login on the trip's computer, about a minute.", card: { card_id: `c_login_${w.tripId}_0` } });
    expect(await w.state()).toBe('asked');
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.of('post_message')).toHaveLength(1);
    // Setup reaching the trip after the search asked: the row is there, so nothing more.
    await w.setup();
    expect(w.link.of('post_message')).toHaveLength(1);
  });

  it("an ask that never reached the room is asked again by the next search", async () => {
    const w = world();
    let fail = true;
    const request = w.link.request.bind(w.link);
    w.link.request = (async (method: string, params: Record<string, unknown>) => {
      if (method === 'post_message' && fail) throw new Error('the Server is away');
      return request(method, params);
    }) as typeof w.link.request;
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(await w.state()).toBeUndefined();
    fail = false;
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(await w.state()).toBe('asked');
    // The failed post never reached the fake Server's record; the second is the one ask.
    expect(w.link.of('post_message')).toHaveLength(1);
  });

  it('asks nothing of a trip that has a row of any kind, Not now included', async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_not_now', 'p_rahul');
    const posts = w.link.of('post_message').length;
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.of('post_message')).toHaveLength(posts);
    expect(await w.state()).toBe('skipped');
  });
});

describe('logging in', () => {
  it("only the person asked can tap; Log in opens ixigo's log in box in front of their window on Go's screen, with no job and no model", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_login', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(w.handOffs).toEqual([]);

    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'done', toast: "Opening ixigo's log in on Go's screen" });
    // No job: no model clicks its way to the box (87 to 96 s on staging, 8 Oct).
    expect(w.starts).toEqual([]);
    // ixigo's home page in FRONT of Rahul's window (as a phone: Bash's front), its own Login tapped and the cursor in its
    // mobile number box, the tab kept there for him for Bash's most; ixigo's userinfo asked from inside the page first,
    // one byte, read by its status only.
    expect(LOGIN_URL).toBe('https://www.ixigo.com/');
    expect(HANDOFF_MS).toBe(600_000);
    expect(w.handOffs).toEqual([{
      url: LOGIN_URL,
      plan: { capture: [], steps: [{ op: 'click', role: 'button', name: 'Login' }, { op: 'click', role: 'textbox', text: 'mobile' }], timeoutMs: HANDOFF_PAGE_MS },
      o: { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB, check: { url: USERINFO, method: 'POST' } },
    }]);
    expect(await w.state()).toBe('logging_in');
    // At once, before the page: the card flips to logging in, with I'm logged in and Not now but no Watch yet (the room
    // says it is opening). Then, the page in front, the same card with Watch.
    const flips = w.link.of('replace_card').map((p) => p.card as C.Card & { kind: 'notice' });
    expect(flips.at(-2)).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'Logging in to ixigo', for_person_ids: ['p_rahul'], body: "Opening ixigo's log in on Go's screen for Rahul.",
      actions: [
        { action_id: 'ixigo_logged_in', label: "I'm logged in", only_for_person_ids: ['p_rahul'] },
        { action_id: 'ixigo_not_now', label: 'Not now', only_for_person_ids: ['p_rahul'] },
      ],
    });
    expect(w.last()).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'Logging in to ixigo',
      body: "ixigo's log in is open on Go's screen. Rahul: tap Watch, log in with your phone, then tap I'm logged in.",
      actions: [
        { action_id: 'ixigo_watch', label: 'Watch', style: 'primary', only_for_person_ids: ['p_rahul'] },
        { action_id: 'ixigo_logged_in', label: "I'm logged in", only_for_person_ids: ['p_rahul'] },
        { action_id: 'ixigo_not_now', label: 'Not now', only_for_person_ids: ['p_rahul'] },
      ],
    });
    // Nobody else gets a Watch: they would watch Rahul type his number. Their card says whose login it is, and nothing more.
    for (const a of w.last().actions) expect(a.only_for_person_ids).toEqual(['p_rahul']);
  });

  it("opens ixigo's desktop page for a person on a computer (the tap's device), and the phone page otherwise", async () => {
    const desk = world();
    await desk.setup();
    await desk.tap('ixigo_login', 'p_rahul', { device: 'desktop' });
    expect(desk.handOffs[0]).toMatchObject({
      url: LOGIN_URL,
      plan: { steps: [{ op: 'click', role: 'button', text: 'Log in/Sign up' }, { op: 'click', role: 'textbox', text: 'mobile' }] },
      o: { device: 'desktop', tab: LOGIN_TAB },
    });
    // No device on the tap (the App, a phone), or a phone: Bash's default, the phone page.
    for (const payload of [undefined, { device: 'phone' }]) {
      const phone = world();
      await phone.setup();
      await phone.tap('ixigo_login', 'p_rahul', payload);
      expect(phone.handOffs[0]!.plan.steps?.[0]).toEqual({ op: 'click', role: 'button', name: 'Login' });
      expect(phone.handOffs[0]!.o).not.toHaveProperty('device');
    }
  });

  it('opens one page for a login however many times Log in is tapped while it opens (a double tap, 8 Oct)', async () => {
    const w = world();
    await w.setup();
    let open: () => void = () => undefined;
    w.hooks.onHandOff = () => new Promise<void>((r) => {
      open = r;
    });
    // Tapped, and tapped again 300 ms later while the page is still opening.
    const first = w.tap('ixigo_login', 'p_rahul');
    await vi.waitFor(() => expect(w.handOffs).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    const second = w.tap('ixigo_login', 'p_rahul');
    await new Promise((r) => setTimeout(r, 50));
    open();
    expect(await first).toEqual({ result: 'done', toast: "Opening ixigo's log in on Go's screen" });
    expect(await second).toEqual({ result: 'done', toast: "Already opening ixigo's log in" });
    // And with the page open, a third tap starts nothing either.
    w.hooks.onHandOff = undefined;
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'done', toast: "Already opening ixigo's log in" });
    expect(w.handOffs).toHaveLength(1);
    expect(await w.state()).toBe('logging_in');
  });

  it('two taps at the same moment still open one page: the row changes in one step', async () => {
    const w = world();
    await w.setup();
    const toasts = (await Promise.all([w.tap('ixigo_login', 'p_rahul'), w.tap('ixigo_login', 'p_rahul')])).map((r) => r.toast).sort();
    expect(toasts).toEqual(["Already opening ixigo's log in", "Opening ixigo's log in on Go's screen"]);
    expect(w.handOffs).toHaveLength(1);
  });

  it("takes a logging-in row back after Bash's most (its end never seen, as after a restart): Log in opens the page again", async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    // The end timer never ran (Go restarted), and the 10 minutes are long past.
    w.clock.now = new Date(w.clock.now.getTime() + HANDOFF_MS + 1_000);
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'done', toast: "Opening ixigo's log in on Go's screen" });
    expect(w.handOffs).toHaveLength(2);
  });

  it('flips the card to logging in before the page is asked for, so the room can say it is opening at once', async () => {
    const w = world();
    await w.setup();
    let atFetch: string[] | null = null;
    w.hooks.onHandOff = () => {
      atFetch = w.last().actions.map((a) => a.action_id);
    };
    await w.tap('ixigo_login', 'p_rahul');
    // When the front fetch started, the card already said logging in, with no Watch.
    expect(atFetch).toEqual(['ixigo_logged_in', 'ixigo_not_now']);
    expect(w.last().actions.map((a) => a.action_id)).toEqual(['ixigo_watch', 'ixigo_logged_in', 'ixigo_not_now']);
  });

  it("Watch gives only the person logging in Go's screen, with control; anyone else's tap is refused and opens nothing", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_watch', 'p_rahul')).toEqual({ result: 'refused', toast: "ixigo's log in isn't open on Go's screen now" });
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.tap('ixigo_watch', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(await w.tap('ixigo_watch', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(w.sessions).toEqual([[w.tripId, 'control']]);
  });

  it("needs no hand-off when ixigo's log in page says the browser is logged in already: the tab closes and the card says so", async () => {
    const w = world({ opened: 200 });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.last()).toMatchObject({ title: 'ixigo: logged in as Rahul' });
  });

  it("keeps a log in page that ran out of time in front for them; one Go's computer would not open goes back to the ask, saying so", async () => {
    const slow = world({ opened: 'timeout' });
    await slow.setup();
    await slow.tap('ixigo_login', 'p_rahul');
    expect(await slow.state()).toBe('logging_in');
    expect(slow.releases).toEqual([]);

    // ixigo's Login or its mobile box not found (Bash's time ran out at that tap, with the check caught): the taps are a
    // convenience, the page in front is not. It stays theirs, the card as it was, no error, nothing closed.
    const missed = world({ opened: 403 });
    await missed.setup();
    await missed.tap('ixigo_login', 'p_rahul');
    expect(await missed.state()).toBe('logging_in');
    expect(missed.releases).toEqual([]);
    expect(missed.last()).toMatchObject({
      title: 'Logging in to ixigo', tone: 'info', body: "ixigo's log in is open on Go's screen. Rahul: tap Watch, log in with your phone, then tap I'm logged in.",
    });

    const refused = world({ opened: 'refused' });
    await refused.setup();
    await refused.tap('ixigo_login', 'p_rahul');
    expect(await refused.state()).toBe('asked');
    // Nothing left open on the trip's screen, and no second path: the card says try again.
    expect(refused.releases).toEqual([LOGIN_TAB]);
    expect(refused.timers.every((t) => t.cancelled)).toBe(true);
    expect(refused.last()).toMatchObject({
      title: 'Link ixigo for this trip',
      body: "Go couldn't open ixigo's log in on its screen just now. Tap Log in to ixigo to try again.",
      actions: [{ action_id: 'ixigo_login' }, { action_id: 'ixigo_not_now' }],
    });
  });

  it('Not now closes the log in on Go\'s screen; a login started as a job before stops it too, and its hand-off is never answered', async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.tap('ixigo_not_now', 'p_rahul')).toEqual({ result: 'done', toast: 'Go will ask again when a booking needs it' });
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.stops).toEqual([]);
    expect(await w.state()).toBe('skipped');
    expect(w.last()).toMatchObject({ title: 'ixigo login skipped', actions: [{ action_id: 'ixigo_login' }] });

    const old = world();
    await old.setup();
    await old.tap('ixigo_login', 'p_rahul');
    await db.pool.query("update ixigo_logins set task_id = 'gt_login_old' where trip_id = $1", [old.tripId]);
    await old.tap('ixigo_not_now', 'p_rahul');
    expect(old.stops).toEqual(['gt_login_old']);
    expect(old.handoffs).toEqual([]);
  });

  it(`a hand-off that runs its ${HANDOFF_MS / 60_000} minutes closes the log in, and the card goes back to its ask, saying so`, async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(w.timers.map((t) => t.ms)).toEqual([HANDOFF_MS]);
    w.timers[0]!.fn();
    await w.login.settled();
    expect(await w.state()).toBe('asked');
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.last()).toMatchObject({
      title: 'Link ixigo for this trip', body: "ixigo's log in closed on Go's screen after 10 minutes. Tap Log in to ixigo to open it again.",
    });
    // A login that ended sooner cancels its end: logged in here.
    const done = world({ statuses: [200] });
    await done.setup();
    await done.tap('ixigo_login', 'p_rahul');
    await done.tap('ixigo_logged_in', 'p_rahul');
    expect(done.timers.map((t) => t.cancelled)).toEqual([true]);
  });

  it('the person leaving the trip while the log in is open closes it first', async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.login.personGone(w.tripId, 'p_rahul', 'left');
    await w.login.settled();
    expect(w.releases[0]).toBe(LOGIN_TAB);
  });

  it("I'm logged in: ixigo's own answer decides by its status alone; 401 keeps the log in in front, 200 closes it and says logged in as Rahul", async () => {
    const w = world({ statuses: [401, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');

    const reads = w.reads.length;
    expect(await w.tap('ixigo_logged_in', 'p_rahul')).toEqual({ result: 'done', toast: 'Checking your login' });
    // No job to settle.
    expect(w.handoffs).toEqual([]);
    // ixigo's userinfo from INSIDE the open log in page, keeping it open for them: nothing opens over it, and the status is
    // read (one byte), the account never is.
    expect(w.tabCalls).toEqual([{ tab: LOGIN_TAB, call: { url: USERINFO, method: 'POST' }, keepOpenMs: HANDOFF_MS }]);
    expect(w.reads).toHaveLength(reads);
    // An early tap, still waiting for the code: the window stays in front, untouched.
    expect(await w.state()).toBe('logging_in');
    expect(w.releases).toEqual([]);
    expect(w.last()).toMatchObject({ tone: 'heads_up', body: 'Not logged in yet. Finish on Watch, then tap again.' });

    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.last()).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'ixigo: logged in as Rahul',
      body: "Since 8 Oct. Searches and bookings for this trip use Rahul's ixigo account; the group never sees its details, and Go never opens the payment page.",
      actions: [{ action_id: 'ixigo_logout', label: 'Log out', only_for_person_ids: ['p_rahul'] }],
    });
  });
});

describe('a recipe that needs the login', () => {
  it('after Not now, asks the same person again with a fresh card, at most once in half an hour, and gives the model its line', async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_not_now', 'p_rahul')).toEqual({ result: 'done', toast: 'Go will ask again when a booking needs it' });
    expect(w.last()).toMatchObject({ title: 'ixigo login skipped', actions: [{ action_id: 'ixigo_login' }] });
    expect(await w.state()).toBe('skipped');

    const no = await w.login.ensure(w.tripId, 'Price lock');
    expect(no).toEqual({ ok: false, note: "Price lock needs the trip's ixigo login. Go asked Rahul to log in on the card: say so in one line, and never ask for a number or a code in the chat." });
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ text: "Rahul, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.", card: { card_id: `c_login_${w.tripId}_1` } });
    await w.login.ensure(w.tripId, 'Price lock');
    expect(w.link.of('post_message')).toHaveLength(2);
    w.clock.now = new Date(NOW.getTime() + 31 * 60_000);
    await w.login.ensure(w.tripId, 'Price lock');
    expect(w.link.of('post_message')).toHaveLength(3);
  });

  it("a login stands for six hours; then ixigo is asked again, and one it no longer has is asked for again", async () => {
    const w = world({ statuses: [200, 200, 'timeout', 401] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    const reads = w.reads.length;
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(w.reads).toHaveLength(reads);

    w.clock.now = new Date(NOW.getTime() + RECHECK_MS + 60_000);
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(w.reads).toHaveLength(reads + 1);
    w.clock.now = new Date(w.clock.now.getTime() + RECHECK_MS + 60_000);
    // ixigo didn't say: the login Go saw stands.
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    // ixigo says it's gone: Rahul is asked again.
    const gone = await w.login.ensure(w.tripId, 'Price lock');
    expect(gone.ok).toBe(false);
    expect(w.link.of('post_message').at(-1)).toMatchObject({ text: "Rahul, this needs ixigo linked for the trip: one login on the trip's computer, about a minute." });
    expect(await w.state()).toBe('asked');
  });

  it('the engine runs a recipe with auth: login only on a logged-in trip computer, and otherwise refuses it with the line', async () => {
    const file = readFileSync(`${BOOK_DIR}plan/destination.yaml`, 'utf8').replace('auth: none', 'auth: login');
    const checked = checkRecipe('plan/destination.yaml', file);
    if (!('recipe' in checked)) throw new Error(checked.problems.join('\n'));
    const { book } = loadBook();
    const locked: Book = { get: (id) => (id === 'plan.destination' ? checked.recipe : book.get(id)), all: () => book.all() };
    const opened: string[] = [];
    const runner = { read: async (_t: string, url: string) => { opened.push(url); return { captures: [], finalUrl: url }; } };
    let ok = false;
    const engine = createEngine({
      book: locked, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => NOW,
      login: async (_tripId, what) => (ok ? { ok: true } : { ok: false, note: `${what} needs the trip's ixigo login.` }),
    });
    await expect(engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_goa' })).rejects.toThrow(/needs the trip's ixigo login/);
    expect(opened).toEqual([]);
    ok = true;
    await engine.answer('plan.destination', { place: 'Goa' }, { tripId: 't_goa' }).catch(() => undefined);
    expect(opened).toEqual(['https://www.ixigo.com/plan/goa']);
  });
});

describe('logging out', () => {
  async function loggedIn(statuses: Array<number | 'timeout'>) {
    const w = world({ statuses: [200, ...statuses] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    return w;
  }

  it("Log out works ixigo's own menu, and the card says so once ixigo agrees", async () => {
    const w = await loggedIn([401]);
    expect(await w.tap('ixigo_logout', 'p_priya')).toMatchObject({ result: 'refused' });
    expect(await w.tap('ixigo_logout', 'p_rahul')).toEqual({ result: 'done', toast: 'Logging out of ixigo' });
    expect(w.reads.at(-2)).toEqual({
      url: 'https://www.ixigo.com/',
      plan: { capture: [], steps: [{ op: 'click', text: 'Hey' }, { op: 'click', role: 'link', name: 'Log out' }], timeoutMs: 15_000 },
    });
    expect(w.reads.at(-1)).toEqual({ url: 'https://www.ixigo.com/', plan: STATUS_PLAN });
    expect(await w.state()).toBe('logged_out');
    expect(w.last()).toMatchObject({ title: 'Logged out of ixigo', body: "Go's computer is no longer logged in to ixigo as Rahul.", actions: [] });
  });

  it('a log out ixigo did not take keeps the login and says so; the person leaving the trip logs it out too', async () => {
    const stuck = await loggedIn([200]);
    await stuck.tap('ixigo_logout', 'p_rahul');
    expect(await stuck.state()).toBe('logged_in');
    expect(stuck.last()).toMatchObject({ title: 'ixigo: logged in as Rahul', body: "Go couldn't log out just now. Tap Log out to try again, or log out on Go's screen." });

    const left = await loggedIn([401]);
    await left.login.onEvent({ event_id: 'e_left', trip_id: left.tripId, seq: 300, occurred_at: NOW.toISOString(), type: 'person.left', data: { person_id: 'p_rahul' } } as C.Event);
    await left.login.settled();
    expect(await left.state()).toBe('logged_out');
    expect(left.last()).toMatchObject({ title: 'Logged out of ixigo', body: 'Rahul left the trip, so Go logged out of ixigo on its computer.' });
    // "Forget me" in the trip, from the memory lane, logs out the same way.
    const forgot = await loggedIn([401]);
    await forgot.login.personGone(forgot.tripId, 'p_rahul', 'forgot');
    await forgot.login.settled();
    expect(forgot.last()).toMatchObject({ title: 'Logged out of ixigo', body: 'Rahul used Forget me in this trip, so Go logged out of ixigo on its computer.' });
    // Someone else leaving changes nothing.
    const other = await loggedIn([]);
    await other.login.onEvent({ event_id: 'e_left', trip_id: other.tripId, seq: 300, occurred_at: NOW.toISOString(), type: 'person.left', data: { person_id: 'p_priya' } } as C.Event);
    await other.login.settled();
    expect(await other.state()).toBe('logged_in');
  });

  it('after Forget me, the next login is asked of someone else: the organizer, or the next member when it was the organizer', async () => {
    const w = await loggedIn([401]);
    // Rahul, the organizer, used Forget me in the trip: the memory lane marks it, then lets his login go.
    await db.pool.query('insert into forgotten (person_id, trip_id, up_to_seq, forgotten_at) values ($1, $2, $3, $4)', ['p_rahul', w.tripId, 300, NOW]);
    await w.login.personGone(w.tripId, 'p_rahul', 'forgot');
    await w.login.settled();
    expect(await w.state()).toBe('logged_out');
    expect(await w.login.ensure(w.tripId, 'The train booking')).toMatchObject({ ok: false, note: expect.stringContaining('Go asked Priya to log in') });
    const asked = w.link.of('post_message').at(-1)!;
    expect(asked).toMatchObject({ mentions: ['p_priya'], card: { for_person_ids: ['p_priya'] } });
    expect(JSON.stringify(asked)).not.toContain('p_rahul');
  });

  it('when the person only asked (not logged in yet) uses Forget me, the next one is asked at once, not half an hour later', async () => {
    const w = world();
    await w.setup();
    expect(await w.state()).toBe('asked');
    await db.pool.query('insert into forgotten (person_id, trip_id, up_to_seq, forgotten_at) values ($1, $2, $3, $4)', ['p_rahul', w.tripId, 300, NOW]);
    await w.login.personGone(w.tripId, 'p_rahul', 'forgot');
    await w.login.settled();
    const before = w.link.of('post_message').length;
    expect(await w.login.ensure(w.tripId, 'The train booking')).toMatchObject({ ok: false, note: expect.stringContaining('Go asked Priya to log in') });
    // A new card, pinned to Priya, posted now: the line the model gets is true.
    expect(w.link.of('post_message').slice(before)).toEqual([expect.objectContaining({ mentions: ['p_priya'], card: expect.objectContaining({ for_person_ids: ['p_priya'] }) })]);
  });
});

describe('a booking ask on a trip with no login (8 Oct demo: "heyy can you try booking Saudades now" got a link)', () => {
  const what = 'Saudades Homestays';
  const resume = { decision_id: 'd_villa', choice_index: 0, payer_person_id: 'p_rahul', refundable_only: false };

  it('brings the login card back with its own line, waits on the login, and carries on with exactly that stay once it is in', async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume } })).toEqual({
      ok: false,
      note: 'Go asked Rahul in the chat, with the login card, and carries on with booking Saudades Homestays once the login is in. Say nothing more about it.',
    });
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      text: "To book Saudades Homestays I need ixigo linked once, Rahul: one login on the trip's computer, about a minute.",
      mentions: ['p_rahul'],
      card: { card_id: `c_login_${w.tripId}_1`, actions: [{ action_id: 'ixigo_login' }, { action_id: 'ixigo_not_now' }] },
    });
    expect(await w.parked()).toEqual({ what, resume });
    expect(w.wakes).toEqual([]);

    // Rahul logs in on Go's screen; ixigo then says the browser is logged in.
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.wakes).toEqual([
      expect.objectContaining({
        id: `travel:login_resume:${w.tripId}:1`, tripId: w.tripId, kind: 'tap',
        payload: { source: 'ixigo_login', action: 'resume', personId: 'p_rahul', what, resume },
      }),
    ]);
    expect(await w.parked()).toBeNull();
    expect(renderLoginResume(w.wakes[0]!, goaPack({ trip: w.trip }))).toBe(
      'Rahul logged in to ixigo on Go\'s computer, so carry on with what the group asked for, without asking anyone again: booking Saudades Homestays. ' +
        'Call set_mandate now with {"decision_id":"d_villa","choice_index":0,"payer_person_id":"p_rahul","refundable_only":false}, then say in one short line what was set and that the payer taps Yes, book it.',
    );
    // Other taps are not this wake's to say.
    expect(renderLoginResume({ ...w.wakes[0]!, payload: { source: 'options', action: 'pick' } }, goaPack({ trip: w.trip }))).toBeNull();
  });

  it('asks once for a turn that runs again, and Not now lets the waiting booking go with the login', async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    await w.login.ensure(w.tripId, what, { park: { what, resume } });
    const again = await w.login.ensure(w.tripId, what, { park: { what, resume } });
    expect(again).toMatchObject({ ok: false, note: expect.stringContaining("Rahul's login card is just above, and Go carries on once the login is in") });
    expect(w.link.of('post_message')).toHaveLength(2);

    await w.tap('ixigo_not_now', 'p_rahul');
    expect(await w.parked()).toBeNull();
    // Logged in later, from another ask: nothing was waiting, so nothing carries on.
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.wakes).toEqual([]);
  });

  it('with the login already in, is ok at once and parks nothing', async () => {
    const w = world({ statuses: [200, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume } })).toEqual({ ok: true });
    expect(await w.parked()).toBeNull();
    expect(w.wakes).toEqual([]);
  });
});
