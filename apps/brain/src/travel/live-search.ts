/**
 * The live card for a search on ixigo.com: posted with "On it." the moment the search starts, its steps ticked as the
 * recipe run reports, and marked done before the options card posts. Updates go out in order, folded into the newest.
 *
 * Live (the Server team's R7, 11 Oct): the card carries live_url, a view-only page of Go's screen (Bash's screen page,
 * WebRTC) the App opens while the card runs, made as the card starts and made again at a step change before its 15
 * minutes run out; ended, and gone from the card, once the card is done. A person signing in on the same screen is never
 * in it (Bash pauses a view session through a hand-off). The card changes at step changes only, never for a picture: the
 * most drawn picture of the page, with its address, rides the next one and stays as the done card's last frame. Pictures
 * are only of search, results and details pages (frame-pages.ts), re-hosted in Go's image cache like every other.
 */
import { createHash } from 'node:crypto';
import type * as C from '@go/contract';
import type { z } from 'zod';
import type { ServerLink } from '../door/server-link.js';
import { clip } from './cards.js';
import { asked } from './filters.js';
import { isFramePage } from './frame-pages.js';
import type { Images } from './images.js';
import type { LiveFrame, OnProgress, RecipeProgress } from './recipes/progress.js';
import type { TravelKind, TravelQuery } from './travel.js';

type WorkingCard = z.infer<typeof C.WorkingCard>;

export interface LiveSearchDeps {
  link: Pick<ServerLink, 'request'>;
  images: Pick<Images, 'putBytes'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** The longest finish() holds the options card back for the card's last update. */
  finishWaitMs?: number;
  /** When each trip's last card said "On it.", shared by every card (register.ts): one ask's second card says nothing. */
  saidOnIt?: Map<string, number>;
  /** A fresh view-only session on the trip's screen (POST /v1/sessions, screen view): the card's live_url. */
  liveView?: (tripId: string) => Promise<{ id?: string; url: string; expires_at: string }>;
  /** Ends a live view's session (DELETE /v1/sessions/{id}) once its card is done or it is made again. */
  endView?: (sessionId: string) => Promise<void>;
  /** The longest a post waits for its live view (LIVE_VIEW_WAIT_MS); tests pass their own. */
  liveViewWaitMs?: number;
}

/** "On it." waits at most this long for its live view: one that comes later rides the next step change. */
export const LIVE_VIEW_WAIT_MS = 1_500;
/** A live view this old is made again at the next step change: Bash's sessions are good for 15 minutes. */
export const LIVE_VIEW_FRESH_MS = 10 * 60_000;

export interface LiveSearch {
  /** For the recipe runner: never throws, and never needs awaiting. */
  progress: OnProgress;
  /** Every step ticked and done, or failed; waits for that update to reach the Server, at most finishWaitMs. */
  finish(ok: boolean): Promise<void>;
  /**
   * Its turn answered (Go's words went out): the card is done now, and stays done. A read that failed, before or after,
   * shows as its failed step, a gap, never as a failed card beside a good answer (exam #9, 10 Oct).
   */
  answered(): void;
}

const NOUN: Record<TravelKind, string> = { flights: 'flights', stays: 'hotels', trains: 'trains', buses: 'buses' };
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FINISH_WAIT_MS = 1_500;
/**
 * A card within this of the trip's last "On it." goes up with no words: it is the same ask's next search (staging, 10 Oct:
 * the early plain read said "On it." at 2 s, and the model's search with ixigo's filters said it again at 12 s).
 */
export const ON_IT_QUIET_MS = 60_000;
const SAID_MAX = 1_000;

/** The planned steps: open ixigo's page, read its results, pick by what the people asked for. */
export function liveSteps(kind: TravelKind, q: TravelQuery): string[] {
  const wants = asked(kind, q);
  return [
    `Opening ixigo ${NOUN[kind]}`,
    'Reading the results',
    clip(wants.length > 0 ? `Picking ${NOUN[kind]}: ${wants.join(', ')}` : `Picking the best ${NOUN[kind]}`, 80),
  ];
}

/** Bash's labels, best first: taken after the captures and the settle, then taken as the captures landed. */
const frameRank = (label: string): number => (label === 'results' ? 2 : label === 'captured' ? 1 : 0);

/**
 * The most drawn frame of a page Go may show, as JPEG bytes; null when there is none. The largest "results" frame (Bash
 * takes those only after the captures), else the largest "captured" one (the frame at capture time, which can be the
 * drawn list where nothing settles, as buses and trains), else the largest of any. A JPEG's size is a cheap measure of
 * what it shows: ixigo's loading state is far smaller than its hotel cards (re-drill 6), but an earlier frame under
 * ixigo's dark popup can outweigh the list, hence the labels first. The newer of two the same size.
 */
export function frameToShow(frames: LiveFrame[]): { bytes: Buffer; pageUrl: string } | null {
  let best: { bytes: Buffer; pageUrl: string; at: number; rank: number } | null = null;
  for (const f of frames) {
    if (!isFramePage(f.page_url)) continue;
    const bytes = Buffer.from(f.jpeg_base64, 'base64');
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!jpeg || bytes.length > MAX_FRAME_BYTES) continue;
    const rank = frameRank(f.label);
    const better = !best ||
      rank > best.rank ||
      (rank === best.rank && (bytes.length > best.bytes.length || (bytes.length === best.bytes.length && f.at_ms > best.at)));
    if (better) best = { bytes, pageUrl: f.page_url, at: f.at_ms, rank };
  }
  return best && { bytes: best.bytes, pageUrl: best.pageUrl };
}

/** Resolves when p settles or after ms, whichever comes first; never rejects. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

/**
 * Starts the card for one recipe run. `runKey` names the run (its cache key and when it started), so a prefetch and the
 * search tool that share one run share one card, and a rerun of the post doesn't post it twice.
 */
/**
 * A live card for a search (its kind and query), or for one of the book's other recipes the ixigo tool runs (its title:
 * a train's running status, a guide), so the room watches every page Go opens on the stage (10 Oct: Keshav, "I want users
 * to see how the agent is acting on the ixigo site").
 */
export type LiveFor = { runKey: string } & ({ kind: TravelKind; query: TravelQuery } | { recipe: string });

export function startLiveSearch(d: LiveSearchDeps, tripId: string, o: LiveFor): LiveSearch {
  const id = createHash('sha256').update(`${tripId}|${o.runKey}`).digest('hex').slice(0, 24);
  const recipe = 'recipe' in o ? clip(o.recipe.charAt(0).toLowerCase() + o.recipe.slice(1), 60) : null;
  const noun = 'kind' in o ? NOUN[o.kind] : '';
  const card: WorkingCard = {
    card_id: `c_live_${id}`,
    kind: 'working',
    fallback_text: recipe ? `Go is checking ${recipe} on ixigo.` : `Go is searching ${noun} on ixigo.`,
    task_id: `search_${id}`,
    title: recipe ? clip(`Checking ixigo: ${recipe}`, 80) : `Searching ${noun} on ixigo`,
    state: 'running',
    steps: ('kind' in o ? liveSteps(o.kind, o.query) : ['Opening ixigo', 'Reading the page', 'Answering']).map((text, i) => ({ text, state: i === 0 ? 'doing' : 'todo' })),
    screenshot_url: null,
    live_url: null,
    page_url: null,
    updated_at: d.now().toISOString(),
    actions: [],
  };
  let posted = false;
  let postFailed = false;
  let ended = false;
  /** Its turn answered: its words say Go answered without it if its read fails. A failed read is never Done. */
  let answeredAt = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();
  let frames: Promise<void> = Promise.resolve();
  /** The card's live view: its session, and when it was made; viewing while one is being made. */
  let view: { id?: string; at: number } | null = null;
  let viewing: Promise<void> | null = null;

  /** A live view made (again): on the card while it runs; one made after the card is done ends at once. */
  function openView(): Promise<void> {
    if (!d.liveView || viewing) return viewing ?? Promise.resolve();
    viewing = d.liveView(tripId)
      .then((s) => {
        const old = view;
        view = { ...(s.id ? { id: s.id } : {}), at: d.now().getTime() };
        if (old?.id) void d.endView?.(old.id).catch(() => undefined);
        if (ended) closeView();
        else card.live_url = s.url;
      })
      .catch((err: unknown) => d.log.warn({ err, cardId: card.card_id }, 'travel: a live view did not open'))
      .finally(() => {
        viewing = null;
      });
    return viewing;
  }

  /** The card is done: its live view ends, and leaves the card. */
  function closeView(): void {
    card.live_url = null;
    const id = view?.id;
    view = null;
    if (id) void d.endView?.(id).catch((err: unknown) => d.log.warn({ err, cardId: card.card_id }, 'travel: a live view did not end'));
  }

  async function send(): Promise<void> {
    if (postFailed) return;
    // The first post, or a view near its 15 minutes: a live view first, briefly (never holding "On it." for long).
    if (!ended && (!posted || (view && d.now().getTime() - view.at >= LIVE_VIEW_FRESH_MS))) {
      if (posted) void openView();
      if (viewing) await within(viewing, d.liveViewWaitMs ?? LIVE_VIEW_WAIT_MS);
    }
    const c: WorkingCard = { ...card, steps: card.steps.map((s) => ({ ...s })), updated_at: d.now().toISOString() };
    try {
      if (!posted) {
        const now = d.now().getTime();
        const last = d.saidOnIt?.get(tripId);
        const quiet = last !== undefined && now - last < ON_IT_QUIET_MS;
        // Claimed before the post goes, so a card posting at the same moment (an ask's two reads, exam #9: 5 ms apart)
        // finds it said and goes up with no words; given back if this post never reached the room.
        if (!quiet && d.saidOnIt) {
          d.saidOnIt.delete(tripId);
          d.saidOnIt.set(tripId, now);
          while (d.saidOnIt.size > SAID_MAX) d.saidOnIt.delete(d.saidOnIt.keys().next().value!);
        }
        try {
          await d.link.request('post_message', { request_id: `go_live_${id}`, trip_id: tripId, ...(quiet ? {} : { text: 'On it.' }), card: c });
        } catch (err) {
          if (!quiet && d.saidOnIt?.get(tripId) === now) {
            if (last === undefined) d.saidOnIt.delete(tripId);
            else d.saidOnIt.set(tripId, last);
          }
          throw err;
        }
        posted = true;
      } else {
        await d.link.request('replace_card', { trip_id: tripId, card: c });
      }
    } catch (err) {
      // A card that never reached the room can't be replaced: nothing more is sent for it.
      if (!posted) postFailed = true;
      d.log.warn({ err, cardId: card.card_id }, 'travel: a live search card update failed');
    }
  }

  /** One update waits at a time, and it carries the card as it is when it goes. */
  function push(): void {
    if (queued) return;
    queued = true;
    chain = chain.then(() => {
      queued = false;
      return send();
    });
  }

  /** The planned steps are the last three: a step for choosing a place may come before them. */
  const tick = (i: number, state: 'doing' | 'done'): void => {
    const step = card.steps[card.steps.length - 3 + i];
    if (step && step.state !== 'done') step.state = state;
  };
  /** The search goes on after a pick: the choosing step is done. */
  const chosen = (): void => {
    if (card.steps.length > 3 && card.steps[0]!.state === 'doing') card.steps[0]!.state = 'done';
  };

  function settle(ok: boolean): void {
    ended = true;
    closeView();
    // A read that failed shows failed, even when Go answered without it (the lead, 11 Oct: Ankur's card said Done over
    // "Opening ixigo, Step 1 of 3").
    card.state = ok ? 'done' : 'failed';
    card.steps = card.steps.map((s) => ({ ...s, state: ok ? 'done' : s.state === 'doing' ? 'failed' : s.state }));
    card.fallback_text = fallbackOf(ok);
    push();
  }

  /** What the card says in words: done, failed, or done with a gap once Go answered without this read. */
  function fallbackOf(ok: boolean): string {
    if (!ok && answeredAt) return recipe ? `Go answered; ixigo's page for ${recipe} didn't load.` : `Go answered; ixigo's ${noun} page didn't load.`;
    return recipe
      ? ok ? `Go checked ${recipe} on ixigo.` : `Go couldn't check ${recipe} on ixigo.`
      : ok ? `Go searched ${noun} on ixigo.` : `Go couldn't search ${noun} on ixigo.`;
  }

  /**
   * drawn: the page as ixigo drew it after the answer, which replaces the picture even on a card that is done. A picture
   * changes nothing in the room while the card runs (R7: step changes only): the next step change carries it, and the
   * done card's update its last. Only a card already done is sent again for its picture.
   */
  async function show(list: LiveFrame[], drawn = false): Promise<void> {
    const frame = frameToShow(list);
    if (!frame || (ended && !drawn)) return;
    const url = await d.images.putBytes(frame.bytes, 'image/jpeg');
    if ((ended && !drawn) || card.screenshot_url === url) return;
    card.screenshot_url = url;
    card.page_url = frame.pageUrl;
    if (ended) push();
  }

  function on(e: RecipeProgress): void {
    if (e.type === 'drawn') {
      if (card.state === 'failed') return;
      frames = frames.then(() => show(e.frames, true)).catch((err: unknown) => d.log.warn({ err, cardId: card.card_id }, 'travel: a live search picture failed'));
      return;
    }
    if (ended) return;
    switch (e.type) {
      case 'opening':
        if (card.steps.length > 3 && card.steps[0]!.state === 'doing') {
          chosen();
          tick(0, 'doing');
          push();
        }
        return;
      case 'choosing': {
        // Not a failure: ixigo knows more than one place, and the card waits on the pick with the search still to come.
        const text = clip(e.between.length > 1 ? `Choosing between ${e.between.slice(0, -1).join(', ')} and ${e.between.at(-1)}` : 'Choosing the place', 80);
        if (card.steps.length > 3) card.steps[0] = { text, state: 'doing' };
        else card.steps.unshift({ text, state: 'doing' });
        for (const s of card.steps.slice(1)) if (s.state === 'doing') s.state = 'todo';
        push();
        return;
      }
      case 'waiting': {
        // Said once, on the card in the room: the search is not lost, it runs as soon as the login is done.
        const text = "ixigo's login is open on Go's screen: this runs once it's done or Not now";
        if (card.steps.length > 3) card.steps[0] = { text, state: 'doing' };
        else card.steps.unshift({ text, state: 'doing' });
        // Nothing opens until it is free: the planned steps wait, as after a pick.
        for (const s of card.steps.slice(1)) if (s.state === 'doing') s.state = 'todo';
        push();
        return;
      }
      case 'queued': {
        // Go's one screen shows the ask before this one: this card is next in line and runs when that one is done, and
        // neither stops the other (the App team's room, 11 Oct).
        const text = 'Next in line, after the search before it';
        if (card.steps.length > 3) card.steps[0] = { text, state: 'doing' };
        else card.steps.unshift({ text, state: 'doing' });
        for (const s of card.steps.slice(1)) if (s.state === 'doing') s.state = 'todo';
        push();
        return;
      }
      case 'turn':
        // Its turn: the line it waited in is done, and its page opens.
        chosen();
        tick(0, 'doing');
        push();
        return;
      case 'captured':
        chosen();
        tick(0, 'done');
        tick(1, 'doing');
        push();
        return;
      case 'frames':
        frames = frames.then(() => show(e.frames)).catch((err: unknown) => d.log.warn({ err, cardId: card.card_id }, 'travel: a live search picture failed'));
        return;
      case 'extracted':
        chosen();
        tick(0, 'done');
        tick(1, 'done');
        tick(2, 'doing');
        push();
        return;
      case 'failed':
        settle(false);
        return;
      case 'answered': {
        // Answered another way: calm and done, the page opened and how the group got its answer, never "Didn't work"
        // (Keshav's live test, 10 Oct: "DIDN'T WORK · Searching flights on ixigo" over the link card that answered).
        const before = card.steps.slice(0, Math.max(0, card.steps.length - 3)).map((st) => ({ ...st, state: 'done' as const }));
        card.steps = [...before, { text: recipe ? 'Opened ixigo' : `Opened ixigo ${noun}`, state: 'done' }, { text: clip(e.text, 80), state: 'done' }];
        card.state = 'done';
        card.fallback_text = clip(`${e.text}.`, 200);
        ended = true;
        closeView();
        push();
        return;
      }
    }
  }

  void openView();
  push();
  return {
    progress(e) {
      try {
        on(e);
      } catch (err) {
        d.log.warn({ err, cardId: card.card_id }, 'travel: a live search update failed');
      }
    },
    async finish(ok) {
      const deadline = Date.now() + (d.finishWaitMs ?? FINISH_WAIT_MS);
      // The last picture first, so the finished card carries it.
      await within(frames, deadline - Date.now());
      if (!ended) settle(ok);
      await within(chain, deadline - Date.now());
    },
    answered() {
      if (answeredAt) return;
      answeredAt = true;
      // A card that already ended failed stays failed, its words saying Go answered without it; one still running ends,
      // done or failed, when its read does.
      if (card.state === 'failed') {
        card.fallback_text = fallbackOf(false);
        push();
      }
    },
  };
}

/** The recipe cards a process keeps for turns not yet over, and the answered turns it remembers: at most this many each. */
const OPEN_MAX = 500;

/** A card that never goes up: a run's, after its turn already answered. */
const NO_CARD: LiveSearch = { progress: () => undefined, finish: async () => undefined, answered: () => undefined };

/**
 * The recipe runs' live cards whose turn is not over, by trip and run key (book/tool.ts runOnStage): a tool call's key
 * starts with its turn's id, an early read's with early:<message id>. When the turn ends, its cards are let go; when it
 * answered, each is told first and ends done, one that failed already or fails later showing its gap, and a run of that
 * turn that would put a card up only now puts none up (no "On it." after Go's answer).
 */
export function openRecipeCards(): {
  card(tripId: string, runKey: string, create: () => LiveSearch): LiveSearch;
  turnEnded(t: { tripId: string; turnId: string; messageIds: string[]; answered?: boolean }): void;
} {
  const open = new Map<string, { tripId: string; runKey: string; live: LiveSearch }>();
  const answered = new Set<string>();
  const ownersOf = (t: { turnId: string; messageIds: string[] }): string[] => [`${t.turnId}|`, ...t.messageIds.map((id) => `early:${id}|`)];
  return {
    card(tripId, runKey, create) {
      for (const a of answered) if (a.startsWith(`${tripId}\u0000`) && runKey.startsWith(a.slice(tripId.length + 1))) return NO_CARD;
      const live = create();
      const key = `${tripId}\u0000${runKey}`;
      open.delete(key);
      open.set(key, { tripId, runKey, live });
      while (open.size > OPEN_MAX) open.delete(open.keys().next().value!);
      return live;
    },
    turnEnded(t) {
      const owners = ownersOf(t);
      for (const [key, c] of open) {
        if (c.tripId !== t.tripId || !owners.some((o) => c.runKey.startsWith(o))) continue;
        if (t.answered) c.live.answered();
        open.delete(key);
      }
      if (t.answered) {
        for (const o of owners) answered.add(`${t.tripId}\u0000${o}`);
        while (answered.size > OPEN_MAX) answered.delete(answered.values().next().value!);
      }
    },
  };
}
