/**
 * One model call per search ask (design section 4d), in every TRAVEL_MODE. When a turn woke for a message whose search
 * started early, the prompt's right-now part carries that search's answer: the results_id, the summary and the results,
 * exactly as the search tool would give them. So the model's first and only call is show_options with its line. The
 * block waits for the search as long as it may hold up the turn (TravelBackend.waitMs: up to 12 s from its start through
 * the browser fetch, none for the agent job, 12 s for a backend that does not say).
 *
 * An early search reaches the room only when the turn takes it up, since the early start can misread an ask: on staging
 * (8 Oct) "any ixigo offers on hotels right now?" started a stays search, the search was handed over whatever the turn
 * did, and its stays card was Go's only answer. A turn takes it up by calling the search tool for it (one still running
 * is handed over there, tools.ts handOver: its card and line go up by themselves when it finishes), or by being the
 * plain ask that answers with no model call (earlyAnswer: the card at once, or the search handed over and the turn says
 * nothing more, or one line that it's still looking where no live card is in the room). Any other answer (another tool,
 * or a reply of its own) leaves the search unshown.
 */
import type { DirectAnswer, NowProvider } from '../../composer/context.js';
import type { Desk } from '../../desk/desk.js';
import { dataBlock, defuse, oneLine } from '../../composer/fence.js';
import { CARD_LINE } from '../../composer/rules.js';
import { plainAsk } from '../answer.js';
import type { Images } from '../images.js';
import type { ResultsStore } from '../results.js';
import { answerItself, handOver, searchAnswer, searchScope, type SearchAnswer } from '../tools.js';
import type { Travel, TravelSearch } from '../travel.js';
import { TRAVEL_WAIT_MS } from './backend.js';
import type { EarlyStart } from './early.js';

/** The longest a turn waits for searches started early, all together. */
export const EARLY_WAIT_MS = TRAVEL_WAIT_MS;
const ANSWERED_MAX = 200;

export interface EarlySearchNowDeps {
  early: Pick<EarlyStart, 'searchFor'>;
  results: Pick<ResultsStore, 'save'>;
  /** How much longer each search may hold up the turn. */
  travel: Pick<Travel, 'waitMs'>;
  now: () => Date;
  wait?: (ms: number) => Promise<void>;
}

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** For a search started early from a misread: the ask comes first, and the search stays unshown. */
const ASKED_ELSE = 'If they asked for something else, not this search, answer that instead and say nothing about this search.';

/** A search's answer for the prompt: what to do with it outside the fence, what came back inside it. */
function answerBlock(seq: number | undefined, a: SearchAnswer, live: boolean): string {
  const which = seq !== undefined ? `#${seq}` : 'the message you woke for';
  const data = dataBlock('search results', [defuse(oneLine(a.summary)), ...(a.results ?? []).map((r) => defuse(JSON.stringify(r)))]);
  if (!a.results_id || a.count === 0) {
    return `Already searched for ${which}, checked ${a.checked}: nothing to show. Say what the summary says in one line, keeping every condition in it, and suggest loosening one thing. ${ASKED_ELSE}\n${data}`;
  }
  return (
    `Already searched for ${which}, checked ${a.checked}: results_id ${a.results_id}, ${a.count} options.\n` +
    'Show them now with show_options (this results_id, the best up to 3, a short title) and your one short line, in this reply: no need to search again. ' +
    `${CARD_LINE} ` +
    (live ? 'The live card already told the room you are on it: don\'t say so again. ' : '') +
    'Only if people gave a condition the summary does not name (a time, a price cap, non-stop), call the search tool with it first: it answers at once from this same search. ' +
    'If they meant another day or place than the summary\'s (the trip\'s Friday, not this week\'s), search for theirs instead. ' +
    "Quote prices, times and areas only as given here. " +
    `${ASKED_ELSE}\n` +
    data
  );
}

export function earlySearchNow(d: EarlySearchNowDeps): NowProvider {
  const wait = d.wait ?? nap;
  // One answer per message: a turn that runs again (more lines arrived) shows the same results_id.
  const answered = new Map<string, Promise<SearchAnswer | null>>();
  const answerFor = (tripId: string, messageId: string, early: NonNullable<ReturnType<EarlyStart['searchFor']>>): Promise<SearchAnswer | null> => {
    const key = `${tripId}:${messageId}`;
    let a = answered.get(key);
    if (!a) {
      a = early.search.then((found) => searchAnswer(early.kind, early.query, found, tripId, d), () => null);
      answered.set(key, a);
      while (answered.size > ANSWERED_MAX) {
        const oldest = answered.keys().next().value;
        if (oldest === undefined) break;
        answered.delete(oldest);
      }
    }
    return a;
  };
  return {
    name: 'travel search',
    order: 35,
    async render(tripId, wake) {
      const deadline = d.now().getTime() + EARLY_WAIT_MS;
      const blocks: string[] = [];
      for (const item of wake) {
        if (item.kind !== 'message') continue;
        const p = item.payload as { messageId?: string; seq?: number };
        const early = p.messageId ? d.early.searchFor(tripId, p.messageId) : null;
        if (!early || !p.messageId) continue;
        const asked = d.travel.waitMs ? await d.travel.waitMs(early.kind, early.query, { tripId }).catch(() => null) : null;
        const allowed = asked ?? EARLY_WAIT_MS;
        const left = Math.max(0, Math.min(allowed, deadline - d.now().getTime()));
        // The race is on the search itself: one already finished is never "still running", however little wait is left.
        const settled = await Promise.race([early.search.then(() => true, () => true), wait(left).then(() => false)]);
        const answer = settled ? await answerFor(tripId, p.messageId, early) : 'running';
        if (answer === 'running') {
          // Not handed over here: only the turn's own search call takes it up (the tool hands it over).
          const scope = `The search for #${p.seq ?? '?'} (${searchScope(early.kind, early.query)}) is still running`;
          const take = `If that search is what they asked for, call search_${early.kind} for it with what was asked: its options go up in the room by themselves when it finishes`;
          blocks.push(
            early.live
              ? `${scope}, and the live card in the room shows it. ${take}, so post nothing about it. ${ASKED_ELSE}`
              : `${scope}. ${take}, so say in one short line that you're still looking and they'll be here in a moment. ${ASKED_ELSE}`,
          );
        } else if (answer) {
          blocks.push(answerBlock(p.seq, answer, early.live));
        }
        // A search that failed says nothing here: the composer searches again, and the tool says what went wrong.
      }
      return blocks.length ? blocks.join('\n\n') : null;
    },
  };
}

export interface EarlyAnswerDeps {
  early: Pick<EarlyStart, 'searchFor'>;
  results: ResultsStore;
  images: Images;
  /** How much longer the search may hold up the turn. */
  travel: Pick<Travel, 'waitMs'>;
  /** Today in the trip's time zone, YYYY-MM-DD. */
  today: (tripId: string) => Promise<string>;
  now: () => Date;
  /** Where a search still running wakes Go when it finishes (tools.ts handOver). */
  desk?: Pick<Desk, 'put'>;
  log?: { warn(obj: object, msg: string): void };
  wait?: (ms: number) => Promise<void>;
}

const RUNNING = Symbol('running');

/**
 * The turn's answer with no model call at all: it woke for one plain search ask whose early search found options (the
 * early read is the search, so the card and its line come from it). The same plain ask whose search is still running:
 * the search is handed over, so the room hears the card's line when it finishes, and the turn says nothing more with
 * its live card in the room, or one line that it's still looking with none. Any doubt, a search that failed or found
 * nothing, or an ask that is not plainly this search, and the turn goes to the model as before, with the block above.
 */
export function earlyAnswer(d: EarlyAnswerDeps): DirectAnswer {
  const wait = d.wait ?? nap;
  return async ({ tripId, wake, pack, ctx }) => {
    const item = wake[0];
    if (wake.length !== 1 || item?.kind !== 'message') return false;
    const messageId = (item.payload as { messageId?: string } | null)?.messageId;
    const early = messageId ? d.early.searchFor(tripId, messageId) : null;
    if (!early) return false;
    // As long as the block would wait for it: the backend's own wait from the run's start, or the block's.
    const allowed = d.travel.waitMs ? await d.travel.waitMs(early.kind, early.query, { tripId }).catch(() => null) : null;
    const found = await Promise.race<TravelSearch | null | typeof RUNNING>([
      early.search.then((f) => f, () => null),
      wait(Math.max(0, allowed ?? EARLY_WAIT_MS)).then(() => RUNNING),
    ]);
    if (found === RUNNING) {
      if (!d.desk || !plainAsk(early.kind, early.query, { wake, pack, today: await d.today(tripId) }).ok) return false;
      handOver(early.kind, early.query, early.search, { tripId, fallbackId: `early:${messageId}` }, d);
      if (!early.live) ctx.lines.push(`Still looking: the ${early.kind} will be here in a moment.`);
      ctx.answered = true;
      return true;
    }
    if (!found || found.results.length === 0) return false;
    if (!plainAsk(early.kind, early.query, { wake, pack, today: await d.today(tripId) }).ok) return false;
    await answerItself(early.kind, early.query, found, ctx, d);
    return true;
  };
}
