import type pg from 'pg';
import { limitRequestId, utcDay, type Budget } from '../budget.js';
import type { DeskItem, TurnInput, TurnRunner } from '../desk/desk.js';
import type { ServerLink } from '../door/server-link.js';
import type { Log } from '../log.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { AnthropicLike } from './anthropic.js';
import { classifyAnthropicError } from './anthropic-helpers.js';
import type { ContextImpl } from './context.js';
import { chatLine, dataBlock, personName } from './fence.js';
import { addUsage, MAX_ROUNDS, noUsage, runLoop } from './loop.js';
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

/** The chat lines of desk items' messages, as the context draws them. */
function linesFor(items: DeskItem[], pack: TripPack): { lines: string[]; seqs: number[] } {
  const names = new Map(pack.trip.people.map((p) => [p.person_id, personName(p.name)]));
  const seqs = new Map(pack.messages.map((m) => [m.message_id, m.seq]));
  const out = { lines: [] as string[], seqs: [] as number[] };
  for (const i of items) {
    const m = pack.messages.find((x) => x.message_id === messageIdOf(i));
    const line = m ? chatLine(m, (id) => names.get(id) ?? 'Someone who left', (id) => seqs.get(id)) : null;
    if (m && line) {
      out.lines.push(line);
      out.seqs.push(m.seq);
    }
  }
  return out;
}

const foldText = (lines: string[]): string =>
  `# New while you were writing\n${dataBlock('new messages', lines)}\n` +
  'Your reply above has not been posted yet. Write the one message to post now, covering these too if they need it. ' +
  'If they change nothing, send the same reply again.';

export function createComposer(d: ComposerDeps): Composer {
  const turnTimeoutMs = d.turnTimeoutMs ?? 20_000;

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
      let newest = prompt.newestSeq;

      // Just before posting: messages that arrived meanwhile join this turn (one more round), instead of a stale answer.
      // A turn under limits (Go woke for itself) skips it: people's messages wait on the desk for their own turn,
      // which runs under the normal rules, never this turn's.
      if (!r.silent && r.text && ctx.mayPostText !== false && ctx.allowedTools === undefined && rounds < MAX_ROUNDS) {
        pulled.push(...(await d.claimNew(t.tripId, t.turnId)));
        const fresh = linesFor(pulled, pack);
        if (fresh.lines.length) {
          r = await runLoop({
            ...base,
            continuing: true,
            maxRounds: MAX_ROUNDS - rounds,
            messages: [...r.messages, { role: 'user', content: [{ type: 'text', text: foldText(fresh.lines) }] }],
          });
          addUsage(usage, r.usage);
          rounds += r.rounds;
          newest = Math.max(newest, ...fresh.seqs);
        }
      }

      // With mayPostText false the words are dropped; the cards in ctx.cards still go.
      const text = r.silent || ctx.mayPostText === false ? null : r.text.trim() || null;
      const replyTo = text ? replyToFor(t.items, pack) : null;
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
            })
          : [];
      posted = ids.length > 0;
      ctx.outcome.posts.push(...ids);
      ctx.outcome.spoke = text !== null && ids.length > 0;
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
      if (!forGo) return;
      const day = utcDay(d.now());
      await d.speak.post({
        link: scopedLink(d.link, t.turnId),
        tripId: t.tripId,
        turnId: t.turnId,
        requestId: () => limitRequestId(t.tripId, day),
        text: OVER_BUDGET,
        cards: [],
      });
    } finally {
      if (forGo) d.speak.typingOff(t.tripId);
    }
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

  return { runTurn, giveUp };
}
