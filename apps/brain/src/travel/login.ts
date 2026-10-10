/**
 * One person's ixigo login on the trip's computer. Keshav's word: "when the trip creates, that's when we [make] the ixigo
 * connection, and all the warming should happen; connection as in ixigo should be logged in, so prompt someone to login",
 * and "if there is no login on ixigo in a group, it should first proactively prompt for that". One setup flow at
 * trip.created: Go's hello itself prompts the organizer (or, with none, the first person who hasn't paused Go), with its
 * last line for them and a card pinned to them on the same message (helloCard: one Go post, never two in a row); the box
 * is made (travel.computer), the prompt is made after the hello if the hello went without it (travel.ixigo_login), then
 * ixigo is opened and warmed on the box (travel.ixigo_warm). A trip that never had the prompt (one Go held before it came) is asked at its
 * first search instead (nudge). Each trip is asked once that way; a row of any kind ("Not now" too) means no more nudges.
 * Nothing waits on the login: searches work logged out. Go asks again the first time a recipe needs the login
 * (auth: login). The person logs in
 * themselves on Go's screen, with no model: their tap opens ixigo's log in box IN FRONT of the person's window on the
 * trip's computer (Bash's front browser fetch), clicks into its mobile number box and keeps the tab there for them; the
 * login card's Watch (theirs alone: nobody else sees the page) gives them control, and they type their own number and code. Go never sees
 * either. The login stays in the trip's browser profile, so every later fetch is logged in.
 *
 * Whether the browser is logged in is ixigo's own answer: the calls its home page makes as it loads (LOGIN_CALLS), by
 * their status only, with one byte of each body kept, never read. The card then says "logged in as Keshav",
 * the trip member's own name: nothing of the account reaches Go. A login is checked again at most every 6 hours, when a
 * recipe needs it. Go logs out (ixigo's own menu) when the person asks on the card or leaves the trip.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import type { Desk, DeskItem } from '../desk/desk.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TapRouter } from '../door/taps.js';
import type { SetupStep } from '../trips/setup.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Tasks } from '../tasks/tasks.js';
import { TravelError } from './mcp-travel.js';
import { IXIGO, type Capture, type FetchPlan } from './recipes/recipe.js';
import { ChallengedError, type RecipeRunner } from './recipes/runners.js';
import type { BrowserLogin, Browsers } from '../tasks/browsers.js';

/**
 * Calls ixigo's page makes as it loads only when it has a login, with its own token and keys. A call of Go's own is
 * 403 even logged in: ixigo's wrapper adds Authorization (its "at" cookie), apikey, clientid, deviceid and more. On
 * staging (9 Oct, 08:40), Keshav's logged-in page made both, 200, and never called userinfo.
 */
export const WALLET = '/api/v3/ixigo-money/wallet';
export const IDENTITY = '/api/profile/secure/booking/with-identity';
/** ixigo's userinfo call: refused (401 or 403), the login the page holds is gone. */
export const USERINFO = '/api/v2/oauth/userinfo';
/**
 * A call ixigo's page makes as it loads whether or not it is logged in, in the same moment as the login's own calls
 * (2349 to 2351 ms into the 08:40 load), so once it is in, theirs are under way. A logged-out load (08:41) made it alone.
 */
const NEARBY = '/api/flights/locations/nearby';
/** How long the page may take to show its log in box; past it the tab stays in front for the person all the same. */
export const HANDOFF_PAGE_MS = 12_000;
/**
 * Whether the browser is logged in, from ixigo's own calls as its home page loads, one byte each, by their status only.
 * None of the login's calls is waited for (a logged-in page never calls userinfo, a logged-out one calls none of them):
 * the page's NEARBY is, as the one required capture, then up to Bash's most (3 s) for the login's calls. Bash refuses a
 * fetch with no required capture and no page_fetch step (400 invalid_request; staging, 9 Oct 13:24, every hand-off).
 */
export const LOGIN_CALLS: FetchPlan = {
  capture: [
    { match: NEARBY, required: true, max_bytes: 1 },
    ...[WALLET, IDENTITY, USERINFO].map((match) => ({ match, required: false, max_bytes: 1 })),
  ],
  steps: [],
  timeoutMs: HANDOFF_PAGE_MS,
  graceMs: 3_000,
};

/**
 * ixigo's answer from its page's calls: a login's own call that worked says in; one of them refused (401 or 403) says out,
 * the token the page holds dead (staging, 9 Oct 17:43: the morning box's wallet and with-identity both 401, hours after
 * they were 200); anything else unknown. With the call that said it, and its status, for the log: never what it answered.
 */
export function loginFrom(captures: Capture[]): { login: 'in' | 'out' | 'unknown'; call: string | null; status: number | null } {
  const worked = captures.find((c) => (c.match === WALLET || c.match === IDENTITY) && c.status === 200);
  if (worked) return { login: 'in', call: worked.match, status: worked.status };
  const refused = captures.find((c) => (c.match === WALLET || c.match === IDENTITY || c.match === USERINFO) && (c.status === 401 || c.status === 403));
  if (refused) return { login: 'out', call: refused.match, status: refused.status };
  return { login: 'unknown', call: null, status: null };
}
/** A login is taken as it stands for this long, then checked again the next time a recipe needs it. */
export const RECHECK_MS = 6 * 3600_000;
/** A booking stands on a login ixigo confirmed this recently; past it, the booking reads ixigo first. */
export const BOOKING_RECHECK_MS = 60_000;
/** Asked again at most this often when recipes keep needing a login nobody has made. */
const ASK_AGAIN_MS = 30 * 60_000;
/** Go's hello is a queued turn: the prompt waits for it this long, looking every HELLO_POLL_MS, before setup tries later. */
export const HELLO_WAIT_MS = 20_000;
const HELLO_POLL_MS = 1_000;
/** The hand-off's tab on the trip's computer, kept in front of the person's window for them (Bash's front). */
export const LOGIN_TAB = 'ixigo_login';
/** How long the hand-off's tab stays in front for them: Bash's most. I'm logged in or Not now closes it sooner. */
export const HANDOFF_MS = 600_000;
/**
 * ixigo's own Login button on its phone page (the hand-off's page runs as a phone: Bash's front), which opens its log in
 * sheet. ?loginVisible=true opens nothing, on the phone page or the desktop one (staging probe, 8 Oct).
 */
const LOGIN_BUTTON = { op: 'click', role: 'button', name: 'Login' } as const;
/** The log in sheet's mobile number field ("Enter Mobile Number"), clicked so the cursor waits in it for the person. */
const MOBILE_BOX = { op: 'click', role: 'textbox', text: 'mobile' } as const;
/** ixigo's home page, where the log in sheet opens. */
export const LOGIN_URL = 'https://www.ixigo.com/';
/** A booking ask asks again with its own line, unless it asked this recently (a turn that runs again). */
const BOOK_ASK_AGAIN_MS = 2 * 60_000;
/** The first ask, at setup or at a trip's first search, when Go's hello went without it. */
const FIRST_LINE = "{name}, link ixigo for the trip: one login on the trip's computer, about a minute.";
/** The ask when the person's browser lost the login (the keep-alive, another trip's check), at the trip's next travel talk. */
const GONE_LINE = "{name}, ixigo logged Go's computer out: one login brings it back, about a minute.";
/** The hello's last line, for the person asked, with the login card on the same message. */
export const HELLO_LINE = '{name}, first link ixigo once so I can search and book for everyone.';

export type LoginState = 'asked' | 'logging_in' | 'logged_in' | 'skipped' | 'logged_out';

/**
 * A booking ask that waits on the trip's login (travel/web-stays.ts): what it books, said in the ask's line, and the
 * set_mandate call to carry on with, which the composer makes when the login is in.
 */
export interface Parked {
  what: string;
  resume: Record<string, unknown>;
}

export interface LoginRow {
  tripId: string;
  personId: string;
  state: LoginState;
  attempt: number;
  taskId: string | null;
  askedAt: Date;
  loggedInAt: Date | null;
  checkedAt: Date | null;
  parked: Parked | null;
}

export interface LoginDeps {
  pool: pg.Pool;
  link: Pick<ServerLink, 'request'>;
  packs: Pick<Packs, 'get'>;
  /** The trip's browser fetch, its hand-off in front included; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read' | 'handOff' | 'release' | 'tabSteps'> | null;
  /** The jobs lane: a login started as a job before the hand-off had no model (a row with a taskId) is settled there. */
  tasks: () => Pick<Tasks, 'handoff' | 'stop'> | null;
  /** A fresh session on the trip's screen, in control or to view (POST /v1/sessions); null with no trip computer here. */
  screen: () => ((tripId: string, mode: 'view' | 'control') => Promise<{ url: string; expires_at: string }>) | null;
  /**
   * Where the trip's browser's ixigo login stands (tasks/browsers.ts): one browser, and one login, for every trip of its
   * organizer, so a trip whose person logged in on another trip of theirs asks nothing. Null with no browsers here.
   */
  browser?: () => Pick<Browsers, 'login' | 'setLogin'> | null;
  /** A booking parked on the login wakes the composer when the login is in. */
  desk: Pick<Desk, 'put'>;
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
  /**
   * Go's hello carries the ask (context.addTurnCard): on the setup turn that greets the trip, with no login yet, the
   * login card and one line for the person asked ride on the hello's own post, so a new trip opens with one Go message,
   * never two in a row. Null for any other turn, a trip that already has a login, or one Go doesn't browse for.
   */
  helloCard(i: { tripId: string; wake: DeskItem[]; pack: TripPack }): Promise<{ card: C.Card; line: string } | null>;
  /** The setup step that asks after Go's hello when the hello went without the ask, before the warm. */
  setupStep: SetupStep;
  /**
   * Travel intent on a trip (warmForTravel's callers: a search tool starting, the early start, a recipe's run): a trip
   * with no login row at all is asked now, once; a trip whose login the person's browser has lost since (the keep-alive,
   * another trip's check) is asked now, once, so they learn before a booking fails. Never into a quiet chat: only on
   * travel talk. Fire and forget: the search never waits on it.
   */
  nudge(tripId: string): void;
  registerTaps(taps: Pick<TapRouter, 'on'>): void;
  /** The login's hand-off is open on the trip (logging in): nothing else is handed to the person over it. */
  handingOff(tripId: string): Promise<boolean>;
  /**
   * For a recipe or a booking that needs the login: ok, or the line for the model (and the person was asked). A booking
   * (park) is asked with its own line ("To book Saudades I need ixigo linked once, Rahul") and waits on the login: when
   * the login is in, the composer wakes and carries on with it. booking: money is about to move, so ixigo is read now
   * unless it said in within BOOKING_RECHECK_MS: a token it refuses flips the browser and asks, never failing silently.
   */
  ensure(tripId: string, what: string, o?: { park?: Parked; booking?: boolean }): Promise<{ ok: true } | { ok: false; note: string }>;
  /**
   * ixigo's own answer for the trip's browser: in, out, or unknown (the page never said); challenged when its page stayed
   * on Cloudflare's check, which says nothing about the login either way. Out on a login Go held lets it go (logged out),
   * so the next booking asks again.
   */
  status(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged'>;
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

/**
 * How a login that just landed reads in "why Go woke": a booking that waited on it carries on (resume), or, with nothing
 * waiting, Go takes off with the trip (linked). Null for other taps.
 */
export function renderLoginResume(item: DeskItem, pack: TripPack): string | null {
  const p = item.payload as { source?: string; action?: string; personId?: string; what?: string; resume?: Record<string, unknown> };
  if (p.source !== 'ixigo_login' || (p.action !== 'resume' && p.action !== 'linked')) return null;
  const who = pack.trip.people.find((x) => x.person_id === p.personId)?.name ?? 'Someone';
  if (p.action === 'linked') {
    return `${who} just linked ixigo on Go's computer, so carry on with the trip now, without asking anyone again: take the most useful next step for what the group has asked for (such as searching stays or flights on ixigo for their place and dates) and post what you find. If where or when is still missing, ask only for that.`;
  }
  return `${who} logged in to ixigo on Go's computer, so carry on with what the group asked for, without asking anyone again: booking ${p.what ?? 'the stay'}. Call set_mandate now with ${JSON.stringify(p.resume ?? {})}, then say in one short line what was set and that the payer taps Yes, book it.`;
}
/**
 * Why the card says what it says: the page still opening, not logged in yet, the person left or used Forget me, a log out
 * ixigo didn't take, or ixigo's page held on Cloudflare's check (challenge).
 */
type Note = 'opening' | 'not_yet' | 'not_opened' | 'expired' | 'left' | 'forgot' | 'logout_failed' | 'challenge';
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
          : note === 'challenge'
            ? "ixigo asked Go's computer to wait a moment before its log in. Tap Log in to ixigo to try again in a minute."
            : note === 'expired'
              ? "ixigo's log in closed on Go's screen after 10 minutes. Tap Log in to ixigo to open it again."
              : `One login on Go's computer lets Go check fares, hold them and book for the group. ${name} logs in on Go's screen with their mobile number and its code; Go never sees either. Trip searches and bookings then use ${name}'s ixigo account, and the group never sees its details.`,
        actions: [button('ixigo_login', 'Log in to ixigo', 'primary'), button('ixigo_not_now', 'Not now', 'secondary')],
        fallback_text: `${name}, log in to ixigo once on Go's computer so Go can check fares and book.`,
      };
    case 'logging_in':
      return {
        ...base,
        // Not logged in yet: a heads-up, so the room's sheet shows the line to the person looking at it.
        ...(note === 'not_yet' ? { tone: 'heads_up' as const } : {}),
        title: 'Logging in to ixigo',
        body: note === 'not_yet'
          ? 'Not logged in yet. Finish on Watch, then tap again.'
          : note === 'opening'
            ? `Opening ixigo's log in on Go's screen for ${name}.`
            : `ixigo's log in is open on Go's screen. ${name}: tap Watch, log in with your mobile number, then tap I'm logged in.`,
        // Watch only for the person logging in (anyone else would watch them type their number), and only once the page
        // is in front: while it opens, the card carries I'm logged in and Not now alone (the room says it is opening).
        actions: [
          ...(note === 'opening' ? [] : [button('ixigo_watch', 'Watch', 'primary')]),
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
      parked: Parked | null;
    }>('select person_id, state, attempt, task_id, asked_at, logged_in_at, checked_at, parked from ixigo_logins where trip_id = $1', [tripId]);
    const r = rows[0];
    return r
      ? { tripId, personId: r.person_id, state: r.state, attempt: r.attempt, taskId: r.task_id, askedAt: r.asked_at, loggedInAt: r.logged_in_at, checkedAt: r.checked_at, parked: r.parked }
      : null;
  }

  /**
   * The login to logging in, in one step on its row, unless it is logging in already: then null, and the tap starts
   * nothing. A logging-in row older than HANDOFF_MS is one whose end Go never saw (a restart): it is taken again.
   */
  async function claim(row: LoginRow): Promise<LoginRow | null> {
    const now = d.now();
    const r = await d.pool.query(
      `update ixigo_logins set state = 'logging_in', task_id = null, updated_at = $2
       where trip_id = $1 and (state <> 'logging_in' or updated_at < $3)`,
      [row.tripId, now, new Date(now.getTime() - HANDOFF_MS)],
    );
    return r.rowCount ? { ...row, state: 'logging_in', taskId: null } : null;
  }

  async function save(row: LoginRow): Promise<void> {
    await d.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, task_id, asked_at, logged_in_at, checked_at, parked, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (trip_id) do update set person_id = excluded.person_id, state = excluded.state, attempt = excluded.attempt,
         task_id = excluded.task_id, asked_at = excluded.asked_at, logged_in_at = excluded.logged_in_at, checked_at = excluded.checked_at,
         parked = excluded.parked, updated_at = excluded.updated_at`,
      [row.tripId, row.personId, row.state, row.attempt, row.taskId, row.askedAt, row.loggedInAt, row.checkedAt, row.parked ? JSON.stringify(row.parked) : null, d.now()],
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
  async function ask(tripId: string, personId: string, attempt: number, line: string, parked: Parked | null = null): Promise<void> {
    const row: LoginRow = { tripId, personId, state: 'asked', attempt, taskId: null, askedAt: d.now(), loggedInAt: null, checkedAt: null, parked };
    await save(row);
    const name = await nameOf(tripId, personId);
    await d.link.request('post_message', {
      request_id: `go_login_${tripId}_${attempt}`, trip_id: tripId, text: line.replace('{name}', name), mentions: [personId], card: loginCard(row, name),
    });
  }

  /**
   * ixigo's answer from its page's calls, logged for the stage desk by call and status alone: never the account. In or out
   * is the person's browser's, for every trip of theirs (tasks/browsers.ts).
   */
  async function said(tripId: string, captures: Capture[], where: string): Promise<'in' | 'out' | 'unknown'> {
    const { login, call, status: s } = loginFrom(captures);
    d.log.info(
      { tripId, login, call, status: s, calls: captures.map((c) => `${c.match} ${c.status}`), where },
      'travel: ixigo said whether the trip computer is logged in',
    );
    if (login !== 'unknown') {
      await d.browser?.()?.setLogin(tripId, login).catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the browser's login was not kept"));
    }
    return login;
  }

  /** Where the trip's browser's login stands, as ixigo last said it on any trip of the person's; null when unknown. */
  async function browserLogin(tripId: string): Promise<BrowserLogin | null> {
    try {
      return (await d.browser?.()?.login(tripId)) ?? null;
    } catch (err) {
      d.log.warn({ err, tripId }, "travel: the browser's login could not be read");
      return null;
    }
  }

  /**
   * The person's browser is logged in already (on another trip of theirs): this trip starts logged in and asks nothing,
   * its row made only where there is none. Not yet confirmed here (checkedAt null): setup reads ixigo once to confirm.
   */
  async function fromBrowser(tripId: string, personId: string): Promise<boolean> {
    const b = await browserLogin(tripId);
    if (b?.login !== 'in') return false;
    const now = d.now();
    await d.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, logged_in_at, updated_at) values ($1, $2, 'logged_in', 0, $3, $4, $3)
       on conflict (trip_id) do nothing`,
      [tripId, personId, now, b.loggedInAt ?? now],
    );
    return true;
  }

  /** ixigo's answer for the trip's browser, read from its home page; nothing changes on the row. */
  async function look(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged'> {
    const runner = d.runner();
    if (!runner) return 'unknown';
    let captures: Capture[];
    try {
      // One byte of each answer is all Bash keeps: Go reads their status, never what they say about the account.
      ({ captures } = await runner.read(tripId, `${IXIGO}/`, LOGIN_CALLS));
    } catch (err) {
      if (!(err instanceof TravelError)) throw err;
      const check = err instanceof ChallengedError;
      d.log.info({ tripId, status: null, login: 'unknown', why: check ? 'challenge' : err.code }, 'travel: ixigo said whether the trip computer is logged in');
      return check ? 'challenged' : 'unknown';
    }
    return await said(tripId, captures, 'home page');
  }

  /**
   * ixigo's answer, and a login Go held that ixigo no longer has (a token it refuses) let go: the row says logged out and
   * its card says so, so the next booking that needs the login asks again instead of standing on a stale one.
   */
  async function status(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged'> {
    const s = await look(tripId);
    if (s === 'out') {
      const row = await get(tripId);
      if (row?.state === 'logged_in') {
        const out: LoginRow = { ...row, state: 'logged_out', checkedAt: d.now() };
        await save(out);
        d.log.info({ tripId }, "travel: ixigo no longer has the trip computer's login; the next booking asks again");
        // A trip that took its login from the person's browser never had a card to change: the card is best effort.
        track('card', tripId, show(out));
      }
    }
    return s;
  }

  /**
   * The login in. carryOn: the person's own login just landed (the hand-off's first look, or "I'm logged in"), not a
   * recipe's check, whose turn is already carrying on.
   */
  async function loggedIn(row: LoginRow, o: { carryOn?: boolean } = {}): Promise<LoginRow> {
    const now = d.now();
    // A booking that waited on this login carries on: the composer wakes with it, before the row lets it go, so a
    // failed write here leaves it parked for the next time the login reads in (the desk item's id makes it once).
    if (row.parked) {
      await d.desk.put({
        id: `travel:login_resume:${row.tripId}:${row.attempt}`, tripId: row.tripId, kind: 'tap', ref: cardId(row.tripId, row.attempt), dueAt: now,
        payload: { source: 'ixigo_login', action: 'resume', personId: row.personId, what: row.parked.what, resume: row.parked.resume },
      });
    } else if (o.carryOn && row.state !== 'logged_in') {
      // Nothing waited on it: Go takes off with the trip (Keshav, 9 Oct: "take off with the main task after login"), once
      // for this login, never for a check of a login it had already (the desk item's id makes it once, too).
      await d.desk.put({
        id: `travel:login_linked:${row.tripId}:${row.attempt}`, tripId: row.tripId, kind: 'tap', ref: cardId(row.tripId, row.attempt), dueAt: now,
        payload: { source: 'ixigo_login', action: 'linked', personId: row.personId },
      });
    }
    const next: LoginRow = { ...row, state: 'logged_in', loggedInAt: row.state === 'logged_in' ? row.loggedInAt : now, checkedAt: now, parked: null };
    await save(next);
    return next;
  }

  /** ixigo's own menu: the greeting at the top ("Hey Keshav") opens it, and its "Log out" link logs the browser out. */
  async function logout(row: LoginRow, why: 'asked' | 'left' | 'forgot'): Promise<void> {
    const runner = d.runner();
    if (runner) {
      try {
        // The home page's nearby call is the one capture Bash waits for: it refuses a fetch with none required and no
        // page_fetch step (400 invalid_request), so a plan of clicks alone never ran.
        await runner.read(row.tripId, `${IXIGO}/`, {
          capture: [{ match: NEARBY, required: true, max_bytes: 1 }],
          steps: [{ op: 'click', text: 'Hey' }, { op: 'click', role: 'link', name: 'Log out' }],
          timeoutMs: 15_000,
        });
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        d.log.warn({ tripId: row.tripId, err: err.message }, "travel: ixigo's log out did not run");
      }
    }
    // Still in, or a page on Cloudflare's check, which can't say: the log out is not taken as done.
    const s = await look(row.tripId);
    if (s === 'in' || s === 'challenged') {
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
    // Logged in already on the person's browser: nothing to ask; setup confirms it with one read (setupStep).
    if (await fromBrowser(tripId, personId)) return;
    const now = d.now();
    const made = await d.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, updated_at) values ($1, $2, 'asked', 0, $3, $3)
       on conflict (trip_id) do nothing`,
      [tripId, personId, now],
    );
    if ((made.rowCount ?? 0) === 0) return;
    const row: LoginRow = { tripId, personId, state: 'asked', attempt: 0, taskId: null, askedAt: now, loggedInAt: null, checkedAt: null, parked: null };
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
   * The hand-off, with no model: ixigo's home page opened IN FRONT of the person's window on the trip's computer (Bash's
   * front fetch, as a phone), its Login tapped and its mobile number box clicked, and the tab kept there for them for
   * HANDOFF_MS. ixigo's own calls as the page loads (LOGIN_CALLS) say whether the browser is logged in already: then
   * there is nothing to hand over. A page Bash would not open puts the card back to its ask, saying so.
   */
  async function handOff(row: LoginRow, runner: Pick<RecipeRunner, 'handOff' | 'release' | 'tabSteps'>): Promise<void> {
    // The hand-off ends at HANDOFF_MS whatever happens: Bash closes the tab then, and the card goes back to its ask.
    ending.get(row.tripId)?.();
    ending.set(row.tripId, later(HANDOFF_MS, () => track('end', row.tripId, expire(row))));
    let opened: { captures: Capture[]; challenged?: true };
    try {
      opened = await runner.handOff!(
        row.tripId,
        LOGIN_URL,
        // The page and ixigo's own calls alone: Watch comes as soon as they have said (its crop is set before the page
        // loads), and the taps run after, while Watch's picture connects (staging, 8 Oct: they were 2 to 3 s of the wait).
        LOGIN_CALLS,
        { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB },
      );
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
    if (opened.challenged) {
      await heldByCheck(now);
      return;
    }
    if ((await said(row.tripId, opened.captures, 'hand-off')) === 'in') {
      await release(row.tripId);
      await show(await loggedIn(now, { carryOn: true }));
    } else {
      // The page is in front for them: now the card carries Watch. Then ixigo's Login and the mobile box, tapped on the
      // page they watch (best effort: the page stays theirs if a tap finds nothing), and the page takes the keyboard.
      await show(now);
      await runner.tabSteps?.(row.tripId, LOGIN_TAB, [LOGIN_BUTTON, MOBILE_BOX], { keepOpenMs: HANDOFF_MS, timeoutMs: HANDOFF_PAGE_MS })
        .catch((err: unknown) => d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's taps did not run"));
    }
  }

  /**
   * ixigo's own answer to "I'm logged in": its log in page loads again in the hand-off's tab (front, kept for them), and
   * the calls ixigo's own code makes as it loads are caught, one byte each, by their status (LOGIN_CALLS). Not logged in
   * yet, the page is theirs again with ixigo's Login and its mobile number box tapped, as the hand-off left it.
   */
  async function statusInLogin(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged'> {
    const runner = d.runner();
    if (!runner?.handOff) return status(tripId);
    let opened: { captures: Capture[]; challenged?: true };
    try {
      opened = await runner.handOff(tripId, LOGIN_URL, LOGIN_CALLS, { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB });
    } catch (err) {
      if (!(err instanceof TravelError)) throw err;
      d.log.info({ tripId, status: null, login: 'unknown', why: err.code }, 'travel: ixigo said whether the trip computer is logged in');
      return 'unknown';
    }
    // Cloudflare's check says nothing about the login: neither in nor out, and nothing tapped on it.
    if (opened.challenged) {
      d.log.info({ tripId, status: null, login: 'unknown', why: 'challenge', where: 'log in page' }, 'travel: ixigo said whether the trip computer is logged in');
      return 'challenged';
    }
    const login = await said(tripId, opened.captures, 'log in page');
    if (login !== 'in') {
      await runner.tabSteps?.(tripId, LOGIN_TAB, [LOGIN_BUTTON, MOBILE_BOX], { keepOpenMs: HANDOFF_MS, timeoutMs: HANDOFF_PAGE_MS })
        .catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the ixigo login's taps did not run"));
    }
    return login;
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

  /**
   * ixigo's page stayed on Cloudflare's check through the runner's tries (CLOUDFLARE, recipes/runners.ts): nothing is
   * handed over and no Watch is offered on it. The tab closes, and the card goes back to its ask, saying so.
   */
  async function heldByCheck(row: LoginRow): Promise<void> {
    await release(row.tripId);
    const back: LoginRow = { ...row, state: 'asked' };
    await save(back);
    await show(back, 'challenge');
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
    async helloCard(i) {
      if (!d.live() || !i.wake.some((w) => w.kind === 'setup' && w.ref === 'greet')) return null;
      // Claimed before the hello goes, so the setup step (and a first search's nudge) finds the ask made and asks nothing.
      // A person whose browser is logged in already (another trip of theirs) is not asked: the trip starts logged in.
      const personId = askable(i.pack);
      if (personId && (await fromBrowser(i.tripId, personId))) return null;
      if (personId) {
        await d.pool.query(
          `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, updated_at) values ($1, $2, 'asked', 0, $3, $3)
           on conflict (trip_id) do nothing`,
          [i.tripId, personId, d.now()],
        );
      }
      // The first ask, made here or by an earlier try of this turn: anything else (logged in, skipped, asked again) is not the hello's.
      const row = await get(i.tripId);
      if (!row || row.state !== 'asked' || row.attempt !== 0) return null;
      const name = i.pack.trip.people.find((p) => p.person_id === row.personId)?.name ?? 'the organizer';
      return { card: loginCard(row, name), line: HELLO_LINE.replace('{name}', name) };
    },

    setupStep: {
      name: 'travel.ixigo_login',
      // Right after the box is started, before ixigo is warmed on it: the prompt never waits on the warm. Go's hello
      // normally carried the ask already (helloCard), and then this finds the row and asks nothing.
      after: 'travel.computer',
      async run(tripId) {
        // Nothing to log in to while Go doesn't browse ixigo.com; a recipe that needs the login asks then.
        if (!d.live()) return;
        if (!(await get(tripId))) {
          const { pack, greeted } = await afterHello(tripId);
          // Still no hello: the setup sweep tries again.
          if (!greeted) throw new Error('waits for Go to greet the trip');
          await firstAsk(tripId, pack);
        }
        // A login the trip took from the person's browser (helloCard, firstAsk): one read of ixigo confirms it before Go
        // stands on it. Gone, and Go asks, once, with its own card; ixigo can't say, and it stands, as a check's does.
        const row = await get(tripId);
        if (row?.state === 'logged_in' && row.checkedAt === null) {
          const s = await look(tripId);
          if (s === 'in') await save({ ...row, checkedAt: d.now() });
          else if (s === 'out') await ask(tripId, row.personId, row.attempt + 1, FIRST_LINE);
        }
      },
    },

    nudge(tripId) {
      if (!d.live() || nudging.has(tripId)) return;
      nudging.add(tripId);
      track('first ask', tripId, (async () => {
        const row = await get(tripId);
        if (!row) {
          // After Go's hello when it comes; a hello that never comes doesn't stop the ask.
          const { pack } = await afterHello(tripId);
          await firstAsk(tripId, pack);
          return;
        }
        // The person's browser lost the login since this trip last checked it: asked once, now, on travel talk.
        const b = await browserLogin(tripId);
        if (row.state === 'logged_in' && b?.login === 'out' && b.at && (!row.checkedAt || b.at > row.checkedAt)) {
          await ask(tripId, row.personId, row.attempt + 1, GONE_LINE);
        }
      })().finally(() => nudging.delete(tripId)));
    },

    async handingOff(tripId) {
      return (await get(tripId))?.state === 'logging_in';
    },

    registerTaps(taps) {
      taps.on('notice', 'ixigo_login', forPerson(async (row) => {
        const runner = d.runner();
        if (!d.live() || !runner?.handOff) return { result: 'refused', toast: "Go's computer isn't browsing ixigo right now." };
        if (row.state === 'logged_in') return { result: 'done', toast: 'ixigo is already logged in' };
        // One hand-off per login: a tap while its page opens or is open (a double tap) starts nothing, not a second page
        // over the first (Keshav, 8 Oct: the second one's measuring cut the page off).
        const next = await claim(row);
        if (!next) return { result: 'done', toast: "Already opening ixigo's log in" };
        // The card first (opening, no Watch yet), then the page: whatever the hand-off finds is said after it, never under it.
        track('hand-off', row.tripId, (async () => {
          await show(next, 'opening');
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
          // ixigo's own answer, from its log in page loaded again in the hand-off's tab. Logged in: the window closes. Not
          // yet: it stays in front for them, its log in box open again. Still on Cloudflare's check: closed, asked again.
          const s = await statusInLogin(row.tripId);
          if (s === 'in') {
            await release(row.tripId);
            await show(await loggedIn(row, { carryOn: true }));
          } else if (s === 'challenged') await heldByCheck(row);
          else await show(row, 'not_yet');
        })());
        return { result: 'done', toast: 'Checking your login' };
      }));

      taps.on('notice', 'ixigo_not_now', forPerson(async (row) => {
        if (row.state === 'logged_in') return { result: 'done' };
        // A booking that waited on the login is let go with it: Go asks again when someone asks for a booking again.
        const next: LoginRow = { ...row, state: 'skipped', parked: null };
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

    async ensure(tripId, what, o = {}) {
      const park = o.park ?? null;
      let row = await get(tripId);
      const now = d.now().getTime();
      // How long a login ixigo confirmed is taken as it stands: a booking reads ixigo again past a minute.
      const trust = o.booking ? BOOKING_RECHECK_MS : RECHECK_MS;
      // The person's browser, as ixigo last said on any trip of theirs: in within that is this trip's login too; out
      // since this trip last checked ends this trip's login, and the ask below asks again.
      const b = await browserLogin(tripId);
      if (b?.login === 'in' && b.at && now - b.at.getTime() < trust) {
        if (!row) {
          const pack = await d.packs.get(tripId);
          await fromBrowser(tripId, askable(pack) ?? pack.trip.organizer_person_id);
        } else if (row.state !== 'logged_in') {
          // Logged in on another trip of theirs while this one asked: its card says logged in, its open log in closes.
          if (row.state === 'logging_in') await release(tripId);
          const next = await loggedIn(row);
          track('card', tripId, show(next));
        }
        return { ok: true };
      }
      if (b?.login === 'out' && row?.state === 'logged_in' && b.at && (!row.checkedAt || b.at > row.checkedAt)) {
        row = { ...row, state: 'logged_out', checkedAt: b.at };
        await save(row);
      }
      if (row && (row.state === 'logged_in' || row.state === 'logging_in')) {
        if (row.state === 'logged_in' && row.checkedAt && now - row.checkedAt.getTime() < trust) return { ok: true };
        const s = await status(tripId);
        if (s === 'in') {
          const next = await loggedIn(row);
          if (row.state !== 'logged_in') track('card', tripId, show(next));
          return { ok: true };
        }
        // ixigo can't say (its page never said, or stayed on Cloudflare's check): a login Go saw stands until it can.
        if ((s === 'unknown' || s === 'challenged') && row.state === 'logged_in') return { ok: true };
        if (row.state === 'logging_in') {
          if (park) await save({ ...row, parked: park });
          const name = await nameOf(tripId, row.personId);
          return {
            ok: false,
            note: park
              ? `${what} needs the trip's ixigo login, and ${name} hasn't finished it on Go's screen yet. Go carries on with it once ${name} is in: say so in one line.`
              : `${what} needs the trip's ixigo login, and ${name} hasn't finished it on Go's screen yet. Say so in one line.`,
          };
        }
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
      // Someone new (the one asked used Forget me) is asked at once; the same person, at most once in half an hour, or,
      // for a booking, with its own line unless that was just asked.
      const again = park ? BOOK_ASK_AGAIN_MS : ASK_AGAIN_MS;
      if (!row || row.personId !== personId || row.state !== 'asked' || now - row.askedAt.getTime() >= again) {
        const line = park ? `To book ${park.what} I need ixigo linked once, {name}: one login on the trip's computer, about a minute.` : "{name}, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.";
        await ask(tripId, personId, row ? row.attempt + 1 : 0, line, park);
        // Go's line and the card are the answer to the booking ask.
        if (park) return { ok: false, note: `Go asked ${name} in the chat, with the login card, and carries on with booking ${park.what} once the login is in. Say nothing more about it.` };
      } else if (park && row) {
        await save({ ...row, parked: park });
        return { ok: false, note: `${what} needs the trip's ixigo login: ${name}'s login card is just above, and Go carries on once the login is in. Say so in one line, and never ask for a number or a code in the chat.` };
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
