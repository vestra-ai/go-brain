/**
 * Jev on every person's message: one call with every question, about 150 ms, at most the deadline.
 * Live questions act; shadow questions only log what they would have done. Any fault reads "unsure",
 * so the worst case is the composer deciding as if Jev were not there.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Message } from '../door/methods.js';
import { plainlyNamesGo } from '../trips/names-go.js';
import type { TripPack } from '../trips/pack.js';
import type { JevClient, JevResult } from './jev.js';
import { parseLive } from './live.js';
import { looksLikeMoney } from './money-line.js';
import type { Log } from '../log.js';
import { buildQuestions, buildState, messageText, QUESTION_VERSIONS } from './questions.js';
import { applyLive, codeOnly, readAnswers, type CodeFacts } from './read.js';
import type { Reflex, ReflexRead } from './reflex.js';
import { secretKinds } from './secrets.js';
import { isSmallTalk } from './small-talk.js';

export interface JevReflexDeps {
  jev: Pick<JevClient, 'ask'>;
  pool: Pool;
  /** brain.switches.get('REFLEX_LIVE'), read on every message. */
  liveValue: () => string;
  deadlineMs: number;
  /** 0 means no cap. */
  dailyCapPerTrip: number;
  now: () => Date;
  log: Log;
  passed?: readonly number[];
}
export type JevReflex = Reflex & { settled(): Promise<void> };

/**
 * What code knows without Jev: Go plainly named (P1's rule, the same one that turns typing on), a secret
 * in the text (still there, or already hidden by P1's intake: secretKinds reads the marks), tasks running, a line about
 * money, and small talk.
 */
export function codeFacts(msg: Message, pack: TripPack, runningTasks: Array<{ id: string }>): CodeFacts {
  const text = messageText(msg);
  const before = pack.messages.filter((m) => m.seq < msg.seq && !m.deleted && !m.withheld).at(-1);
  return {
    namesGo: plainlyNamesGo(msg, pack), secretKinds: secretKinds(text), hasTasks: runningTasks.length > 0, money: looksLikeMoney(text), smallTalk: isSmallTalk(text),
    answersGo: before?.author.kind === 'go',
  };
}

export function createJevReflex(d: JevReflexDeps): JevReflex {
  const pending = new Set<Promise<void>>();
  const calls = new Map<string, number>();

  function overCap(tripId: string): boolean {
    if (d.dailyCapPerTrip === 0) return false;
    const key = `${tripId}:${d.now().toISOString().slice(0, 10)}`;
    const used = calls.get(key) ?? 0;
    if (used >= d.dailyCapPerTrip) return true;
    if (calls.size > 10_000) calls.clear(); // old days only; a fresh count is harmless
    calls.set(key, used + 1);
    return false;
  }

  function logRead(values: unknown[]): void {
    const p = d.pool
      .query(
        `INSERT INTO reflex_reads (read_id, trip_id, message_id, seq, ok, fault, http_status, total_ms, server_ms, input_tokens,
           live, versions, p, would, acted, secret_kinds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        values,
      )
      .then(
        () => undefined,
        (err: unknown) => d.log.warn({ err: String(err) }, 'reflex_reads insert failed'),
      );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  return {
    async read(msg, ctx): Promise<ReflexRead> {
      if (msg.author.kind !== 'person' || msg.withheld || msg.deleted) {
        return codeOnly({ namesGo: false, secretKinds: [], hasTasks: ctx.runningTasks.length > 0, money: false });
      }
      const tripId = ctx.pack.trip.trip_id;
      const facts = codeFacts(msg, ctx.pack, ctx.runningTasks);
      const mode = parseLive(d.liveValue(), d.passed);
      const input = { message: msg, pack: ctx.pack, runningTasks: ctx.runningTasks };
      const { questions, taskKeys } = buildQuestions(input);
      let result: JevResult;
      if (!mode.call) result = { ok: false, fault: 'killed', totalMs: 0 };
      else if (overCap(tripId)) result = { ok: false, fault: 'daily_cap', totalMs: 0 };
      else result = await d.jev.ask({ state: buildState(input), questions, deadlineMs: d.deadlineMs });
      if (!result.ok && (result.fault === 'http_error' || result.fault === 'transport_error' || result.fault === 'bad_response')) {
        d.log.warn({ tripId, fault: result.fault, status: result.status ?? null, ms: result.totalMs }, 'jev fault');
      }
      const { would, p } = readAnswers(result.ok ? result.answers : null, facts, taskKeys);
      const readId = `rr_${randomUUID()}`;
      const acted: ReflexRead = { ...applyLive(would, mode.live, facts), readId };
      logRead([
        readId,
        tripId,
        msg.message_id,
        msg.seq,
        result.ok,
        result.ok ? null : result.fault,
        !result.ok && result.status !== undefined ? result.status : null,
        Math.round(result.totalMs),
        result.ok && result.serverMs !== null ? Math.round(result.serverMs) : null,
        result.ok ? result.inputTokens : 0,
        [...mode.live],
        JSON.stringify(QUESTION_VERSIONS),
        JSON.stringify(p),
        JSON.stringify(would),
        JSON.stringify(acted),
        facts.secretKinds,
      ]);
      return acted;
    },
    async settled() {
      await Promise.all([...pending]);
    },
  };
}
