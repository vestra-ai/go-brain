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
import type { EngineAnswer } from '../book/engine.js';
import { NAMES_ONLY_FROM_IXIGO, NOTHING_ON_IXIGO } from '../book/tool.js';
import type { Images } from '../images.js';
import { withoutPhotos } from '../photos.js';
import type { ResultsStore } from '../results.js';
import { answerItself, handOver, searchAnswer, searchScope, type SearchAnswer } from '../tools.js';
import type { Travel, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { isSearchChoice, type SearchChoice } from '../../reflex/questions.js';
import type { EarlyStart } from './early.js';
import { FAST_ASKS } from './fast.js';

/**
 * The longest a turn's context waits for searches started early, all together: a beat, for one already answering from
 * what Go keeps, never the search itself. A turn never waits on ixigo to build (staging, 10 Oct: a villa ask waited
 * 12 s behind a Cloudflare check before the model started): one still running says so, its live card shows it, and its
 * options go up by themselves when it finishes.
 */
export const EARLY_WAIT_MS = 600;
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
  // Nothing fits, but the nearest are saved (stays): the answer's own note says how to show them.
  if (a.results_id && a.count === 0) return `Already searched for ${which}, checked ${a.checked}: results_id ${a.results_id}. ${a.note} ${ASKED_ELSE}\n${data}`;
  if (!a.results_id || a.count === 0) {
    return `Already searched for ${which}, checked ${a.checked}: nothing to show. Say what the summary says in one line, keeping every condition in it, and suggest loosening one thing. ${ASKED_ELSE}\n${data}`;
  }
  return (
    `Already searched for ${which}, checked ${a.checked}: results_id ${a.results_id}, ${a.count} options.\n` +
    'Show them now with show_options (this results_id, the best up to 3, a short title) and your one short line, in this reply: no need to search again. ' +
    `${CARD_LINE} ` +
    (live ? 'The live card already told the room you are on it: don\'t say so again. ' : '') +
    'Only if people gave a condition the summary does not name (a time, a price cap, non-stop, a kind of stay, an amenity, anything), call the search tool with it first, ' +
    "ixigo's own filters in site_filters and the rest in wants: it answers from this same search, or ixigo's filtered one, and you pick what no filter covers. " +
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
        const allowed = Math.min(asked ?? EARLY_WAIT_MS, EARLY_WAIT_MS);
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
  /** When ixigo's own quiet on a search's page ends, or null: a try again of one that didn't load waits past it. */
  ixigoQuiet?: (kind: TravelKind, q: TravelQuery) => number | null;
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
    // As long as the block would wait for it, a beat at most: a search still running is handed over, never waited on.
    const allowed = d.travel.waitMs ? await d.travel.waitMs(early.kind, early.query, { tripId }).catch(() => null) : null;
    const found = await Promise.race<TravelSearch | null | typeof RUNNING>([
      early.search.then((f) => f, () => null),
      wait(Math.max(0, Math.min(allowed ?? EARLY_WAIT_MS, EARLY_WAIT_MS))).then(() => RUNNING),
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

export interface EarlyReadNowDeps {
  early: Pick<EarlyStart, 'readFor'>;
  now: () => Date;
  wait?: (ms: number) => Promise<void>;
}

/** The most of a read's facts the prompt carries; the ixigo tool gives the rest. */
const READ_FACTS_MAX = 5_000;
/** A read's facts as data lines, one a row, up to READ_FACTS_MAX in all: a row cut short, or rows left out, are said. */
function factLines(rows: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = JSON.stringify(withoutPhotos(row));
    if (used + line.length > READ_FACTS_MAX) {
      out.push(out.length ? `(${rows.length - out.length} more: the ixigo tool gives them)` : `${line.slice(0, READ_FACTS_MAX)}… (cut short: the ixigo tool gives all of it)`);
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out.map(defuse);
}

/** For a read started early from a misread: the ask comes first, and the read stays unsaid. */
const ASKED_ELSE_READ = 'If they asked for something else, not this, answer that instead and say nothing about this read.';

/**
 * An ixigo read started early (fast.ts: a train's status, a guide, the offers...): its facts in the turn's right-now part,
 * so the model answers in its first call with no tool call; one still running is joined by the tool's call with the
 * same inputs (the engine keeps a facts read in flight by recipe and inputs). One that failed says nothing here: the
 * model calls the tool, which says what went wrong.
 */
export function earlyReadNow(d: EarlyReadNowDeps): NowProvider {
  const wait = d.wait ?? nap;
  return {
    name: 'ixigo read',
    order: 36,
    async render(tripId, wake) {
      const deadline = d.now().getTime() + EARLY_WAIT_MS;
      const blocks: string[] = [];
      for (const item of wake) {
        if (item.kind !== 'message') continue;
        const p = item.payload as { messageId?: string; seq?: number };
        const early = p.messageId ? d.early.readFor(tripId, p.messageId) : null;
        if (!early) continue;
        const which = p.seq !== undefined ? `#${p.seq}` : 'the message you woke for';
        const left = Math.max(0, deadline - d.now().getTime());
        const got = await Promise.race<EngineAnswer | null | typeof RUNNING>([early.answer.then((a) => a, () => null), wait(left).then(() => RUNNING)]);
        if (got === RUNNING) {
          const inputs = early.choice === 'pnr' ? 'the PNR in their message' : `inputs ${JSON.stringify(early.asked)}`;
          blocks.push(`Go is already reading ixigo for ${which} (${early.recipe}). If that is what they asked, call the ixigo tool with recipe ${early.recipe} and ${inputs}: it joins the same read. ${ASKED_ELSE_READ}`);
        } else if (got?.as === 'facts') {
          blocks.push(
            got.rows.length === 0
              ? `Already read ixigo for ${which} (${early.recipe}): ${NOTHING_ON_IXIGO} ${ASKED_ELSE_READ}`
              : `Already read ixigo for ${which} (${early.recipe}), checked ${got.checkedAt}: no need to call the ixigo tool for it. ${NAMES_ONLY_FROM_IXIGO} ${ASKED_ELSE_READ}\n` +
                  dataBlock('ixigo facts', [defuse(oneLine(got.title)), ...factLines(got.rows)]),
          );
        }
      }
      return blocks.length ? blocks.join('\n\n') : null;
    },
  };
}

export interface JevPickNowDeps {
  early: Pick<EarlyStart, 'pickFor' | 'readFor' | 'searchFor'>;
  /** The ixigo tool reads this recipe here: it is in the book, and Go searches ixigo.com itself. */
  canRead: (recipe: string) => boolean;
}

/** The tool that searches each search kind. */
const SEARCH_TOOL: Record<SearchChoice, string> = { flights: 'search_flights', stays: 'search_stays', trains: 'search_trains', buses: 'search_buses' };

/**
 * Jev's sure pick for a line the turn woke for, when nothing started early for it (its slots weren't in the words, or it
 * wasn't said to Go): the tool that reads it on ixigo, so the answer comes from ixigo, never from memory. EXAM, 10 Oct:
 * boarding points, stops, tatkal and an offer's terms were answered from memory, and Jev had read #14 as trains at 1.00.
 * A kind no recipe reads yet is said to be general advice.
 */
export function jevPickNow(d: JevPickNowDeps): NowProvider {
  return {
    name: 'ixigo can read',
    order: 37,
    async render(tripId, wake) {
      const lines: string[] = [];
      for (const item of wake) {
        if (item.kind !== 'message') continue;
        const p = item.payload as { messageId?: string; seq?: number };
        if (!p.messageId) continue;
        const pick = d.early.pickFor(tripId, p.messageId);
        // A read or a search that started early has its own block (earlyReadNow, earlySearchNow).
        if (!pick || d.early.readFor(tripId, p.messageId) || d.early.searchFor(tripId, p.messageId)) continue;
        const which = p.seq !== undefined ? `#${p.seq}` : 'the message you woke for';
        if (isSearchChoice(pick)) {
          lines.push(`ixigo can read ${which}: ${SEARCH_TOOL[pick]} searches it. Search there, asking first for the one thing missing if one is; never answer it from memory.`);
          continue;
        }
        const recipe = FAST_ASKS[pick].recipe;
        lines.push(
          d.canRead(recipe)
            ? `ixigo can read ${which}: the ixigo tool's recipe ${recipe}. Read it there, asking first for the one thing missing if one is (which train, which stay); never answer it from memory.`
            : `No ixigo recipe reads ${which} yet: what you say about it is from what you know, so say it is ("usually", "from what I know").`,
        );
      }
      return lines.length ? lines.join('\n') : null;
    },
  };
}
