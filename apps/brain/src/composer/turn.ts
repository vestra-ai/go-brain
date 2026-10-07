import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { limitRequestId, utcDay, type Budget } from '../budget.js';
import type { DeskItem, TurnInput, TurnRunner } from '../desk/desk.js';
import type { ServerLink } from '../door/server-link.js';
import type { Log } from '../log.js';
import { withholdCheck } from '../memory/reactions.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { AnthropicLike } from './anthropic.js';
import { classifyAnthropicError } from './anthropic-helpers.js';
import type { ContextImpl } from './context.js';
import { chatLine, dataBlock, personName } from './fence.js';
import { addUsage, MAX_ROUNDS, noUsage, runLoop } from './loop.js';
import { stripMessageRefs } from './sanitize.js';
import type { Speak } from './speak.js';
import { makeTurnCtx, scopedLink, type Tools } from './tools.js';

export interface ComposerDeps {
  pool: pg.Pool;
  log: Log;
  now: () => Date;
  link: ServerLink;
  packs: Packs;
  tools: Tools;
  context: ContextImpl;
  speak: Speak;
  client: AnthropicLike;
  model: string;
  /** The desk's claimNew: message items that arrived while this turn ran. */
  claimNew: (tripId: string, turnId: string) => Promise<DeskItem[]>;
  /** The desk's release: items this turn took go back, for a turn of their own. */
  release: (turnId: string, ids: string[]) => Promise<void>;
  /** The daily model budget; without it, no cap. */
  budget?: Budget;
  turnTimeoutMs?: number;
}

export interface Composer {
  runTurn: TurnRunner;
  giveUp: TurnRunner;
}

export const TROUBLE = "Sorry, I'm having trouble right now. Give me a minute and ask me again?";
/** Said once per trip per day, to someone who asks Go once today's model budget is spent. */
export const OVER_BUDGET = "I've reached today's limit for this demo. I'll be back tomorrow.";

const isForGo = (i: DeskItem): boolean => i.kind === 'message' && (i.payload as { namesGo?: boolean } | null)?.namesGo === true;
const messageIdOf = (i: DeskItem): string => (i.payload as { messageId?: string } | null)?.messageId ?? i.ref;

/** Reply to the one message that named Go when others spoke after it, so the thread stays clear. */
function replyToFor(items: DeskItem[], pack: TripPack): string | null {
  const named = items.filter(isForGo);
  const only = named.length === 1 ? named[0] : undefined;
  if (!only) return null;
  const id = messageIdOf(only);
  const m = pack.messages.find((x) => x.message_id === id);
  if (!m) return null;
  return pack.messages.some((x) => x.seq > m.seq && x.author.kind === 'person') ? id : null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The messages a posted question goes back to: Go asked their author something, so no ✅ goes on them. When several
 * people's messages woke the turn, only those whose author the question names.
 */
function askedBack(text: string, items: DeskItem[], pack: TripPack, readUpTo: number): string[] {
  if (!text.includes('?')) return [];
  const ids = new Set(items.filter((i) => i.kind === 'message').map(messageIdOf));
  // Only lines the model read: one the budget left unread was never part of the question.
  const theirs = pack.messages.flatMap((m) =>
    ids.has(m.message_id) && m.seq <= readUpTo && m.author.kind === 'person' ? [{ id: m.message_id, by: m.author.person_id }] : [],
  );
  if (new Set(theirs.map((x) => x.by)).size <= 1) return theirs.map((x) => x.id);
  const named = (personId: string): boolean => {
    const first = pack.trip.people.find((p) => p.person_id === personId)?.name.trim().split(/\s+/)[0];
    return !!first && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(first)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  };
  return theirs.filter((x) => named(x.by)).map((x) => x.id);
}

/**
 * The first message Go's words cited ("Meher said so in #6"), when it is a real message in this trip. The number leaves
 * the words, and the post replies to that message instead, so people see the proof itself.
 */
function citedMessageId(text: string, pack: TripPack): string | null {
  for (const seq of stripMessageRefs(text).refs) {
    const m = pack.messages.find((x) => x.seq === seq && !x.deleted && !x.withheld);
    if (m) return m.message_id;
  }
  return null;
}

/** The change number of a desk item's message in the pack, or null when it is not there (deleted since). */
const seqOf = (i: DeskItem, pack: TripPack): number | null => pack.messages.find((m) => m.message_id === messageIdOf(i))?.seq ?? null;

/** The chat lines of desk items' messages, as the context draws them, past `shownUpTo`: the prompt already holds the rest. */
function linesFor(items: DeskItem[], pack: TripPack, shownUpTo: number): { lines: string[]; seqs: number[] } {
  const names = new Map(pack.trip.people.map((p) => [p.person_id, personName(p.name)]));
  const seqs = new Map(pack.messages.map((m) => [m.message_id, m.seq]));
  const out = { lines: [] as string[], seqs: [] as number[] };
  for (const i of items) {
    const m = pack.messages.find((x) => x.message_id === messageIdOf(i));
    if (m && m.seq <= shownUpTo) continue;
    const line = m ? chatLine(m, (id) => names.get(id) ?? 'Someone who left', (id) => seqs.get(id)) : null;
    if (m && line) {
      out.lines.push(line);
      out.seqs.push(m.seq);
    }
  }
  return out;
}

/**
 * The exchange plus the lines that arrived meanwhile, as the next user turn. A turn that ended on its cards ends with
 * the cards' tool results (a user turn), so the lines join that turn instead of starting a second one in a row.
 */
function withNewLines(messages: Anthropic.MessageParam[], text: string): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (last?.role === 'user' && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text }] }];
  }
  return [...messages, { role: 'user', content: [{ type: 'text', text }] }];
}

const foldText = (lines: string[]): string =>
  `# New while you were writing\n${dataBlock('new messages', lines)}\n` +
  'Your reply above has not been posted yet. Write the one message to post now, covering these too if they need it. ' +
  'If they change nothing, send the same reply again.';

export function createComposer(d: ComposerDeps): Composer {
  const turnTimeoutMs = d.turnTimeoutMs ?? 20_000;
  /** The messages a running turn pulled in after it started: they are the turn's too when it ends. */
  const pulledBy = new Map<string, DeskItem[]>();

  async function alreadyPosted(turnId: string): Promise<boolean> {
    const r = await d.pool.query(
      `select 1 from go_requests where turn_id = $1 and method = 'post_message' and answered_at is not null and error is null limit 1`,
      [turnId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async function runTurn(t: TurnInput): Promise<void> {
    // A rerun of a turn whose message already went out: the room has its answer.
    if (await alreadyPosted(t.turnId)) return;
    const pack = await d.packs.get(t.tripId);
    const forGo = t.items.some(isForGo);
    if (d.budget && !d.budget.allows()) return overBudget(t, forGo);
    // Typing stays honest while the turn works: on now (if it was not), off when the turn ends.
    const typingAt = forGo ? d.speak.working(t.tripId) : null;
    const times: { firstToken: Date | null } = { firstToken: null };
    const usage = noUsage();
    let rounds = 0;
    // Typing may also be on for a message the turn pulled in, or one intake turned it on for: a turn that posted answered it.
    const pulled: DeskItem[] = [];
    let posted = false;
    try {
      const trip = await d.pool.query<{ composer_seen_seq: number; tz: string }>('select composer_seen_seq, tz from trips where trip_id = $1', [t.tripId]);
      const seenSeq = trip.rows[0]?.composer_seen_seq ?? 0;
      const tz = trip.rows[0]?.tz ?? 'Asia/Kolkata';
      await d.pool.query(
        `insert into turns (turn_id, trip_id, woke_for, attempt, started_at, typing_at, model) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (turn_id) do update
           set attempt = excluded.attempt, started_at = excluded.started_at, typing_at = coalesce(turns.typing_at, excluded.typing_at), error = null`,
        [t.turnId, t.tripId, t.items.map((i) => i.kind), t.attempt, d.now(), typingAt, d.model],
      );
      const prompt = await d.context.build({ tripId: t.tripId, pack, wake: t.items, seenSeq, now: d.now(), tz });
      const signal = AbortSignal.timeout(turnTimeoutMs);
      // P6's proactive bar may limit a turn Go woke for on its own: which tools, and whether its text may be posted.
      const limits = d.context.turnRules(t.items);
      const ctx = makeTurnCtx({ tripId: t.tripId, turnId: t.turnId, link: d.link, pack, wake: t.items, signal, limits });
      const base = {
        client: d.client,
        model: d.model,
        system: prompt.system,
        tools: d.tools.list(),
        ctx,
        signal,
        onFirstToken: () => {
          times.firstToken ??= d.now();
        },
        ...(d.budget ? { budget: d.budget } : {}),
      };
      let r = await runLoop({ ...base, messages: [{ role: 'user', content: prompt.user }] });
      addUsage(usage, r.usage);
      rounds += r.rounds;
      // The first round's hold did not fit today's budget (calls running at the same moment took the rest): no model
      // call was made, so someone who asked Go hears the day's limit, once per trip.
      if (r.stopReason === 'over_budget' && r.rounds === 0 && forGo) await limitLine(t);
      let newest = prompt.newestSeq;
      let unanswered = false;

      // Just before posting: messages that arrived meanwhile join this turn (one more round), instead of a stale answer.
      // A turn under limits (Go woke for itself) skips it: people's messages wait on the desk for their own turn,
      // which runs under the normal rules, never this turn's. A message the prompt already held (it landed before the
      // prompt was built, its desk item after) needs no extra round. But one that names Go was never a reason this turn
      // woke, so the model may have passed over it (a hello that only says hello): it goes back on the desk for a turn
      // of its own, which sees what Go just said.
      if (!r.silent && r.text && ctx.mayPostText !== false && ctx.allowedTools === undefined && rounds < MAX_ROUNDS) {
        const claimed = await d.claimNew(t.tripId, t.turnId);
        const passedOver = claimed.filter((i) => isForGo(i) && (seqOf(i, pack) ?? Number.POSITIVE_INFINITY) <= prompt.newestSeq);
        await d.release(t.turnId, passedOver.map((i) => i.id));
        pulled.push(...claimed.filter((i) => !passedOver.includes(i)));
        pulledBy.set(t.turnId, pulled);
        const fresh = linesFor(pulled, pack, prompt.newestSeq);
        if (fresh.lines.length) {
          const more = await runLoop({
            ...base,
            maxRounds: MAX_ROUNDS - rounds,
            messages: withNewLines(r.messages, foldText(fresh.lines)),
          });
          addUsage(usage, more.usage);
          rounds += more.rounds;
          if (more.stopReason === 'over_budget' && more.rounds === 0) {
            // Today's budget ran out before the extra round could call the model: the answer round 1 already paid for
            // still goes out. The new lines were never read, so they stay new for the next turn.
            unanswered = pulled.some(isForGo);
          } else {
            r = more;
            newest = Math.max(newest, ...fresh.seqs);
          }
        }
      }

      // With mayPostText false the words are dropped; the cards in ctx.cards still go.
      const text = r.silent || ctx.mayPostText === false ? null : r.text.trim() || null;
      const replyTo = text ? (replyToFor(t.items, pack) ?? citedMessageId(text, pack)) : null;
      const ids =
        text || ctx.cards.length
          ? await d.speak.post({
              link: ctx.link,
              tripId: t.tripId,
              turnId: t.turnId,
              requestId: (tag) => ctx.stableId(`go_${tag}`),
              text,
              cards: ctx.cards,
              ...(replyTo ? { replyTo } : {}),
              // People Go's words name get a push.
              people: pack.trip.people,
            })
          : [];
      posted = ids.length > 0;
      ctx.outcome.posts.push(...ids);
      ctx.outcome.spoke = text !== null && ids.length > 0;
      // Someone named Go in a line the budget left unread: they hear the day's limit, once per trip.
      if (unanswered) await limitLine(t);
      // Go asked instead of noting (a question back to the person, or a tool that chose to ask): no ✅ on those messages,
      // and a quick one the reflex already put there is taken back. A message this turn noted itself keeps its ✅.
      const asked = new Set([...(ctx.outcome.asked ?? []), ...(ctx.outcome.spoke && text ? askedBack(text, [...t.items, ...pulled], pack, newest) : [])]);
      for (const id of ctx.outcome.noted ?? []) asked.delete(id);
      for (const id of asked) {
        await withholdCheck(d.pool, ctx.link, t.tripId, id).catch((err: unknown) =>
          d.log.warn({ err, trip: t.tripId, message: id }, 'could not keep the ✅ off a message Go asked about'),
        );
      }
      const outcome = ctx.outcome.spoke ? 'spoke' : ids.length > 0 || ctx.outcome.reactions > 0 ? 'acted' : 'silent';
      await d.pool.query(
        `update turns set ended_at = $2, first_token_at = $3, rounds = $4, input_tokens = $5, cached_tokens = $6,
           cache_write_tokens = $7, output_tokens = $8, cost_usd = $9, outcome = $10, error = null
         where turn_id = $1`,
        [t.turnId, d.now(), times.firstToken, rounds, usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.costUsd, outcome],
      );
      await d.pool.query('update trips set composer_seen_seq = greatest(composer_seen_seq, $2) where trip_id = $1', [t.tripId, newest]);
    } catch (e) {
      const kind = classifyAnthropicError(e).kind;
      const message = e instanceof Error ? e.message : String(e);
      await d.pool
        .query(`update turns set ended_at = $2, outcome = 'failed', error = $3 where turn_id = $1`, [t.turnId, d.now(), `${kind}: ${message}`.slice(0, 500)])
        .catch(() => undefined);
      throw e;
    } finally {
      if (forGo || posted || pulled.some(isForGo)) d.speak.typingOff(t.tripId);
    }
  }

  /**
   * Over today's model budget: no model call. Someone who named Go hears so once per trip per day (one request id per
   * trip and day, so the Server posts it once however often this runs); a turn Go woke for on its own just ends.
   * Typing goes off either way.
   */
  async function overBudget(t: TurnInput, forGo: boolean): Promise<void> {
    try {
      if (forGo) await limitLine(t);
    } finally {
      if (forGo) d.speak.typingOff(t.tripId);
    }
  }

  /** The one "today's limit" line in a trip on a UTC day. */
  async function limitLine(t: TurnInput): Promise<void> {
    const day = utcDay(d.now());
    await d.speak.post({
      link: scopedLink(d.link, t.turnId),
      tripId: t.tripId,
      turnId: t.turnId,
      requestId: () => limitRequestId(t.tripId, day),
      text: OVER_BUDGET,
      cards: [],
    });
  }

  /** After the last failed attempt: one calm line, only if someone asked Go something and nothing went out yet. */
  async function giveUp(t: TurnInput): Promise<void> {
    if (!t.items.some(isForGo)) return;
    if (await alreadyPosted(t.turnId)) return;
    await d.speak.post({
      link: scopedLink(d.link, t.turnId),
      tripId: t.tripId,
      turnId: t.turnId,
      requestId: () => `go_trouble_${t.turnId}`,
      text: TROUBLE,
      cards: [],
    });
  }

  /**
   * A turn is over when it ran, or gave up after its last attempt (a failed attempt runs again under the same turn id):
   * the lanes end what it left open, such as a live search card (context.turnEnded).
   */
  function ended(t: TurnInput): void {
    const items = [...t.items, ...(pulledBy.get(t.turnId) ?? [])];
    pulledBy.delete(t.turnId);
    d.context.turnEnded({ tripId: t.tripId, turnId: t.turnId, messageIds: items.filter((i) => i.kind === 'message').map(messageIdOf) });
  }

  return {
    async runTurn(t) {
      await runTurn(t);
      ended(t);
    },
    async giveUp(t) {
      try {
        await giveUp(t);
      } finally {
        ended(t);
      }
    },
  };
}
