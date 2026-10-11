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
import {
  cardIsTheAsk, createIxigoLogin, HANDOFF_MS, HANDOFF_PAGE_MS, HELLO_WAIT_MS, IDENTITY, ixigoLoginTool, LOGIN_CALLS, LOGIN_POLL_FAST_FOR_MS, LOGIN_POLL_MS, LOGIN_POLL_SLOW_MS, LOGIN_TAB, LOGIN_URL, loginFrom, RECHECK_MS, renderLoginResume,
  SELF_CHECK_MS, USERINFO, WALLET,
} from '../login.js';
import { TravelError } from '../mcp-travel.js';
import { capture } from '../recipes/__tests__/fixtures.js';
import { ChallengedError } from '../recipes/runners.js';
import type { BrowserLogin } from '../../tasks/browsers.js';
import { IXIGO, type Capture, type FetchPlan } from '../recipes/recipe.js';

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
/** opened: how ixigo's page loads in the hand-off (load: 200 logged in, 403 its login gone, by default), 'timeout' for
 *  a page that caught nothing in its time, 'refused' for a hand-off Bash would not open, 'challenged' for one that stayed
 *  on Cloudflare's check through the runner's tries. statuses: how it loads after, in turn: for "I'm logged in" (its page
 *  loaded again) and for a check in the background. */
function world(o: {
  /** A Bash that predates desktop hand-offs (front_device): its hand-off opens the phone page however asked. */
  phoneOnly?: boolean;
  /** The Server refusing a call of Go's (fakeLink's fail): the old login card's replace, say. */
  linkFail?: (method: string) => Error | null;
  live?: boolean; greeted?: boolean; paused?: string[]; statuses?: Array<number | 'timeout' | 'challenged' | 'dead' | 'quiet'>; opened?: number | 'timeout' | 'refused' | 'challenged'; taps?: 'fail';
  /** The person's browser (tasks/browsers.ts), shared by every world given the same one: one login for all their trips. */
  browser?: FakeBrowser;
  /**
   * A Bash that reads the browser's cookies (a one-tap login): what its n-th read answers (0 is the one at the tap), and
   * null for a read Bash couldn't answer. Without it the runner has no cookie read, as a Bash from before it.
   */
  cookies?: (n: number) => Array<{ name: string; expiresAt: number | null }> | null;
} = {}) {
  trips += 1;
  const tripId = `t_login_${trips}`;
  const clock = { now: NOW };
  const link = fakeLink(o.linkFail ? { fail: o.linkFail } : {});
  const base = goaTrip({ trip_id: tripId });
  const trip = goaTrip({ trip_id: tripId, people: base.people.map((p) => ({ ...p, go_paused: o.paused?.includes(p.person_id) ?? false })) });
  const hello = msg({ by: 'go', text: 'Hey all, I am Go.' });
  const packs = fakePacks(goaPack({ trip, messages: o.greeted === false ? [] : [hello] }));
  const greet = (): void => packs.set(goaPack({ trip, messages: [hello] }));
  const looks: number[] = [];
  const hooks: { onSleep?: (n: number) => void; onHandOff?: () => void | Promise<void> } = {};
  const statuses = [...(o.statuses ?? [])];
  /** An "I'm logged in" tap is being answered. */
  let checking = false;
  const reads: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      reads.push({ url, plan });
      if (plan !== LOGIN_CALLS) return { captures: [], finalUrl: url };
      const s = statuses.shift() ?? 'timeout';
      if (s === 'timeout') throw new TravelError('unreachable', 'ixigo took too long to answer.');
      if (s === 'challenged') throw new ChallengedError();
      return { captures: load(s), finalUrl: url };
    },
    handOff: async (_trip: string, url: string, plan: FetchPlan, ho: { keepOpenMs: number; tab: string; device?: 'desktop' }) => {
      handOffs.push({ url, plan, o: ho });
      await hooks.onHandOff?.();
      // "I'm logged in" loads the log in page again: ixigo's answers to it come in turn, as for any later check.
      const s = checking ? (statuses.shift() ?? 'timeout') : (o.opened ?? 403);
      if (s === 'refused') throw new TravelError('refused', 'Bash would not open the page.');
      if (s === 'challenged') return { captures: [], challenged: true as const };
      const device = ho.device === 'desktop' && !o.phoneOnly ? ('desktop' as const) : ('phone' as const);
      return { captures: s === 'timeout' ? [] : load(s), device };
    },
    release: async (_trip: string, tab: string) => {
      releases.push(tab);
    },
    // The taps on the page once it is in front: what the card says then is kept, to see it said so first.
    tabSteps: async (_trip: string, tab: string, steps: unknown[], to: { keepOpenMs: number; timeoutMs: number }) => {
      tabStepCalls.push({ tab, steps, o: to, cardActions: cardActions() });
      if (o.taps === 'fail') throw new TravelError('unreachable', 'ixigo took too long to answer.');
    },
    ...(o.cookies ? { cookies: async (_trip: string, domain: string, names: string[]) => {
      cookieReads.push({ domain, names, at: clock.now.getTime() });
      return o.cookies!(cookieReads.length - 1);
    } } : {}),
  };
  const cookieReads: Array<{ domain: string; names: string[]; at: number }> = [];
  const ended: string[] = [];
  const tabStepCalls: Array<{ tab: string; steps: unknown[]; o: { keepOpenMs: number; timeoutMs: number }; cardActions: string[] }> = [];
  const cardActions = (): string[] => {
    const replaced = link.of('replace_card');
    return ((replaced.at(-1)?.card as { actions?: Array<{ action_id: string }> } | undefined)?.actions ?? []).map((a) => a.action_id);
  };
  const handOffs: Array<{ url: string; plan: FetchPlan; o: { keepOpenMs: number; tab: string } }> = [];
  const releases: string[] = [];
  const sessions: Array<[string, string]> = [];
  /** Who each session asked to drive first (driver), by session. */
  const drivers: Array<string | undefined> = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const screen = async (trip: string, mode: 'view' | 'control', so?: { driver?: 'user' }) => {
    sessions.push([trip, mode]);
    drivers.push(so?.driver);
    return { id: `ses_${sessions.length}`, url: `https://screen.example/${mode}`, expires_at: '2026-10-08T06:15:00.000Z' };
  };
  const endScreen = async (id: string) => {
    ended.push(id);
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
  const said: object[] = [];
  const deps: Parameters<typeof createIxigoLogin>[0] = {
    pool: db.pool, link, packs, runner: () => runner, tasks: () => tasks, screen: () => screen, endScreen: () => endScreen, desk, live: () => o.live !== false, now: () => clock.now,
    ...(o.browser ? { browser: () => o.browser! } : {}),
    log: { warn: () => undefined, info: (obj) => said.push(obj) },
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
  };
  const handlers = new Map<string, (tap: CardTapParams, card: C.Card) => Promise<CardTapResult>>();
  const wire = (l: ReturnType<typeof createIxigoLogin>) => {
    l.registerTaps({ on: (kind, action, h) => handlers.set(`${kind}:${action}`, h) });
    return l;
  };
  let login = wire(createIxigoLogin(deps));
  /** Go restarted: a fresh login on the same database and Bash, remembering nothing; the taps are its now. */
  const restart = () => (login = wire(createIxigoLogin(deps)));
  let tapN = 0;
  /** A tap that is not waited on (one made while a background wait is running): its work joins settled(). */
  const fire = (action: string, personId: string): Promise<CardTapResult> => {
    tapN += 1;
    return handlers.get(`notice:${action}`)!({ tap_id: `tap_${tapN}`, trip_id: tripId, card_id: 'c_login', action_id: action, person_id: personId }, {} as C.Card);
  };
  const tap = async (action: string, personId: string): Promise<CardTapResult> => {
    checking = action === 'ixigo_logged_in';
    try {
      const out = await fire(action, personId);
      await login.settled();
      return out;
    } finally {
      checking = false;
    }
  };
  const cards = (): C.Card[] => [...link.of('post_message').flatMap((p) => (p.card ? [p.card as C.Card] : [])), ...link.of('replace_card').map((p) => p.card as C.Card)];
  const last = (): C.Card & { kind: 'notice' } => cards().at(-1) as C.Card & { kind: 'notice' };
  const state = async (): Promise<string | undefined> =>
    (await db.pool.query<{ state: string }>('select state from ixigo_logins where trip_id = $1', [tripId])).rows[0]?.state;
  const parked = async (): Promise<unknown> =>
    (await db.pool.query<{ parked: unknown }>('select parked from ixigo_logins where trip_id = $1', [tripId])).rows[0]?.parked ?? null;
  return {
    tripId, trip, clock, link, reads, statuses, starts, handoffs, stops, handOffs, releases, sessions, drivers, ended, cookieReads, timers, tabStepCalls, wakes, tap, fire, restart, last, cards,
    state, parked, greet, looks, hooks, said, setup: () => login.setupStep.run(tripId),
    get login() {
      return login;
    },
  };
}

/** A person's browser as tasks/browsers.ts keeps it: where its ixigo login stands, and every time ixigo said so. */
type FakeBrowser = ReturnType<typeof fakeBrowser>;
function fakeBrowser(state: BrowserLogin | null = null) {
  const b = {
    state,
    sets: [] as Array<{ tripId: string; login: 'in' | 'out' }>,
    login: async (_tripId: string): Promise<BrowserLogin | null> => b.state,
    setLogin: async (tripId: string, login: 'in' | 'out'): Promise<void> => {
      b.sets.push({ tripId, login });
      const loggedInAt = login === 'in' && b.state?.login !== 'in' ? NOW : (b.state?.loggedInAt ?? null);
      b.state = { login, at: NOW, loggedInAt };
    },
  };
  return b;
}
const greetWake: DeskItem = { id: 'setup:greet', tripId: 't', kind: 'setup', ref: 'greet', dueAt: NOW, payload: {} };

/**
 * ixigo's page as it loads, by the calls Go keeps (staging, 9 Oct): logged in (200), its wallet and with-identity calls
 * answer 200 and it never calls userinfo (08:40); a login it holds that is gone (401, 403), its userinfo call is refused.
 */
const call = (match: string, status: number): Capture => capture(match, `${IXIGO}${match}`, '{', status);
function load(s: number | 'dead' | 'quiet'): Capture[] {
  // dead: a token ixigo refuses (the morning box, 9 Oct 17:43): its wallet and with-identity calls both 401.
  if (s === 'dead') return [call(WALLET, 401), call(IDENTITY, 401)];
  // quiet: the page booted (its content came) and made none of the login's calls (staging, 10 Oct 05:54: logged out).
  if (s === 'quiet') return [call('/action/content', 200)];
  return s === 200 ? [call(WALLET, 200), call(IDENTITY, 200)] : [call(USERINFO, s)];
}

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
      text: "@Rahul, link ixigo for the trip: one login on the trip's computer, about a minute.",
      mentions: ['p_rahul'],
    });
    expect(post!['card']).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, kind: 'notice', for_person_ids: ['p_rahul'], title: 'Link ixigo for this trip',
      actions: [
        { action_id: 'ixigo_login', label: 'Log in to ixigo', style: 'primary', only_for_person_ids: ['p_rahul'] },
        { action_id: 'ixigo_not_now', label: 'Not now', style: 'secondary', only_for_person_ids: ['p_rahul'] },
      ],
    });
    expect((post!['card'] as { body: string }).body).toContain('with their mobile number and its code; Go never sees either');
    // Mobile number and its code only: no other way in is named (a Google sign-in popup was cut off on Go's screen, 8 Oct).
    expect((post!['card'] as { body: string }).body).not.toMatch(/google/i);
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
    expect(w.link.of('post_message')[0]).toMatchObject({ text: "@Priya, link ixigo for the trip: one login on the trip's computer, about a minute.", mentions: ['p_priya'] });
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
    expect(w.link.of('post_message')[0]).toMatchObject({ text: "@Rahul, link ixigo for the trip: one login on the trip's computer, about a minute.", card: { card_id: `c_login_${w.tripId}_0` } });
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
  it("only the person asked can tap; Log in opens Go's screen at once and ixigo's log in box in front of their window there, with no job and no model", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_login', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(w.handOffs).toEqual([]);
    expect(w.sessions).toEqual([]);

    // Keshav, 10 Oct: "Login button appears, click login, open the browser immediately": the tap answers with Go's
    // screen, in control, for Rahul alone.
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(w.sessions).toEqual([[w.tripId, 'control']]);
    // No job: no model clicks its way to the box (87 to 96 s on staging, 8 Oct).
    expect(w.starts).toEqual([]);
    // ixigo's home page in FRONT of Rahul's window (as a phone: Bash's front), the tab kept there for him for Bash's most;
    // the calls ixigo's own code makes as the page loads caught, one byte each, read by their status only. Only the page's
    // content (logged in or out) is waited for, Bash's one required capture, then up to 3 s for the login's own calls. Not
    // the nearby flights call: ixigo's home stopped making it (10 Oct), and every read timed out on it.
    expect(LOGIN_URL).toBe('https://www.ixigo.com/');
    expect(HANDOFF_MS).toBe(600_000);
    expect(LOGIN_CALLS).toEqual({
      capture: [
        { match: '/action/content', required: true, max_bytes: 1 },
        { match: '/api/v3/ixigo-money/wallet', required: false, max_bytes: 1 },
        { match: '/api/profile/secure/booking/with-identity', required: false, max_bytes: 1 },
        { match: '/api/v2/oauth/userinfo', required: false, max_bytes: 1 },
      ],
      steps: [],
      timeoutMs: HANDOFF_PAGE_MS,
      graceMs: 3_000,
    });
    // ixigo's DESKTOP page (10 Oct): a login made on its phone page is its phone client's, which its desktop pages refuse.
    // The person's screen shows its log in drawer alone (Bash's front_crop): a phone sees it at about 1:1 (the App team, 10 Oct).
    expect(w.handOffs).toEqual([{ url: LOGIN_URL, plan: LOGIN_CALLS, o: { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB, device: 'desktop', crop: { role: 'dialog' } } }]);
    // Then, the card saying the page is in front, ixigo's own Login and the cursor in its mobile number box, on the page he watches.
    expect(w.tabStepCalls).toEqual([{
      tab: LOGIN_TAB, steps: [{ op: 'click', role: 'button', name: 'Log in/Sign up' }, { op: 'click', role: 'textbox', text: 'mobile' }],
      o: { keepOpenMs: HANDOFF_MS, timeoutMs: HANDOFF_PAGE_MS, crop: { role: 'dialog' } }, cardActions: ['ixigo_login', 'ixigo_logged_in', 'ixigo_not_now'],
    }]);
    expect(await w.state()).toBe('logging_in');
    // At once, before the page: the card flips to logging in. Then, the page in front, it says so. One button opens Go's
    // screen, and opens it again: Log in to ixigo; no Watch in any state. This Bash can't show Go the login land, so I'm
    // logged in is there from the start.
    const flips = w.link.of('replace_card').map((p) => p.card as C.Card & { kind: 'notice' });
    const buttons = [
      { action_id: 'ixigo_login', label: 'Log in to ixigo', style: 'primary', only_for_person_ids: ['p_rahul'] },
      { action_id: 'ixigo_logged_in', label: "I'm logged in", only_for_person_ids: ['p_rahul'] },
      { action_id: 'ixigo_not_now', label: 'Not now', only_for_person_ids: ['p_rahul'] },
    ];
    expect(flips.at(-2)).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'Logging in to ixigo', for_person_ids: ['p_rahul'], body: "Opening ixigo's log in on Go's screen for Rahul.", actions: buttons,
    });
    expect(w.last()).toMatchObject({ card_id: `c_login_${w.tripId}_0`, title: 'Logging in to ixigo', body: "ixigo's log in is open on Go's screen. Rahul: log in there with your mobile number, then tap I'm logged in. Log in to ixigo opens it again.", actions: buttons });
    expect(w.cards().flatMap((c) => ((c as { actions?: Array<{ action_id: string }> }).actions ?? []).map((a) => a.action_id))).not.toContain('ixigo_watch');
    // Nobody else gets the screen: they would watch Rahul type his number. Their card says whose login it is, and nothing more.
    for (const a of w.last().actions) expect(a.only_for_person_ids).toEqual(['p_rahul']);
  });

  it("opens one page for a login however many times Log in is tapped while it opens (a double tap, 8 Oct): each tap opens Go's screen again", async () => {
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
    expect(await first).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(await second).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    // And with the page open, a third tap opens the screen again, and no second page.
    w.hooks.onHandOff = undefined;
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(w.handOffs).toHaveLength(1);
    expect(w.sessions).toHaveLength(3);
    expect(await w.state()).toBe('logging_in');
  });

  it('two taps at the same moment still open one page: the row changes in one step', async () => {
    const w = world();
    await w.setup();
    const answers = (await Promise.all([w.tap('ixigo_login', 'p_rahul'), w.tap('ixigo_login', 'p_rahul')])).map((r) => r.result);
    expect(answers).toEqual(['open', 'open']);
    expect(w.handOffs).toHaveLength(1);
  });

  it("takes a logging-in row back after Bash's most (its end never seen, as after a restart): Log in opens the page again", async () => {
    const w = world();
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    // The end timer never ran (Go restarted), and the 10 minutes are long past.
    w.clock.now = new Date(w.clock.now.getTime() + HANDOFF_MS + 1_000);
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
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
    // When the front fetch started, the card already said logging in.
    expect(atFetch).toEqual(['ixigo_login', 'ixigo_logged_in', 'ixigo_not_now']);
    expect(w.last().actions.map((a) => a.action_id)).toEqual(['ixigo_login', 'ixigo_logged_in', 'ixigo_not_now']);
  });

  it("Watch on a card from before opens Go's screen again for the person logging in only; anyone else's tap is refused and opens nothing", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_watch', 'p_rahul')).toEqual({ result: 'refused', toast: "ixigo's log in isn't open on Go's screen now" });
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.tap('ixigo_watch', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(await w.tap('ixigo_watch', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(await w.tap('ixigo_login', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(w.sessions).toEqual([[w.tripId, 'control'], [w.tripId, 'control']]);
  });

  it("needs no hand-off when ixigo's log in page says the browser is logged in already: the tab closes and the card says so", async () => {
    const w = world({ opened: 200 });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.last()).toMatchObject({ title: 'ixigo: logged in as Rahul' });
    // Nothing to tap on a page already logged in, and the screen opened at the tap closed with the tab.
    expect(w.tabStepCalls).toEqual([]);
  });

  it("keeps a log in page that ran out of time in front for them; one Go's computer would not open goes back to the ask, saying so", async () => {
    const slow = world({ opened: 'timeout' });
    await slow.setup();
    await slow.tap('ixigo_login', 'p_rahul');
    expect(await slow.state()).toBe('logging_in');
    expect(slow.releases).toEqual([]);

    // ixigo's Login or its mobile box not found (Bash's time ran out at that tap, with the check caught): the taps are a
    // convenience, the page in front is not. It stays theirs, the card as it was, no error, nothing closed.
    const missed = world({ opened: 403, taps: 'fail' });
    await missed.setup();
    await missed.tap('ixigo_login', 'p_rahul');
    expect(missed.tabStepCalls).toHaveLength(1);
    expect(await missed.state()).toBe('logging_in');
    expect(missed.releases).toEqual([]);
    expect(missed.last()).toMatchObject({
      title: 'Logging in to ixigo', tone: 'info', body: "ixigo's log in is open on Go's screen. Rahul: log in there with your mobile number, then tap I'm logged in. Log in to ixigo opens it again.",
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

  it("I'm logged in: ixigo's OWN answer decides, by its status alone; 401 keeps the log in in front, 200 closes it and says logged in as Rahul", async () => {
    const w = world({ statuses: [401, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');

    const reads = w.reads.length;
    expect(await w.tap('ixigo_logged_in', 'p_rahul')).toEqual({ result: 'done', toast: 'Checking your login' });
    // No job to settle.
    expect(w.handoffs).toEqual([]);
    // ixigo's log in page loads again in the hand-off's tab, in front and kept for them, and the calls ixigo's own code
    // makes (with its own token and keys) are what answer: a call of Go's own is 403 even logged in. Their status is read
    // (one byte), the account never is.
    expect(w.handOffs).toHaveLength(2);
    expect(w.handOffs[1]).toEqual({ url: LOGIN_URL, plan: LOGIN_CALLS, o: { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB, device: 'desktop', crop: { role: 'dialog' } } });
    expect(w.reads).toHaveLength(reads);
    // An early tap, still waiting for the code: the window stays in front, its log in box open again for them.
    expect(await w.state()).toBe('logging_in');
    expect(w.releases).toEqual([]);
    expect(w.tabStepCalls).toHaveLength(2);
    expect(w.tabStepCalls[1]).toMatchObject({ tab: LOGIN_TAB, steps: [{ op: 'click', role: 'button', name: 'Log in/Sign up' }, { op: 'click', role: 'textbox', text: 'mobile' }] });
    expect(w.last()).toMatchObject({ tone: 'heads_up', body: "Not logged in yet. Finish on Go's screen, then tap I'm logged in again." });

    // ixigo's own calls work (Keshav's Google log in, 9 Oct): logged in, the page closes.
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.tabStepCalls).toHaveLength(2);
    expect(w.last()).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'ixigo: logged in as Rahul',
      body: "Since 8 Oct. Searches and bookings for this trip use Rahul's ixigo account; the group never sees its details, and Go never opens the payment page.",
      actions: [{ action_id: 'ixigo_logout', label: 'Log out', only_for_person_ids: ['p_rahul'] }],
    });
  });
});

describe("ixigo's answer, from the calls its page makes as it loads (staging, 9 Oct)", () => {
  it("a logged-in load (08:40: wallet and with-identity 200, no userinfo call) reads in; a refused userinfo reads out; else unknown", () => {
    // Keshav's logged-in page, loaded again by "I'm logged in": Go waited for a userinfo call that never came, and said unknown.
    expect(loginFrom([call(WALLET, 200), call(IDENTITY, 200)])).toEqual({ login: 'in', call: WALLET, status: 200 });
    expect(loginFrom([call(IDENTITY, 200)])).toEqual({ login: 'in', call: IDENTITY, status: 200 });
    // A login the page holds that is gone.
    expect(loginFrom([call(USERINFO, 403)])).toEqual({ login: 'out', call: USERINFO, status: 403 });
    expect(loginFrom([call(USERINFO, 401)])).toEqual({ login: 'out', call: USERINFO, status: 401 });
    // A logged-out load (08:41, the new trip): none of them, only its nearby call, which Go does not keep.
    expect(loginFrom([])).toEqual({ login: 'unknown', call: null, status: null });
    // A token ixigo refuses (the morning box at 17:43, hours after its wallet said 200): its own calls 401 or 403, out.
    expect(loginFrom([call(WALLET, 401), call('/api/flights/locations/nearby', 200), call(IDENTITY, 401)])).toEqual({ login: 'out', call: WALLET, status: 401 });
    expect(loginFrom([call(IDENTITY, 403)])).toEqual({ login: 'out', call: IDENTITY, status: 403 });
    // Anything else is not ixigo saying either: a wallet call that failed some other way, or a userinfo call that worked.
    expect(loginFrom([call(WALLET, 500)]).login).toBe('unknown');
    // ixigo slowing our shared address down (429, 9 Oct) is never the login ending: unknown, and the login stands.
    expect(loginFrom([call(WALLET, 429), call(IDENTITY, 429)]).login).toBe('unknown');
    expect(loginFrom([call(USERINFO, 200)]).login).toBe('unknown');
    // A login's own call that worked says in, whatever userinfo said.
    expect(loginFrom([call(USERINFO, 403), call(WALLET, 200)]).login).toBe('in');
  });

  it("I'm logged in on the 08:40 page reads in, and the log says which call and its status, never what it answered", async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.said.at(-1)).toEqual({
      tripId: w.tripId, login: 'in', call: WALLET, status: 200, where: 'log in page',
      calls: ['/api/v3/ixigo-money/wallet 200', '/api/profile/secure/booking/with-identity 200'],
    });
    // The hand-off's first look, on a page with its login gone: out, by userinfo's 403.
    expect(w.said[0]).toMatchObject({ login: 'out', call: USERINFO, status: 403, where: 'hand-off' });
  });
});

describe("ixigo's page on Cloudflare's check (CLOUDFLARE, recipes/runners.ts)", () => {
  const CHECK_BODY = "ixigo asked Go's computer to wait a moment before its log in. Tap Log in to ixigo to try again in a minute.";
  /** The card ever said the page was in front for the person. */
  const everInFront = (w: ReturnType<typeof world>): boolean =>
    w.link.of('replace_card').some((p) => ((p.card as { body?: string }).body ?? '').startsWith("ixigo's log in is open"));

  it('a hand-off still on the check is never handed over: never said in front, no taps, the tab and the screen closed, and the card asks again, saying so', async () => {
    const w = world({ opened: 'challenged' });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(everInFront(w)).toBe(false);
    expect(w.ended).toEqual(['ses_1']);
    expect(w.tabStepCalls).toEqual([]);
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.timers.every((t) => t.cancelled)).toBe(true);
    expect(await w.state()).toBe('asked');
    expect(w.last()).toMatchObject({ title: 'Link ixigo for this trip', body: CHECK_BODY, actions: [{ action_id: 'ixigo_login' }, { action_id: 'ixigo_not_now' }] });
  });

  it("I'm logged in on the check reads neither in nor out: nothing tapped on it, the tab closed, and Log in asked again", async () => {
    const w = world({ statuses: ['challenged'] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(w.tabStepCalls).toHaveLength(1);
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(w.tabStepCalls).toHaveLength(1);
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(await w.state()).toBe('asked');
    expect(w.last()).toMatchObject({ body: CHECK_BODY });
    expect(w.said.at(-1)).toMatchObject({ login: 'unknown', why: 'challenge', where: 'log in page' });
  });

  it('a login Go saw stands through a check in the background, and a log out is never taken as done on one', async () => {
    const w = world({ statuses: [200, 'challenged', 'challenged', 'challenged'] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    w.clock.now = new Date(NOW.getTime() + RECHECK_MS + 60_000);
    expect(await w.login.status(w.tripId)).toBe('challenged');
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(await w.state()).toBe('logged_in');
    expect(w.link.of('post_message')).toHaveLength(1);
    await w.tap('ixigo_logout', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.last()).toMatchObject({ title: 'ixigo: logged in as Rahul', body: "Go couldn't log out just now. Tap Log out to try again, or log out on Go's screen." });
  });
});

describe('a login that lands with nothing waiting on it (Keshav, 9 Oct 14:52: "take off with the main task after login")', () => {
  const linked = (w: ReturnType<typeof world>) => w.wakes.filter((x) => (x.payload as { action?: string }).action === 'linked');

  it("I'm logged in reading in wakes Go once, to carry on with the trip, with its own line", async () => {
    const w = world({ statuses: [200, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(w.wakes).toEqual([]);
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.wakes).toEqual([
      expect.objectContaining({
        id: `travel:login_linked:${w.tripId}:0`, tripId: w.tripId, kind: 'tap', ref: `c_login_${w.tripId}_0`,
        payload: { source: 'ixigo_login', action: 'linked', personId: 'p_rahul' },
      }),
    ]);
    expect(renderLoginResume(w.wakes[0]!, goaPack({ trip: w.trip }))).toBe(
      "Rahul just linked ixigo on Go's computer, so carry on with the trip now, without asking anyone again: take the most useful next step for what the group has asked for " +
        '(such as searching stays or flights on ixigo for their place and dates) and post what you find. If where or when is still missing, ask only for that.',
    );
    // Never twice for one login: "I'm logged in" again, and a recipe's check of it six hours on, wake nothing more.
    await w.tap('ixigo_logged_in', 'p_rahul');
    w.clock.now = new Date(NOW.getTime() + RECHECK_MS + 60_000);
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(w.wakes).toHaveLength(1);
  });

  it("a computer that was logged in already when Log in was tapped carries on too, once", async () => {
    const w = world({ opened: 200 });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(linked(w)).toHaveLength(1);
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'done', toast: 'ixigo is already logged in' });
    expect(linked(w)).toHaveLength(1);
  });

  it("a recipe's own check that finds the login in wakes nothing: its turn is carrying on already", async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(await w.state()).toBe('logged_in');
    expect(w.wakes).toEqual([]);
  });
});

// p2's audit, 11 Oct: every new trip's hello said "Nishanth Gunupudi, first link ixigo once…".
describe('the login lines name the person by their first name', () => {
  it("the hello's line, and the ask with no hello, say the first name; the card keeps the whole name", async () => {
    const w = world({ statuses: [] });
    const trip = { ...w.trip, people: w.trip.people.map((p) => (p.person_id === 'p_rahul' ? { ...p, name: 'Rahul Varma' } : p)) };
    const hello = await w.login.helloCard({ tripId: w.tripId, wake: [greetWake], pack: goaPack({ trip }) });
    expect(hello?.line).toBe('@Rahul, link ixigo once with one tap and I can book for everyone.');
    expect(JSON.stringify(hello?.card)).toContain('Rahul Varma');
  });
});

describe("one login for all of a person's trips: their browser (tasks/browsers.ts; Keshav, 9 Oct: \"I dont want to login again and again\")", () => {
  it("a person whose browser is logged in already is not asked: Go's hello carries no login, and setup confirms it with one read", async () => {
    const b = fakeBrowser({ login: 'in', at: NOW, loggedInAt: new Date(NOW.getTime() - 3600_000) });
    const w = world({ browser: b, statuses: [200] });
    expect(await w.login.helloCard({ tripId: w.tripId, wake: [greetWake], pack: goaPack({ trip: w.trip }) })).toBeNull();
    expect(await w.state()).toBe('logged_in');
    await w.setup();
    // One read of ixigo's home page, and nothing said in the room: no ask, no card.
    expect(w.reads).toHaveLength(1);
    expect(w.reads[0]).toMatchObject({ url: 'https://www.ixigo.com/', plan: LOGIN_CALLS });
    expect(w.link.of('post_message')).toEqual([]);
    expect(w.link.of('replace_card')).toEqual([]);
    // A booking now is ok at once, with nothing read again.
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(w.reads).toHaveLength(1);
  });

  it("setup's read that finds the browser's login gone asks once, with its own card; a first search's nudge asks nothing on a logged-in browser", async () => {
    const b = fakeBrowser({ login: 'in', at: NOW, loggedInAt: NOW });
    const w = world({ browser: b, statuses: ['dead'] });
    expect(await w.login.helloCard({ tripId: w.tripId, wake: [greetWake], pack: goaPack({ trip: w.trip }) })).toBeNull();
    await w.setup();
    expect(b.state?.login).toBe('out');
    expect(await w.state()).toBe('asked');
    expect(w.link.of('post_message')).toEqual([
      expect.objectContaining({ text: "@Rahul, link ixigo for the trip: one login on the trip's computer, about a minute.", card: expect.objectContaining({ card_id: `c_login_${w.tripId}_1` }) }),
    ]);

    const n = world({ browser: fakeBrowser({ login: 'in', at: NOW, loggedInAt: NOW }) });
    n.login.nudge(n.tripId);
    await n.login.settled();
    expect(n.link.of('post_message')).toEqual([]);
    expect(await n.state()).toBe('logged_in');
  });

  it('a login on one trip is the login on every other trip of the same person: a booking there is ok at once, read nothing, ask nothing', async () => {
    const b = fakeBrowser();
    const one = world({ browser: b, statuses: [200] });
    await one.setup();
    await one.tap('ixigo_login', 'p_rahul');
    await one.tap('ixigo_logged_in', 'p_rahul');
    // ixigo's answer on the first trip is the browser's.
    expect(b.sets.map((x) => x.login)).toEqual(['out', 'in']);
    expect(b.state?.login).toBe('in');
    const two = world({ browser: b });
    expect(await two.login.helloCard({ tripId: two.tripId, wake: [greetWake], pack: goaPack({ trip: two.trip }) })).toBeNull();
    expect(await two.login.ensure(two.tripId, 'Price lock')).toEqual({ ok: true });
    expect(two.reads).toEqual([]);
    expect(two.link.of('post_message')).toEqual([]);
  });

  it('a trip that asked while its person logged in on another trip: the next booking is ok, and its card says logged in', async () => {
    const b = fakeBrowser();
    const w = world({ browser: b });
    await w.setup();
    expect(await w.state()).toBe('asked');
    b.state = { login: 'in', at: NOW, loggedInAt: NOW };
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    await w.login.settled();
    expect(await w.state()).toBe('logged_in');
    expect(w.last()).toMatchObject({ title: 'ixigo: logged in as Rahul' });
    expect(w.reads).toEqual([]);
  });

  it("a login the browser lost (the keep-alive found it gone) is asked for once at the trip's next travel talk, never into a quiet chat", async () => {
    const b = fakeBrowser();
    const w = world({ browser: b, statuses: [200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    const posts = w.link.of('post_message').length;
    // The keep-alive's read found the token refused; nobody in the trip has talked travel since: nothing posted.
    w.clock.now = new Date(NOW.getTime() + 60_000);
    b.state = { login: 'out', at: w.clock.now, loggedInAt: NOW };
    expect(w.link.of('post_message')).toHaveLength(posts);
    // Then someone asks for a search: the card, once, before any booking can fail.
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.of('post_message')).toHaveLength(posts + 1);
    expect(w.link.of('post_message').at(-1)).toMatchObject({
      text: "@Rahul, ixigo logged Go's computer out: one login brings it back, about a minute.", card: expect.objectContaining({ card_id: `c_login_${w.tripId}_1` }),
    });
    expect(await w.state()).toBe('asked');
    // More travel talk asks nothing more.
    w.login.nudge(w.tripId);
    await w.login.settled();
    expect(w.link.of('post_message')).toHaveLength(posts + 1);
  });

  it("a booking reads ixigo even with the browser said in: a token ixigo refuses flips the browser and asks once, never failing silently", async () => {
    const b = fakeBrowser({ login: 'in', at: NOW, loggedInAt: NOW });
    const w = world({ browser: b, statuses: ['dead'] });
    expect(await w.login.helloCard({ tripId: w.tripId, wake: [greetWake], pack: goaPack({ trip: w.trip }) })).toBeNull();
    // A search two minutes on stands on the browser's login with no read; a booking does not.
    w.clock.now = new Date(NOW.getTime() + 2 * 60_000);
    expect(await w.login.ensure(w.tripId, 'Price lock')).toEqual({ ok: true });
    expect(w.reads).toEqual([]);
    const what = 'Saudades Homestays';
    const first = await w.login.ensure(w.tripId, what, { park: { what, resume: { decision_id: 'd_villa' } }, booking: true });
    expect(w.reads).toHaveLength(1);
    expect(first.ok).toBe(false);
    expect(b.state?.login).toBe('out');
    expect(await w.state()).toBe('asked');
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ text: "To book Saudades Homestays I need ixigo linked once, @Rahul: one login on the trip's computer, about a minute." });
    // The same booking asked again a moment later: no second card, no second read.
    w.clock.now = new Date(w.clock.now.getTime() + 30_000);
    const again = await w.login.ensure(w.tripId, what, { park: { what, resume: { decision_id: 'd_villa' } }, booking: true });
    expect(again.ok).toBe(false);
    expect(w.link.of('post_message')).toHaveLength(1);
    expect(w.reads).toHaveLength(1);
  });

  // The lead, 11 Oct: Keshav booked on Saket's trip, and the login card went to Saket, the organizer. Anyone in the trip
  // can log in on the trip's computer: the person booking is asked, and an ask open for someone else moves to them.
  it("asks the person booking for the trip's ixigo login before the organizer, and moves the organizer's open ask to them", async () => {
    const w = world({});
    await w.setup();
    const whose = async () => (await db.pool.query<{ person_id: string }>('select person_id from ixigo_logins where trip_id = $1', [w.tripId])).rows[0]?.person_id;
    expect(await whose()).toBe('p_rahul');
    const before = w.link.of('post_message').length;
    const out = await w.login.ensure(w.tripId, 'Booking IndiGo 6E2150 for Meher', { booking: true, for: 'p_meher' });
    expect(out.ok).toBe(false);
    const posts = w.link.of('post_message').slice(before);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ card: { for_person_ids: ['p_meher'] } });
    expect(JSON.stringify(posts[0])).not.toContain('p_rahul');
    expect(await whose()).toBe('p_meher');
    expect(await w.state()).toBe('asked');
  });

  it("the browser's login gone since this trip checked ends this trip's login: the next booking asks again, reading nothing", async () => {
    const b = fakeBrowser();
    const w = world({ browser: b, statuses: [200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    const reads = w.reads.length;
    // The keep-alive (or another trip's check) found the token refused a minute later.
    w.clock.now = new Date(NOW.getTime() + 60_000);
    b.state = { login: 'out', at: w.clock.now, loggedInAt: NOW };
    const r = await w.login.ensure(w.tripId, 'Price lock');
    expect(r.ok).toBe(false);
    expect(await w.state()).toBe('asked');
    expect(w.link.of('post_message').at(-1)).toMatchObject({ text: "@Rahul, this needs ixigo linked for the trip: one login on the trip's computer, about a minute." });
    expect(w.reads).toHaveLength(reads);
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
    expect(no).toEqual({ ok: false, note: `Price lock needs the trip's ixigo login. ${cardIsTheAsk('Rahul', "I'll carry on")}` });
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ text: "@Rahul, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.", card: { card_id: `c_login_${w.tripId}_1` } });
    await w.login.ensure(w.tripId, 'Price lock');
    expect(w.link.of('post_message')).toHaveLength(2);
    w.clock.now = new Date(NOW.getTime() + 31 * 60_000);
    await w.login.ensure(w.tripId, 'Price lock');
    expect(w.link.of('post_message')).toHaveLength(3);
  });

  it("a login whose token ixigo refuses is let go: the card says so, and the next booking asks again", async () => {
    const w = world({ statuses: [200, 'dead'] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    // Its wallet and with-identity calls now 401: out, and the login Go held is gone.
    expect(await w.login.status(w.tripId)).toBe('out');
    expect(await w.state()).toBe('logged_out');
    await w.login.settled();
    expect(w.last()).toMatchObject({ title: 'Logged out of ixigo', body: "Go's computer is no longer logged in to ixigo as Rahul." });
    // A booking asks again at once, with a fresh card: no stale login stands in for it.
    const posts = w.link.of('post_message').length;
    expect((await w.login.ensure(w.tripId, 'Price lock')).ok).toBe(false);
    expect(w.link.of('post_message')).toHaveLength(posts + 1);
    expect(await w.state()).toBe('asked');
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
    expect(w.link.of('post_message').at(-1)).toMatchObject({ text: "@Rahul, this needs ixigo linked for the trip: one login on the trip's computer, about a minute." });
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
      // Bash takes no fetch without a required capture or a page_fetch step: the home page's content is it.
      plan: { capture: [{ match: '/action/content', required: true, max_bytes: 1 }], steps: [{ op: 'click', text: 'Hey' }, { op: 'click', role: 'link', name: 'Log out' }], timeoutMs: 15_000 },
    });
    expect(w.reads.at(-1)).toEqual({ url: 'https://www.ixigo.com/', plan: LOGIN_CALLS });
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
    expect(await w.login.ensure(w.tripId, 'The train booking')).toMatchObject({ ok: false, note: expect.stringContaining("Priya's login card is up in the chat with its own line: that is the ask.") });
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
    expect(await w.login.ensure(w.tripId, 'The train booking')).toMatchObject({ ok: false, note: expect.stringContaining("Priya's login card is up in the chat with its own line: that is the ask.") });
    // A new card, pinned to Priya, posted now: the line the model gets is true.
    expect(w.link.of('post_message').slice(before)).toEqual([expect.objectContaining({ mentions: ['p_priya'], card: expect.objectContaining({ for_person_ids: ['p_priya'] }) })]);
  });
});

describe('a booking ask on a trip with no login (8 Oct demo: "heyy can you try booking Saudades now" got a link)', () => {
  const what = 'Saudades Homestays';
  const resume = { decision_id: 'd_villa', choice_index: 0, payer_person_id: 'p_rahul', refundable_only: false };

  // p2's re-audit, 11 Oct: the same ask twice in two minutes. One card per trip while it is up: a booking parks on it.
  it('a booking while the ask is up parks on that card: no second card, and the reply says what comes once the login is in', async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume } })).toEqual({
      ok: false,
      note: `Booking Saudades Homestays waits on the trip's ixigo login, and Go carries on with it once the login is in. ${cardIsTheAsk('Rahul', "I'll re-check Saudades Homestays and book it")}`,
    });
    expect(w.link.of('post_message')).toHaveLength(1);
    expect(await w.parked()).toMatchObject({ what, resume });
  });

  // #478 (Keshav, 11 Oct): the login card goes to the person booking. One card per person while it is up: an ask open for
  // Rahul moves to Priya when she books, and her second booking parks on her card.
  it("an ask open for one person moves to the person booking, once: their next booking parks on their card", async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    expect(w.link.of('post_message')).toHaveLength(1);
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    expect((await w.login.ensure(w.tripId, what, { park: { what, resume }, booking: true, for: 'p_priya' })).ok).toBe(false);
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ mentions: ['p_priya'], card: { for_person_ids: ['p_priya'] } });
    w.clock.now = new Date(NOW.getTime() + 5 * 60_000);
    expect((await w.login.ensure(w.tripId, what, { park: { what, resume }, booking: true, for: 'p_priya' })).ok).toBe(false);
    expect(w.link.of('post_message')).toHaveLength(2);
    // The card that was Rahul's is not his to tap now.
    expect(await w.tap('ixigo_login', 'p_rahul')).toMatchObject({ result: 'refused' });
  });

  it('brings the login card back with its own line, waits on the login, and carries on with exactly that stay once it is in', async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    // Half an hour on: the first ask is far up the chat.
    w.clock.now = new Date(NOW.getTime() + 31 * 60_000);
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume } })).toEqual({
      ok: false,
      note: `Booking Saudades Homestays waits on the trip's ixigo login, and Go carries on with it once the login is in. ${cardIsTheAsk('Rahul', "I'll re-check Saudades Homestays and book it")}`,
    });
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      text: "To book Saudades Homestays I need ixigo linked once, @Rahul: one login on the trip's computer, about a minute.",
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

  // p2's re-run #24, 11 Oct: "book the villa we liked yesterday" put the login card up with its line asking Rahul, and Go's
  // reply asked him again ("Rahul, I need you to log in to ixigo first"). The card is the ask: the reply adds only what
  // comes once he's in.
  it("tells the reply the card is the ask: never a second login ask, only what comes once they're in, while they log in too", async () => {
    const next = cardIsTheAsk('Rahul', "I'll re-check Saudades Homestays and book it");
    expect(next).toContain('Never ask Rahul or anyone to log in again, and never point at the card.');
    expect(next).toContain(`"once Rahul's logged in, I'll re-check Saudades Homestays and book it"`);
    const w = world();
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    expect((await w.login.ensure(w.tripId, what, { park: { what, resume } })).ok).toBe(false);
    // Rahul is logging in on Go's screen: the booking asked again still never asks him again.
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logging_in');
    const before = w.link.of('post_message').length;
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume }, booking: true })).toEqual({
      ok: false, note: `Saudades Homestays needs the trip's ixigo login, and Rahul is logging in on Go's screen now. ${next}`,
    });
    // No new card or line for it.
    expect(w.link.of('post_message')).toHaveLength(before);
  });

  it('asks once for a turn that runs again, and Not now lets the waiting booking go with the login', async () => {
    const w = world({ statuses: [200] });
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 31 * 60_000);
    await w.login.ensure(w.tripId, what, { park: { what, resume } });
    const again = await w.login.ensure(w.tripId, what, { park: { what, resume } });
    expect(again).toMatchObject({ ok: false, note: expect.stringContaining(cardIsTheAsk('Rahul', "I'll re-check Saudades Homestays and book it")) });
    expect(w.link.of('post_message')).toHaveLength(2);

    await w.tap('ixigo_not_now', 'p_rahul');
    expect(await w.parked()).toBeNull();
    // Logged in later, from another ask: no booking was waiting, so none carries on; Go takes off with the trip instead.
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    expect(w.wakes.map((x) => (x.payload as { action: string }).action)).toEqual(['linked']);
  });

  it('with the login already in, is ok at once and parks nothing', async () => {
    const w = world({ statuses: [200, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    const linked = w.wakes.length;
    expect(await w.login.ensure(w.tripId, what, { park: { what, resume } })).toEqual({ ok: true });
    expect(await w.parked()).toBeNull();
    // No booking waits, and the login Go already had wakes nothing more.
    expect(w.wakes).toHaveLength(linked);
  });
});

// Keshav, 10 Oct: Meher wrote "I want to login again to Ixigo" with no @Go, and Go only reacted. Asked in the chat, Go
// puts the login card up at once, for whoever logs in for the trip, and says whose login it is.
describe('a login someone asks for in the chat', () => {
  it("puts the card up for the organizer at once, even inside the half hour, and tells someone else whose login it is", async () => {
    const w = world();
    await w.setup();
    expect(w.link.of('post_message')).toHaveLength(1);
    const r = await w.login.askNow(w.tripId, 'p_meher');
    expect(r).toEqual({
      posted: true,
      note: "Go put the login card up for Rahul, with its own line. The trip's ixigo login is on Rahul's browser, so it is Rahul's to do. Say nothing more about it, and never ask for a number or a code in the chat.",
    });
    const posts = w.link.of('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      text: "The trip's ixigo login is on Rahul's browser. @Rahul, tap Log in to ixigo on the card, about a minute on the trip's computer.",
      mentions: ['p_rahul'],
      card: { card_id: `c_login_${w.tripId}_1`, for_person_ids: ['p_rahul'] },
    });
    expect(await w.state()).toBe('asked');
    // The organizer asking: the line is theirs.
    await w.login.askNow(w.tripId, 'p_rahul');
    expect(w.link.of('post_message')[2]).toMatchObject({ text: "@Rahul, here's the ixigo login: tap Log in to ixigo on the card, about a minute on the trip's computer." });
  });

  it('reads ixigo first when Go holds a login: logged in, nothing goes up; logged out since, the card goes up', async () => {
    const inn = world({ statuses: [200, 200] });
    await inn.setup();
    await inn.tap('ixigo_login', 'p_rahul');
    await inn.tap('ixigo_logged_in', 'p_rahul');
    expect(await inn.state()).toBe('logged_in');
    const posts = inn.link.of('post_message').length;
    const r = await inn.login.askNow(inn.tripId, 'p_meher');
    expect(r.posted).toBe(false);
    expect(r.note).toContain("ixigo is logged in for the trip, on Rahul's browser: say so in one line. The trip's ixigo login is on Rahul's browser");
    expect(inn.link.of('post_message')).toHaveLength(posts);

    const out = world({ statuses: [200, 'dead'] });
    await out.setup();
    await out.tap('ixigo_login', 'p_rahul');
    await out.tap('ixigo_logged_in', 'p_rahul');
    const before = out.link.of('post_message').length;
    expect((await out.login.askNow(out.tripId, 'p_rahul')).posted).toBe(true);
    expect(out.link.of('post_message')).toHaveLength(before + 1);
  });

  it('puts nothing up while Go does not browse ixigo.com itself, and the tool ends the turn on a card it put up', async () => {
    const off = world({ live: false });
    expect(await off.login.askNow(off.tripId, 'p_meher')).toEqual({
      posted: false, note: "Go doesn't browse ixigo.com itself for this trip, so there is no ixigo login to make: say so in one line.",
    });
    const w = world();
    await w.setup();
    const asked: Array<string | null> = [];
    const tool = ixigoLoginTool({ askNow: async (tripId, askerId) => { asked.push(askerId); return w.login.askNow(tripId, askerId); } });
    const line = msg({ id: 'm_login', by: 'p_meher', text: 'I want to login again to Ixigo' });
    const ctx = { tripId: w.tripId, pack: goaPack({ trip: w.trip, messages: [line] }), wake: [{ id: 'msg:x', tripId: w.tripId, kind: 'message', ref: 'm_login', dueAt: NOW, payload: { messageId: 'm_login' } }] } as never as Parameters<typeof tool.run>[1];
    const out = await tool.run({}, ctx);
    expect(asked).toEqual(['p_meher']);
    expect(out).toMatchObject({ note: expect.stringContaining('Go put the login card up for Rahul') });
    expect(ctx.answered).toBe(true);
  });
});

// Staging, 10 Oct: his login ended within the hour and Go never heard: a logged-out page read "unknown", and nobody was
// asked. Now a quiet page counts once a second read agrees, and Go asks its person, once.
describe("ixigo's login, watched: when it ends, Go asks again", () => {
  /** A trip logged in on the person's browser, with these answers to ixigo's reads after the login's own. */
  async function linked(after: Array<number | 'quiet'>) {
    const browser = fakeBrowser();
    const w = world({ statuses: [200, ...after], browser });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    return { w, browser, posts: w.link.of('post_message').length };
  }

  it('reads a page that booted with none of the login calls as quiet: out, but only when a second read agrees', () => {
    expect(loginFrom([call('/action/content', 200)])).toEqual({ login: 'out', call: null, status: null, quiet: true });
    // A login call that came, whatever it said, is not quiet; a page that never booted says nothing.
    expect(loginFrom([call('/action/content', 200), call(WALLET, 500)]).login).toBe('unknown');
    expect(loginFrom([]).login).toBe('unknown');
  });

  it("asks nothing on the keep-alive's quiet read; its confirming read ends the login, and its person is asked once", async () => {
    const { w, browser, posts } = await linked(['quiet', 'quiet']);
    expect(await w.login.keepAlive(w.tripId)).toBe('quiet');
    // One quiet read flips nothing: the browser and the trip stand.
    expect(browser.state?.login).toBe('in');
    expect(await w.state()).toBe('logged_in');
    expect(await w.login.keepAlive(w.tripId, { confirming: true })).toBe('out');
    await w.login.settled();
    expect(browser.state?.login).toBe('out');
    expect(await w.state()).toBe('asked');
    const asked = w.link.of('post_message').slice(posts);
    expect(asked).toHaveLength(1);
    expect(String(asked[0]!.text)).toContain("ixigo logged Go's computer out");
  });

  // Staging, 10 Oct 08:13: the trip took its login from the person's browser, so it had no card; the old card's replace
  // failed ("card ... is not on one of Go's messages"). The ask must post all the same, with a fresh card.
  it('asks with a fresh card when the trip never had one (its login came from the browser), and when the old card\'s replace fails', async () => {
    for (const linkFail of [undefined, (m: string) => (m === 'replace_card' ? new Error('card c_login_t_0 is not on one of Go\'s messages in this trip') : null)]) {
      const browser = fakeBrowser({ login: 'in', at: NOW, loggedInAt: NOW });
      const w = world({ statuses: [200, 'quiet', 'quiet'], browser, ...(linkFail ? { linkFail } : {}) });
      // The trip starts logged in from the browser: no card of its own, its row confirmed at setup.
      await w.setup();
      expect(await w.state()).toBe('logged_in');
      const posts = w.link.of('post_message').length;
      expect(await w.login.keepAlive(w.tripId)).toBe('quiet');
      expect(await w.login.keepAlive(w.tripId, { confirming: true })).toBe('out');
      await w.login.settled();
      const asked = w.link.of('post_message').slice(posts);
      expect(asked).toHaveLength(1);
      expect(String(asked[0]!.text)).toContain("ixigo logged Go's computer out");
      expect((asked[0]!.card as { actions?: Array<{ action_id: string }> }).actions?.map((x) => x.action_id)).toContain('ixigo_login');
      expect(await w.state()).toBe('asked');
      expect(w.said).toContainEqual(expect.objectContaining({ tripId: w.tripId, attempt: 1 }));
    }
  });

  it('a quiet read that a second one finds in does nothing', async () => {
    const { w, browser, posts } = await linked(['quiet', 200]);
    expect(await w.login.keepAlive(w.tripId)).toBe('quiet');
    expect(await w.login.keepAlive(w.tripId, { confirming: true })).toBe('in');
    await w.login.settled();
    expect(browser.state?.login).toBe('in');
    expect(await w.state()).toBe('logged_in');
    expect(w.link.of('post_message').slice(posts)).toEqual([]);
  });
});

// Staging, 10 Oct: his login, made on ixigo's phone page in the hand-off (its client iximweb), was gone within the hour of
// Go reading ixigo's desktop pages (client ixiweb). The hand-off now logs in on the desktop page; an older Bash, the phone.
describe("the ixigo login's hand-off, on ixigo's desktop page", () => {
  it("asks for the desktop page and taps its Log in/Sign up; a Bash without it opens the phone page, and its Login is tapped", async () => {
    const desk = world({ statuses: [] });
    await desk.setup();
    await desk.tap('ixigo_login', 'p_rahul');
    expect(desk.handOffs[0]!.o).toMatchObject({ device: 'desktop', crop: { role: 'dialog' } });
    expect(desk.tabStepCalls[0]!.steps[0]).toEqual({ op: 'click', role: 'button', name: 'Log in/Sign up' });
    // The drawer its Log in/Sign up opens is what the person's screen shows.
    expect(desk.tabStepCalls[0]!.o).toMatchObject({ crop: { role: 'dialog' } });
    const phone = world({ statuses: [], phoneOnly: true });
    await phone.setup();
    await phone.tap('ixigo_login', 'p_rahul');
    expect(phone.tabStepCalls[0]!.steps[0]).toEqual({ op: 'click', role: 'button', name: 'Login' });
    // The phone page is a phone's already: its whole page shows.
    expect(phone.tabStepCalls[0]!.o).not.toHaveProperty('crop');
    // The mobile box is the same words on both pages.
    expect(desk.tabStepCalls[0]!.steps[1]).toEqual({ op: 'click', role: 'textbox', text: 'mobile' });
  });
});

// Keshav, 10 Oct: "why should user click watch button then login then click I logged in button… make a seamless login
// right at the beginning: one click, live stream opens, login there, Go detects, and when back proceeds automatically."
describe("one tap: Go's screen opens with the log in, and Go sees the login land by itself", () => {
  const AT = Date.parse('2026-11-07T06:00:00Z');
  const at = (expiresAt: number | null) => [{ name: 'at', expiresAt }];
  const ids = (c: C.Card | undefined): string[] => ((c as { actions?: Array<{ action_id: string }> } | undefined)?.actions ?? []).map((a) => a.action_id);

  it("opens Go's screen at once, in control; ixigo's `at` coming (a first login: none before) closes the tab and the screen, and Go carries on", async () => {
    const w = world({ cookies: (n) => (n < 3 ? [] : at(AT)), statuses: [200] });
    await w.setup();
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(w.sessions).toEqual([[w.tripId, 'control']]);
    // In their hands from the first frame: no Take control, no "Bash is driving" (Keshav, 11 Oct).
    expect(w.drivers).toEqual(['user']);
    // Read by name on ixigo's site, never a value: once at the tap, then every 2 s once the page is in front, until it came.
    expect(w.cookieReads.map((r) => [r.domain, r.names])).toEqual(Array(4).fill(['ixigo.com', ['at']]));
    expect(w.cookieReads.slice(1).map((r, i) => r.at - w.cookieReads[i]!.at)).toEqual([LOGIN_POLL_MS, LOGIN_POLL_MS, LOGIN_POLL_MS]);
    // The card while it opened, and once the page was in front: Log in to ixigo opens it again; no I'm logged in at any point.
    const replaced = w.link.of('replace_card').map((p) => p.card as C.Card);
    expect(ids(replaced[0])).toEqual(['ixigo_login', 'ixigo_not_now']);
    expect(replaced[0]).toMatchObject({ body: "Opening ixigo's log in on Go's screen for Rahul." });
    expect(ids(replaced[1])).toEqual(['ixigo_login', 'ixigo_not_now']);
    expect(replaced[1]).toMatchObject({ body: "ixigo's log in is open on Go's screen. Rahul: log in there with your mobile number, and Go carries on by itself. Log in to ixigo opens it again." });
    expect(w.cards().flatMap(ids)).not.toContain('ixigo_logged_in');
    // Logged in: the tab closed, the screen's session ended (Bash's page closes itself), and one read of ixigo confirmed it.
    expect(w.releases).toEqual([LOGIN_TAB]);
    expect(w.ended).toEqual(['ses_1']);
    expect(w.reads.filter((r) => r.plan === LOGIN_CALLS)).toHaveLength(1);
    expect(await w.state()).toBe('logged_in');
    expect(w.last()).toMatchObject({ title: 'ixigo: logged in as Rahul', actions: [{ action_id: 'ixigo_logout' }] });
    expect(w.wakes).toEqual([
      expect.objectContaining({ id: `travel:login_linked:${w.tripId}:0`, payload: { source: 'ixigo_login', action: 'linked', personId: 'p_rahul' } }),
    ]);
  });

  // Prod, 11 Oct 08:13Z: the trip's cards could not reach its Server, the opening card's failure stopped the hand-off, and
  // the person's screen stayed on a new tab with no log in on it.
  it("a card that can't go out never keeps ixigo's page or its taps from the screen the person is on", async () => {
    let down = false;
    const w = world({ cookies: (n) => (n < 2 ? [] : at(AT)), statuses: [200], linkFail: (m) => (down && m === 'replace_card' ? new Error('no socket from the Server is open') : null) });
    await w.setup();
    down = true;
    expect(await w.tap('ixigo_login', 'p_rahul')).toMatchObject({ result: 'open' });
    expect(w.handOffs).toHaveLength(1);
    expect(w.handOffs[0]!.o).toMatchObject({ device: 'desktop', tab: LOGIN_TAB, crop: { role: 'dialog' } });
    expect(w.tabStepCalls[0]!.steps[0]).toEqual({ op: 'click', role: 'button', name: 'Log in/Sign up' });
    expect(await w.state()).toBe('logged_in');
    expect(w.releases).toEqual([LOGIN_TAB]);
  });

  // 11 Oct: about 50 reads a minute from two waits, and the next Log in to ixigo found every Go key resting.
  it('reads every LOGIN_POLL_MS for LOGIN_POLL_FAST_FOR_MS from the tap, then every LOGIN_POLL_SLOW_MS', async () => {
    const w = world({ cookies: (n) => (n < 20 ? [] : at(AT)), statuses: [200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    const reads = w.cookieReads.map((r) => r.at);
    const gaps = reads.slice(1).map((t, i) => t - reads[i]!);
    gaps.forEach((g, i) => expect(g).toBe(reads[i]! - reads[0]! < LOGIN_POLL_FAST_FOR_MS ? LOGIN_POLL_MS : LOGIN_POLL_SLOW_MS));
    expect(gaps).toContain(LOGIN_POLL_SLOW_MS);
  });

  it('an `at` the browser had counts once its expiry moves or it went and came back; a read Bash could not answer compares nothing', async () => {
    // Its expiry moves on the third read.
    const moved = world({ cookies: (n) => (n < 2 ? at(AT) : at(AT + 3600_000)), statuses: [200] });
    await moved.setup();
    await moved.tap('ixigo_login', 'p_rahul');
    expect(moved.cookieReads).toHaveLength(3);
    expect(await moved.state()).toBe('logged_in');
    // ixigo's page cleared a stale one, then a login set it again.
    const back = world({ cookies: (n) => (n === 1 ? [] : at(AT)), statuses: [200] });
    await back.setup();
    await back.tap('ixigo_login', 'p_rahul');
    expect(back.cookieReads).toHaveLength(3);
    expect(await back.state()).toBe('logged_in');
    // Bash said nothing at the tap: the first read that answers is what the next is compared with.
    const blind = world({ cookies: (n) => (n === 0 ? null : n < 3 ? at(AT) : at(AT + 3600_000)), statuses: [200] });
    await blind.setup();
    await blind.tap('ixigo_login', 'p_rahul');
    expect(blind.cookieReads).toHaveLength(4);
    expect(await blind.state()).toBe('logged_in');
  });

  it('a booking that waited on the login carries on with exactly that stay once Go sees it land', async () => {
    const what = 'Saudades Homestays';
    const resume = { decision_id: 'd_villa', choice_index: 0, payer_person_id: 'p_rahul', refundable_only: false };
    const w = world({ cookies: (n) => (n < 2 ? [] : at(AT)), statuses: [200] });
    await w.setup();
    w.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    await w.login.ensure(w.tripId, what, { park: { what, resume } });
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
    // The booking parked on the ask that was up (attempt 0): no card of its own, and its wake is that ask's.
    expect(w.wakes).toEqual([
      expect.objectContaining({ id: `travel:login_resume:${w.tripId}:0`, payload: { source: 'ixigo_login', action: 'resume', personId: 'p_rahul', what, resume } }),
    ]);
    expect(w.ended).toEqual(['ses_1']);
  });

  it("a cookie ixigo then refuses is no login: the screen closes all the same, and the card goes back to its ask, saying so", async () => {
    const w = world({ cookies: (n) => (n < 1 ? [] : at(AT)), statuses: [401] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('asked');
    expect(w.ended).toEqual(['ses_1']);
    expect(w.last()).toMatchObject({
      title: 'Link ixigo for this trip', body: "ixigo didn't keep the login on Go's computer. Tap Log in to ixigo to try again.",
      actions: [{ action_id: 'ixigo_login' }, { action_id: 'ixigo_not_now' }],
    });
    expect(w.wakes).toEqual([]);
  });

  it(`with nothing seen for ${SELF_CHECK_MS / 1000} s the card gets I'm logged in; Not now ends every screen session it opened`, async () => {
    const w = world({ cookies: () => [] });
    await w.setup();
    // The look that reaches 60 s from the tap: every 2 s for the first 30 s, then every 5 s.
    const at60 = LOGIN_POLL_FAST_FOR_MS / LOGIN_POLL_MS + (SELF_CHECK_MS - LOGIN_POLL_FAST_FOR_MS) / LOGIN_POLL_SLOW_MS;
    const seen: Record<number, string[]> = {};
    // While Go waits: Log in tapped again (the screen opens again), then, once that is answered, Not now. Each is kept, so
    // the test waits on them itself: how many looks the wait takes meanwhile is the database's pace, never counted.
    let reopened: Promise<unknown> | null = null;
    let notNow: Promise<unknown> | null = null;
    w.hooks.onSleep = (n) => {
      seen[n] = ids(w.last());
      if (n === at60 + 2) reopened = w.fire('ixigo_login', 'p_rahul');
      if (n === at60 + 6) notNow = reopened!.then(() => w.fire('ixigo_not_now', 'p_rahul'));
    };
    await w.tap('ixigo_login', 'p_rahul');
    // The wait ends only once Not now is in (its state), so both taps were made by now.
    await notNow;
    await w.login.settled();
    // Up to 60 s from the tap the card has no I'm logged in, and the next look shows it.
    expect(seen[at60]).toEqual(['ixigo_login', 'ixigo_not_now']);
    expect(seen[at60 + 1]).toEqual(['ixigo_login', 'ixigo_logged_in', 'ixigo_not_now']);
    expect(w.cards().filter((c) => ids(c).includes('ixigo_logged_in'))).toHaveLength(1);
    // Not now: both screen sessions end, so every view of the log in closes, and Go stops reading.
    expect(await w.state()).toBe('skipped');
    expect(w.sessions).toHaveLength(2);
    expect(w.ended).toEqual(['ses_1', 'ses_2']);
    expect(w.releases).toEqual([LOGIN_TAB]);
    // Go stopped reading at Not now, long before the hand-off's own end: a bound that never depends on the runner's pace.
    expect(w.looks.length).toBeLessThan(HANDOFF_MS / LOGIN_POLL_MS);
  });

  it(`a one-tap log in still open at ${HANDOFF_MS / 60_000} minutes ends as the hand-off's own time would end it`, async () => {
    const w = world({ cookies: () => [] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');
    expect(w.cookieReads.at(-1)!.at - w.cookieReads[0]!.at).toBeLessThan(HANDOFF_MS);
    expect(await w.state()).toBe('asked');
    expect(w.ended).toEqual(['ses_1']);
    expect(w.last()).toMatchObject({ body: "ixigo's log in closed on Go's screen after 10 minutes. Tap Log in to ixigo to open it again." });
  });

  // The lead, 10 Oct: state survives a restart (level-triggered): the minute's sweep, or Log in again, picks the wait up.
  it("a restart of Go mid-login loses nothing: the minute's sweep picks the wait up from the row and ends the same screen session", async () => {
    const w = world({ cookies: (n) => (n < 3 ? [] : at(AT)), statuses: [200] });
    await w.setup();
    // The process goes away at its first look.
    w.hooks.onSleep = (n) => {
      if (n === 1) throw new Error('Go restarted');
    };
    await w.tap('ixigo_login', 'p_rahul');
    expect(await w.state()).toBe('logging_in');
    w.hooks.onSleep = undefined;
    const after = w.restart();
    await after.sweep();
    await after.settled();
    // The `at` kept from the tap (none) is what the next reads compare with: its coming is the login.
    expect(await w.state()).toBe('logged_in');
    expect(w.ended).toEqual(['ses_1']);
    expect(w.releases).toEqual([LOGIN_TAB]);
    // A second sweep finds nothing to do.
    await after.sweep();
    await after.settled();
    expect(w.cookieReads).toHaveLength(4);
  });

  it('after a restart, Log in tapped again picks the wait up too; a sweep after the hand-off time ends the log in', async () => {
    const w = world({ cookies: (n) => (n < 2 ? [] : at(AT)), statuses: [200] });
    await w.setup();
    w.hooks.onSleep = (n) => {
      if (n === 1) throw new Error('Go restarted');
    };
    await w.tap('ixigo_login', 'p_rahul');
    w.hooks.onSleep = undefined;
    w.restart();
    expect(await w.tap('ixigo_login', 'p_rahul')).toMatchObject({ result: 'open' });
    expect(w.handOffs).toHaveLength(1);
    expect(await w.state()).toBe('logged_in');
    expect(w.ended).toEqual(['ses_1', 'ses_2']);

    const late = world({ cookies: () => [] });
    await late.setup();
    late.hooks.onSleep = (n) => {
      if (n === 1) throw new Error('Go restarted');
    };
    await late.tap('ixigo_login', 'p_rahul');
    late.hooks.onSleep = undefined;
    late.clock.now = new Date(late.clock.now.getTime() + HANDOFF_MS);
    const after = late.restart();
    await after.sweep();
    await after.settled();
    expect(await late.state()).toBe('asked');
    expect(late.ended).toEqual(['ses_1']);
    expect(late.cookieReads).toHaveLength(1);
  });

  it("a Bash without the cookie read still opens Go's screen at the tap; the card carries I'm logged in from the start", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'open', url: 'https://screen.example/control', expires_at: '2026-10-08T06:15:00.000Z' });
    expect(w.sessions).toEqual([[w.tripId, 'control']]);
    expect(w.cookieReads).toEqual([]);
    expect(ids(w.last())).toEqual(['ixigo_login', 'ixigo_logged_in', 'ixigo_not_now']);
  });
});
