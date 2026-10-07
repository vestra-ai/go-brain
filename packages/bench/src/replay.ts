/**
 * Replays a recorded chat through the real Go: starts it in-process with P1's shared harness
 * (startRoom: its own schema, every lane that has landed, the simulator connected), plays the Server,
 * cuts idle time, and records what Go sent. Latencies are measured on the wall clock at both ends; the chat's own time is kept on
 * SimClock for the cache TTL.
 */
import { DEFAULT_TIMINGS } from '@go/brain/dist/app.js';
import { startRoom, type RoomOptions } from '@go/brain/dist/testing/start-room.js';
import { BenchReflex, countingReflex, lineKey, type CountingReflex, type ReflexRead } from './bench-reflex.js';
import type { Chat, ChatLine, SayLine } from './chat.js';
import type { RequestLog } from './requests.js';
import { assertWallClock, type Delivered, type RecallRun, type ReplayRecord } from './score.js';
import { simPort } from './sim-port.js';
import type { Timeline } from './timings.js';

/** Chat time in seconds. The model stand-in and the recorder read it for the cache TTL. */
export class SimClock {
  s = 0;
  readonly now = (): number => this.s;
}

export interface ReplaySettings {
  /** Gaps up to this many seconds are slept in real time; longer gaps wait for Go to be quiet. */
  burstWindowS: number;
  /** Quiet needs this long with no frame from Go. */
  settleMs: number;
  quietTimeoutMs: number;
  /** A line the reflex has not read after this long is counted and no longer waited for. */
  unreadAfterMs: number;
}
export const DEFAULT_SETTINGS: ReplaySettings = { burstWindowS: 3, settleMs: 150, quietTimeoutMs: 60_000, unreadAfterMs: 3_000 };

export type Wait = { kind: 'none' } | { kind: 'real'; ms: number } | { kind: 'quiet' };
export interface ReplayStep { line: ChatLine; wait: Wait; simS: number }

export function planReplay(chat: Chat, burstWindowS: number): ReplayStep[] {
  return chat.lines.map((line, n) => {
    const prev = chat.lines[n - 1];
    if (prev === undefined) return { line, wait: { kind: 'none' }, simS: line.at };
    const gap = line.at - prev.at;
    return { line, wait: gap <= burstWindowS ? { kind: 'real', ms: Math.round(gap * 1000) } : { kind: 'quiet' }, simS: line.at };
  });
}

export interface ReplayOptions {
  chat: Chat;
  mode: 'fast' | 'live';
  /** Go's environment, laid over the harness's test values; must hold DATABASE_URL and no GO_SIGNING_SECRET (the harness signs with its own). */
  rawEnv: Record<string, string>;
  /** The model client Go gets: the policy model's, or the recorder around the real one. */
  client: unknown;
  /** Where that client records requests. */
  log: RequestLog;
  clock: SimClock;
  reflex: { kind: 'bench'; recorded: Map<number, ReflexRead> | null } | { kind: 'live' };
  settings?: Partial<ReplaySettings>;
  progress?: (line: string) => void;
}
export interface ReplayOutcome {
  record: ReplayRecord;
  /** What Go's own /stats.json said at the end, or null. */
  board: unknown;
  /** What the real reflex said about each line (live only). */
  recorded: Map<string, ReflexRead> | null;
  /** Live only: why Go woke the model. */
  jev: JevTrace | null;
  /** Live only: Go's desk and turns, for where each ask's reply time goes (timings.ts). */
  timeline: Timeline | null;
}

/**
 * Live only, read from Go's own tables before the run's database is dropped: what Jev answered for each message (its
 * numbers, never people's words: reflex_reads), and how many model turns each kind of wake started (turns.woke_for).
 */
export interface JevTrace {
  reads: Array<{ line: number | null; seq: number; ok: boolean; fault: string | null; totalMs: number; p: unknown; would: unknown; acted: unknown }>;
  turns: Array<{ wokeFor: string[]; n: number }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBoard(url: string, token: string | undefined): Promise<unknown> {
  if (token === undefined || token === '') return null;
  const res = await fetch(`${url}/stats.json?hours=168`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok ? await res.json() : null;
}

export async function replayChat(o: ReplayOptions): Promise<ReplayOutcome> {
  const set: ReplaySettings = { ...DEFAULT_SETTINGS, ...o.settings };
  if (o.rawEnv['DATABASE_URL'] === undefined) throw new Error('replayChat needs DATABASE_URL');
  // startRoom signs the socket with its own SECRET; another secret here would make Go refuse the simulator.
  if (o.rawEnv['GO_SIGNING_SECRET'] !== undefined) throw new Error('replayChat takes no GO_SIGNING_SECRET: the harness signs with its own');
  // P1's shared harness, with production timings: a fresh schema, every lane in LANES, Go started, the simulator connected.
  const room = await startRoom({ anthropic: o.client as RoomOptions['anthropic'], env: o.rawEnv, timings: DEFAULT_TIMINGS, instance: 'bench' });
  try {
    const { built, db } = room;
    const realReflex = built.brain.reflex as typeof built.brain.reflex & { settled?: () => Promise<void> };
    // No trip exists yet, so swapping the reflex now is the same as before start(): the intake reads brain.reflex per message.
    const live = o.reflex.kind === 'live' ? countingReflex(built.brain.reflex) : null;
    const counter: CountingReflex = live ?? new BenchReflex(o.chat.lines, o.reflex.kind === 'bench' && o.reflex.recorded !== null ? o.reflex.recorded : undefined);
    built.brain.reflex = counter;
    const addr = built.brain.http.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('Go is not listening on a port');
    const goUrl = `http://127.0.0.1:${addr.port}`;
    const sim = simPort(room.fake);

    const trip = sim.trip();
    const tripId = trip.trip_id;
    const ids = new Map<number, string>();
    const idOf = (i: number): string => {
      const id = ids.get(i);
      if (id === undefined) throw new Error(`${o.chat.name}: line ${i} was never delivered`);
      return id;
    };
    const authorOf = (i: number): string => (o.chat.lines[i] as SayLine).person;
    const delivered: Delivered[] = [];
    const recall: RecallRun[] = [];
    const expected = new Map<string, { n: number; lastMs: number }>();
    const waived = new Map<string, number>();
    let unreadByReflex = 0;
    let lastDeliveryMs = Date.now();

    const pendingReads = (): number => {
      let pending = 0;
      for (const [key, e] of expected) {
        const done = (counter.reads.get(key) ?? 0) + (waived.get(key) ?? 0);
        if (done >= e.n) continue;
        if (Date.now() - e.lastMs > set.unreadAfterMs) {
          waived.set(key, (waived.get(key) ?? 0) + (e.n - done));
          unreadByReflex += e.n - done;
          continue;
        }
        pending++;
      }
      return pending;
    };
    const waitQuiet = async (): Promise<void> => {
      const deadline = Date.now() + set.quietTimeoutMs;
      for (;;) {
        const unread = pendingReads();
        const due = (await db.pool.query<{ n: number }>(
          'select count(*)::int as n from desk_items where trip_id = $1 and done_at is null and due_at <= $2',
          [tripId, new Date(Date.now() + 5_000)],
        )).rows[0]?.n ?? 0;
        const lastActivity = Math.max(lastDeliveryMs, sim.lastFrameAt(tripId));
        if (unread === 0 && due === 0 && Date.now() - lastActivity >= set.settleMs) return;
        if (Date.now() > deadline) throw new Error(`${o.chat.name}: Go did not go quiet within ${set.quietTimeoutMs} ms (${due} desk items due, ${unread} lines not read yet)`);
        await sleep(20);
      }
    };

    o.clock.s = o.chat.lines[0]?.at ?? 0;
    const startedMs = Date.now();
    await sim.createTrip(trip);
    await waitQuiet();

    for (const step of planReplay(o.chat, set.burstWindowS)) {
      if (step.wait.kind === 'real') await sleep(step.wait.ms);
      else if (step.wait.kind === 'quiet') await waitQuiet();
      o.clock.s = step.simS;
      const l = step.line;
      const t0 = Date.now();
      if (l.kind === 'say') {
        if (l.person === 'go') continue;
        const key = lineKey(l);
        expected.set(key, { n: (expected.get(key)?.n ?? 0) + 1, lastMs: t0 });
        const m = await sim.say(tripId, l.person, l.text, {
          ...(l.photo !== undefined ? { photoCaption: l.photo.caption } : {}),
          ...(l.reply_to !== undefined ? { replyTo: idOf(l.reply_to) } : {}),
        });
        lastDeliveryMs = t0;
        ids.set(l.i, m.messageId);
        delivered.push({ i: l.i, realMs: t0, simS: step.simS, messageId: m.messageId, seq: m.seq });
        if (l.recall !== undefined) {
          await waitQuiet();
          for (const probe of l.recall) {
            const memory = built.brain.memory;
            recall.push({ probe, afterLine: l.i, realMs: Date.now(), results: memory === undefined ? null : await memory.recall(tripId, probe.question, 'group') });
          }
        }
      } else {
        if (l.kind === 'edit') await sim.edit(authorOf(l.of), idOf(l.of), l.text);
        else if (l.kind === 'delete') await sim.remove(authorOf(l.of), idOf(l.of));
        else await sim.react(l.person, idOf(l.of), l.emoji);
        lastDeliveryMs = t0;
        delivered.push({ i: l.i, realMs: t0, simS: step.simS });
      }
      if (l.i > 0 && l.i % 250 === 0) o.progress?.(`${o.chat.name}: ${l.i} of ${o.chat.lines.length} lines`);
    }
    await waitQuiet();
    const endedMs = Date.now();
    const frames = sim.frames(tripId);
    assertWallClock(frames, startedMs, endedMs);
    const board = await fetchBoard(goUrl, o.rawEnv['ADMIN_TOKEN']);
    let jev: JevTrace | null = null;
    let timeline: Timeline | null = null;
    if (live !== null) {
      // The reflex writes its reads off the message path; wait for the last ones.
      await realReflex.settled?.();
      const lineOf = new Map(delivered.flatMap((d): Array<[number, number]> => (d.seq !== undefined ? [[d.seq, d.i]] : [])));
      const reads = await db.pool.query<{ seq: number; ok: boolean; fault: string | null; total_ms: number; p: unknown; would: unknown; acted: unknown }>(
        'SELECT seq, ok, fault, total_ms, p, would, acted FROM reflex_reads WHERE trip_id = $1 ORDER BY seq, created_at',
        [tripId],
      );
      const turns = await db.pool.query<{ woke_for: string[]; n: number }>(
        'SELECT woke_for, count(*)::int AS n FROM turns WHERE trip_id = $1 GROUP BY woke_for ORDER BY n DESC, woke_for',
        [tripId],
      );
      jev = {
        reads: reads.rows.map((x) => ({ line: lineOf.get(x.seq) ?? null, seq: x.seq, ok: x.ok, fault: x.fault, totalMs: x.total_ms, p: x.p, would: x.would, acted: x.acted })),
        turns: turns.rows.map((x) => ({ wokeFor: x.woke_for, n: x.n })),
      };
      const desk = await db.pool.query<{ ref: string; kind: string; due_at: Date; turn_id: string | null }>(
        'SELECT ref, kind, due_at, turn_id FROM desk_items WHERE trip_id = $1 ORDER BY created_at, id',
        [tripId],
      );
      const turnTimes = await db.pool.query<{ turn_id: string; started_at: Date; posted_at: Date | null; ended_at: Date | null }>(
        'SELECT turn_id, started_at, posted_at, ended_at FROM turns WHERE trip_id = $1 ORDER BY started_at',
        [tripId],
      );
      // Go's own log of its writes to the Server: a retry shows as more than one attempt, and its error stays.
      const writes = await db.pool.query<{ request_id: string; turn_id: string | null; method: string; attempts: number; sent_at: Date | null; answered_at: Date | null; error: { code?: unknown; message?: unknown } | null }>(
        'SELECT request_id, turn_id, method, attempts, sent_at, answered_at, error FROM go_requests WHERE trip_id = $1 ORDER BY created_at',
        [tripId],
      );
      timeline = {
        desk: desk.rows.map((x) => ({ ref: x.ref, kind: x.kind, dueMs: x.due_at.getTime(), turnId: x.turn_id })),
        turns: turnTimes.rows.map((x) => ({ turnId: x.turn_id, startedMs: x.started_at.getTime(), postedMs: x.posted_at?.getTime() ?? null, endedMs: x.ended_at?.getTime() ?? null })),
        writes: writes.rows.map((x) => ({
          requestId: x.request_id, turnId: x.turn_id, method: x.method, attempts: x.attempts, sentMs: x.sent_at?.getTime() ?? null, answeredMs: x.answered_at?.getTime() ?? null,
          error: x.error ? `${String(x.error.code ?? '')} ${String(x.error.message ?? '')}`.trim() : null,
        })),
      };
    }
    return {
      record: {
        chat: o.chat, mode: o.mode, composerModel: o.log.composerModel,
        reflexSource: o.reflex.kind === 'live' ? 'live' : o.reflex.recorded !== null ? 'recorded' : 'labels',
        startedMs, endedMs, delivered, frames, requests: o.log.requests, recall, unreadByReflex,
      },
      board,
      recorded: live?.recorded ?? null,
      jev,
      timeline,
    };
  } finally {
    await room.stop();
  }
}
