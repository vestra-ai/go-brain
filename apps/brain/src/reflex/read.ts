/**
 * Pure readers: Jev's answers plus what code already knows, to a ReflexRead.
 * Every gate is written positively (a bar must be cleared), so a missing, NaN or odd answer can only
 * read "unsure". Question 8 can only raise caution.
 */
import type { JevAnswer } from './jev.js';
import { REACTIONS, RECIPE_CHOICES, type QuestionName, type RecipeChoice } from './questions.js';
import type { ReflexRead, Sure } from './reflex.js';
import type { SecretKind } from './secrets.js';
import { BARS, type Bars } from './thresholds.js';

export interface CodeFacts {
  /** Go plainly named: mentions_go, a reply to Go, or Go spoken to (trips/names-go.ts). */
  namesGo: boolean;
  /** What the secrets screen found in the message. */
  secretKinds: SecretKind[];
  hasTasks: boolean;
  /** A line about money (money-line.ts): it always reaches the model, whatever Jev says. */
  money: boolean;
  /** Only emoji, a laugh, an ok, or a greeting or sign-off (small-talk.ts): read only when Jev has no answer. */
  smallTalk?: boolean;
}
export type RiskWhy = 'spend' | 'steer' | 'secret';
type Answers = Record<string, JevAnswer> | null;

export const sure = <T>(value: T): Sure<T> => ({ value, sure: true });
export const unsure = <T>(): Sure<T> => ({ value: null, sure: false });

const inRange = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** A noul's probability of yes, or NaN when missing or malformed. */
export function noulP(a: Answers, key: string): number {
  const x = a?.[key];
  return x && x.type === 'noul' && inRange(x.noul) ? x.noul : Number.NaN;
}

/** One option's probability mass in a Choice; the confidence only for the chosen option when probabilities are absent. */
export function massOf(a: Answers, key: string, option: string): number {
  const x = a?.[key];
  if (!x || x.type !== 'choice') return Number.NaN;
  const p = x.probabilities ? x.probabilities[option] : undefined;
  if (inRange(p)) return p;
  return x.choice === option && inRange(x.confidence) ? x.confidence : Number.NaN;
}

const atLeast = (p: number, bar: number): boolean => Number.isFinite(p) && p >= bar;
const atMost = (p: number, bar: number): boolean => Number.isFinite(p) && p <= bar;
const allAtMost = (ps: number[], bar: number): boolean => ps.every((p) => atMost(p, bar));
const anyAtLeast = (ps: number[], bar: number): boolean => ps.some((p) => atLeast(p, bar));

function readForGo(a: Answers, f: CodeFacts, b: Bars): Sure<boolean> {
  if (f.namesGo) return sure(true);
  const addressed = noulP(a, 'q1_addressed');
  const chatter = noulP(a, 'q1_chatter');
  // A line about money is never read as not for Go: only a turn records an expense or asks what it was for.
  if (!f.money) {
    if (atLeast(chatter, b.for_go.chatterMin) && atMost(addressed, b.for_go.addressedMaxForChatter)) return sure(false);
    // No one spoke to Go (a fact, a plan, friends talking): not for Go, though not chatter. The chatter answer must be
    // well formed too, so an odd answer still reads unsure.
    if (atMost(addressed, b.for_go.notAddressedMax) && Number.isFinite(chatter)) return sure(false);
    // No answer from Jev (a timeout or an error): small talk ("gn 😴", "haha 😂") says nothing to Go; any other line wakes.
    if (!Number.isFinite(addressed) && !Number.isFinite(chatter) && f.smallTalk) return sure(false);
  }
  if (atLeast(addressed, b.for_go.addressedMin) && atMost(chatter, b.for_go.chatterMaxForAddressed)) return sure(true);
  return unsure();
}

/**
 * Sure complete only for a line that names Go: an ask to Go Jev leans complete on is whole, while one cut short reads low
 * ("@Go can you", "@Go one thing"). A line that doesn't name Go can sit mid-burst and read as complete as the burst's end
 * ("if there's a cab from Mopa airport to Anjuna" 0.54, "for 5 people with luggage" 0.53), so it is never sure-complete.
 */
function readComplete(a: Answers, f: CodeFacts, b: Bars): Sure<boolean> {
  const p = noulP(a, 'q2_complete');
  if (f.namesGo && atLeast(p, b.complete.namedMin)) return sure(true);
  if (atMost(p, b.complete.noMax)) return sure(false);
  return unsure();
}

function readSize(a: Answers, b: Bars): Sure<'quick' | 'big'> {
  const big = [noulP(a, 'q3_big_compare'), noulP(a, 'q3_big_steps')];
  const quick = [noulP(a, 'q3_quick_answer'), noulP(a, 'q3_quick_search'), noulP(a, 'q3_quick_act')];
  if (anyAtLeast(big, b.size.kindMin) && allAtMost(quick, b.size.otherMax)) return sure('big');
  if (anyAtLeast(quick, b.size.kindMin) && allAtMost(big, b.size.otherMax)) return sure('quick');
  return unsure();
}

function readTask(a: Answers, f: CodeFacts, keys: Array<{ key: string; id: string }>, b: Bars): Sure<string | null> {
  if (!f.hasTasks || keys.length === 0) return sure(null);
  const own = keys.map((k) => ({ ...k, mass: massOf(a, 'q4_task', k.key), is: noulP(a, `q4_is_${k.key}`) }));
  const top = own.filter((k) => Number.isFinite(k.mass)).sort((x, y) => y.mass - x.mass)[0];
  if (top && atLeast(top.mass, b.task.pickMin) && atLeast(top.is, b.task.ownMin)) {
    const others = own.filter((k) => k.key !== top.key).map((k) => k.is);
    const loudest = others.length ? Math.max(...others.map((p) => (Number.isFinite(p) ? p : 1))) : 0;
    if (top.is - loudest >= b.task.gapMin) return sure(top.id);
  }
  if (atLeast(massOf(a, 'q4_task', 'none'), b.task.noneMin) && allAtMost(own.map((k) => k.is), b.task.noneOwnMax)) return sure(null);
  return unsure();
}

function readRecord(a: Answers, b: Bars): Sure<'agreed' | 'open' | 'doing' | null> {
  const kinds = [
    { kind: 'agreed' as const, p: noulP(a, 'q6_agreed') },
    { kind: 'open' as const, p: noulP(a, 'q6_open') },
    { kind: 'doing' as const, p: noulP(a, 'q6_doing') },
  ];
  const hits = kinds.filter((k) => atLeast(k.p, b.record.kindMin));
  if (hits.length === 1 && allAtMost(kinds.filter((k) => k !== hits[0]).map((k) => k.p), b.record.otherMax)) return sure(hits[0]!.kind);
  if (allAtMost(kinds.map((k) => k.p), b.record.noneMax)) return sure(null);
  return unsure();
}

function readReaction(a: Answers, b: Bars): Sure<string | null> {
  const opts = ['noted', 'thumbs', 'cheer', 'none'] as const;
  const ranked = opts
    .map((o) => ({ o, m: massOf(a, 'q7_reaction', o) }))
    .filter((x) => Number.isFinite(x.m))
    .sort((x, y) => y.m - x.m);
  const top = ranked[0];
  if (!top || top.m < b.reaction.pickMin) return unsure();
  if (top.m - (ranked[1]?.m ?? 0) < b.reaction.marginMin) return unsure();
  return top.o === 'none' ? sure(null) : sure(REACTIONS[top.o]);
}

/** One clear winner: at least the pick bar, and no other option up to the rival bar. */
function readRecipe(a: Answers, b: Bars): Sure<RecipeChoice | null> {
  const ranked = [...RECIPE_CHOICES, 'none' as const]
    .map((o) => ({ o, m: massOf(a, 'q10_recipe', o) }))
    .filter((x) => Number.isFinite(x.m))
    .sort((x, y) => y.m - x.m);
  const top = ranked[0];
  if (!top || top.m < b.recipe.pickMin) return unsure();
  if (ranked.slice(1).some((x) => x.m >= b.recipe.rivalMax)) return unsure();
  return top.o === 'none' ? sure(null) : sure(top.o);
}

function readRisky(a: Answers, f: CodeFacts, b: Bars): { risky: Sure<boolean>; why: RiskWhy[] } {
  const why = new Set<RiskWhy>();
  if (f.secretKinds.length) why.add('secret');
  if (atLeast(noulP(a, 'q8_spend'), b.risky.raiseAt)) why.add('spend');
  if (atLeast(noulP(a, 'q8_steer'), b.risky.raiseAt)) why.add('steer');
  if (atLeast(noulP(a, 'q8_secret'), b.risky.raiseAt)) why.add('secret');
  // Raise-only: there is no "sure safe" answer.
  return why.size ? { risky: sure(true), why: [...why] } : { risky: unsure(), why: [] };
}

function flatten(a: Answers): Record<string, number> {
  const p: Record<string, number> = {};
  if (!a) return p;
  for (const [key, x] of Object.entries(a)) {
    if (x?.type === 'noul' && inRange(x.noul)) p[key] = x.noul;
    else if (x && (x.type === 'choice' || x.type === 'score')) {
      for (const [opt, v] of Object.entries(x.probabilities ?? {})) if (inRange(v)) p[`${key}:${opt}`] = v;
    }
  }
  return p;
}

export function readAnswers(
  a: Answers,
  facts: CodeFacts,
  taskKeys: Array<{ key: string; id: string }>,
  bars: Bars = BARS,
): { would: ReflexRead; p: Record<string, number> } {
  const risk = readRisky(a, facts, bars);
  const fact = [noulP(a, 'q5_food'), noulP(a, 'q5_dates'), noulP(a, 'q5_travel'), noulP(a, 'q5_other')];
  const opening = [noulP(a, 'q9_group_question'), noulP(a, 'q9_circles'), noulP(a, 'q9_someone_look')];
  const would: ReflexRead = {
    forGo: readForGo(a, facts, bars),
    complete: readComplete(a, facts, bars),
    size: readSize(a, bars),
    taskId: readTask(a, facts, taskKeys, bars),
    fact: anyAtLeast(fact, bars.fact.yesMin) ? sure(true) : allAtMost(fact, bars.fact.noMax) ? sure(false) : unsure(),
    recordKind: readRecord(a, bars),
    reaction: readReaction(a, bars),
    risky: risk.risky,
    opening: anyAtLeast(opening, bars.opening.yesMin) ? sure(true) : allAtMost(opening, bars.opening.noMax) ? sure(false) : unsure(),
    recipe: readRecipe(a, bars),
    riskWhy: risk.why,
  };
  return { would, p: flatten(a) };
}

/** What code alone knows: Go named, no tasks running, a secret in the text. Everything else unsure. */
export function codeOnly(facts: CodeFacts): ReflexRead {
  return {
    forGo: facts.namesGo ? sure(true) : unsure(),
    complete: unsure(),
    size: unsure(),
    taskId: facts.hasTasks ? unsure() : sure(null),
    fact: unsure(),
    recordKind: unsure(),
    reaction: unsure(),
    risky: facts.secretKinds.length ? sure(true) : unsure(),
    opening: unsure(),
    recipe: unsure(),
    riskWhy: facts.secretKinds.length ? ['secret'] : [],
  };
}

/** Live questions act on Jev's reading; shadow questions fall back to what code alone knows. */
export function applyLive(would: ReflexRead, live: ReadonlySet<QuestionName>, facts: CodeFacts): ReflexRead {
  const base = codeOnly(facts);
  return {
    forGo: live.has('for_go') ? would.forGo : base.forGo,
    complete: live.has('complete') ? would.complete : base.complete,
    size: live.has('size') ? would.size : base.size,
    taskId: live.has('task') ? would.taskId : base.taskId,
    fact: live.has('fact') ? would.fact : base.fact,
    recordKind: live.has('record') ? would.recordKind : base.recordKind,
    reaction: live.has('reaction') ? would.reaction : base.reaction,
    risky: live.has('risky') ? would.risky : base.risky,
    opening: live.has('opening') ? would.opening : base.opening,
    recipe: (live.has('recipe') ? would.recipe : base.recipe) ?? unsure(),
    riskWhy: live.has('risky') ? (would.riskWhy ?? []) : (base.riskWhy ?? []),
  };
}
