/**
 * The cache hit rate the provider would give, computed from the request bodies Go sent.
 * Rules (research/agent-sdk.md §3.4): render order tools, system, messages; a read lands only
 * where an earlier request wrote a breakpoint; each breakpoint looks back at most 20 blocks;
 * nothing under the model's minimum is cached. Token counts are estimates (bytes / 4).
 */
import { positions, promptParts, type MessageBody, type PromptParts, type RecordedRequest } from './requests.js';

export function minCacheableTokens(model: string): number {
  if (model.includes('haiku-4-5')) return 4096;
  if (/sonnet-5-5|opus-5-5|fable-5/.test(model)) return 512;
  return 1024;
}

export interface CacheEstimate {
  totalTokens: number;
  readTokens: number;
  writeTokens: number;
  /** At least one breakpoint reached the model's minimum. */
  eligible: boolean;
  /** Tokens up to the end of the cached chat (breakpoint 2), when there is one. */
  chatEndTokens: number | null;
  /** Tokens of tools and system together. */
  rulesTokens: number;
}

interface Entry { expiresS: number; ttlS: number; rules: boolean }

export class CacheEstimator {
  private readonly entries = new Map<string, Entry>();
  private readonly lookback: number;
  private readonly rulesStayWarm: boolean;

  /** `rulesStayWarm`: other trips keep the shared rules cached in production, so a quiet trip still reads them. */
  constructor(opts: { lookback?: number; rulesStayWarm?: boolean } = {}) {
    this.lookback = opts.lookback ?? 20;
    this.rulesStayWarm = opts.rulesStayWarm ?? true;
  }

  estimate(body: MessageBody, simS: number): CacheEstimate {
    const ps = positions(body);
    const cum: number[] = [];
    let running = 0;
    for (const p of ps) {
      running += p.tokens;
      cum.push(running);
    }
    const tokensAt = (k: number): number => cum[k] ?? 0;
    const rulesEnd = ps.reduce((last, p, k) => (p.part === 'tools' || p.part === 'system' ? k : last), -1);
    const chatEnd = ps.reduce((last, p, k) => (p.part === 'chat' ? k : last), -1);
    const alive = (hash: string): boolean => {
      const e = this.entries.get(hash);
      return e !== undefined && ((this.rulesStayWarm && e.rules) || e.expiresS >= simS);
    };
    const breakpoints = ps.flatMap((p, k) => (p.breakpoint ? [k] : []));

    let best = -1;
    for (const b of breakpoints) {
      for (let k = b; k >= Math.max(0, b - this.lookback); k--) {
        if (alive(ps[k]?.hash ?? '')) {
          best = Math.max(best, k);
          break;
        }
      }
    }
    const readTokens = best >= 0 ? tokensAt(best) : 0;
    const read = best >= 0 ? this.entries.get(ps[best]?.hash ?? '') : undefined;
    if (read !== undefined) read.expiresS = simS + read.ttlS;

    const min = minCacheableTokens(body.model);
    let lastWritten = -1;
    for (const b of breakpoints) {
      const p = ps[b];
      if (p === undefined || tokensAt(b) < min) continue;
      this.entries.set(p.hash, { expiresS: simS + p.ttlS, ttlS: p.ttlS, rules: b <= rulesEnd });
      lastWritten = b;
    }
    return {
      totalTokens: running,
      readTokens,
      writeTokens: lastWritten > best ? tokensAt(lastWritten) - readTokens : 0,
      eligible: lastWritten >= 0,
      chatEndTokens: chatEnd >= 0 ? tokensAt(chatEnd) : null,
      rulesTokens: rulesEnd >= 0 ? tokensAt(rulesEnd) : 0,
    };
  }
}

export type MissReason = 'first' | 'below_minimum' | 'ttl' | 'rules_changed' | 'delete' | 'edit' | 'fold' | 'drift';
export type TurnResult = 'hit' | MissReason;
export interface ChatEvent { kind: 'edit' | 'delete'; realMs: number }

export interface TurnCache {
  n: number;
  realMs: number;
  simS: number;
  /** The turn's first model call (one user message); later rounds carry tool results. */
  firstRound: boolean;
  parts: PromptParts;
  estimate: CacheEstimate;
  hitRate: number;
  result: TurnResult;
  /** Leading positions identical to the previous first round. */
  sharedBlocks: number;
}

/** The TTL Go asks for (master §6.5). A miss after a shorter gap is never excused as "ttl". */
export const CACHE_TTL_S = 3600;

export function cacheTurns(requests: readonly RecordedRequest[], events: readonly ChatEvent[], opts: { rulesStayWarm?: boolean } = {}): TurnCache[] {
  const estimator = new CacheEstimator(opts.rulesStayWarm === undefined ? {} : { rulesStayWarm: opts.rulesStayWarm });
  const out: TurnCache[] = [];
  let prev: { realMs: number; turn: TurnCache; hashes: string[] } | null = null;
  let lastSimS: number | null = null;
  for (const r of requests) {
    if (r.role !== 'composer') continue;
    const estimate = estimator.estimate(r.body, r.simS);
    const parts = promptParts(r.body);
    const hashes = positions(r.body).map((p) => p.hash);
    const firstRound = r.body.messages.length === 1;
    let result: TurnResult;
    let sharedBlocks = 0;
    if (!estimate.eligible) {
      result = 'below_minimum';
    } else if (!firstRound) {
      result = estimate.readTokens >= (estimate.chatEndTokens ?? estimate.rulesTokens) ? 'hit' : 'drift';
    } else if (prev === null || !prev.turn.estimate.eligible) {
      result = 'first';
    } else {
      const p = prev;
      while (sharedBlocks < hashes.length && sharedBlocks < p.hashes.length && hashes[sharedBlocks] === p.hashes[sharedBlocks]) sharedBlocks++;
      const wanted = p.turn.estimate.chatEndTokens ?? p.turn.estimate.rulesTokens;
      const landed = (kind: ChatEvent['kind']): boolean => events.some((e) => e.kind === kind && e.realMs > p.realMs && e.realMs <= r.realMs);
      if (estimate.readTokens >= wanted) result = 'hit';
      else if (lastSimS !== null && r.simS - lastSimS > CACHE_TTL_S) result = 'ttl';
      else if (parts.rules !== p.turn.parts.rules) result = 'rules_changed';
      else if (landed('delete')) result = 'delete';
      else if (landed('edit')) result = 'edit';
      else if (parts.chatBlocks < p.turn.parts.chatBlocks) result = 'fold';
      else result = 'drift';
    }
    const turn: TurnCache = {
      n: r.n, realMs: r.realMs, simS: r.simS, firstRound, parts, estimate,
      hitRate: estimate.totalTokens > 0 ? estimate.readTokens / estimate.totalTokens : 0,
      result, sharedBlocks,
    };
    out.push(turn);
    lastSimS = r.simS;
    if (firstRound) prev = { realMs: r.realMs, turn, hashes };
  }
  return out;
}

export interface CacheSummary {
  requests: number;
  eligible: number;
  /** Read over total input, every composer request but the run's first. Null when there is nothing to count. */
  hitRate: number | null;
  /** The same over every composer request, the first included. */
  hitRateAll: number | null;
  status: 'ok' | 'not_cacheable_yet' | 'no_requests';
  results: Record<TurnResult, number>;
  folds: Array<{ n: number; beforeChatTokens: number; afterChatTokens: number }>;
}

export function summarizeCache(turns: readonly TurnCache[]): CacheSummary {
  const results: Record<TurnResult, number> = { hit: 0, first: 0, below_minimum: 0, ttl: 0, rules_changed: 0, delete: 0, edit: 0, fold: 0, drift: 0 };
  for (const t of turns) results[t.result]++;
  const folds: CacheSummary['folds'] = [];
  let prevFirst: TurnCache | null = null;
  for (const t of turns) {
    if (!t.firstRound) continue;
    if (t.result === 'fold' && prevFirst !== null) folds.push({ n: t.n, beforeChatTokens: prevFirst.parts.chat, afterChatTokens: t.parts.chat });
    prevFirst = t;
  }
  const rate = (ts: readonly TurnCache[]): number | null => {
    const total = ts.reduce((s, t) => s + t.estimate.totalTokens, 0);
    return total > 0 ? ts.reduce((s, t) => s + t.estimate.readTokens, 0) / total : null;
  };
  const eligible = turns.filter((t) => t.estimate.eligible).length;
  const base = { requests: turns.length, eligible, results, folds };
  if (turns.length === 0) return { ...base, status: 'no_requests', hitRate: null, hitRateAll: null };
  if (eligible === 0) return { ...base, status: 'not_cacheable_yet', hitRate: null, hitRateAll: null };
  return { ...base, status: 'ok', hitRate: rate(turns.slice(1)), hitRateAll: rate(turns) };
}
