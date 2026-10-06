/**
 * Scores one replay: did Go speak when it should and stay quiet when it should, how fast were the
 * first sign and the reply, how often did the model wake, how much of each prompt was cached,
 * did recall find the right message, did a deleted message come back. Latencies use the wall
 * clock at both ends; the cache uses chat time.
 */
import { computeAnthropicCostUsd } from '@vestra/agent-sdk';
import { cacheTurns, summarizeCache, type CacheSummary, type ChatEvent, type TurnCache } from './cache-estimate.js';
import { addressesGo, chatCounts, type Chat, type RecallProbe, type SayLine, type Speak } from './chat.js';
import { promptParts, type RecordedRequest } from './requests.js';
import { percentile } from './stats-math.js';

export interface Delivered {
  i: number;
  /** Wall clock just before the line was handed to the simulator. */
  realMs: number;
  simS: number;
  messageId?: string;
  seq?: number;
}
export interface GoFrame {
  method: string;
  params: Record<string, unknown>;
  /** Wall clock (Date.now()) when the simulator received it. */
  at: number;
}
export interface RecallRun {
  probe: RecallProbe;
  afterLine: number;
  realMs: number;
  /** Null when the memory lane is not registered. */
  results: Array<{ text: string; messageId: string; seq: number }> | null;
}
export interface ReplayRecord {
  chat: Chat;
  mode: 'fast' | 'live';
  composerModel: string;
  reflexSource: 'labels' | 'recorded' | 'live';
  startedMs: number;
  endedMs: number;
  delivered: Delivered[];
  frames: GoFrame[];
  requests: RecordedRequest[];
  recall: RecallRun[];
  /** People's lines the reflex never read within 3 s (the replay stopped waiting for them). */
  unreadByReflex: number;
}

export const BURST_GAP_S = 5;
export const FOLLOW_UP_MS = 8_000;
export const TYPING_WINDOW_MS = 10_000;
export const LEAK_GRACE_MS = 1_000;

export interface AskGroup { lines: number[]; person: string; expect: Speak }

/** A person's lines at most BURST_GAP_S apart are one group; Go answers the group, not each line. */
export function groupsOf(chat: Chat): AskGroup[] {
  const out: AskGroup[] = [];
  let last: SayLine | null = null;
  for (const l of chat.lines) {
    if (l.kind !== 'say' || l.person === 'go') continue;
    const g = out[out.length - 1];
    if (g !== undefined && last !== null && last.person === l.person && l.at - last.at <= BURST_GAP_S) g.lines.push(l.i);
    else out.push({ lines: [l.i], person: l.person, expect: false });
    last = l;
  }
  for (const g of out) {
    const speaks = g.lines.map((i) => (chat.lines[i] as SayLine).go_should_speak);
    g.expect = speaks.includes(true) ? true : speaks.includes('either') ? 'either' : false;
  }
  return out;
}

export type PostKind = 'prompted' | 'follow_up' | 'greeting' | 'duplicate' | 'unprompted';

export interface ChatScore {
  chat: string;
  mode: 'fast' | 'live';
  composerModel: string;
  reflexSource: ReplayRecord['reflexSource'];
  messages: { people: number; goLinesSkipped: number; edits: number; deletes: number; reactions: number; photos: number };
  wake: { turns: number; messages: number; rate: number | null };
  typing: { n: number; p50Ms: number | null; p90Ms: number | null; missing: number; withoutPost: number };
  reply: { n: number; p50Ms: number | null; p90Ms: number | null };
  speak: {
    asks: number;
    answered: number;
    missed: Array<{ line: number; text: string }>;
    posts: number;
    byKind: Record<PostKind, number>;
    unprompted: Array<{ at: number; afterLine: number | null; text: string }>;
    duplicates: Array<{ at: number; text: string }>;
  };
  quiet: { reactions: number; wrongReactions: Array<{ line: number; emoji: string }>; recordLines: number };
  cache: CacheSummary;
  turns: TurnCache[];
  prompt: { maxTokens: number | null; lastTokens: number | null; average: { tools: number; system: number; chat: number; now: number } | null };
  recall: { probes: number; ran: boolean; passed: number; afterFold: number; failed: Array<{ question: string; line: number; seq: number | null; got: string[] }> };
  leaks: Array<{ line: number; requestN: number }>;
  firstToken: { p50Ms: number | null; p90Ms: number | null };
  side: { requests: number; tokens: number };
  costUsd: number | null;
  unreadByReflex: number;
  durationMs: number;
}

export function wrongSpeak(s: ChatScore): number {
  return s.speak.missed.length + s.speak.unprompted.length + s.speak.duplicates.length;
}

/** One frame per request_id: a resend of the same write is the same write. */
function uniqueWrites(frames: readonly GoFrame[], method: string): GoFrame[] {
  const seen = new Set<string>();
  return frames
    .filter((f) => f.method === method)
    .filter((f) => {
      const id = f.params['request_id'];
      if (typeof id !== 'string') return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.at - b.at);
}

function postText(f: GoFrame): string {
  if (typeof f.params['text'] === 'string') return f.params['text'];
  const card = f.params['card'] as { fallback_text?: unknown } | undefined;
  return typeof card?.fallback_text === 'string' ? card.fallback_text : '';
}

/** Throws when the simulator stamped a frame with a clock other than the wall clock. */
export function assertWallClock(frames: readonly GoFrame[], startedMs: number, endedMs: number): void {
  for (const f of frames) {
    if (f.at < startedMs - 1000 || f.at > endedMs + 1000)
      throw new Error(`a ${f.method} frame at ${f.at} is outside the run (${startedMs} to ${endedMs}): the simulator is not stamping frames with the wall clock`);
  }
}

export interface ProviderNumbers {
  requests: number;
  cacheHit: number | null;
  firstTokenP50Ms: number | null;
  firstTokenP90Ms: number | null;
  costUsd: number | null;
}

/** The provider's own numbers from recorded usage: cache read over all input, every composer request but the first. */
export function providerNumbers(requests: readonly RecordedRequest[]): ProviderNumbers {
  const composer = requests.filter((r) => r.role === 'composer');
  const counted = composer.filter((r) => r.usage !== undefined).slice(1);
  let read = 0;
  let total = 0;
  for (const r of counted) {
    const u = r.usage;
    if (u === undefined) continue;
    const cr = u.cache_read_input_tokens ?? 0;
    read += cr;
    total += u.input_tokens + cr + (u.cache_creation_input_tokens ?? 0);
  }
  const firsts = composer.flatMap((r) => (r.firstTokenMs !== undefined ? [r.firstTokenMs - r.realMs] : []));
  return {
    requests: composer.length,
    cacheHit: total > 0 ? read / total : null,
    firstTokenP50Ms: percentile(firsts, 50),
    firstTokenP90Ms: percentile(firsts, 90),
    costUsd: costOf(requests),
  };
}

function costOf(requests: readonly RecordedRequest[]): number | null {
  let cost = 0;
  let priced = 0;
  for (const r of requests) {
    if (r.usage === undefined) continue;
    cost += computeAnthropicCostUsd({
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
    }, r.body.model);
    priced++;
  }
  return priced > 0 ? cost : null;
}

export function scoreReplay(rec: ReplayRecord): ChatScore {
  const { chat, frames, requests } = rec;
  const counts = chatCounts(chat);
  const deliveredByLine = new Map(rec.delivered.map((d) => [d.i, d]));
  const people = rec.delivered
    .flatMap((d) => {
      const line = chat.lines[d.i];
      return line !== undefined && line.kind === 'say' && line.person !== 'go' ? [{ line, d }] : [];
    })
    .sort((a, b) => a.d.realMs - b.d.realMs);

  // Posts, each classified.
  const posts = uniqueWrites(frames, 'post_message').map((f) => ({ at: f.at, text: postText(f) }));
  const byKind: Record<PostKind, number> = { prompted: 0, follow_up: 0, greeting: 0, duplicate: 0, unprompted: 0 };
  const unprompted: ChatScore['speak']['unprompted'] = [];
  const duplicates: ChatScore['speak']['duplicates'] = [];
  let prevAt = Number.NEGATIVE_INFINITY;
  let prevKind: PostKind | null = null;
  let prevText: string | null = null;
  const firstPersonMs = people[0]?.d.realMs;
  for (const p of posts) {
    const window = people.filter((x) => x.d.realMs > prevAt && x.d.realMs <= p.at);
    let kind: PostKind;
    if (firstPersonMs === undefined || p.at < firstPersonMs) kind = 'greeting';
    else if (window.length === 0 && prevText !== null && p.text === prevText) kind = 'duplicate';
    else if (window.some((x) => x.line.go_should_speak !== false)) kind = 'prompted';
    else if (prevKind !== null && prevKind !== 'unprompted' && prevKind !== 'duplicate' && p.at - prevAt <= FOLLOW_UP_MS && p.text !== prevText) kind = 'follow_up';
    else kind = 'unprompted';
    byKind[kind]++;
    if (kind === 'duplicate') duplicates.push({ at: p.at, text: p.text });
    if (kind === 'unprompted') {
      const before = people.filter((x) => x.d.realMs <= p.at);
      unprompted.push({ at: p.at, afterLine: before[before.length - 1]?.line.i ?? null, text: p.text });
    }
    prevAt = p.at;
    prevKind = kind;
    prevText = p.text;
  }

  // Asks: answered or missed, and how long the answer took.
  const asks = groupsOf(chat).filter((g) => g.expect === true);
  const missed: ChatScore['speak']['missed'] = [];
  const replyMs: number[] = [];
  asks.forEach((g, k) => {
    const start = deliveredByLine.get(g.lines[0] ?? -1)?.realMs;
    if (start === undefined) return;
    const next = asks[k + 1];
    const end = next === undefined ? Number.POSITIVE_INFINITY : deliveredByLine.get(next.lines[0] ?? -1)?.realMs ?? Number.POSITIVE_INFINITY;
    const answer = posts.find((p) => p.at >= start && p.at < end);
    const lastLine = g.lines[g.lines.length - 1] ?? -1;
    if (answer === undefined) {
      const l = chat.lines[lastLine];
      missed.push({ line: lastLine, text: l !== undefined && l.kind === 'say' ? l.text : '' });
      return;
    }
    const before = g.lines.map((i) => deliveredByLine.get(i)?.realMs).filter((t): t is number => t !== undefined && t <= answer.at);
    replyMs.push(answer.at - Math.max(...before));
  });

  // Typing: the first sign for each line that calls Go, and typing that led to nothing.
  const typingOn = frames.filter((f) => f.method === 'typing' && f.params['on'] === true).sort((a, b) => a.at - b.at);
  const typingMs: number[] = [];
  let typingMissing = 0;
  for (const x of people) {
    if (!addressesGo(x.line.text)) continue;
    const t = typingOn.find((f) => f.at >= x.d.realMs && f.at <= x.d.realMs + TYPING_WINDOW_MS);
    if (t === undefined) typingMissing++;
    else typingMs.push(t.at - x.d.realMs);
  }
  let withoutPost = 0;
  let lastOn = Number.NEGATIVE_INFINITY;
  for (const f of typingOn) {
    if (f.at - lastOn > FOLLOW_UP_MS && !posts.some((p) => p.at >= f.at && p.at <= f.at + 25_000)) withoutPost++;
    lastOn = f.at;
  }

  // Quiet actions.
  const lineByMessage = new Map(rec.delivered.flatMap((d) => (d.messageId !== undefined ? [[d.messageId, d.i] as const] : [])));
  const reactions = uniqueWrites(frames, 'add_reaction');
  const wrongReactions: ChatScore['quiet']['wrongReactions'] = [];
  for (const r of reactions) {
    const i = lineByMessage.get(String(r.params['message_id']));
    const l = i === undefined ? undefined : chat.lines[i];
    if (i !== undefined && l !== undefined && l.kind === 'say' && l.quiet_ok !== true) wrongReactions.push({ line: i, emoji: String(r.params['emoji'] ?? '') });
  }

  // Cache, prompt size and folds.
  const events: ChatEvent[] = rec.delivered.flatMap((d) => {
    const l = chat.lines[d.i];
    return l !== undefined && (l.kind === 'edit' || l.kind === 'delete') ? [{ kind: l.kind, realMs: d.realMs }] : [];
  });
  const turns = cacheTurns(requests, events);
  const cache = summarizeCache(turns);
  const firsts = turns.filter((t) => t.firstRound);
  const avg = (pick: (t: TurnCache) => number): number => Math.round(firsts.reduce((s, t) => s + pick(t), 0) / firsts.length);
  const firstRounds = requests.filter((r) => r.role === 'composer' && r.body.messages.length === 1).length;

  // Recall.
  const foldAt = turns.find((t) => t.result === 'fold')?.realMs ?? null;
  const failed: ChatScore['recall']['failed'] = [];
  let passed = 0;
  for (const run of rec.recall) {
    if (run.results === null) continue;
    const seq = deliveredByLine.get(run.probe.line)?.seq ?? null;
    const want = run.probe.answer.toLowerCase();
    if (seq !== null && run.results.some((x) => x.seq === seq && x.text.toLowerCase().includes(want))) passed++;
    else failed.push({ question: run.probe.question, line: run.probe.line, seq, got: run.results.slice(0, 3).map((x) => `#${x.seq} ${x.text}`.slice(0, 120)) });
  }

  // Leaks of deleted text into later prompts.
  const leaks: ChatScore['leaks'] = [];
  for (const l of chat.lines) {
    if (l.kind !== 'delete') continue;
    const d = deliveredByLine.get(l.i);
    const orig = chat.lines[l.of];
    if (d === undefined || orig === undefined || orig.kind !== 'say' || orig.text.length < 12) continue;
    const needle = JSON.stringify(Array.from(orig.text).slice(0, 30).join('')).slice(1, -1);
    const hit = requests.find((r) => r.role === 'composer' && r.realMs > d.realMs + LEAK_GRACE_MS && JSON.stringify(r.body).includes(needle));
    if (hit !== undefined) leaks.push({ line: l.of, requestN: hit.n });
  }

  const firstTokens = requests.flatMap((r) => (r.role === 'composer' && r.firstTokenMs !== undefined ? [r.firstTokenMs - r.realMs] : []));
  const side = requests.filter((r) => r.role === 'side');

  return {
    chat: chat.name,
    mode: rec.mode,
    composerModel: rec.composerModel,
    reflexSource: rec.reflexSource,
    messages: { people: counts.peopleMessages, goLinesSkipped: counts.goLines, edits: counts.edits, deletes: counts.deletes, reactions: counts.reactions, photos: counts.photos },
    wake: { turns: firstRounds, messages: people.length, rate: people.length > 0 ? firstRounds / people.length : null },
    typing: { n: typingMs.length, p50Ms: percentile(typingMs, 50), p90Ms: percentile(typingMs, 90), missing: typingMissing, withoutPost },
    reply: { n: replyMs.length, p50Ms: percentile(replyMs, 50), p90Ms: percentile(replyMs, 90) },
    speak: { asks: asks.length, answered: asks.length - missed.length, missed, posts: posts.length, byKind, unprompted, duplicates },
    quiet: { reactions: reactions.length, wrongReactions, recordLines: uniqueWrites(frames, 'add_record_line').length },
    cache,
    turns,
    prompt: {
      maxTokens: firsts.length > 0 ? Math.max(...firsts.map((t) => t.parts.total)) : null,
      lastTokens: firsts[firsts.length - 1]?.parts.total ?? null,
      average: firsts.length > 0 ? { tools: avg((t) => t.parts.tools), system: avg((t) => t.parts.system), chat: avg((t) => t.parts.chat), now: avg((t) => t.parts.now) } : null,
    },
    recall: {
      probes: rec.recall.length,
      ran: rec.recall.every((r) => r.results !== null),
      passed,
      afterFold: foldAt === null ? 0 : rec.recall.filter((r) => r.realMs > foldAt).length,
      failed,
    },
    leaks,
    firstToken: { p50Ms: percentile(firstTokens, 50), p90Ms: percentile(firstTokens, 90) },
    side: { requests: side.length, tokens: side.reduce((s, r) => s + promptParts(r.body).total, 0) },
    costUsd: costOf(requests),
    unreadByReflex: rec.unreadByReflex,
    durationMs: rec.endedMs - rec.startedMs,
  };
}
