/**
 * One person's ixigo login on the trip's computer. Keshav's word: "when the trip creates, that's when we [make] the ixigo
 * connection, and all the warming should happen; connection as in ixigo should be logged in, so prompt someone to login".
 * One setup flow at trip.created: the box is made (travel.computer), ixigo is opened and warmed on it (travel.ixigo_warm),
 * and right after, Go prompts the organizer with one line and a card pinned to them. Nothing waits on the login: searches
 * work logged out. "Not now" is fine, and Go asks again the first time a recipe needs the login (auth: login). The person logs in
 * themselves on Go's screen: their tap starts a job on the trip's computer that opens ixigo's login and hands the
 * browser to them (the working card's Watch, in control), and they type their own number and code. Go never sees
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
import type { Packs } from '../trips/pack.js';
import type { Tasks } from '../tasks/tasks.js';
import { returnsSchema } from '../tasks/returns.js';
import { TravelError } from './mcp-travel.js';
import { IXIGO, type Capture } from './recipes/recipe.js';
import type { RecipeRunner } from './recipes/runners.js';

/** ixigo's own call that says whether the browser is logged in (about 900 bytes logged in), read by its status only. */
export const USERINFO = '/api/v2/oauth/userinfo';
/** A login is taken as it stands for this long, then checked again the next time a recipe needs it. */
export const RECHECK_MS = 6 * 3600_000;
/** Asked again at most this often when recipes keep needing a login nobody has made. */
const ASK_AGAIN_MS = 30 * 60_000;
/** Setup asks only a trip made this recently; an older one is asked the first time a recipe needs the login. */
const NEW_TRIP_MS = 24 * 3600_000;
/** The setup step that opens and warms ixigo on the new computer (IXIGO_WARM_STEP in warm.ts, p4's #218): the prompt
 *  follows it in the same setup pass, whether the warm worked or gave up after its tries. */
export const AFTER_WARM = 'travel.ixigo_warm';

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
  /** The trip's browser fetch; null while the trip's computer is not set up here. */
  runner: () => Pick<RecipeRunner, 'read'> | null;
  /** The jobs lane: the login is a job that opens ixigo's login and hands the browser to the person. */
  tasks: () => Pick<Tasks, 'start' | 'handoff'> | null;
  /** Whether Go searches ixigo.com itself (TRAVEL_MODE ixigo_web): only then is there a login to ask for. */
  live: () => boolean;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

export interface IxigoLogin {
  /** The setup step that asks the organizer, once Go has greeted the trip. */
  setupStep: SetupStep;
  registerTaps(taps: Pick<TapRouter, 'on'>): void;
  /** For a recipe that needs the login: ok, or the line for the model (and the person was asked). */
  ensure(tripId: string, what: string): Promise<{ ok: true } | { ok: false; note: string }>;
  /** ixigo's own answer for the trip's browser: in, out, or unknown (the page never said). */
  status(tripId: string): Promise<'in' | 'out' | 'unknown'>;
  onEvent(ev: C.Event): Promise<void>;
  /** Waits for the work taps started in the background (tests). */
  settled(): Promise<void>;
}

const cardId = (tripId: string, attempt: number): string => `c_login_${tripId}_${attempt}`;
const day = (at: Date): string => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** The login card for where things stand: who it is for, what it says, and the buttons only they see. */
export function loginCard(row: Pick<LoginRow, 'tripId' | 'personId' | 'state' | 'attempt' | 'loggedInAt'>, name: string, note?: 'not_yet' | 'left' | 'logout_failed'): C.Card {
  const only = [row.personId];
  const button = (action_id: string, label: string, style: 'primary' | 'secondary'): C.CardAction => ({ action_id, label, style, only_for_person_ids: only });
  const base = { card_id: cardId(row.tripId, row.attempt), kind: 'notice' as const, tone: 'info' as const, for_person_ids: only };
  switch (row.state) {
    case 'asked':
      return {
        ...base,
        title: 'Link ixigo for this trip',
        body: `One login on Go's computer lets Go check fares, hold them and book for the group. ${name} logs in on Go's screen with their own phone; Go never sees the number or the code. Trip searches and bookings then use ${name}'s ixigo account, and the group never sees its details.`,
        actions: [button('ixigo_login', 'Log in to ixigo', 'primary'), button('ixigo_not_now', 'Not now', 'secondary')],
        fallback_text: `${name}, log in to ixigo once on Go's computer so Go can check fares and book.`,
      };
    case 'logging_in':
      return {
        ...base,
        title: 'Logging in to ixigo',
        body: note === 'not_yet'
          ? "Go can't see ixigo logged in yet. Finish the login on Go's screen (Watch on its card), then tap I'm logged in again."
          : `Go is opening ixigo's login on its screen. When Go says it needs ${name}, tap Watch on its card, log in with your phone, then tap I'm logged in here.`,
        actions: [button('ixigo_logged_in', "I'm logged in", 'primary'), button('ixigo_not_now', 'Not now', 'secondary')],
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
        body: note === 'left' ? `${name} left the trip, so Go logged out of ixigo on its computer.` : `Go's computer is no longer logged in to ixigo as ${name}.`,
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

  async function show(row: LoginRow, note?: 'not_yet' | 'left' | 'logout_failed'): Promise<void> {
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
      if (err instanceof TravelError) return 'unknown';
      throw err;
    }
    const s = captures.find((c) => c.url.includes(USERINFO))?.status;
    return s === 200 ? 'in' : s === 401 || s === 403 ? 'out' : 'unknown';
  }

  async function loggedIn(row: LoginRow): Promise<LoginRow> {
    const now = d.now();
    const next: LoginRow = { ...row, state: 'logged_in', loggedInAt: row.state === 'logged_in' ? row.loggedInAt : now, checkedAt: now };
    await save(next);
    return next;
  }

  /** ixigo's own menu: the greeting at the top ("Hey Keshav") opens it, and its "Log out" link logs the browser out. */
  async function logout(row: LoginRow, why: 'asked' | 'left'): Promise<void> {
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
    await show(out, why === 'left' ? 'left' : undefined);
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
      after: AFTER_WARM,
      async run(tripId) {
        // Nothing to log in to while Go doesn't browse ixigo.com; a recipe that needs the login asks then.
        if (!d.live() || (await get(tripId))) return;
        const pack = await d.packs.get(tripId);
        // A trip that was going before the login came (the setup sweep reaches those too) is asked when a recipe needs it.
        if (d.now().getTime() - Date.parse(pack.trip.created_at) > NEW_TRIP_MS) return;
        if (!pack.messages.some((m) => m.author.kind === 'go')) throw new Error('waits for Go to greet the trip');
        const organizer = pack.trip.people.find((p) => p.person_id === pack.trip.organizer_person_id && !p.go_paused);
        if (!organizer) return;
        await ask(tripId, organizer.person_id, 0, "{name}, link ixigo for the trip: one login on the trip's computer, about a minute.");
      },
    },

    registerTaps(taps) {
      taps.on('notice', 'ixigo_login', forPerson(async (row, tap) => {
        const tasks = d.tasks();
        if (!d.live() || !tasks) return { result: 'refused', toast: "Go's computer isn't browsing ixigo right now." };
        if (row.state === 'logged_in') return { result: 'done', toast: 'ixigo is already logged in' };
        const name = await nameOf(row.tripId, row.personId);
        const job = await tasks.start(row.tripId, {
          goal:
            "Open https://www.ixigo.com/ in the browser and open its log in (the Log in button at the top of the page). Then hand the browser to the person so they log in themselves with their own mobile number and the one-time code. Never type, read, copy or keep a number, a code, a name or an email, and never open a page under /payments/. When they say they are done, say in the summary only whether the page's top bar greets a logged-in person; never say who.",
          returns: returnsSchema('answer'),
          returnsKind: 'answer',
          context: {},
          title: 'Logging in to ixigo',
          steps: ["Opening ixigo's login", `${name} logs in`, 'Checking the login'],
          askedBy: row.personId,
          // One job a tap: a tap Go already answered gets its first answer back, and another tap is another try.
          key: `ixigo_login_${tap.tap_id}`,
        });
        const next: LoginRow = { ...row, state: 'logging_in', taskId: job.taskId };
        await save(next);
        track('card', row.tripId, show(next));
        return { result: 'done', toast: "Opening ixigo on Go's computer" };
      }));

      taps.on('notice', 'ixigo_logged_in', forPerson(async (row) => {
        if (row.state !== 'logging_in') return { result: 'done' };
        track('check', row.tripId, (async () => {
          // The job's hand-off, settled for them: the job then looks at the page and ends.
          if (row.taskId) await d.tasks()?.handoff(row.taskId, 'done').catch(() => undefined);
          if ((await status(row.tripId)) === 'in') await show(await loggedIn(row));
          else await show(row, 'not_yet');
        })());
        return { result: 'done', toast: 'Checking your login' };
      }));

      taps.on('notice', 'ixigo_not_now', forPerson(async (row) => {
        if (row.state === 'logged_in') return { result: 'done' };
        const next: LoginRow = { ...row, state: 'skipped' };
        await save(next);
        if (row.taskId && row.state === 'logging_in') track('hand-off', row.tripId, d.tasks()?.handoff(row.taskId, 'not_now').catch(() => undefined) ?? Promise.resolve());
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
      const organizer = pack.trip.people.find((p) => p.person_id === pack.trip.organizer_person_id && !p.go_paused);
      // The person asked before, while they are still in the trip and haven't paused Go; else the organizer.
      const still = row !== null && pack.trip.people.some((p) => p.person_id === row.personId && !p.go_paused);
      const personId = row !== null && still ? row.personId : organizer?.person_id;
      if (!personId) return { ok: false, note: `${what} needs the trip's ixigo login, and nobody can be asked for it now. Say so in one line.` };
      const name = await nameOf(tripId, personId);
      if (!row || row.state !== 'asked' || now - row.askedAt.getTime() >= ASK_AGAIN_MS) {
        await ask(tripId, personId, row ? row.attempt + 1 : 0, "{name}, this needs ixigo linked for the trip: one login on the trip's computer, about a minute.");
      }
      return { ok: false, note: `${what} needs the trip's ixigo login. Go asked ${name} to log in on the card: say so in one line, and never ask for a number or a code in the chat.` };
    },

    status,

    async onEvent(ev) {
      if (ev.type !== 'person.left') return;
      const row = await get(ev.trip_id);
      if (!row || row.personId !== ev.data.person_id || (row.state !== 'logged_in' && row.state !== 'logging_in')) return;
      track('log out', ev.trip_id, logout(row, 'left'));
    },

    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
