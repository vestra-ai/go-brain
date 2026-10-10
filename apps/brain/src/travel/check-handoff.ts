/**
 * Cloudflare's check, handed to a person (Keshav, 10 Oct: "even if cloudflare blocks it asks for captcha right, we fill
 * it? what's wrong in that"). A search a person waits on whose page stays on Cloudflare's check through Go's reloads
 * (CLOUDFLARE, recipes/runners.ts) asks the browser's person, the trip's organizer, to tick it on Go's screen: the same
 * front hand-off as the login (a phone's view, Watch showing only it, no picture of the screen taken while it is open),
 * opened on the page that was checked. Go itself never ticks it and never uses a solver: a person does, or nobody.
 *
 * Go looks every CHECK_LOOK_MS whether ixigo lets the browser through (the site's own address answering 200 from inside
 * the page), and then the hand-off closes on its own and the search runs again at once (recipes/backend.ts). At most one
 * ask a browser (its organizer) in CHECK_ASK_EVERY_MS, and never over the login's own hand-off: the login comes first.
 */
import type * as C from '@go/contract';
import type { CardTapParams, CardTapResult } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TapRouter } from '../door/taps.js';
import type { Packs } from '../trips/pack.js';
import { IXIGO } from './recipes/recipe.js';
import type { RecipeRunner } from './recipes/runners.js';

/** The hand-off's tab, beside the login's (LOGIN_TAB): one check open a browser at a time. */
export const CHECK_TAB = 'ixigo_check';
/** One ask a browser in this long: a person is asked to tick, not nagged. */
export const CHECK_ASK_EVERY_MS = 10 * 60_000;
/** How long the check stays on Go's screen for them. */
export const CHECK_WAIT_MS = 3 * 60_000;
/** How often Go looks whether ixigo let the browser through. */
export const CHECK_LOOK_MS = 4_000;
/** The page's own load in front, as the login's: long enough for Cloudflare's page to show. */
const OPEN_MS = 12_000;
export const CHECK_LINE = "ixigo wants a quick 'I'm human' tick on Go's screen. Tap to open it.";

export interface CheckDeps {
  runner: () => Pick<RecipeRunner, 'handOff' | 'release' | 'tabCall'> | null;
  link: Pick<ServerLink, 'request'>;
  packs: Pick<Packs, 'get'>;
  /** A fresh session on the trip's screen, in control (POST /v1/sessions); null with no trip computer here. */
  screen: () => ((tripId: string, mode: 'view' | 'control') => Promise<{ url: string; expires_at: string }>) | null;
  /** The login's own hand-off is open on the trip: the login comes first. */
  loginOpen: (tripId: string) => Promise<boolean>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckHandOff {
  /**
   * Hands Cloudflare's check on `page` to the trip's organizer and waits until ixigo lets the browser through: true, and
   * the caller runs its search again. False when it may not ask now (asked in the last 10 minutes, the login's hand-off
   * open, no organizer or computer), or when nobody ticked it in CHECK_WAIT_MS. Concurrent asks of one browser share one.
   */
  ask(tripId: string, page: string): Promise<boolean>;
  registerTaps(taps: Pick<TapRouter, 'on'>): void;
}

const cardId = (tripId: string, n: number): string => `c_check_${tripId}_${n}`.slice(0, 80);

function checkCard(tripId: string, n: number, organizer: string, state: 'open' | 'cleared' | 'closed'): C.Card {
  const only = [organizer];
  return {
    card_id: cardId(tripId, n),
    kind: 'notice',
    tone: state === 'open' ? 'heads_up' : 'info',
    for_person_ids: only,
    title: state === 'cleared' ? 'ixigo let Go through' : "A quick check on Go's screen",
    body: state === 'open'
      ? "ixigo wants to be sure a person is there. Tap Open Go's screen and tick the box; Go carries on as soon as ixigo lets it through."
      : state === 'cleared'
        ? 'Thanks: the search is running again.'
        : "The check closed after 3 minutes. Go asks again if ixigo checks again.",
    actions: state === 'open' ? [{ action_id: 'ixigo_check_watch', label: "Open Go's screen", style: 'primary', only_for_person_ids: only }] : [],
    fallback_text: state === 'open' ? CHECK_LINE : state === 'cleared' ? 'ixigo let Go through.' : "ixigo's check closed.",
  };
}

export function createCheckHandOff(d: CheckDeps): CheckHandOff {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  /** When each organizer's browser was last asked. */
  const asked = new Map<string, number>();
  /** The ask open now, by organizer: concurrent searches share it. */
  const open = new Map<string, Promise<boolean>>();
  /** The trips with a check open on Go's screen, for the tap. */
  const openTrips = new Set<string>();
  let n = 0;

  async function run(tripId: string, organizer: string, page: string): Promise<boolean> {
    const runner = d.runner();
    if (!runner?.handOff || !runner.tabCall || !runner.release) return false;
    const started = d.now().getTime();
    let opened: { challenged?: true };
    try {
      opened = await runner.handOff(tripId, page, { capture: [], steps: [], timeoutMs: OPEN_MS }, { keepOpenMs: CHECK_WAIT_MS, tab: CHECK_TAB, check: { url: '/', method: 'GET' }, keepChallenge: true });
    } catch (err) {
      d.log.warn({ tripId, err: String(err).slice(0, 200) }, "travel: ixigo's check could not open on Go's screen");
      await runner.release(tripId, CHECK_TAB).catch(() => undefined);
      return false;
    }
    // ixigo let the browser through already (the check passed by itself): nothing to ask.
    if (!opened.challenged) {
      await runner.release(tripId, CHECK_TAB).catch(() => undefined);
      d.log.info({ tripId }, "travel: ixigo's check had passed by the time Go opened it");
      return true;
    }
    const k = ++n;
    openTrips.add(tripId);
    try {
      await d.link.request('post_message', {
        request_id: `go_check_${tripId}_${k}`, trip_id: tripId, text: CHECK_LINE, mentions: [organizer], card: checkCard(tripId, k, organizer, 'open'),
      });
      for (;;) {
        await sleep(CHECK_LOOK_MS);
        // The site's own address, from inside the checked page: 200 once ixigo lets the browser through. A look refused
        // while the person ticks (browser_in_use) is no answer; the tab gone (its time ran out) ends the ask.
        let look: { status: number } | null | 'busy';
        try {
          look = await runner.tabCall(tripId, CHECK_TAB, { url: '/', method: 'GET' }, CHECK_WAIT_MS);
        } catch {
          look = 'busy';
        }
        const ms = d.now().getTime() - started;
        if (look !== 'busy' && look?.status === 200) {
          d.log.info({ tripId, ms }, "travel: a person cleared ixigo's check on Go's screen");
          await runner.release(tripId, CHECK_TAB).catch(() => undefined);
          await d.link.request('replace_card', { trip_id: tripId, card: checkCard(tripId, k, organizer, 'cleared') }).catch(() => undefined);
          return true;
        }
        if (look === null || ms >= CHECK_WAIT_MS) {
          d.log.info({ tripId, ms }, "travel: nobody cleared ixigo's check on Go's screen");
          await runner.release(tripId, CHECK_TAB).catch(() => undefined);
          await d.link.request('replace_card', { trip_id: tripId, card: checkCard(tripId, k, organizer, 'closed') }).catch(() => undefined);
          return false;
        }
      }
    } finally {
      openTrips.delete(tripId);
    }
  }

  return {
    async ask(tripId, page) {
      const pack = await d.packs.get(tripId);
      const organizer = pack.trip.organizer_person_id;
      if (!organizer) return false;
      const going = open.get(organizer);
      if (going) return going;
      const last = asked.get(organizer);
      if (last !== undefined && d.now().getTime() - last < CHECK_ASK_EVERY_MS) return false;
      // Held at once, before anything is awaited: a second search at the same moment shares this ask.
      const p = (async (): Promise<boolean> => {
        if (await d.loginOpen(tripId)) return false;
        asked.set(organizer, d.now().getTime());
        return run(tripId, organizer, page.startsWith(`${IXIGO}/`) ? page : `${IXIGO}/`);
      })().finally(() => open.delete(organizer));
      open.set(organizer, p);
      return p;
    },

    registerTaps(taps) {
      // Only the person asked opens it, in control: the box is theirs to tick, and nobody else drives Go's screen then.
      taps.on('notice', 'ixigo_check_watch', async (tap: CardTapParams): Promise<CardTapResult> => {
        const pack = await d.packs.get(tap.trip_id);
        if (tap.person_id !== pack.trip.organizer_person_id) return { result: 'refused', toast: 'This check is for the trip organizer.' };
        const screen = d.screen();
        if (!openTrips.has(tap.trip_id) || !screen) return { result: 'refused', toast: "ixigo's check isn't open on Go's screen now" };
        try {
          const s = await screen(tap.trip_id, 'control');
          return { result: 'open', url: s.url, expires_at: s.expires_at };
        } catch (err) {
          d.log.warn({ err, tripId: tap.trip_id }, "travel: Go's screen did not open for ixigo's check");
          return { result: 'refused', toast: "Can't open Go's screen right now" };
        }
      });
    },
  };
}
