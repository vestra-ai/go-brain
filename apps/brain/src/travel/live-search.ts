/**
 * The live card for a search on ixigo.com: posted with "On it." the moment the search starts, its steps ticked as the
 * recipe run reports, the most drawn picture of the page in a small browser window with the page's address, and marked
 * done before the options card posts. Pictures are shown only of search, results and details pages (frame-pages.ts),
 * re-hosted in Go's image cache like every other picture on a card. Updates go out in order, folded into the newest.
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
}

export interface LiveSearch {
  /** For the recipe runner: never throws, and never needs awaiting. */
  progress: OnProgress;
  /** Every step ticked and done, or failed; waits for that update to reach the Server, at most finishWaitMs. */
  finish(ok: boolean): Promise<void>;
}

const NOUN: Record<TravelKind, string> = { flights: 'flights', stays: 'hotels', trains: 'trains', buses: 'buses' };
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FINISH_WAIT_MS = 1_500;

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
export function startLiveSearch(d: LiveSearchDeps, tripId: string, o: { runKey: string; kind: TravelKind; query: TravelQuery }): LiveSearch {
  const id = createHash('sha256').update(`${tripId}|${o.runKey}`).digest('hex').slice(0, 24);
  const noun = NOUN[o.kind];
  const card: WorkingCard = {
    card_id: `c_live_${id}`,
    kind: 'working',
    fallback_text: `Go is searching ${noun} on ixigo.`,
    task_id: `search_${id}`,
    title: `Searching ${noun} on ixigo`,
    state: 'running',
    steps: liveSteps(o.kind, o.query).map((text, i) => ({ text, state: i === 0 ? 'doing' : 'todo' })),
    screenshot_url: null,
    page_url: null,
    updated_at: d.now().toISOString(),
    actions: [],
  };
  let posted = false;
  let postFailed = false;
  let ended = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();
  let frames: Promise<void> = Promise.resolve();

  async function send(): Promise<void> {
    if (postFailed) return;
    const c: WorkingCard = { ...card, steps: card.steps.map((s) => ({ ...s })), updated_at: d.now().toISOString() };
    try {
      if (!posted) {
        await d.link.request('post_message', { request_id: `go_live_${id}`, trip_id: tripId, text: 'On it.', card: c });
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

  const tick = (i: number, state: 'doing' | 'done'): void => {
    const step = card.steps[i];
    if (step && step.state !== 'done') step.state = state;
  };

  function settle(ok: boolean): void {
    ended = true;
    card.state = ok ? 'done' : 'failed';
    card.steps = card.steps.map((s) => ({ ...s, state: ok ? 'done' : s.state === 'doing' ? 'failed' : s.state }));
    card.fallback_text = ok ? `Go searched ${noun} on ixigo.` : `Go couldn't search ${noun} on ixigo.`;
    push();
  }

  async function show(list: LiveFrame[]): Promise<void> {
    const frame = frameToShow(list);
    if (!frame || ended) return;
    const url = await d.images.putBytes(frame.bytes, 'image/jpeg');
    if (ended || card.screenshot_url === url) return;
    card.screenshot_url = url;
    card.page_url = frame.pageUrl;
    push();
  }

  function on(e: RecipeProgress): void {
    if (ended) return;
    switch (e.type) {
      case 'opening':
        return;
      case 'captured':
        tick(0, 'done');
        tick(1, 'doing');
        push();
        return;
      case 'frames':
        frames = frames.then(() => show(e.frames)).catch((err: unknown) => d.log.warn({ err, cardId: card.card_id }, 'travel: a live search picture failed'));
        return;
      case 'extracted':
        tick(0, 'done');
        tick(1, 'done');
        tick(2, 'doing');
        push();
        return;
      case 'failed':
        settle(false);
        return;
    }
  }

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
  };
}
