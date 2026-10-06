/** The bars from spec §1 and the verdict on a run: every check with its value, its bar, and why it passed when there was nothing to measure. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { wrongSpeak, type ChatScore, type ProviderNumbers } from './score.js';
import { fmtMs, fmtPct, percentile } from './stats-math.js';

const share = z.number().min(0).max(1);
export const Bars = z.object({
  schema: z.literal('go.bench-bars/v1'),
  fast: z.object({
    typingP90Ms: z.number().positive(),
    goTimeP90Ms: z.number().positive(),
    cacheHitMin: share,
    cacheChats: z.array(z.string()),
    wakeRateMax: share,
    labelledChats: z.array(z.string()),
    recallMissMax: z.int().nonnegative(),
    leakMax: z.int().nonnegative(),
    brokenCacheMax: z.int().nonnegative(),
    requireMemory: z.boolean(),
    foldChats: z.array(z.string()),
  }),
  live: z.object({
    typingP90Ms: z.number().positive(),
    replyP50Ms: z.number().positive(),
    replyP90Ms: z.number().positive(),
    cacheHitMin: share,
    wakeRateMax: share,
    labelledChats: z.array(z.string()),
    unpromptedShareMax: share,
    recallMissMax: z.int().nonnegative(),
  }),
});
export type Bars = z.infer<typeof Bars>;

export function loadBars(): Bars {
  return Bars.parse(JSON.parse(readFileSync(new URL('../bars.json', import.meta.url), 'utf8')));
}

export interface Check { chat: string; name: string; value: string; bar: string; ok: boolean; note?: string }
export interface Verdict { ok: boolean; checks: Check[] }

function adder(checks: Check[], chat: string) {
  return (name: string, value: string, bar: string, ok: boolean, note?: string): void => {
    checks.push({ chat, name, value, bar, ok, ...(note !== undefined ? { note } : {}) });
  };
}

export function compareFast(scores: readonly ChatScore[], b: Bars['fast']): Verdict {
  const checks: Check[] = [];
  for (const s of scores) {
    const add = adder(checks, s.chat);
    const typingBar = `p90 under ${b.typingP90Ms} ms`;
    if (s.typing.p90Ms === null) add('typing p90', 'n/a', typingBar, true, 'no message named Go');
    else add('typing p90', fmtMs(s.typing.p90Ms), typingBar, s.typing.p90Ms <= b.typingP90Ms);
    if (s.typing.missing > 0) add('typing missing', String(s.typing.missing), '0', false);

    const goTimeBar = `p90 under ${b.goTimeP90Ms} ms`;
    if (s.reply.p90Ms === null) add("Go's own time to reply", 'n/a', goTimeBar, true, 'no answered ask');
    else add("Go's own time to reply", fmtMs(s.reply.p90Ms), goTimeBar, s.reply.p90Ms <= b.goTimeP90Ms, 'the model is a stand-in that answers at once');

    const cacheBar = `${Math.round(b.cacheHitMin * 100)}% or more`;
    if (s.cache.status === 'not_cacheable_yet') add('cache hit', 'not cacheable yet', cacheBar, true, 'every prompt is under the model minimum');
    else if (s.cache.hitRate === null) add('cache hit', 'n/a', cacheBar, true, 'no composer turns to compare');
    else if (!b.cacheChats.includes(s.chat)) add('cache hit', fmtPct(s.cache.hitRate), cacheBar, true, 'reported only: this chat is shorter than the prompts the bar is for');
    else add('cache hit', fmtPct(s.cache.hitRate), cacheBar, s.cache.hitRate >= b.cacheHitMin);
    const broken = s.cache.results.drift + s.cache.results.rules_changed;
    add('cache breaks (drift, rules changed)', String(broken), `at most ${b.brokenCacheMax}`, broken <= b.brokenCacheMax);

    const wakeBar = `under ${Math.round(b.wakeRateMax * 100)}%`;
    if (s.wake.rate === null) add('woke the model', 'n/a', wakeBar, true, 'no messages from people');
    else add('woke the model', `${s.wake.turns} of ${s.wake.messages} (${fmtPct(s.wake.rate)})`, wakeBar, s.wake.rate < b.wakeRateMax);

    const wrong = wrongSpeak(s);
    if (b.labelledChats.includes(s.chat)) {
      add('wrong speak (missed, unprompted, duplicate)', String(wrong), '0', wrong === 0);
      add('wrong quiet reactions', String(s.quiet.wrongReactions.length), '0', s.quiet.wrongReactions.length === 0);
    } else {
      add('duplicate posts', String(s.speak.duplicates.length), '0', s.speak.duplicates.length === 0);
      add('wrong speak', String(wrong), 'for review', true, 'generated labels: listed for a person to review');
    }
    add('deleted text in a later prompt', String(s.leaks.length), `at most ${b.leakMax}`, s.leaks.length <= b.leakMax);
    if (s.unreadByReflex > 0) add('lines the reflex never read', String(s.unreadByReflex), '0', false);

    if (s.recall.probes > 0) {
      if (!s.recall.ran) add('recall', 'not run', `all ${s.recall.probes}`, !b.requireMemory, 'the memory lane is not registered');
      else add('recall', `${s.recall.passed} of ${s.recall.probes}`, `at most ${b.recallMissMax} missed`, s.recall.probes - s.recall.passed <= b.recallMissMax);
    }
    if (b.foldChats.includes(s.chat)) {
      const folded = s.cache.folds.length >= 1;
      if (b.requireMemory) add('folds', String(s.cache.folds.length), 'at least 1', folded);
      else add('folds', String(s.cache.folds.length), 'at least 1', true, 'not required until the memory lane lands');
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export interface LiveRun { model: string; chat: string; score: ChatScore; provider: ProviderNumbers }

export function liveChecks(run: LiveRun, b: Bars['live']): Check[] {
  const checks: Check[] = [];
  const add = adder(checks, `${run.chat} (${run.model})`);
  const s = run.score;
  const within = (name: string, v: number | null, max: number, bar: string): void => {
    if (v === null) add(name, 'n/a', bar, true, 'nothing to measure');
    else add(name, fmtMs(v), bar, v <= max);
  };
  within('typing p90', s.typing.p90Ms, b.typingP90Ms, `under ${b.typingP90Ms} ms`);
  within('reply p50', s.reply.p50Ms, b.replyP50Ms, `under ${b.replyP50Ms} ms`);
  within('reply p90', s.reply.p90Ms, b.replyP90Ms, `under ${b.replyP90Ms} ms`);
  const cacheBar = `${Math.round(b.cacheHitMin * 100)}% or more`;
  if (s.cache.status === 'not_cacheable_yet') add('cache hit (provider)', 'not cacheable yet', cacheBar, true, 'every prompt is under the model minimum');
  else if (run.provider.cacheHit === null) add('cache hit (provider)', 'n/a', cacheBar, true, 'no usage reported');
  else add('cache hit (provider)', fmtPct(run.provider.cacheHit), cacheBar, run.provider.cacheHit >= b.cacheHitMin);
  const wakeBar = `under ${Math.round(b.wakeRateMax * 100)}%`;
  if (s.wake.rate === null) add('woke the model', 'n/a', wakeBar, true, 'no messages from people');
  else add('woke the model', fmtPct(s.wake.rate), wakeBar, s.wake.rate < b.wakeRateMax);
  if (b.labelledChats.includes(run.chat)) add('wrong speak', String(wrongSpeak(s)), '0', wrongSpeak(s) === 0);
  else {
    const unpromptedShare = s.speak.posts > 0 ? s.speak.unprompted.length / s.speak.posts : null;
    const bar = `under 1 in ${Math.round(1 / b.unpromptedShareMax)}`;
    if (unpromptedShare === null) add('unprompted posts', 'n/a', bar, true, 'no posts');
    else add('unprompted posts', `${s.speak.unprompted.length} of ${s.speak.posts}`, bar, unpromptedShare < b.unpromptedShareMax, 'a person reviews each one');
  }
  if (s.recall.probes > 0) add('recall', s.recall.ran ? `${s.recall.passed} of ${s.recall.probes}` : 'not run', `at most ${b.recallMissMax} missed`, s.recall.ran && s.recall.probes - s.recall.passed <= b.recallMissMax);
  return checks;
}

export function compareLive(runs: readonly LiveRun[], b: Bars['live'], gateModel: string): Verdict & { byModel: Record<string, boolean> } {
  const byModel: Record<string, boolean> = {};
  const checks: Check[] = [];
  for (const r of runs) {
    const cs = liveChecks(r, b);
    checks.push(...cs);
    byModel[r.model] = (byModel[r.model] ?? true) && cs.every((c) => c.ok);
  }
  const gate = runs.filter((r) => r.model === gateModel);
  return { ok: gate.length > 0 && byModel[gateModel] === true, checks, byModel };
}

/** The fastest model (median of its chats' reply p50) among those that pass every live bar; cost breaks ties. */
export function pickModel(runs: readonly LiveRun[], byModel: Readonly<Record<string, boolean>>): { model: string; why: string } | null {
  const models = [...new Set(runs.map((r) => r.model))];
  if (models.length === 0) return null;
  const reply = (m: string): number | null => percentile(runs.filter((r) => r.model === m).flatMap((r) => (r.score.reply.p50Ms === null ? [] : [r.score.reply.p50Ms])), 50);
  const cost = (m: string): number => runs.filter((r) => r.model === m).reduce((s, r) => s + (r.provider.costUsd ?? 0), 0);
  const passing = models.filter((m) => byModel[m] === true);
  const pool = passing.length > 0 ? passing : models;
  const best = [...pool].sort((a, b) => (reply(a) ?? Number.MAX_VALUE) - (reply(b) ?? Number.MAX_VALUE) || cost(a) - cost(b))[0];
  if (best === undefined) return null;
  return {
    model: best,
    why: passing.length > 0
      ? `passes every live bar with the fastest reply p50 (${fmtMs(reply(best))})`
      : `no model passes every bar; this one has the fastest reply p50 (${fmtMs(reply(best))})`,
  };
}
