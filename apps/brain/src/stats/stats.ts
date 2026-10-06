/** The proof board's numbers, from the turns Go really ran in a window, plus the sources other lanes add. */
import type pg from 'pg';
import type { StatsRegistry, StatsWindow } from './sources.js';

/** The provider's minimum cacheable prompt (research/agent-sdk.md §3.4). */
export function minCacheableTokens(model: string): number {
  if (model.includes('haiku-4-5')) return 4096;
  if (/sonnet-5-5|opus-5-5|fable-5/.test(model)) return 512;
  return 1024;
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))] ?? null;
}

export interface BoardSource { name: string; label: string; good: 'zero' | 'low' | 'high'; value: number | null; of?: number; note?: string }
export interface BoardBench { chat: string; mode: string; receivedAt: string; summary: Record<string, unknown> }

export interface BoardNumbers {
  window: { hours: number; from: string; to: string };
  /** No turns in the window. */
  empty: boolean;
  turns: number;
  messages: number;
  /** From the waking message landing to typing on. */
  typing: { n: number; p50Ms: number | null; p90Ms: number | null };
  /** From the waking message landing to Go's post. */
  reply: { n: number; p50Ms: number | null; p90Ms: number | null };
  cache: { status: 'ok' | 'not_cacheable_yet' | 'no_turns'; hit: number | null; turns: number; eligibleTurns: number };
  wake: { turns: number; messages: number; rate: number | null };
  cost: { totalUsd: number; perTripUsd: number | null; trips: number };
  sources: BoardSource[];
  bench: BoardBench[];
}

interface TurnRow {
  trip_id: string;
  typing_at: Date | null;
  posted_at: Date | null;
  landed_at: Date | null;
  model: string;
  rounds: number;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost_usd: string | number | null;
}

/** pg returns numeric as a string; anything unreadable counts as 0. */
const num = (v: number | string | null): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function computeBoard(pool: pg.Pool, registry: StatsRegistry, o: { now: Date; hours: number }): Promise<BoardNumbers> {
  const to = o.now;
  const from = new Date(to.getTime() - o.hours * 3_600_000);
  const window: StatsWindow = { from, to, hours: o.hours };
  const { rows } = await pool.query<TurnRow>(
    `select t.trip_id, t.typing_at, t.posted_at, t.model, t.rounds, t.input_tokens, t.cached_tokens, t.cache_write_tokens, t.cost_usd,
            (select min(e.received_at)
               from desk_items d
               join trip_events e
                 on e.trip_id = d.trip_id and e.type = 'message.created' and e.payload #>> '{data,message,message_id}' = d.ref
              where d.turn_id = t.turn_id and d.kind = 'message') as landed_at
       from turns t
      where t.started_at >= $1 and t.started_at < $2`,
    [from, to],
  );
  const msgs = await pool.query<{ n: number }>(
    `select count(*)::int as n from trip_events
      where type = 'message.created' and received_at >= $1 and received_at < $2
        and payload #>> '{data,message,author,kind}' = 'person'`,
    [from, to],
  );
  const messages = msgs.rows[0]?.n ?? 0;

  const since = (at: Date | null, landed: Date | null): number[] => {
    if (at === null || landed === null) return [];
    const d = at.getTime() - landed.getTime();
    return d >= 0 ? [d] : [];
  };
  const typingMs = rows.flatMap((r) => since(r.typing_at, r.landed_at));
  const replyMs = rows.flatMap((r) => since(r.posted_at, r.landed_at));

  const modelTurns = rows.filter((r) => r.rounds > 0);
  const inputOf = (r: TurnRow): number => r.input_tokens + r.cached_tokens + r.cache_write_tokens;
  const input = modelTurns.reduce((s, r) => s + inputOf(r), 0);
  const cached = modelTurns.reduce((s, r) => s + r.cached_tokens, 0);
  const eligibleTurns = modelTurns.filter((r) => inputOf(r) >= minCacheableTokens(r.model)).length;
  const status: BoardNumbers['cache']['status'] = modelTurns.length === 0 ? 'no_turns' : eligibleTurns === 0 ? 'not_cacheable_yet' : 'ok';

  const totalUsd = rows.reduce((s, r) => s + num(r.cost_usd), 0);
  const trips = new Set(rows.map((r) => r.trip_id)).size;

  const sources: BoardSource[] = [];
  for (const s of registry.list()) {
    try {
      sources.push({ name: s.name, label: s.label, good: s.good, ...(await s.read(pool, window)) });
    } catch {
      sources.push({ name: s.name, label: s.label, good: s.good, value: null, note: 'Could not read this number.' });
    }
  }
  const bench = (await pool.query<{ chat: string; mode: string; summary: Record<string, unknown>; received_at: Date }>(
    'select chat, mode, summary, received_at from bench_reports order by chat',
  )).rows.map((b) => ({ chat: b.chat, mode: b.mode, receivedAt: b.received_at.toISOString(), summary: b.summary }));

  return {
    window: { hours: o.hours, from: from.toISOString(), to: to.toISOString() },
    empty: rows.length === 0,
    turns: rows.length,
    messages,
    typing: { n: typingMs.length, p50Ms: percentile(typingMs, 50), p90Ms: percentile(typingMs, 90) },
    reply: { n: replyMs.length, p50Ms: percentile(replyMs, 50), p90Ms: percentile(replyMs, 90) },
    cache: { status, hit: status === 'ok' && input > 0 ? cached / input : null, turns: modelTurns.length, eligibleTurns },
    wake: { turns: modelTurns.length, messages, rate: messages > 0 ? modelTurns.length / messages : null },
    cost: { totalUsd, perTripUsd: trips > 0 ? totalUsd / trips : null, trips },
    sources,
    bench,
  };
}
