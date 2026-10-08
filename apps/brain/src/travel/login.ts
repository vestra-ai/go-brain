/**
 * One person's ixigo login on the trip's computer. Keshav's word: "when the trip creates, that's when we [make] the ixigo
 * connection, and all the warming should happen; connection as in ixigo should be logged in, so prompt someone to login",
 * and "if there is no login on ixigo in a group, it should first proactively prompt for that". One setup flow at
 * trip.created: the box is made (travel.computer), then, right after Go's hello, Go prompts the organizer (or, with none,
 * the first person who hasn't paused Go) with one line and a card pinned to them (travel.ixigo_login), then ixigo is opened
 * and warmed on the box (travel.ixigo_warm). A trip that never had the prompt (one Go held before it came) is asked at its
 * first search instead (nudge). Each trip is asked once that way; a row of any kind ("Not now" too) means no more nudges.
 * Nothing waits on the login: searches work logged out. Go asks again the first time a recipe needs the login
 * (auth: login). The person logs in
 * themselves on Go's screen, with no model: their tap opens ixigo's log in box IN FRONT of the person's window on the
 * trip's computer (Bash's front browser fetch), clicks into its mobile number box and keeps the tab there for them; the
 * login card's Watch (theirs alone: nobody else sees the page) gives them control, and they type their own number and code. Go never sees
 * either. The login stays in the trip's browser profile, so every later fetch is logged in.
 *
 * Whether the browser is logged in is ixigo's own answer: the home page's POST /api/v2/oauth/userinfo, by its status
 * only (200 in, 401 or 403 out), with one byte of its body kept, never read. The card then says "logged in as Keshav",
 * the trip member's own name: nothing of the account reaches Go. A login is checked again at most every 6 hours, when a
 * recipe needs it. Go logs out (ixigo's own menu) when the person asks on the card or leaves the trip.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TapRouter } from '../door/taps.js';
import type { SetupStep } from '../trips/setup.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Tasks } from '../tasks/tasks.js';
import { TravelError } from './mcp-travel.js';
import { IXIGO, type Capture } from './recipes/recipe.js';
import type { RecipeRunner } from './recipes/runners.js';

/** ixigo's own call that says whether the browser is logged in (about 900 bytes logged in), read by its status only. */
export const USERINFO = '/api/v2/oauth/userinfo';
/** A login is taken as it stands for this long, then checked again the next time a recipe needs it. */
export const RECHECK_MS = 6 * 3600_000;
/** Asked again at most this often when recipes keep needing a login nobody has made. */
const ASK_AGAIN_MS = 30 * 60_000;
/** Go's hello is a queued turn: the prompt waits for it this long, looking every HELLO_POLL_MS, before setup tries later. */
export const HELLO_WAIT_MS = 20_000;
const HELLO_POLL_MS = 1_000;
/** The hand-off's tab on the trip's computer, kept in front of the person's window for them (Bash's front). */
export const LOGIN_TAB = 'ixigo_login';
/** How long the hand-off's tab stays in front for them: Bash's most. I'm logged in or Not now closes it sooner. */
export const HANDOFF_MS = 600_000;
/** How long the page may take to show its log in box; past it the tab stays in front for the person all the same. */
export const HANDOFF_PAGE_MS = 12_000;
/** The log in box's mobile number field ("Enter Mobile Number"), clicked so the cursor waits in it for the person. */
const MOBILE_BOX = { op: 'click', role: 'textbox', text: 'mobile' } as const;
/** ixigo's home page with its log in box open: ixigo's own address for it, so the job clicks nothing to open the box. */
export const LOGIN_URL = 'https://www.ixigo.com/?loginVisible=true';
/** The first ask, at setup or at a trip's first search. */
const FIRST_LINE = "{name}, link ixigo for the trip: one login on the trip's computer, about a minute.";

export type LoginState = 'asked' | 'logging_in' | 'logged_in' | 'skipped' | 'logged_out';

export interface LoginRow {
  tripId: string;
  personId: string;
  state: LoginState;
  attempt: number;
  taskId: string | null;
  askedAt: Date;
  loggedInAt: Date | null;
  checkedAt: Date | null;
}

export interface LoginDeps {
  pool: pg.Pool;
  link: Pick<ServerLink, 'request'>;
  packs: Pick<Packs, 'get'>;
  /** The trip's browser fetch, its hand-off in front included; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read' | 'handOff' | 'release' | 'tabCall'> | null;
  /** The jobs lane: a login started as a job before the hand-off had no model (a row with a taskId) is settled there. */
  tasks: () => Pick<Tasks, 'handoff' | 'stop'> | null;
  /** A fresh session on the trip's screen, in control or to view (POST /v1/sessions); null with no trip computer here. */
  screen: () => ((tripId: string, mode: 'view' | 'control') => Promise<{ url: string; expires_at: string }>) | null;
  /** Whether Go searches ixigo.com itself (TRAVEL_MODE ixigo_web): only then is there a login to ask for. */
  live: () => boolean;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /** Waits between looks for Go's hello; tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs `fn` after `ms` (the hand-off's end at HANDOFF_MS) and returns how to cancel it; tests pass their own. */
  later?: (ms: number, fn: () => void) => () => void;
}

export interface IxigoLogin {
  /** The setup step that asks right after Go's hello, before the warm. */
  setupStep: SetupStep;
  /**
   * Travel intent on a trip (warmForTravel's callers: a search tool starting, the early start, a recipe's run): a trip
   * with no login row at all is asked now, once. Fire and forget: the search never waits on it.
   */
  nudge(tripId: string): void;
  registerTaps(taps: Pick<TapRouter, 'on'>): void;
  /** For a recipe that needs the login: ok, or the line for the model (and the person was asked). */
  ensure(tripId: string, what: string): Promise<{ ok: true } | { ok: false; note: string }>;
  /** ixigo's own answer for the trip's browser: in, out, or unknown (the page never said). */
  status(tripId: string): Promise<'in' | 'out' | 'unknown'>;
  onEvent(ev: C.Event): Promise<void>;
  /**
   * A person gone from their login: they left the trip, or used "Forget me" in it. When the trip's login is theirs, Go
   * logs the trip's computer out of ixigo (in the background) and the card says why. Travel calls it on person.left; the
   * memory lane's forget_person calls it through brain.ixigoLogin.
   */
  personGone(tripId: string, personId: string, why: 'left' | 'forgot'): Promise<void>;
  /** Waits for the work taps started in the background (tests). */
  settled(): Promise<void>;
}

const cardId = (tripId: string, attempt: number): string => `c_login_${tripId}_${attempt}`;
/** Why the card says what it says: not logged in yet, the person left or used Forget me, a log out ixigo didn't take. */
type Note = 'not_yet' | 'not_opened' | 'expired' | 'left' | 'forgot' | 'logout_failed';
const day = (at: Date): string => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** The login card for where things stand: who it is for, what it says, and the buttons only they see. */
export function loginCard(row: Pick<LoginRow, 'tripId' | 'personId' | 'state' | 'attempt' | 'loggedInAt'>, name: string, note?: Note): C.Card {
  const only = [row.personId];
  const button = (action_id: string, label: string, style: 'primary' | 'secondary'): C.CardAction => ({ action_id, label, style, only_for_person_ids: only });
  const base = { card_id: cardId(row.tripId, row.attempt), kind: 'notice' as const, tone: 'info' as const, for_person_ids: only };
  switch (row.state) {
    case 'asked':
      return {
        ...base,
        title: 'Link ixigo for this trip',
        body: note === 'not_opened'
          ? "Go couldn't open ixigo's log in on its screen just now. Tap Log in to ixigo to try again."
          : note === 'expired'
            ? "ixigo's log in closed on Go's screen after 10 minutes. Tap Log in to ixigo to open it again."
            : `One login on Go's computer lets Go check fares, hold them and book for the group. ${name} logs in on Go's screen with their own phone; Go never sees the number or the code. Trip searches and bookings then use ${name}'s ixigo account, and the group never sees its details.`,
        actions: [button('ixigo_login', 'Log in to ixigo', 'primary'), button('ixigo_not_now', 'Not now', 'secondary')],
        fallback_text: `${name}, log in to ixigo once on Go's computer so Go can check fares and book.`,
      };
    case 'logging_in':
      return {
        ...base,
        title: 'Logging in to ixigo',
        body: note === 'not_yet'
          ? 'Not logged in yet. Finish on Watch, then tap again.'
          : `ixigo's log in is open on Go's screen. ${name}: tap Watch, log in with your phone, then tap I'm logged in.`,
        // Watch only for the person logging in: anyone else would watch them type their number.
        actions: [
          button('ixigo_watch', 'Watch', 'primary'),
          button('ixigo_logged_in', "I'm logged in", 'secondary'),
          button('ixigo_not_now', 'Not now', 'secondary'),
        ],
        fallback_text: `${name} is logging in to ixigo on Go's computer.`,
      };
    case 'logged_in':
      return {
        ...base,
        title: `ixigo: logged in as ${name}`.slice(0, 80),
        body: note === 'logout_failed'
          ? `Go couldn't log out just now. Tap Log out to try again, or log out on Go's screen.`
          : `Since ${row.loggedInAt ? day(row.loggedInAt) : 'today'}. Searches and bookings for this trip use ${name}'s ixigo account; the group never sees its details, and Go never opens the payment page.`,
        actions: [button('ixigo_logout', 'Log out', 'secondary')],
        fallback_text: `ixigo is logged in as ${name} on Go's computer.`,
      };
    case 'skipped':
      return {
        ...base,
        title: 'ixigo login skipped',
        body: 'Go will ask again when a booking needs it.',
        actions: [button('ixigo_login', 'Log in to ixigo', 'secondary')],
        fallback_text: 'The ixigo login was skipped for now.',
      };
    case 'logged_out':
      return {
        ...base,
        title: 'Logged out of ixigo',
        body: note === 'left'
          ? `${name} left the trip, so Go logged out of ixigo on its computer.`
          : note === 'forgot' ? `${name} used Forget me in this trip, so Go logged out of ixigo on its computer.` : `Go's computer is no longer logged in to ixigo as ${name}.`,
        actions: [],
        fallback_text: 'Go logged out of ixigo.',
      };
  }
}

export function createIxigoLogin(d: LoginDeps): IxigoLogin {
  const inFlight = new Set<Promise<void>>();
  const track = (what: string, tripId: string, p: Promise<void>): void => {
    const q = p.catch((err: unknown) => d.log.warn({ err, tripId }, `travel: the ixigo login's ${what} failed`));
    inFlight.add(q);
    void q.finally(() => inFlight.delete(q));
  };

  async function get(tripId: string): Promise<LoginRow | null> {
    const { rows } = await d.pool.query<{
      person_id: string; state: LoginState; attempt: number; task_id: string | null; asked_at: Date; logged_in_at: Date | null; checked_at: Date | null;
    }>('select person_id, state, attempt, task_id, asked_at, logged_in_at, checked_at from ixigo_logins where trip_id = $1', [tripId]);
    const r = rows[0];
    return r ? { tripId, personId: r.person_id, state: r.state, attempt: r.attempt, taskId: r.task_id, askedAt: r.asked_at, loggedInAt: r.logged_in_at, checkedAt: r.checked_at } : null;
  }

  async function save(row: LoginRow): Promise<void> {
    await d.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, task_id, asked_at, logged_in_at, checked_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (trip_id) do update set person_id = excluded.person_id, state = excluded.state, attempt = excluded.attempt,
         task_id = excluded.task_id, asked_at = excluded.asked_at, logged_in_at = excluded.logged_in_at, checked_at = excluded.checked_at,
         updated_at = excluded.updated_at`,
      [row.tripId, row.personId, row.state, row.attempt, row.taskId, row.askedAt, row.loggedInAt, row.checkedAt, d.now()],
    );
  }

  async function nameOf(tripId: string, personId: string): Promise<string> {
    const pack = await d.packs.get(tripId);
    return pack.trip.people.find((p) => p.person_id === personId)?.name ?? 'the organizer';
  }

  async function show(row: LoginRow, note?: Note): Promise<void> {
    await d.link.request('replace_card', { trip_id: row.tripId, card: loginCard(row, await nameOf(row.tripId, row.personId), note) });
  }

  /** Asks one person, with a line naming them and a fresh card (an earlier card is far up the chat by now). */
  async function ask(tripId: string, personId: string, attempt: number, line: string): Promise<void> {
    const row: LoginRow = { tripId, personId, state: 'asked', attempt, taskId: null, askedAt: d.now(), loggedInAt: null, checkedAt: null };
    await save(row);
    const name = await nameOf(tripId, personId);
    await d.link.request('post_message', {
      request_id: `go_login_${tripId}_${attempt}`, trip_id: tripId, text: line.replace('{name}', name), mentions: [personId], card: loginCard(row, name),
    });
  }

  async function status(tripId: string): Promise<'in' | 'out' | 'unknown'> {
    const runner = d.runner();
    if (!runner) return 'unknown';
    let captures: Capture[];
    try {
      // One byte of the answer is all Bash keeps: Go reads its status, never what it says about the account.
      ({ captures } = await runner.read(tripId, `${IXIGO}/`, { capture: [{ match: USERINFO, required: true, max_bytes: 1 }], timeoutMs: 12_000 }));
    } catch (err) {
      if (!(err instanceof TravelError)) throw err;
      d.log.info({ tripId, status: null, login: 'unknown', why: err.code }, 'travel: ixigo said whether the trip computer is logged in');
      return 'unknown';
    }
    const s = captures.find((c) => c.url.includes(USERINFO))?.status;
    const said = s === 200 ? 'in' : s === 401 || s === 403 ? 'out' : 'unknown';
    // The status alone, for the stage desk's log: never the account.
    d.log.info({ tripId, status: s ?? null, login: said }, 'travel: ixigo said whether the trip computer is logged in');
    return said;
  }

  async function loggedIn(row: LoginRow): Promise<LoginRow> {
    const now = d.now();
    const next: LoginRow = { ...row, state: 'logged_in', loggedInAt: row.state === 'logged_in' ? row.loggedInAt : now, checkedAt: now };
    await save(next);
    return next;
  }

  /** ixigo's own menu: the greeting at the top ("Hey Keshav") opens it, and its "Log out" link logs the browser out. */
  async function logout(row: LoginRow, why: 'asked' | 'left' | 'forgot'): Promise<void> {
    const runner = d.runner();
    if (runner) {
      try {
        await runner.read(row.tripId, `${IXIGO}/`, {
          capture: [],
          steps: [{ op: 'click', text: 'Hey' }, { op: 'click', role: 'link', name: 'Log out' }],
          timeoutMs: 15_000,
        });
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        d.log.warn({ tripId: row.tripId, err: err.message }, "travel: ixigo's log out did not run");
      }
    }
    if ((await status(row.tripId)) === 'in') {
      await show(row, 'logout_failed');
      return;
    }
    const out: LoginRow = { ...row, state: 'logged_out', checkedAt: d.now() };
    await save(out);
    await show(out, why === 'asked' ? undefined : why);
  }

  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const later = d.later ?? ((ms: number, fn: () => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  /** Each trip's hand-off end (HANDOFF_MS), cancelled when the login ends sooner. In this process: Bash closes the tab itself. */
  const ending = new Map<string, () => void>();
  const nudging = new Set<string>();
  /** Trips known to have a login row: a nudge there reads nothing. */
  const hasRow = new Set<string>();

  /** Who is asked first: the organizer, or the first person in the trip who hasn't paused Go. */
  function askable(pack: TripPack): string | null {
    const free = (id: string): boolean => pack.trip.people.some((p) => p.person_id === id && !p.go_paused);
    if (free(pack.trip.organizer_person_id)) return pack.trip.organizer_person_id;
    return pack.trip.people.find((p) => !p.go_paused)?.person_id ?? null;
  }

  /** The trip once Go has said hello there (a queued turn), looking every second for up to HELLO_WAIT_MS. */
  async function afterHello(tripId: string): Promise<{ pack: TripPack; greeted: boolean }> {
    const end = d.now().getTime() + HELLO_WAIT_MS;
    for (;;) {
      const pack = await d.packs.get(tripId);
      if (pack.messages.some((m) => m.author.kind === 'go')) return { pack, greeted: true };
      if (d.now().getTime() >= end) return { pack, greeted: false };
      await sleep(HELLO_POLL_MS);
    }
  }

  /** The trip's first ask: its row made only where there is none, so two asks at once (setup and a search) post once. */
  async function firstAsk(tripId: string, pack: TripPack): Promise<void> {
    const personId = askable(pack);
    if (!personId) return;
    const now = d.now();
    const made = await d.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, updated_at) values ($1, $2, 'asked', 0, $3, $3)
       on conflict (trip_id) do nothing`,
      [tripId, personId, now],
    );
    if ((made.rowCount ?? 0) === 0) return;
    const row: LoginRow = { tripId, personId, state: 'asked', attempt: 0, taskId: null, askedAt: now, loggedInAt: null, checkedAt: null };
    const name = await nameOf(tripId, personId);
    try {
      await d.link.request('post_message', {
        request_id: `go_login_${tripId}_0`, trip_id: tripId, text: FIRST_LINE.replace('{name}', name), mentions: [personId], card: loginCard(row, name),
      });
    } catch (err) {
      // An ask that never reached the room is no ask: the row goes, so setup's retry or the next search asks again.
      await d.pool.query("delete from ixigo_logins where trip_id = $1 and state = 'asked' and attempt = 0", [tripId]);
      throw err;
    }
  }

  /**
   * The hand-off, with no model: ixigo's log in box opened IN FRONT of the person's window on the trip's computer
   * (Bash's front fetch), its mobile number box clicked, and the tab kept there for them for HANDOFF_MS. ixigo's own
   * userinfo answer on that page says whether the browser is logged in already: then there is nothing to hand over. A
   * page Bash would not open puts the card back to its ask, saying so.
   */
  async function handOff(row: LoginRow, runner: Pick<RecipeRunner, 'handOff' | 'release'>): Promise<void> {
    // The hand-off ends at HANDOFF_MS whatever happens: Bash closes the tab then, and the card goes back to its ask.
    ending.get(row.tripId)?.();
    ending.set(row.tripId, later(HANDOFF_MS, () => track('end', row.tripId, expire(row))));
    let captures: Capture[];
    try {
      ({ captures } = await runner.handOff!(
        row.tripId,
        LOGIN_URL,
        { capture: [{ match: USERINFO, required: true, max_bytes: 1 }], steps: [MOBILE_BOX], timeoutMs: HANDOFF_PAGE_MS },
        { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB },
      ));
    } catch (err) {
      // Loud, and nothing left open: no second path.
      await release(row.tripId);
      const now = await get(row.tripId);
      if (now?.state === 'logging_in' && now.attempt === row.attempt) {
        const back: LoginRow = { ...now, state: 'asked' };
        await save(back);
        await show(back, 'not_opened');
      }
      throw err;
    }
    const now = await get(row.tripId);
    // Not now while the page opened, or another try: this hand-off is no longer theirs to finish.
    if (now?.state !== 'logging_in' || now.attempt !== row.attempt) return;
    if (captures.find((c) => c.url.includes(USERINFO))?.status === 200) {
      await release(row.tripId);
      await show(await loggedIn(now));
    }
  }

  /**
   * ixigo's userinfo answer from inside the open log in page (one byte, by its status), keeping the page for them. With no
   * log in page open (its 10 minutes ran out), the home page's own answer, as any check reads it.
   */
  async function statusInLogin(tripId: string): Promise<'in' | 'out' | 'unknown'> {
    const runner = d.runner();
    if (!runner?.tabCall) return status(tripId);
    let got: Capture | null;
    try {
      got = await runner.tabCall(tripId, LOGIN_TAB, { url: USERINFO, method: 'POST' }, HANDOFF_MS);
    } catch (err) {
      if (!(err instanceof TravelError)) throw err;
      d.log.info({ tripId, status: null, login: 'unknown', why: err.code }, 'travel: ixigo said whether the trip computer is logged in');
      return 'unknown';
    }
    if (got === null) return status(tripId);
    const said = got.status === 200 ? 'in' : got.status === 401 || got.status === 403 ? 'out' : 'unknown';
    // The status alone, for the stage desk's log: never the account.
    d.log.info({ tripId, status: got.status, login: said, where: 'log in page' }, 'travel: ixigo said whether the trip computer is logged in');
    return said;
  }

  /**
   * The hand-off's tab closes, so the person's own window is on top again; one already gone is nothing to close. Every end
   * of a login closes it: logged in, Not now, a hand-off that failed or ran its time, the person gone.
   */
  async function release(tripId: string): Promise<void> {
    ending.get(tripId)?.();
    ending.delete(tripId);
    await d.runner()?.release?.(tripId, LOGIN_TAB).catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the ixigo login's tab did not close"));
  }

  /** A hand-off that ran its HANDOFF_MS: its tab is closed, and its card goes back to its ask, saying so. */
  async function expire(row: LoginRow): Promise<void> {
    ending.delete(row.tripId);
    const now = await get(row.tripId);
    if (now?.state !== 'logging_in' || now.attempt !== row.attempt) return;
    await release(row.tripId);
    const back: LoginRow = { ...now, state: 'asked' };
    await save(back);
    await show(back, 'expired');
  }

  async function personGone(tripId: string, personId: string, why: 'left' | 'forgot'): Promise<void> {
    const row = await get(tripId);
    if (!row || row.personId !== personId || (row.state !== 'logged_in' && row.state !== 'logging_in')) return;
    // A log in still open for them closes first.
    if (row.state === 'logging_in') await release(tripId);
    track('log out', tripId, logout(row, why));
  }

  /** A tap on the login card by the person it is for; anyone else is told whose it is. */
  const forPerson = (h: (row: LoginRow, tap: CardTapParams) => Promise<CardTapResult>) =>
    async (tap: CardTapParams): Promise<CardTapResult> => {
      const row = await get(tap.trip_id);
      if (!row) return { result: 'refused', toast: 'That login card is not active any more.' };
      if (row.personId !== tap.person_id) return { result: 'refused', toast: `Only ${await nameOf(row.tripId, row.personId)} can do this here.` };
      return h(row, tap);
    };

  return {
    setupStep: {
      name: 'travel.ixigo_login',
      // Right after the box is started, before ixigo is warmed on it: the prompt never waits on the warm.
      after: 'travel.computer',
      async run(tripId) {
        // Nothing to log in to while Go doesn't browse ixigo.com; a recipe that needs the login asks then.
        if (!d.live() || (await get(tripId))) return;
        const { pack, greeted } = await afterHello(tripId);
        // Still no hello: the setup sweep tries again.
        if (!greeted) throw new Error('waits for Go to greet the trip');
        await firstAsk(tripId, pack);
      },
    },

    nudge(tripId) {
      if (!d.live() || hasRow.has(tripId) || nudging.has(tripId)) return;
      nudging.add(tripId);
      track('first ask', tripId, (async () => {
        if (await get(tripId)) {
          hasRow.add(tripId);
          return;
        }
        // After Go's hello when it comes; a hello that never comes doesn't stop the ask.
        const { pack } = await afterHello(tripId);
        await firstAsk(tripId, pack);
      })().finally(() => nudging.delete(tripId)));
    },

    registerTaps(taps) {
      taps.on('notice', 'ixigo_login', forPerson(async (row) => {
        const runner = d.runner();
        if (!d.live() || !runner?.handOff) return { result: 'refused', toast: "Go's computer isn't browsing ixigo right now." };
        if (row.state === 'logged_in') return { result: 'done', toast: 'ixigo is already logged in' };
        const next: LoginRow = { ...row, state: 'logging_in', taskId: null };
        await save(next);
        // The card first, then the page: whatever the hand-off finds is said after it, never under it.
        track('hand-off', row.tripId, (async () => {
          await show(next);
          await handOff(next, runner);
        })());
        return { result: 'done', toast: "Opening ixigo's log in on Go's screen" };
      }));

      // Only the person logging in watches, with control: nobody else sees their number typed. Never a link in the chat:
      // the tap opens it.
      taps.on('notice', 'ixigo_watch', forPerson(async (row) => {
        const screen = d.screen();
        if (row.state !== 'logging_in' || !screen) return { result: 'refused', toast: "ixigo's log in isn't open on Go's screen now" };
        try {
          const s = await screen(row.tripId, 'control');
          return { result: 'open', url: s.url, expires_at: s.expires_at };
        } catch (err) {
          d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's Watch did not open");
          return { result: 'refused', toast: "Can't open Go's screen right now" };
        }
      }));

      taps.on('notice', 'ixigo_logged_in', forPerson(async (row) => {
        if (row.state !== 'logging_in') return { result: 'done' };
        track('check', row.tripId, (async () => {
          // A login started as a job (before the hand-off had no model): its hand-off settled for them, quietly.
          if (row.taskId) await d.tasks()?.handoff(row.taskId, 'done').catch(() => undefined);
          // ixigo's own answer, read from inside the log in page: nothing opens over it, and an early tap (still waiting for
          // the code) keeps its place. Logged in: the window closes. Not yet: it stays in front, untouched.
          if ((await statusInLogin(row.tripId)) === 'in') {
            await release(row.tripId);
            await show(await loggedIn(row));
          } else await show(row, 'not_yet');
        })());
        return { result: 'done', toast: 'Checking your login' };
      }));

      taps.on('notice', 'ixigo_not_now', forPerson(async (row) => {
        if (row.state === 'logged_in') return { result: 'done' };
        const next: LoginRow = { ...row, state: 'skipped' };
        await save(next);
        if (row.state === 'logging_in') {
          // The log in leaves the person's screen; a job from before stops where it is, its card saying Stopped.
          track('close', row.tripId, release(row.tripId));
          if (row.taskId) track('stop', row.tripId, d.tasks()?.stop(row.taskId) ?? Promise.resolve());
        }
        track('card', row.tripId, show(next));
        return { result: 'done', toast: 'Go will ask again when a booking needs it' };
      }));

      taps.on('notice', 'ixigo_logout', forPerson(async (row) => {
        if (row.state !== 'logged_in') return { result: 'done' };
        track('log out', row.tripId, logout(row, 'asked'));
        return { result: 'done', toast: 'Logging out of ixigo' };
      }));
    },

    async ensure(tripId, what) {
      const row = await get(tripId);
      const now = d.now().getTime();
      if (row && (row.state === 'logged_in' || row.state === 'logging_in')) {
        if (row.state === 'logged_in' && row.checkedAt && now - row.checkedAt.getTime() < RECHECK_MS) return { ok: true };
        const s = await status(tripId);
        if (s === 'in') {
          const next = await loggedIn(row);
          if (row.state !== 'logged_in') track('card', tripId, show(next));
          return { ok: true };
        }
        // ixigo can't say: a login Go saw stands until it can.
        if (s === 'unknown' && row.state === 'logged_in') return { ok: true };
        if (row.state === 'logging_in') return { ok: false, note: `${what} needs the trip's ixigo login, and ${await nameOf(tripId, row.personId)} hasn't finished it on Go's screen yet. Say so in one line.` };
      }
      const pack = await d.packs.get(tripId);
      // Someone who used Forget me in this trip is never asked again (memory's forgotten marks).
      const forgot = new Set(
        (await d.pool.query<{ person_id: string }>('select person_id from forgotten where trip_id = $1', [tripId])).rows.map((r) => r.person_id),
      );
      const can = (id: string | null | undefined): id is string =>
        !!id && !forgot.has(id) && pack.trip.people.some((p) => p.person_id === id && !p.go_paused);
      // The person asked before, while they are still in the trip and can be asked; else the organizer; else the first
      // member who can be (the organizer used Forget me).
      const personId = row !== null && can(row.personId)
        ? row.personId
        : can(pack.trip.organizer_person_id)
          ? pack.trip.organizer_person_id
          : pack.trip.people.find((p) => can(p.person_id))?.person_id;
      if (!personId) return { ok: false, note: `${what} needs the trip's ixigo login, and nobody can be asked for it now. Say so in one line.` };
      const name = await nameOf(tripId, personId);
      // Someone new (the one asked used Forget me) is asked at once; the same person, at most once in half an hour.
      if (!row || row.personId !== personId || row.state !== 'asked' || now - row.askedAt.getTime() >= ASK_AGAIN_MS) {
        await ask(tripId, personId, row ? row.attempt + 1 : 0, "{name}, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.");
      }
      return { ok: false, note: `${what} needs the trip's ixigo login. Go asked ${name} to log in on the card: say so in one line, and never ask for a number or a code in the chat.` };
    },

    status,

    async onEvent(ev) {
      if (ev.type === 'person.left') await personGone(ev.trip_id, ev.data.person_id, 'left');
    },

    personGone,

    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
