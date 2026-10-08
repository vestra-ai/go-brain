import { readFileSync } from 'node:fs';
import type * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createSetup } from '../../trips/setup.js';
import type { CardTapParams, CardTapResult } from '../../door/methods.js';
import { fakeLink, fakePacks, goaPack, goaTrip, msg } from '../../proactive/fakes.js';
import type { TaskBrief } from '../../tasks/tasks.js';
import { BOOK_DIR, checkRecipe, loadBook, type Book } from '../book/book.js';
import { createEngine } from '../book/engine.js';
import { createIxigoLogin, HELLO_WAIT_MS, RECHECK_MS, USERINFO } from '../login.js';
import { TravelError } from '../mcp-travel.js';
import { capture } from '../recipes/__tests__/fixtures.js';
import { IXIGO, type FetchPlan } from '../recipes/recipe.js';

// Keshav, 8 Oct: "when the trip creates, that's when we [make] the ixigo connection, and all the warming should happen;
// connection as in ixigo should be logged in, so prompt someone to login". The organizer is asked right after setup warms
// ixigo; their own tap starts the job that hands them Go's browser; ixigo's own answer, by its status, says whether the
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
function world(o: { live?: boolean; greeted?: boolean; paused?: string[]; statuses?: Array<number | 'timeout'> } = {}) {
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
  const hooks: { onSleep?: (n: number) => void } = {};
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
  };
  const starts: TaskBrief[] = [];
  const handoffs: Array<[string, string]> = [];
  const tasks = {
    start: async (_trip: string, brief: TaskBrief) => {
      starts.push(brief);
      return { taskId: `gt_login_${starts.length}`, cardId: `c_work_${starts.length}` };
    },
    handoff: async (taskId: string, outcome: 'done' | 'could_not' | 'not_now') => {
      handoffs.push([taskId, outcome]);
    },
  };
  const login = createIxigoLogin({
    pool: db.pool, link, packs, runner: () => runner, tasks: () => tasks, live: () => o.live !== false, now: () => clock.now,
    log: { warn: () => undefined, info: () => undefined },
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      looks.push(ms);
      hooks.onSleep?.(looks.length);
    },
  });
  const handlers = new Map<string, (tap: CardTapParams, card: C.Card) => Promise<CardTapResult>>();
  login.registerTaps({ on: (kind, action, h) => handlers.set(`${kind}:${action}`, h) });
  let tapN = 0;
  const tap = async (action: string, personId: string): Promise<CardTapResult> => {
    tapN += 1;
    const out = await handlers.get(`notice:${action}`)!({ tap_id: `tap_${tapN}`, trip_id: tripId, card_id: 'c_login', action_id: action, person_id: personId }, {} as C.Card);
    await login.settled();
    return out;
  };
  const cards = (): C.Card[] => [...link.of('post_message').flatMap((p) => (p.card ? [p.card as C.Card] : [])), ...link.of('replace_card').map((p) => p.card as C.Card)];
  const last = (): C.Card & { kind: 'notice' } => cards().at(-1) as C.Card & { kind: 'notice' };
  const state = async (): Promise<string | undefined> =>
    (await db.pool.query<{ state: string }>('select state from ixigo_logins where trip_id = $1', [tripId])).rows[0]?.state;
  return { tripId, clock, link, reads, statuses, starts, handoffs, login, tap, last, state, greet, looks, hooks, setup: () => login.setupStep.run(tripId) };
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
  it("only the person asked can tap; Log in starts the job that opens ixigo's login and hands them the browser", async () => {
    const w = world();
    await w.setup();
    expect(await w.tap('ixigo_login', 'p_priya')).toEqual({ result: 'refused', toast: 'Only Rahul can do this here.' });
    expect(w.starts).toEqual([]);

    expect(await w.tap('ixigo_login', 'p_rahul')).toEqual({ result: 'done', toast: "Opening ixigo on Go's computer" });
    expect(w.starts).toHaveLength(1);
    const job = w.starts[0]!;
    expect(job).toMatchObject({ title: 'Logging in to ixigo', askedBy: 'p_rahul', returnsKind: 'answer', steps: ["Opening ixigo's login", 'Rahul logs in', 'Checking the login'] });
    expect(job.goal).toContain('https://www.ixigo.com/');
    expect(job.goal).toContain('Never type, read, copy or keep a number, a code, a name or an email');
    expect(job.goal).toContain('never open a page under /payments/');
    expect(await w.state()).toBe('logging_in');
    expect(w.last()).toMatchObject({
      card_id: `c_login_${w.tripId}_0`, title: 'Logging in to ixigo',
      actions: [{ action_id: 'ixigo_logged_in', label: "I'm logged in" }, { action_id: 'ixigo_not_now', label: 'Not now' }],
    });
  });

  it("I'm logged in settles the job's hand-off, and ixigo's own answer decides by its status alone: 401 is not yet, 200 is logged in as Rahul", async () => {
    const w = world({ statuses: [401, 200] });
    await w.setup();
    await w.tap('ixigo_login', 'p_rahul');

    expect(await w.tap('ixigo_logged_in', 'p_rahul')).toEqual({ result: 'done', toast: 'Checking your login' });
    expect(w.handoffs).toEqual([['gt_login_1', 'done']]);
    // ixigo's home page, keeping one byte of its userinfo call: the status is read, the account never is.
    expect(w.reads.at(-1)).toEqual({ url: 'https://www.ixigo.com/', plan: STATUS_PLAN });
    expect(await w.state()).toBe('logging_in');
    expect(w.last().body).toBe("Go can't see ixigo logged in yet. Finish the login on Go's screen (Watch on its card), then tap I'm logged in again.");

    await w.tap('ixigo_logged_in', 'p_rahul');
    expect(await w.state()).toBe('logged_in');
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
