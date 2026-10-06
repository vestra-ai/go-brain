// The live smoke: a FakeServer on a deployed Go, a fresh smoke trip (a new trip id every run, so a real trip is never
// touched), two lines from Priya, and how fast Go answered each: typing on, the reply, the cards it posted. The script
// that runs it is scripts/live-smoke.ts.
import { randomBytes } from 'node:crypto';
import type { Message, TripSnapshot } from '@go/contract';
import type { GoRequest, WriteRecord } from './fake-server.js';
import { GOA_PEOPLE, goaFreshTrip } from './goa.js';

/** Typing must show within 1 s of a line for Go, and a reply must land within 15 s. */
export const SMOKE_LIMITS = { typingMs: 1_000, replyMs: 15_000 } as const;
export interface SmokeLimits {
  typingMs: number;
  replyMs: number;
}

export const SMOKE_LINES = ['@Go hello, what can you do?', '@Go flights Delhi to Goa Friday evening'] as const;
export const SMOKE_PERSON = GOA_PEOPLE.priya;

/** The part of the FakeServer the smoke uses. */
export interface SmokeServer {
  readonly requests: readonly GoRequest[];
  readonly writes: readonly WriteRecord[];
  createTrip(snapshot: TripSnapshot): Promise<unknown>;
  say(personId: string, text: string, opts: { tripId: string }): Promise<Message>;
}

export interface SmokeStep {
  line: string;
  /** From the line to Go's first typing on; null when Go never showed typing. */
  typingMs: number | null;
  /** From the line to Go's first message; null when none came within the limit. */
  replyMs: number | null;
  reply: string | null;
  /** The kinds of the cards Go posted for this line. */
  cards: string[];
}

export interface SmokeVerdict {
  ok: boolean;
  problems: string[];
}

export interface SmokeReport {
  tripId: string;
  /** Go's hello to the new trip. */
  joined: { ms: number | null; text: string | null };
  steps: SmokeStep[];
  totalMs: number;
  verdict: SmokeVerdict;
}

/** "t_smoke_20261006T101500_a1b2c3d4": readable in Go's logs, and never the same twice. */
export function smokeTripId(at: Date): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '');
  return `t_smoke_${stamp}_${randomBytes(4).toString('hex')}`;
}

/** The Goa trip's five people at the start of a trip, under a new trip id and a title that says what it is. */
export function smokeTrip(tripId: string): TripSnapshot {
  return { ...goaFreshTrip(), trip_id: tripId, title: `Smoke test ${tripId.slice('t_smoke_'.length)}` };
}

const goPosts = (writes: readonly WriteRecord[], tripId: string, from: number, to = Number.POSITIVE_INFINITY): WriteRecord[] =>
  writes.filter((w) => {
    const at = Date.parse(w.at);
    return w.method === 'post_message' && w.applied && w.trip_id === tripId && at >= from && at <= to;
  });

const textOf = (w: WriteRecord): string | null => (typeof w.params['text'] === 'string' ? w.params['text'] : null);

const cardKind = (w: WriteRecord): string | null => {
  const card = w.params['card'] as { kind?: unknown } | undefined;
  return typeof card?.kind === 'string' ? card.kind : null;
};

/** One line's timings, read from what the FakeServer recorded between `sentAt` and `until` (ms since the epoch). */
export function measureStep(o: {
  line: string;
  tripId: string;
  sentAt: number;
  until: number;
  requests: readonly GoRequest[];
  writes: readonly WriteRecord[];
}): SmokeStep {
  const typing = o.requests.find((r) => {
    const at = Date.parse(r.at);
    return r.method === 'typing' && r.params['trip_id'] === o.tripId && r.params['on'] === true && at >= o.sentAt && at <= o.until;
  });
  const posts = goPosts(o.writes, o.tripId, o.sentAt, o.until);
  const first = posts[0];
  return {
    line: o.line,
    typingMs: typing ? Date.parse(typing.at) - o.sentAt : null,
    replyMs: first ? Date.parse(first.at) - o.sentAt : null,
    reply: first ? textOf(first) : null,
    cards: posts.map(cardKind).filter((k): k is string => k !== null),
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

export function verdictOf(steps: readonly SmokeStep[], limits: SmokeLimits = SMOKE_LIMITS): SmokeVerdict {
  const problems: string[] = [];
  steps.forEach((s, k) => {
    const step = `Step ${k + 1} ("${s.line}")`;
    if (s.typingMs === null) problems.push(`${step}: Go never showed typing`);
    else if (s.typingMs > limits.typingMs) problems.push(`${step}: typing took ${secs(s.typingMs)}, over ${secs(limits.typingMs)}`);
    if (s.replyMs === null) problems.push(`${step}: no reply within ${secs(limits.replyMs)}`);
  });
  if (steps.length < SMOKE_LINES.length) problems.push(`Not run after the first miss: ${SMOKE_LINES.slice(steps.length).map((l) => `"${l}"`).join(', ')}`);
  return { ok: problems.length === 0, problems };
}

/** Waits for `check` to give something, polling every 25 ms; null once `timeoutMs` has passed. */
async function until<T>(check: () => T | undefined, timeoutMs: number, now: () => number, pause: (ms: number) => Promise<void>): Promise<T | null> {
  const started = now();
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (now() - started >= timeoutMs) return null;
    await pause(25);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Makes the smoke trip, waits for Go's hello, then says each line and times Go's answer. After the first message of a
 * reply it waits `settleMs` more for the rest (a card can follow the words). It stops at the first line with no reply,
 * so a late answer is never taken for the next line's.
 */
export async function runSmoke(o: {
  server: SmokeServer;
  tripId?: string;
  limits?: SmokeLimits;
  settleMs?: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}): Promise<SmokeReport> {
  const now = o.now ?? Date.now;
  const pause = o.pause ?? sleep;
  const limits = o.limits ?? SMOKE_LIMITS;
  const settleMs = o.settleMs ?? 2_000;
  const tripId = o.tripId ?? smokeTripId(new Date(now()));
  const started = now();

  await o.server.createTrip(smokeTrip(tripId));
  // Go says hello to a new trip: wait for it, so it is never taken for the answer to the first line.
  const hello = await until(() => goPosts(o.server.writes, tripId, started)[0], limits.replyMs, now, pause);
  if (hello) await pause(settleMs);
  const joined = { ms: hello ? Date.parse(hello.at) - started : null, text: hello ? textOf(hello) : null };

  const steps: SmokeStep[] = [];
  for (const line of SMOKE_LINES) {
    const sentAt = now();
    await o.server.say(SMOKE_PERSON, line, { tripId });
    const first = await until(() => goPosts(o.server.writes, tripId, sentAt)[0], Math.max(0, limits.replyMs - (now() - sentAt)), now, pause);
    const end = first ? Date.parse(first.at) + settleMs : sentAt + limits.replyMs;
    if (first) await pause(Math.max(0, end - now()));
    const step = measureStep({ line, tripId, sentAt, until: end, requests: o.server.requests, writes: o.server.writes });
    steps.push(step);
    if (step.replyMs === null) break;
  }
  return { tripId, joined, steps, totalMs: now() - started, verdict: verdictOf(steps, limits) };
}

const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The report the script prints: each step's timings, the total, and PASS or FAIL with what missed. */
export function formatReport(r: SmokeReport, limits: SmokeLimits = SMOKE_LIMITS): string {
  const out = [`Smoke trip ${r.tripId}`];
  out.push(`Go joined: ${r.joined.ms === null ? `no hello within ${secs(limits.replyMs)}` : `${secs(r.joined.ms)}, "${oneLine(r.joined.text ?? '(a card)')}"`}`);
  r.steps.forEach((s, k) => {
    out.push(`${k + 1}. Priya: "${s.line}"`);
    out.push(`   typing on  ${s.typingMs === null ? 'never' : secs(s.typingMs)}`);
    out.push(`   reply      ${s.replyMs === null ? `none within ${secs(limits.replyMs)}` : `${secs(s.replyMs)}, "${oneLine(s.reply ?? '(a card)')}"`}`);
    out.push(`   cards      ${s.cards.length > 0 ? s.cards.join(', ') : 'none'}`);
  });
  out.push(`Total ${secs(r.totalMs)}`);
  out.push(r.verdict.ok ? 'PASS' : ['FAIL', ...r.verdict.problems.map((p) => `- ${p}`)].join('\n'));
  return out.join('\n');
}
