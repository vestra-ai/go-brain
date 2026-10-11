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
 * same tap opens Go's screen for them (theirs alone, in control: nobody else sees the page), and they type their own number
 * and code. Go never sees either. The login stays in the trip's browser profile, so every later fetch is logged in.
 *
 * One tap (Keshav, 10 Oct: "one click, live stream opens, login there, Go detects, and when back proceeds automatically",
 * and "there is no point of watch buttons"): "Log in to ixigo" is the card's one button, and it opens Go's screen at once
 * (Bash's Watch page) and again. Where Bash can read the browser's cookies, Go sees the login land by itself, from ixigo's
 * `at` cookie by its name and expiry alone (never its value), then closes the tab and ends the screen's sessions, which
 * closes the person's view, and carries on. "I'm logged in" shows only when Go has seen nothing for SELF_CHECK_MS.
 *
 * Whether the browser is logged in is ixigo's own answer: the calls its home page makes as it loads (LOGIN_CALLS), by
 * their status only, with one byte of each body kept, never read. The card then says "logged in as Keshav",
 * the trip member's own name: nothing of the account reaches Go. A login is checked again at most every 6 hours, when a
 * recipe needs it. Go logs out (ixigo's own menu) when the person asks on the card or leaves the trip.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import { z } from 'zod';
import type { QuickTool } from '../composer/tools.js';
import type { Desk, DeskItem } from '../desk/desk.js';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TapRouter } from '../door/taps.js';
import type { SetupStep } from '../trips/setup.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Tasks } from '../tasks/tasks.js';
import { TravelError } from './mcp-travel.js';
import { IXIGO, type Capture, type FetchPlan } from './recipes/recipe.js';
import { ChallengedError, type CropTo, type RecipeRunner } from './recipes/runners.js';
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
 * Calls ixigo's page makes as it loads whether or not it is logged in: its content service, behind every block of the
 * home page (six calls, 1.4 to 2.0 s into a load; staging, 10 Oct 04:31), in the same burst as the login's own calls, so
 * once the first is in, theirs are under way. It was the nearby flights call until ixigo's home stopped making it (10
 * Oct): every read waited for it, timed out and said unknown, a logged-in browser too.
 */
const PAGE_CONTENT = '/action/content';
/** How long the page may take to show its log in box; past it the tab stays in front for the person all the same. */
export const HANDOFF_PAGE_MS = 12_000;
/**
 * Whether the browser is logged in, from ixigo's own calls as its home page loads, one byte each, by their status only.
 * None of the login's calls is waited for (a logged-in page never calls userinfo, a logged-out one calls none of them):
 * the page's content is, as the one required capture, then up to Bash's most (3 s) for the login's calls. Bash refuses a
 * fetch with no required capture and no page_fetch step (400 invalid_request; staging, 9 Oct 13:24, every hand-off). A
 * page_fetch of a login call of Go's own can't stand in: it is 403 logged in or out (WALLET).
 */
export const LOGIN_CALLS: FetchPlan = {
  capture: [
    { match: PAGE_CONTENT, required: true, max_bytes: 1 },
    ...[WALLET, IDENTITY, USERINFO].map((match) => ({ match, required: false, max_bytes: 1 })),
  ],
  steps: [],
  timeoutMs: HANDOFF_PAGE_MS,
  graceMs: 3_000,
};

/**
 * ixigo's answer from its page's calls: a login's own call that worked says in; one of them refused (401 or 403) says out,
 * the token the page holds dead (staging, 9 Oct 17:43: the morning box's wallet and with-identity both 401, hours after
 * they were 200). A page that booted (its content came) and made none of the login's calls holds no login: out, but
 * quiet (a slow box's calls can miss the grace), so Go acts on it only once a second read agrees (login-keepalive.ts).
 * Anything else unknown. With the call that said it, and its status, for the log: never what it answered.
 */
export function loginFrom(captures: Capture[]): { login: 'in' | 'out' | 'unknown'; call: string | null; status: number | null; quiet?: true } {
  const worked = captures.find((c) => (c.match === WALLET || c.match === IDENTITY) && c.status === 200);
  if (worked) return { login: 'in', call: worked.match, status: worked.status };
  const refused = captures.find((c) => (c.match === WALLET || c.match === IDENTITY || c.match === USERINFO) && (c.status === 401 || c.status === 403));
  if (refused) return { login: 'out', call: refused.match, status: refused.status };
  const booted = captures.some((c) => c.match === PAGE_CONTENT && c.status >= 200 && c.status < 300);
  if (booted && !captures.some((c) => c.match === WALLET || c.match === IDENTITY || c.match === USERINFO)) return { login: 'out', call: null, status: null, quiet: true };
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
/**
 * ixigo's login cookie: its page's code sets `at` when a login lands, its expiry fixed from that moment, and clears it when
 * ixigo refuses it. Go reads its name and expiry alone, never its value (Bash's cookie read answers with no values).
 */
export const LOGIN_COOKIE = 'at';
const COOKIE_SITE = 'ixigo.com';
/** How often Go reads the browser's `at` while the person logs in on Watch. One browser-level read: no page, no tab. */
export const LOGIN_POLL_MS = 2_000;
/**
 * Past this long from the tap, the read comes every LOGIN_POLL_SLOW_MS: a login that has not landed in 30 s is a person
 * reading a code, and every read is a request Bash counts against Go (11 Oct: about 50 a minute from two waits, and
 * "Every /v1 key is resting" on the next Log in to ixigo).
 */
export const LOGIN_POLL_FAST_FOR_MS = 30_000;
export const LOGIN_POLL_SLOW_MS = 5_000;
/** A one-tap login shows "I'm logged in" only when Go has seen nothing land this long (Bash's read gone quiet, say). */
export const SELF_CHECK_MS = 60_000;
/** How often Go looks over the one-tap logins (sweep): a restart of Go loses at most this much of a person's wait. */
export const LOGIN_SWEEP_MS = 60_000;
/** How long the hand-off's tab stays in front for them: Bash's most. I'm logged in or Not now closes it sooner. */
export const HANDOFF_MS = 600_000;
/**
 * ixigo's own button that opens its log in: "Log in/Sign up" on its desktop page, where the hand-off logs in (its device
 * desktop: a login made on ixigo's phone page is its phone client's, and its desktop pages, where Go reads, refused it
 * within the hour; staging, 10 Oct), opening a 440 wide drawer with the mobile box, Continue and Google's button; "Login"
 * on its phone page, where a Bash without desktop hand-offs opens it. ?loginVisible=true opens nothing (8 Oct).
 */
const LOGIN_BUTTON = { desktop: { op: 'click', role: 'button', name: 'Log in/Sign up' }, phone: { op: 'click', role: 'button', name: 'Login' } } as const;
/**
 * ixigo's desktop log in drawer (a 440 wide dialog, the page's height): the person's screen shows it alone (Bash's
 * front_crop), so a phone sees the drawer at about 1:1, never the whole desktop page (the App team, 10 Oct: "the login
 * showed a laptop view of the browser instead of the mobile view").
 */
const LOGIN_DRAWER: CropTo = { role: 'dialog' };
/** The log in sheet's mobile number field ("Enter Mobile Number"), clicked so the cursor waits in it for the person. */
const MOBILE_BOX = { op: 'click', role: 'textbox', text: 'mobile' } as const;
/** ixigo's home page, where the log in sheet opens. */
export const LOGIN_URL = 'https://www.ixigo.com/';
/** The first ask, at setup or at a trip's first search, when Go's hello went without it. */
const FIRST_LINE = "{name}, link ixigo for the trip: one login on the trip's computer, about a minute.";
/** The ask when the person's browser lost the login (the keep-alive, another trip's check), at the trip's next travel talk. */
const GONE_LINE = "{name}, ixigo logged Go's computer out: one login brings it back, about a minute.";
/**
 * The model's note while someone's login card is up with its own line (p2's re-run #24, 11 Oct: the card's line asked
 * Rahul to log in, and Go's reply asked him again). The card is the ask: the reply never asks for the login again, and
 * says only what it adds, what Go does once they're in ("once Rahul's logged in, I'll re-check and book it").
 */
export const cardIsTheAsk = (name: string, next: string): string =>
  `${name}'s login card is up in the chat with its own line: that is the ask. Never ask ${name} or anyone to log in again, and never point at the card. ` +
  `If your reply says anything about it, say only what it adds, in a few words: "once ${name}'s logged in, ${next}". Never ask for a number or a code in the chat.`;

/** The hello's last line, for the person asked, with the login card on the same message: the login before anything else. */
export const HELLO_LINE = '{name}, link ixigo once with one tap and I can book for everyone.';

/**
 * How a line in the chat names the person it asks: their first name, as a friend would ("Nishanth", never "Nishanth
 * Gunupudi": p2's audit, 11 Oct). The card keeps the whole name.
 */
const addressOf = (name: string): string => (name === ORGANIZER ? name : name.trim().split(/\s+/)[0] || name);
const ORGANIZER = 'the organizer';

export type LoginState = 'asked' | 'logging_in' | 'logged_in' | 'skipped' | 'logged_out';

/**
 * A booking ask that waits on the trip's login (travel/web-stays.ts): what it books, said in the ask's line, and the
 * set_mandate call to carry on with, which the composer makes when the login is in.
 */
export interface Parked {
  what: string;
  resume: Record<string, unknown>;
}

/** The browser's `at` cookie as Go last read it: its expiry (null for one that lasts while the browser runs), or null with none. */
export type LoginCookie = { expiresAt: number | null } | null;

/**
 * A one-tap login Go watches land by itself, kept on its row so a restart of Go picks it up where it was: when Log in was
 * tapped (ms), and the `at` cookie as last read, once a read has answered (known).
 */
export interface OneTap {
  tappedAt: number;
  known: boolean;
  cookie: LoginCookie;
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
  /** Null unless Go watches this login land by itself (one tap). Written only by its own steps, never by save. */
  oneTap?: OneTap | null;
}

export interface LoginDeps {
  pool: pg.Pool;
  link: Pick<ServerLink, 'request'>;
  packs: Pick<Packs, 'get'>;
  /** The trip's browser fetch, its hand-off in front included; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read' | 'handOff' | 'release' | 'tabSteps' | 'cookies'> | null;
  /** The jobs lane: a login started as a job before the hand-off had no model (a row with a taskId) is settled there. */
  tasks: () => Pick<Tasks, 'handoff' | 'stop'> | null;
  /** A fresh session on the trip's screen, in control or to view (POST /v1/sessions); null with no trip computer here. */
  screen: () => ((tripId: string, mode: 'view' | 'control', o?: { driver?: 'user' }) => Promise<{ id?: string; url: string; expires_at: string }>) | null;
  /** Ends a session now (DELETE /v1/sessions/{id}): Bash's Watch page then closes itself. Null with no trip computer here. */
  endScreen?: () => ((sessionId: string) => Promise<void>) | null;
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
  /**
   * For a recipe or a booking that needs the login: ok, or the line for the model (and the person was asked). A booking
   * (park) is asked with its own line ("To book Saudades I need ixigo linked once, Rahul") and waits on the login: when
   * the login is in, the composer wakes and carries on with it. booking: money is about to move, so ixigo is read now
   * unless it said in within BOOKING_RECHECK_MS: a token it refuses flips the browser and asks, never failing silently.
   */
  /**
   * for: who is asked first, when they can be: the person whose booking needs it (the lead, 11 Oct: anyone in the trip
   * can log in on the trip's computer, and Keshav's booking asked Saket, the organizer). Else the one asked before, else
   * the organizer.
   */
  ensure(tripId: string, what: string, o?: { park?: Parked; booking?: boolean; for?: string }): Promise<{ ok: true } | { ok: false; note: string }>;
  /**
   * Someone in the chat asked to log in to ixigo (again): the card goes up now for whoever logs in for the trip (the one
   * asked before while they can be, else the organizer: the trip's browser is theirs), whatever the wait between asks,
   * since a person asked. ixigo is read first when Go holds a login: logged in, nothing goes up and the note says so.
   * The note is the model's: it names who logs in, so someone else who asked hears whose login it is.
   */
  askNow(tripId: string, askerId: string | null): Promise<{ posted: boolean; note: string }>;
  /**
   * ixigo's own answer for the trip's browser: in, out, or unknown (the page never said); challenged when its page stayed
   * on Cloudflare's check, which says nothing about the login either way. Out on a login Go held lets it go (logged out),
   * so the next booking asks again.
   */
  status(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged'>;
  /**
   * The keep-alive's read (login-keepalive.ts): status's, except that a quiet page (it booted, none of the login's calls
   * came) says quiet, for the keep-alive to read again CONFIRM_OUT_MS on. The read that confirms it (confirming: quiet or
   * out again), or an out, ends the login and asks its person in the trip, once, with the login card as a first ask
   * does: Go never waits for a booking to find it gone.
   */
  keepAlive(tripId: string, o?: { confirming?: boolean }): Promise<'in' | 'out' | 'unknown' | 'challenged' | 'quiet'>;
  onEvent(ev: C.Event): Promise<void>;
  /**
   * A person gone from their login: they left the trip, or used "Forget me" in it. When the trip's login is theirs, Go
   * logs the trip's computer out of ixigo (in the background) and the card says why. Travel calls it on person.left; the
   * memory lane's forget_person calls it through brain.ixigoLogin.
   */
  personGone(tripId: string, personId: string, why: 'left' | 'forgot'): Promise<void>;
  /**
   * The minute's look at one-tap logins (level-triggered: what the rows say, whatever this process remembers): one still
   * in its time with no wait running here (Go restarted) is watched again; one past its time ends as a hand-off does.
   */
  sweep(): Promise<void>;
  /**
   * Hears a trip's login land (whatever saw it: the one-tap watch, "I'm logged in", a check), once per login: a flight
   * booking that waited on it carries on (booking/flight-booking.ts resumeWaiting).
   */
  onLoggedIn(fn: (tripId: string) => void): void;
  /** Waits for the work taps started in the background (tests). */
  settled(): Promise<void>;
}

const cardId = (tripId: string, attempt: number): string => `c_login_${tripId}_${attempt}`;
/** The taps on the page in front: the desktop page's drawer is what the person's screen shows once they open it. */
const tapsOf = (device: 'phone' | 'desktop' | undefined): { keepOpenMs: number; timeoutMs: number; crop?: CropTo } =>
  ({ keepOpenMs: HANDOFF_MS, timeoutMs: HANDOFF_PAGE_MS, ...(device === 'desktop' ? { crop: LOGIN_DRAWER } : {}) });

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
 * ixigo didn't take, ixigo's page held on Cloudflare's check (challenge), or a login cookie ixigo then refused (not_kept).
 */
type Note = 'opening' | 'not_yet' | 'not_opened' | 'expired' | 'left' | 'forgot' | 'logout_failed' | 'challenge' | 'not_kept';
const day = (at: Date): string => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * The login card for where things stand: who it is for, what it says, and the buttons only they see. selfCheck: a one-tap
 * login Go is watching land by itself, so the card has no "I'm logged in" (for its first SELF_CHECK_MS).
 */
export function loginCard(
  row: Pick<LoginRow, 'tripId' | 'personId' | 'state' | 'attempt' | 'loggedInAt'>,
  name: string,
  note?: Note,
  o: { selfCheck?: boolean } = {},
): C.Card {
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
            : note === 'not_kept'
              ? "ixigo didn't keep the login on Go's computer. Tap Log in to ixigo to try again."
              : note === 'expired'
              ? "ixigo's log in closed on Go's screen after 10 minutes. Tap Log in to ixigo to open it again."
              : `One login on Go's computer lets Go check fares, hold them and book for the group. ${name} logs in on Go's screen with their mobile number and its code; Go never sees either. Trip searches and bookings then use ${name}'s ixigo account, and the group never sees its details.`,
        actions: [button('ixigo_login', 'Log in to ixigo', 'primary'), button('ixigo_not_now', 'Not now', 'secondary')],
        fallback_text: `${addressOf(name)}, log in to ixigo once on Go's computer so Go can check fares and book.`,
      };
    case 'logging_in':
      return {
        ...base,
        // Not logged in yet: a heads-up, so the room's sheet shows the line to the person looking at it.
        ...(note === 'not_yet' ? { tone: 'heads_up' as const } : {}),
        title: 'Logging in to ixigo',
        body: note === 'not_yet'
          ? "Not logged in yet. Finish on Go's screen, then tap I'm logged in again."
          : note === 'opening'
            ? `Opening ixigo's log in on Go's screen for ${name}.`
            : o.selfCheck
              ? `ixigo's log in is open on Go's screen. ${name}: log in there with your mobile number, and Go carries on by itself. Log in to ixigo opens it again.`
              : `ixigo's log in is open on Go's screen. ${name}: log in there with your mobile number, then tap I'm logged in. Log in to ixigo opens it again.`,
        // Keshav, 10 Oct: "there is no point of watch buttons etc. Login button appears, click login, open the browser
        // immediately, and when logged in automatically continue." One button opens Go's screen, and opens it again: Log in
        // to ixigo, for the person logging in alone (anyone else would watch them type their number). A card that no
        // longer offers it is a login over, and the App closes the view it opened from it. I'm logged in only once Go has
        // seen nothing land for SELF_CHECK_MS, or where it can't see a login land at all.
        actions: [
          button('ixigo_login', 'Log in to ixigo', 'primary'),
          ...(o.selfCheck ? [] : [button('ixigo_logged_in', "I'm logged in", 'secondary')]),
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
  /** Who hears a trip's login land (onLoggedIn). */
  const loggedInListeners: Array<(tripId: string) => void> = [];
  /** The trips whose one-tap login this process is watching now (from the tap until the wait ends). */
  const waiting = new Set<string>();
  const track = (what: string, tripId: string, p: Promise<void>): void => {
    const q = p.catch((err: unknown) => d.log.warn({ err, tripId }, `travel: the ixigo login's ${what} failed`));
    inFlight.add(q);
    void q.finally(() => inFlight.delete(q));
  };

  async function get(tripId: string): Promise<LoginRow | null> {
    const { rows } = await d.pool.query<{
      person_id: string; state: LoginState; attempt: number; task_id: string | null; asked_at: Date; logged_in_at: Date | null; checked_at: Date | null;
      parked: Parked | null; one_tap: OneTap | null;
    }>('select person_id, state, attempt, task_id, asked_at, logged_in_at, checked_at, parked, one_tap from ixigo_logins where trip_id = $1', [tripId]);
    const r = rows[0];
    return r
      ? {
        tripId, personId: r.person_id, state: r.state, attempt: r.attempt, taskId: r.task_id, askedAt: r.asked_at, loggedInAt: r.logged_in_at, checkedAt: r.checked_at,
        parked: r.parked, oneTap: r.one_tap,
      }
      : null;
  }

  /**
   * The login to logging in, in one step on its row, unless it is logging in already: then null, and the tap starts
   * nothing. A logging-in row older than HANDOFF_MS is one whose end Go never saw (a restart): it is taken again.
   */
  async function claim(row: LoginRow): Promise<LoginRow | null> {
    const now = d.now();
    const r = await d.pool.query(
      `update ixigo_logins set state = 'logging_in', task_id = null, one_tap = null, updated_at = $2
       where trip_id = $1 and (state <> 'logging_in' or updated_at < $3)`,
      [row.tripId, now, new Date(now.getTime() - HANDOFF_MS)],
    );
    return r.rowCount ? { ...row, state: 'logging_in', taskId: null, oneTap: null } : null;
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
    return pack.trip.people.find((p) => p.person_id === personId)?.name ?? ORGANIZER;
  }

  async function show(row: LoginRow, note?: Note): Promise<void> {
    const card = loginCard(row, await nameOf(row.tripId, row.personId), note, { selfCheck: selfChecking(row) });
    await d.link.request('replace_card', { trip_id: row.tripId, card });
  }

  /** Asks one person, with a line naming them and a fresh card (an earlier card is far up the chat by now). */
  async function ask(tripId: string, personId: string, attempt: number, line: string, parked: Parked | null = null): Promise<void> {
    const row: LoginRow = { tripId, personId, state: 'asked', attempt, taskId: null, askedAt: d.now(), loggedInAt: null, checkedAt: null, parked };
    await save(row);
    const name = await nameOf(tripId, personId);
    await d.link.request('post_message', {
      request_id: `go_login_${tripId}_${attempt}`, trip_id: tripId, text: line.replaceAll('{name}', addressOf(name)), mentions: [personId], card: loginCard(row, name),
    });
  }

  /**
   * ixigo's answer from its page's calls, logged for the stage desk by call and status alone: never the account. In or out
   * is the person's browser's, for every trip of theirs (tasks/browsers.ts).
   */
  async function said(tripId: string, captures: Capture[], where: string): Promise<'in' | 'out' | 'unknown' | 'quiet'> {
    const { login, call, status: s, quiet } = loginFrom(captures);
    d.log.info(
      { tripId, login, call, status: s, ...(quiet ? { quiet: true } : {}), calls: captures.map((c) => `${c.match} ${c.status}`), where },
      'travel: ixigo said whether the trip computer is logged in',
    );
    // A quiet read is never kept as the browser's on its own: the read that confirms it says so (ended).
    if (login !== 'unknown' && !quiet) {
      await d.browser?.()?.setLogin(tripId, login).catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the browser's login was not kept"));
    }
    return quiet ? 'quiet' : login;
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
  async function look(tripId: string): Promise<'in' | 'out' | 'unknown' | 'challenged' | 'quiet'> {
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
      await ended(tripId);
      return 'out';
    }
    // One quiet read says nothing here: the keep-alive reads again to confirm (keepAlive).
    return s === 'quiet' ? 'unknown' : s;
  }

  /** ixigo has no login in the trip's browser: the browser says out on every trip of the person's, and this trip's ends. */
  async function ended(tripId: string): Promise<LoginRow | null> {
    await d.browser?.()?.setLogin(tripId, 'out').catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the browser's login was not kept"));
    const row = await get(tripId);
    if (row?.state !== 'logged_in') return row;
    const out: LoginRow = { ...row, state: 'logged_out', checkedAt: d.now() };
    await save(out);
    d.log.info({ tripId }, "travel: ixigo no longer has the trip computer's login; the next booking asks again");
    // A trip that took its login from the person's browser never had a card to change: the card is best effort.
    track('card', tripId, show(out));
    return out;
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
    if (row.state !== 'logged_in') for (const fn of loggedInListeners) fn(row.tripId);
    return next;
  }

  /** ixigo's own menu: the greeting at the top ("Hey Keshav") opens it, and its "Log out" link logs the browser out. */
  async function logout(row: LoginRow, why: 'asked' | 'left' | 'forgot'): Promise<void> {
    const runner = d.runner();
    if (runner) {
      try {
        // The home page's content is the one capture Bash waits for: it refuses a fetch with none required and no
        // page_fetch step (400 invalid_request), so a plan of clicks alone never ran.
        await runner.read(row.tripId, `${IXIGO}/`, {
          capture: [{ match: PAGE_CONTENT, required: true, max_bytes: 1 }],
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
        request_id: `go_login_${tripId}_0`, trip_id: tripId, text: FIRST_LINE.replace('{name}', addressOf(name)), mentions: [personId], card: loginCard(row, name),
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
    let opened: { captures: Capture[]; challenged?: true; device?: 'phone' | 'desktop' };
    try {
      opened = await runner.handOff!(
        row.tripId,
        LOGIN_URL,
        // The page and ixigo's own calls alone: Watch comes as soon as they have said (its crop is set before the page
        // loads), and the taps run after, while Watch's picture connects (staging, 8 Oct: they were 2 to 3 s of the wait).
        LOGIN_CALLS,
        { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB, device: 'desktop', crop: LOGIN_DRAWER },
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
      // The page is in front for them: the card says so. Then ixigo's Login and the mobile box, tapped on the page they
      // watch (best effort: the page stays theirs if a tap finds nothing), and the page takes the keyboard. A card that
      // can't go out never keeps the taps from the page they are already looking at.
      await show(now).catch((err: unknown) => d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's card did not say the page is open"));
      await runner.tabSteps?.(row.tripId, LOGIN_TAB, [LOGIN_BUTTON[opened.device ?? 'phone'], MOBILE_BOX], tapsOf(opened.device))
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
    let opened: { captures: Capture[]; challenged?: true; device?: 'phone' | 'desktop' };
    try {
      opened = await runner.handOff(tripId, LOGIN_URL, LOGIN_CALLS, { keepOpenMs: HANDOFF_MS, tab: LOGIN_TAB, device: 'desktop', crop: LOGIN_DRAWER });
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
      await runner.tabSteps?.(tripId, LOGIN_TAB, [LOGIN_BUTTON[opened.device ?? 'phone'], MOBILE_BOX], tapsOf(opened.device))
        .catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the ixigo login's taps did not run"));
    }
    // Quiet on the log in page is "not logged in yet", as it always read.
    return login === 'quiet' ? 'unknown' : login;
  }

  /**
   * The hand-off's tab closes, so the person's own window is on top again; one already gone is nothing to close. Every end
   * of a login closes it: logged in, Not now, a hand-off that failed or ran its time, the person gone. Its Watch sessions
   * end with it (Bash's Watch page then closes itself, and its control ends), and its one-tap wait with them.
   */
  async function release(tripId: string): Promise<void> {
    ending.get(tripId)?.();
    ending.delete(tripId);
    const { rows } = await d.pool.query<{ sessions: string[] }>(
      `with was as (select watch_sessions from ixigo_logins where trip_id = $1)
       update ixigo_logins set watch_sessions = '{}', one_tap = null where trip_id = $1 returning (select watch_sessions from was) as sessions`,
      [tripId],
    );
    const end = d.endScreen?.();
    await Promise.all([
      d.runner()?.release?.(tripId, LOGIN_TAB).catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the ixigo login's tab did not close")),
      ...(rows[0]?.sessions ?? []).map((id) => end?.(id).catch((err: unknown) => d.log.warn({ err, tripId }, "travel: the ixigo login's Watch did not end"))),
    ]);
  }

  /**
   * A Watch session on the trip's screen, in the person's hands from its first frame (driver: user: no Take control, no
   * "Bash is driving"; Keshav, 11 Oct), for the person logging in; kept on the row so the login's end ends it.
   */
  async function openWatch(tripId: string): Promise<{ url: string; expires_at: string }> {
    const screen = d.screen();
    if (!screen) throw new Error("no trip computer for the ixigo login's Watch");
    const s = await screen(tripId, 'control', { driver: 'user' });
    if (s.id) await d.pool.query('update ixigo_logins set watch_sessions = array_append(watch_sessions, $2) where trip_id = $1', [tripId, s.id]);
    return { url: s.url, expires_at: s.expires_at };
  }

  /** A one-tap login hides I'm logged in for its first SELF_CHECK_MS: Go is watching the login land itself. */
  function selfChecking(row: LoginRow): boolean {
    return row.state === 'logging_in' && !!row.oneTap && d.now().getTime() - row.oneTap.tappedAt < SELF_CHECK_MS;
  }

  /** The browser's `at` cookie: its expiry when it has one, null with none, undefined when Bash can't say. */
  async function loginCookie(tripId: string): Promise<LoginCookie | undefined> {
    const cookies = await d.runner()?.cookies?.(tripId, COOKIE_SITE, [LOGIN_COOKIE]);
    if (!cookies) return undefined;
    const at = cookies.find((c) => c.name === LOGIN_COOKIE);
    return at ? { expiresAt: at.expiresAt } : null;
  }

  /** The `at` as last read, on the row, while this attempt is still logging in. */
  async function keepCookie(row: LoginRow, cookie: LoginCookie): Promise<void> {
    await d.pool.query(
      `update ixigo_logins set one_tap = one_tap || jsonb_build_object('known', true, 'cookie', $3::jsonb)
       where trip_id = $1 and attempt = $2 and state = 'logging_in' and one_tap is not null`,
      [row.tripId, row.attempt, JSON.stringify(cookie)],
    );
  }

  /**
   * A one-tap login, once its page is in front: Go reads the browser's `at` every LOGIN_POLL_MS. A login landed when `at`
   * is there and was not at the read before, or its expiry moved (ixigo fixes it from the login's moment): on a first-ever
   * login there was none, so its coming is enough. Until a read has answered there is nothing to compare with. Past
   * SELF_CHECK_MS from the tap with nothing seen, the card gets I'm logged in. It ends with the login (any end); at
   * HANDOFF_MS the hand-off ends as its timer would end it (expire), so a restart of Go never leaves one open.
   * What it compares with is kept on the row, so the wait picks up after a restart where it was (sweep).
   */
  async function waitForLogin(row: LoginRow): Promise<void> {
    let fellBack = false;
    for (;;) {
      const sinceTap = row.oneTap ? d.now().getTime() - row.oneTap.tappedAt : 0;
      await sleep(sinceTap < LOGIN_POLL_FAST_FOR_MS ? LOGIN_POLL_MS : LOGIN_POLL_SLOW_MS);
      const now = await get(row.tripId);
      if (now?.state !== 'logging_in' || now.attempt !== row.attempt || !now.oneTap) return;
      const waited = d.now().getTime() - now.oneTap.tappedAt;
      if (waited >= HANDOFF_MS) {
        await expire(now);
        return;
      }
      const at = await loginCookie(row.tripId);
      if (at !== undefined) {
        const last = now.oneTap;
        if (last.known && at && (!last.cookie || at.expiresAt !== last.cookie.expiresAt)) {
          await landed(now);
          return;
        }
        if (!last.known || JSON.stringify(at) !== JSON.stringify(last.cookie)) await keepCookie(now, at);
      }
      if (waited >= SELF_CHECK_MS && !fellBack) {
        fellBack = true;
        await show(now);
      }
    }
  }

  /** The wait for a one-tap login, run once per trip in this process; it ends with the login. */
  function watchLogin(row: LoginRow, before?: Promise<void>): void {
    if (waiting.has(row.tripId)) return;
    waiting.add(row.tripId);
    track('sign-in wait', row.tripId, (async () => {
      await before;
      await waitForLogin(row);
    })().finally(() => waiting.delete(row.tripId)));
  }

  /**
   * ixigo's `at` came: the person's view closes first (the tab, then Watch's session), so they are back in the chat at
   * once, then one quiet read of ixigo confirms it. ixigo refusing it after all (out) puts the card back to its ask; a read
   * that can't say (a quiet page, Cloudflare's check) leaves the cookie standing.
   */
  async function landed(row: LoginRow): Promise<void> {
    await release(row.tripId);
    const s = await look(row.tripId);
    const now = await get(row.tripId);
    // Not now (or another try) while ixigo was read: this login is no longer theirs to finish.
    if (now?.state !== 'logging_in' || now.attempt !== row.attempt) return;
    d.log.info({ tripId: row.tripId, confirm: s }, "travel: ixigo's login cookie came on the trip computer");
    if (s === 'out') {
      const back: LoginRow = { ...now, state: 'asked' };
      await save(back);
      await show(back, 'not_kept');
      return;
    }
    if (s !== 'in') await d.browser?.()?.setLogin(row.tripId, 'in').catch((err: unknown) => d.log.warn({ err, tripId: row.tripId }, "travel: the browser's login was not kept"));
    await show(await loggedIn(now, { carryOn: true }));
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

  /**
   * Go's screen again for a log in already open: a fresh session in control, never a second page. A one-tap login with no
   * wait running here (Go restarted since the tap) is watched again.
   */
  async function reopen(row: LoginRow): Promise<CardTapResult> {
    try {
      const s = await openWatch(row.tripId);
      if (row.oneTap && d.runner()?.cookies) watchLogin(row);
      return { result: 'open', url: s.url, expires_at: s.expires_at };
    } catch (err) {
      d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's screen did not open again");
      return { result: 'refused', toast: "Can't open Go's screen right now" };
    }
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
      const name = i.pack.trip.people.find((p) => p.person_id === row.personId)?.name ?? ORGANIZER;
      return { card: loginCard(row, name), line: HELLO_LINE.replace('{name}', addressOf(name)) };
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

    registerTaps(taps) {
      taps.on('notice', 'ixigo_login', forPerson(async (row) => {
        const runner = d.runner();
        if (!d.live() || !runner?.handOff) return { result: 'refused', toast: "Go's computer isn't browsing ixigo right now." };
        if (row.state === 'logged_in') return { result: 'done', toast: 'ixigo is already logged in' };
        // One hand-off per login: a tap while its page opens or is open (a double tap, or the person back for it) opens
        // Go's screen again, never a second page over the first (Keshav, 8 Oct: the second one's measuring cut it off).
        const next = await claim(row);
        if (!next) return reopen(row);
        // Go's screen opens now, in control, and the page comes in front in it. Where Go can read the browser's cookies, it
        // sees the login land by itself: the `at` before the page loads is read first, to tell a new login from the old.
        let watch: { url: string; expires_at: string } | null = null;
        try {
          watch = await openWatch(row.tripId);
        } catch (err) {
          d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's screen did not open; Log in to ixigo opens it again");
        }
        let shown = next;
        if (watch && runner.cookies) {
          const oneTap: OneTap = { tappedAt: d.now().getTime(), known: false, cookie: null };
          await d.pool.query("update ixigo_logins set one_tap = $3 where trip_id = $1 and attempt = $2 and state = 'logging_in'", [row.tripId, next.attempt, JSON.stringify(oneTap)]);
          shown = { ...next, oneTap };
        }
        const before = shown.oneTap ? loginCookie(row.tripId).then((at) => (at === undefined ? undefined : keepCookie(shown, at))).catch(() => undefined) : null;
        // The card first (opening), then the page: whatever the hand-off finds is said after it, never under it. The person
        // is on Go's screen already, so a card that can't go out never keeps the page from them (prod, 11 Oct 08:13Z: the
        // opening card's failure stopped the hand-off, and the screen stayed on a new tab).
        const page = (async () => {
          await show(shown, 'opening').catch((err: unknown) => d.log.warn({ err, tripId: row.tripId }, "travel: the ixigo login's card did not say opening"));
          await handOff(shown, runner);
        })();
        track('hand-off', row.tripId, page);
        // The wait starts once the page is in front (a hand-off that ended the login ends it at once).
        if (before) watchLogin(shown, Promise.all([page.catch(() => undefined), before]).then(() => undefined));
        return watch ? { result: 'open', url: watch.url, expires_at: watch.expires_at } : { result: 'done', toast: "Opening ixigo's log in on Go's screen" };
      }));

      // Watch, on a login card from before Log in opened Go's screen itself (10 Oct): it opens the screen again, as Log in
      // does now. Only the person logging in, with control: nobody else sees their number typed.
      taps.on('notice', 'ixigo_watch', forPerson(async (row) => {
        if (row.state !== 'logging_in' || !d.screen()) return { result: 'refused', toast: "ixigo's log in isn't open on Go's screen now" };
        return reopen(row);
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

    async askNow(tripId, askerId) {
      if (!d.live()) return { posted: false, note: "Go doesn't browse ixigo.com itself for this trip, so there is no ixigo login to make: say so in one line." };
      const row = await get(tripId);
      if (row?.state === 'logging_in') {
        const name = await nameOf(tripId, row.personId);
        return { posted: false, note: `${name} is logging in to ixigo on Go's screen right now: say so in one line.` };
      }
      const pack = await d.packs.get(tripId);
      const forgot = new Set(
        (await d.pool.query<{ person_id: string }>('select person_id from forgotten where trip_id = $1', [tripId])).rows.map((r) => r.person_id),
      );
      const can = (id: string | null | undefined): id is string =>
        !!id && !forgot.has(id) && pack.trip.people.some((p) => p.person_id === id && !p.go_paused);
      const personId = row !== null && can(row.personId)
        ? row.personId
        : can(pack.trip.organizer_person_id)
          ? pack.trip.organizer_person_id
          : pack.trip.people.find((p) => can(p.person_id))?.person_id;
      if (!personId) return { posted: false, note: 'Nobody in the trip can log in to ixigo for it now: say so in one line.' };
      const name = await nameOf(tripId, personId);
      const theirs = askerId !== null && askerId !== personId ? ` The trip's ixigo login is on ${name}'s browser, so it is ${name}'s to do.` : '';
      // A login Go holds is read again now: the person asking may know it ended before Go does.
      if (row?.state === 'logged_in' && (await status(tripId)) === 'in') {
        return { posted: false, note: `ixigo is logged in for the trip, on ${name}'s browser: say so in one line.${theirs} If they still want a fresh login, ${name} can tap Log out on the ixigo card first.` };
      }
      const line = askerId === personId
        ? "{name}, here's the ixigo login: tap Log in to ixigo on the card, about a minute on the trip's computer."
        : "The trip's ixigo login is on {name}'s browser. {name}, tap Log in to ixigo on the card, about a minute on the trip's computer.";
      await ask(tripId, personId, row ? row.attempt + 1 : 0, line, row?.parked ?? null);
      return { posted: true, note: `Go put the login card up for ${name}, with its own line.${theirs} Say nothing more about it, and never ask for a number or a code in the chat.` };
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
            note: `${what} needs the trip's ixigo login, and ${name} is logging in on Go's screen now. ${cardIsTheAsk(name, park ? `I'll re-check ${park.what} and book it` : "I'll carry on")}`,
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
      // The person whose booking it is, when they can be asked; else the one asked before, while they are still in the
      // trip and can be; else the organizer; else the first member who can be (the organizer used Forget me).
      const personId = can(o.for)
        ? o.for
        : row !== null && can(row.personId)
        ? row.personId
        : can(pack.trip.organizer_person_id)
          ? pack.trip.organizer_person_id
          : pack.trip.people.find((p) => can(p.person_id))?.person_id;
      if (!personId) return { ok: false, note: `${what} needs the trip's ixigo login, and nobody can be asked for it now. Say so in one line.` };
      const name = await nameOf(tripId, personId);
      // One login card per trip while it is up and unanswered (p2's re-audit, 11 Oct: the same ask twice in two minutes,
      // the first right after the rooms card, then a booking's): a booking parks on the card that is up, and the reply
      // says what comes once the login is in. Someone new (the one asked used Forget me) is asked at once; the same
      // person again once the last ask was answered (a login that ended) or half an hour on, far up the chat by then.
      if (!row || row.personId !== personId || row.state !== 'asked' || now - row.askedAt.getTime() >= ASK_AGAIN_MS) {
        const line = park ? `To book ${park.what} I need ixigo linked once, {name}: one login on the trip's computer, about a minute.` : "{name}, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.";
        await ask(tripId, personId, row ? row.attempt + 1 : 0, line, park);
        // Go's line and the card are the ask: the reply adds only what comes once the login is in.
        if (park) return { ok: false, note: `Booking ${park.what} waits on the trip's ixigo login, and Go carries on with it once the login is in. ${cardIsTheAsk(name, `I'll re-check ${park.what} and book it`)}` };
      } else if (park && row) {
        await save({ ...row, parked: park });
        return { ok: false, note: `Booking ${park.what} waits on the trip's ixigo login, and Go carries on with it once the login is in. ${cardIsTheAsk(name, `I'll re-check ${park.what} and book it`)}` };
      }
      return { ok: false, note: `${what} needs the trip's ixigo login. ${cardIsTheAsk(name, "I'll carry on")}` };
    },

    status,

    async keepAlive(tripId, o = {}) {
      const s = await look(tripId);
      if (s === 'quiet' && !o.confirming) return 'quiet';
      if (s !== 'out' && s !== 'quiet') return s;
      const row = await ended(tripId);
      // Asked once, with a fresh card: the browser now says out, so the keep-alive reads it no more until a login brings
      // it back. Never hangs on the old card: a trip that took its login from the browser has none (staging, 10 Oct
      // 08:13, "card ... is not on one of Go's messages"), and its replace goes on its own (ended). A trip with no login
      // row at all is asked as a first ask is (nudge).
      if (!row) {
        this.nudge(tripId);
      } else if (row.state === 'logged_out') {
        await ask(tripId, row.personId, row.attempt + 1, GONE_LINE);
        d.log.info({ tripId, personId: row.personId, attempt: row.attempt + 1 }, "travel: the trip's ixigo login ended; its person asked to log in again");
      }
      return 'out';
    },

    async onEvent(ev) {
      if (ev.type === 'person.left') await personGone(ev.trip_id, ev.data.person_id, 'left');
    },

    personGone,

    onLoggedIn(fn) {
      loggedInListeners.push(fn);
    },

    async sweep() {
      if (!d.live() || !d.runner()?.cookies) return;
      const { rows } = await d.pool.query<{ trip_id: string }>("select trip_id from ixigo_logins where state = 'logging_in' and one_tap is not null");
      for (const r of rows) {
        if (waiting.has(r.trip_id)) continue;
        const row = await get(r.trip_id);
        if (row?.state !== 'logging_in' || !row.oneTap) continue;
        if (d.now().getTime() - row.oneTap.tappedAt >= HANDOFF_MS) track('end', row.tripId, expire(row));
        else watchLogin(row);
      }
    },

    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}

const NoInput = z.object({}).strict();

/**
 * The login on request: someone in the chat asks to log in to ixigo, or says Go's ixigo is logged out. The card and its
 * line are the answer, so the turn ends on them (one Go post, never two in a row).
 */
export function ixigoLoginTool(login: Pick<IxigoLogin, 'askNow'>): QuickTool<z.infer<typeof NoInput>> {
  return {
    name: 'ixigo_login',
    description:
      "Puts the ixigo login card up now, when someone asks to log in to ixigo (again) or says Go's ixigo is logged out. It goes to " +
      'whoever logs in for the trip, with a line saying whose login it is. Never ask for a number or a code in the chat.',
    input: NoInput,
    // A login Go holds is read on ixigo first: one page, a few seconds on a sleeping box.
    timeoutMs: 15_000,
    async run(_args, ctx) {
      // The person who asked: the newest message the turn woke for.
      const ids = new Set(ctx.wake.flatMap((i) => (i.kind === 'message' ? [(i.payload as { messageId?: string } | null)?.messageId ?? i.ref] : [])));
      const asked = [...ctx.pack.messages].reverse().find((m) => ids.has(m.message_id));
      const r = await login.askNow(ctx.tripId, asked?.author.kind === 'person' ? asked.author.person_id : null);
      if (r.posted) ctx.answered = true;
      return { note: r.note };
    },
  };
}
