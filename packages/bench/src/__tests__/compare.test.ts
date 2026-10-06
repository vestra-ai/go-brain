import { describe, expect, it } from 'vitest';
import { compareFast, compareLive, loadBars, pickModel, type LiveRun } from '../compare.js';
import { renderSummary, type BenchReport } from '../report-md.js';
import type { ChatScore } from '../score.js';

const bars = loadBars();
const base: ChatScore = {
  chat: 'goa-50', mode: 'fast', composerModel: 'claude-sonnet-5-5', reflexSource: 'labels',
  messages: { people: 50, goLinesSkipped: 0, edits: 1, deletes: 1, reactions: 1, photos: 1 },
  wake: { turns: 10, messages: 50, rate: 0.2 },
  typing: { n: 6, p50Ms: 20, p90Ms: 40, missing: 0, withoutPost: 1 },
  reply: { n: 6, p50Ms: 300, p90Ms: 900 },
  speak: { asks: 6, answered: 6, missed: [], posts: 7, byKind: { prompted: 6, follow_up: 0, greeting: 1, duplicate: 0, unprompted: 0 }, unprompted: [], duplicates: [] },
  quiet: { reactions: 7, wrongReactions: [], recordLines: 2 },
  cache: { requests: 10, eligible: 10, hitRate: 0.9, hitRateAll: 0.82, status: 'ok', results: { hit: 9, first: 1, below_minimum: 0, ttl: 0, rules_changed: 0, delete: 0, edit: 0, fold: 0, drift: 0 }, folds: [] },
  turns: [],
  prompt: { maxTokens: 6200, lastTokens: 6100, average: { tools: 900, system: 3200, chat: 1100, now: 500 } },
  recall: { probes: 5, ran: true, passed: 5, afterFold: 0, failed: [] },
  leaks: [], firstToken: { p50Ms: null, p90Ms: null }, side: { requests: 3, tokens: 1200 }, costUsd: 0.012, unreadByReflex: 0, durationMs: 20_000,
};
const failed = (scores: ChatScore[]): string[] => compareFast(scores, bars.fast).checks.filter((c) => !c.ok).map((c) => `${c.chat}: ${c.name}`);

describe('the bars and the verdict', () => {
  it('holds the spec\'s numbers', () => {
    expect(bars.fast).toMatchObject({ typingP90Ms: 500, cacheHitMin: 0.85, wakeRateMax: 0.25, labelledChats: ['goa-50'] });
    expect(bars.live).toMatchObject({ typingP90Ms: 500, replyP50Ms: 2500, replyP90Ms: 5000, cacheHitMin: 0.85, wakeRateMax: 0.25, unpromptedShareMax: 0.02 });
  });

  it('passes a clean score', () => {
    expect(failed([base])).toEqual([]);
    expect(compareFast([base], bars.fast).ok).toBe(true);
  });

  it('judges the cache on long chats and only reports it on the short one', () => {
    const low = { ...base.cache, hitRate: 0.8 };
    // goa-2000 must also fold (bars.json requires memory): give it one, so only the cache fails.
    const folded = { ...low, folds: [{ n: 40, beforeChatTokens: 12_400, afterChatTokens: 6_100 }] };
    expect(failed([{ ...base, chat: 'goa-2000', cache: folded }])).toEqual(['goa-2000: cache hit']);
    const short = compareFast([{ ...base, cache: low }], bars.fast).checks.find((c) => c.name === 'cache hit');
    expect(short).toMatchObject({ ok: true, value: '80.0%' });
  });

  it('says "not cacheable yet" instead of 0% and does not fail on it', () => {
    const young = { ...base, chat: 'goa-300', cache: { ...base.cache, status: 'not_cacheable_yet' as const, hitRate: null, hitRateAll: null, eligible: 0 } };
    const c = compareFast([young], bars.fast).checks.find((x) => x.name === 'cache hit');
    expect(c).toMatchObject({ value: 'not cacheable yet', ok: true });
  });

  it('fails a wake rate over the bar and notes a chat with no messages from people', () => {
    expect(failed([{ ...base, wake: { turns: 14, messages: 50, rate: 0.28 } }])).toEqual(['goa-50: woke the model']);
    const none = compareFast([{ ...base, wake: { turns: 1, messages: 0, rate: null } }], bars.fast).checks.find((c) => c.name === 'woke the model');
    expect(none).toMatchObject({ ok: true, note: 'no messages from people' });
  });

  it('fails any wrong speak on the labelled chat, and only duplicates elsewhere', () => {
    const missed = { ...base.speak, missed: [{ line: 9, text: '@Go flights?' }], answered: 5 };
    expect(failed([{ ...base, speak: missed }])).toEqual(['goa-50: wrong speak (missed, unprompted, duplicate)']);
    expect(failed([{ ...base, chat: 'goa-300', speak: missed }])).toEqual([]);
    const dup = { ...base.speak, duplicates: [{ at: 1, text: 'On it! Checking now.' }] };
    expect(failed([{ ...base, chat: 'goa-300', speak: dup }])).toEqual(['goa-300: duplicate posts']);
    expect(failed([{ ...base, quiet: { ...base.quiet, wrongReactions: [{ line: 36, emoji: '✅' }] } }])).toEqual(['goa-50: wrong quiet reactions']);
  });

  it('fails a broken cache, a leak, an unread line and missing typing', () => {
    expect(failed([{ ...base, cache: { ...base.cache, results: { ...base.cache.results, drift: 1 } } }])).toEqual(['goa-50: cache breaks (drift, rules changed)']);
    expect(failed([{ ...base, leaks: [{ line: 15, requestN: 4 }] }])).toEqual(['goa-50: deleted text in a later prompt']);
    expect(failed([{ ...base, unreadByReflex: 2 }])).toEqual(['goa-50: lines the reflex never read']);
    expect(failed([{ ...base, typing: { ...base.typing, missing: 1 } }])).toEqual(['goa-50: typing missing']);
  });

  it('fails a recall miss; recall not run fails only once memory is required', () => {
    expect(failed([{ ...base, recall: { ...base.recall, passed: 4, failed: [{ question: 'q', line: 6, seq: 8, got: [] }] } }])).toEqual(['goa-50: recall']);
    const notRun = { ...base, recall: { ...base.recall, ran: false, passed: 0 } };
    expect(compareFast([notRun], { ...bars.fast, requireMemory: false }).ok).toBe(true);
    expect(compareFast([notRun], { ...bars.fast, requireMemory: true }).ok).toBe(false);
  });

  it('needs a fold on the fold chat once memory is required', () => {
    const big = { ...base, chat: 'goa-2000', recall: { ...base.recall, probes: 0, passed: 0 } };
    expect(compareFast([big], { ...bars.fast, requireMemory: false }).ok).toBe(true);
    expect(compareFast([big], { ...bars.fast, requireMemory: true }).checks.find((c) => c.name === 'folds')?.ok).toBe(false);
  });
});

describe('the live verdict and the model pick', () => {
  const provider = { requests: 10, cacheHit: 0.9, firstTokenP50Ms: 700, firstTokenP90Ms: 1100, costUsd: 0.05 };
  const run = (model: string, replyP50: number, over: Partial<LiveRun> = {}): LiveRun => ({
    model, chat: 'goa-50', score: { ...base, mode: 'live', composerModel: model, reply: { n: 6, p50Ms: replyP50, p90Ms: replyP50 * 2 } }, provider, ...over,
  });

  it('judges the gate model and picks the fastest model that passes every bar', () => {
    const sonnet = run('claude-sonnet-5-5', 1900);
    const haiku = run('claude-haiku-4-5', 1200, { provider: { ...provider, cacheHit: 0.4 } });
    const v = compareLive([sonnet, haiku], bars.live, 'claude-sonnet-5-5');
    expect(v.ok).toBe(true);
    expect(v.byModel).toEqual({ 'claude-sonnet-5-5': true, 'claude-haiku-4-5': false });
    expect(pickModel([sonnet, haiku], v.byModel)?.model).toBe('claude-sonnet-5-5');
    const both = compareLive([sonnet, run('claude-haiku-4-5', 1200)], bars.live, 'claude-haiku-4-5');
    expect(pickModel([sonnet, run('claude-haiku-4-5', 1200)], both.byModel)?.model).toBe('claude-haiku-4-5');
  });

  it('fails a slow reply on the live bench', () => {
    const v = compareLive([run('claude-sonnet-5-5', 3000)], bars.live, 'claude-sonnet-5-5');
    expect(v.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['reply p50', 'reply p90']);
  });
});

describe('the summary', () => {
  it('puts failures first and never prints NaN, undefined, Infinity or an em dash', () => {
    const scores = [base, { ...base, chat: 'goa-2000', cache: { ...base.cache, hitRate: 0.8 } }, { ...base, chat: 'empty', wake: { turns: 0, messages: 0, rate: null }, typing: { n: 0, p50Ms: null, p90Ms: null, missing: 0, withoutPost: 0 }, prompt: { maxTokens: null, lastTokens: null, average: null }, costUsd: null }];
    const report: BenchReport = { schema: 'go.bench-report/v1', mode: 'fast', at: '2026-10-06T18:00:00Z', commit: 'abc1234', scores, verdict: compareFast(scores, bars.fast) };
    const md = renderSummary(report);
    expect(md).toContain('1 of');
    expect(md.indexOf('goa-2000 | cache hit')).toBeLessThan(md.indexOf('goa-50 | typing p90'));
    for (const bad of ['NaN', 'undefined', 'Infinity', '\u2014']) expect(md).not.toContain(bad);
  });
});
