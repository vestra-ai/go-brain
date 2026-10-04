/**
 * turn-decisions.test.ts — the four policy blocks lifted out of iterateTurn
 * (P2.7), pinned as independent decisions so the highest-churn abort/steer
 * invariants have named tests instead of 30-line inline narrations.
 *
 * Pure decisions (isRoundAbort / classifyTerminalAbort / collectRunningToolUseIds
 * / foldCompactionResult) are asserted near-zero-mock; the effectful steer/recall
 * consults run against a REAL journal + a projecting FakeTransport (the recall
 * suite's discipline) so re-projection mechanics run exactly as in production.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIUserAbortError as AnthropicAPIUserAbortError } from '@anthropic-ai/sdk';
import { APIUserAbortError as OpenAIAPIUserAbortError } from 'openai';
import {
  isRoundAbort,
  classifyTerminalAbort,
  collectRunningToolUseIds,
  foldCompactionResult,
  injectStagedSteer,
  consultRecall,
  newRecallTurnState,
} from '../turn-decisions.js';
import { FakeTransport, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig, SteerTurn } from '../native-config.js';
import type { RecallSeam, RecallConsultSample } from '../recall.js';
import { appendUserEntry } from '../native-journal.js';
import { frameQueuedAdditions } from '../../contract/injected-user-text.js';

// ── shared fakes (mirrors native-harness.recall.test.ts) ─────────────────────

type FakeMsg = { role: string; text?: string };

/** A transport whose historyFromJournal is a REAL projection over the fake shape,
 *  so the steer/recall re-projections behave as in prod. */
class ProjectingTransport extends FakeTransport {
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    const out: FakeMsg[] = [];
    for (const e of entries) {
      const p = e.payload;
      if (p.type === 'user' || p.type === 'assistant') {
        const text = p.blocks.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
        if (text) out.push({ role: p.type, text });
      }
    }
    return out;
  }
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `td-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

function buildCtx(opts: {
  taskId: string;
  journal?: Journal;
  signal?: AbortSignal;
  drainSteerText?: () => string | null;
  pollSteer?: () => SteerTurn | null;
  recall?: RecallSeam;
}): HarnessContext<NativeConfig> {
  // A fresh (never-aborted) signal stands in when a test doesn't supply one, so
  // `cfg.signal?.aborted` reads false exactly as an absent signal would.
  const signal = opts.signal ?? new AbortController().signal;
  const cfg = {
    maxTurns: 10,
    signal,
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.drainSteerText ? { drainSteerText: opts.drainSteerText } : {}),
    ...(opts.pollSteer ? { pollSteer: opts.pollSteer } : {}),
    ...(opts.recall ? { recall: opts.recall } : {}),
  } as unknown as NativeConfig;
  return { taskId: opts.taskId, sessionId: 's', cwd: '/tmp', model: 'fake-model', signal, config: cfg };
}

async function projectTexts(journal: Journal): Promise<Array<{ role: string; text: string }>> {
  const { messages } = await journal.project();
  return messages
    .filter((e) => e.payload.type === 'user' || e.payload.type === 'assistant')
    .map((e) => {
      const p = e.payload as { type: string; blocks: ContentBlock[] };
      return {
        role: p.type,
        text: p.blocks.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n'),
      };
    });
}

const abortedSignal = (): AbortSignal => {
  const c = new AbortController();
  c.abort();
  return c.signal;
};

// ── abort-sealing: isRoundAbort ──────────────────────────────────────────────

describe('isRoundAbort — "abort now, continue same stream" vs a terminal stop', () => {
  // Invariant: an abort-shaped throw whose LIVE signal is NOT aborted is a
  // round-abort (the steer-interrupt swapped the run scope before aborting).
  it('abort-shaped throw + live signal NOT aborted (false) → round-abort', () => {
    expect(isRoundAbort(new OpenAIAPIUserAbortError(), false)).toBe(true);
    expect(isRoundAbort(new AnthropicAPIUserAbortError(), false)).toBe(true);
    expect(isRoundAbort({ name: 'AbortError' }, false)).toBe(true);
  });

  it('abort-shaped throw + live signal ALREADY aborted (true) → NOT a round-abort (a real interrupt)', () => {
    expect(isRoundAbort(new OpenAIAPIUserAbortError(), true)).toBe(false);
  });

  // `signalAborted === false`, never `!signalAborted`: an ABSENT signal rethrows.
  it('ABSENT signal (undefined) → NOT a round-abort (rethrows to the terminal catch, byte-identical)', () => {
    expect(isRoundAbort(new OpenAIAPIUserAbortError(), undefined)).toBe(false);
  });

  it('a non-abort throw is never a round-abort, regardless of signal', () => {
    expect(isRoundAbort(new Error('boom'), false)).toBe(false);
    expect(isRoundAbort(new Error('Request was aborted.'), false)).toBe(false); // no message sniffing
  });
});

// ── abort-sealing: classifyTerminalAbort ─────────────────────────────────────

describe('classifyTerminalAbort — terminal outcome + the interrupted-seal flag', () => {
  const classifyError = (err: unknown): TurnOutcome => ({
    kind: 'model_error',
    message: err instanceof Error ? err.message : String(err),
    raw: { subtype: 'x', errors: [] },
  });

  it('signal aborted → user_aborted, and the phase is tools inside a batch / streaming outside', () => {
    const inTools = classifyTerminalAbort({ err: new Error('x'), signalAborted: true, inToolBatch: true, classifyError });
    expect(inTools.outcome).toMatchObject({ kind: 'user_aborted', abortPhase: 'tools' });
    expect(inTools.userAborted).toBe(true);

    const streaming = classifyTerminalAbort({ err: new Error('x'), signalAborted: true, inToolBatch: false, classifyError });
    expect(streaming.outcome).toMatchObject({ kind: 'user_aborted', abortPhase: 'streaming' });
  });

  it('abort-shaped throw with signal NOT aborted → still user_aborted (+ userAborted seals with the interrupt text)', () => {
    const r = classifyTerminalAbort({ err: new OpenAIAPIUserAbortError(), signalAborted: false, inToolBatch: false, classifyError });
    expect(r.outcome.kind).toBe('user_aborted');
    expect(r.userAborted).toBe(true);
  });

  it('a genuine crash (non-abort, signal not aborted) → classifyError, and NOT sealed as a user abort', () => {
    const r = classifyTerminalAbort({ err: new Error('provider 500'), signalAborted: false, inToolBatch: true, classifyError });
    expect(r.outcome).toMatchObject({ kind: 'model_error', message: 'provider 500' });
    expect(r.userAborted).toBe(false); // heals with NEUTRAL empty-blocks, not "Interrupted by user."
  });

  it('absent signal (undefined) + non-abort → classifyError; undefined never counts as aborted', () => {
    const r = classifyTerminalAbort({ err: new Error('x'), signalAborted: undefined, inToolBatch: false, classifyError });
    expect(r.outcome.kind).toBe('model_error');
    expect(r.userAborted).toBe(false);
  });
});

// ── abort-sealing: collectRunningToolUseIds ──────────────────────────────────

describe('collectRunningToolUseIds — the founder-visible pill-heal capture', () => {
  it('collects ONLY tool_use blocks whose status is running (settled/other blocks ignored)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hi' } as ContentBlock,
      { type: 'tool_use', toolUseId: 'a', status: 'running' } as unknown as ContentBlock,
      { type: 'tool_use', toolUseId: 'b', status: 'complete' } as unknown as ContentBlock,
      { type: 'tool_use', toolUseId: 'c', status: 'running' } as unknown as ContentBlock,
    ];
    expect(collectRunningToolUseIds(blocks)).toEqual(['a', 'c']);
  });

  it('drops a running tool_use with no toolUseId (never emits a heal for an id-less card)', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', status: 'running' } as unknown as ContentBlock];
    expect(collectRunningToolUseIds(blocks)).toEqual([]);
  });

  it('empty when nothing is running', () => {
    expect(collectRunningToolUseIds([{ type: 'text', text: 'x' } as ContentBlock])).toEqual([]);
  });
});

// ── compaction-trigger: foldCompactionResult ─────────────────────────────────

describe('foldCompactionResult — the compaction cost/usage fold (billing invariant)', () => {
  const result = {
    compactionCostUsd: 0.042,
    compactionModel: 'summarizer-1',
    compactionUsage: { inputTokens: 1200, outputTokens: 80 },
  };

  it('advances cumulative AND parentOwn by the SAME amount (Agent v2 lockstep — compaction is parent-own work)', () => {
    const fold = foldCompactionResult(result);
    expect(fold.cumulativeDeltaUsd).toBe(0.042);
    expect(fold.parentOwnDeltaUsd).toBe(0.042);
    expect(fold.parentOwnDeltaUsd).toBe(fold.cumulativeDeltaUsd);
  });

  it('the usage entry mirrors the summarize round with source:compaction', () => {
    expect(foldCompactionResult(result).usageEntry).toEqual({
      costUsd: 0.042,
      model: 'summarizer-1',
      source: 'compaction',
      inputTokens: 1200,
      outputTokens: 80,
    });
  });
});

// ── mid-turn steer: injectStagedSteer ────────────────────────────────────────

describe('injectStagedSteer — round-head drain and post-batch drain+poll (one marker discipline)', () => {
  it('journal path: a drained steer lands as the [User steered mid-task] marker entry; steered=true', async () => {
    const journal = makeJournal('steer-drain-j');
    const ctx = buildCtx({ taskId: 'steer-drain-j', journal, drainSteerText: () => 'go left' });
    await appendUserEntry(journal, ctx, 'original ask');

    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], false, null);

    expect(res.steered).toBe(true);
    expect(await projectTexts(journal)).toEqual([
      { role: 'user', text: 'original ask' },
      { role: 'user', text: '[User steered mid-task]: go left' },
    ]);
  });

  it('in-memory path (no journal): the marker is pushed onto the provider history', async () => {
    const ctx = buildCtx({ taskId: 'steer-mem', drainSteerText: () => 'wait, stop' });
    const history: ProviderHistory = [];
    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), history, false, null);
    expect(res.steered).toBe(true);
    expect(history).toEqual([{ role: 'user', text: '[User steered mid-task]: wait, stop' }]);
  });

  it('boundary (includePoll): a drained steer (marker) is appended BEFORE the polled steer (plain user entry)', async () => {
    const journal = makeJournal('steer-both');
    const ctx = buildCtx({
      taskId: 'steer-both',
      journal,
      drainSteerText: () => 'drained first',
      pollSteer: () => ({ text: 'polled second' }),
    });
    await appendUserEntry(journal, ctx, 'seed');

    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], true, null);

    expect(res.steered).toBe(true);
    expect(await projectTexts(journal)).toEqual([
      { role: 'user', text: 'seed' },
      { role: 'user', text: '[User steered mid-task]: drained first' }, // drain THEN poll
      // The polled steer is FRAMED (queued-additions): the bare form read as a
      // replacement of the earlier ask. Fixture built by calling the mint.
      { role: 'user', text: frameQueuedAdditions(['polled second']) },
    ]);
  });

  it('boundary batch: a multi-message poll lands as ONE framed entry, messages in lane order', async () => {
    const journal = makeJournal('steer-batch');
    const ctx = buildCtx({
      taskId: 'steer-batch',
      journal,
      drainSteerText: () => null,
      pollSteer: () => ({ text: 'is it visual ?\n\nis it on fireworks ?', texts: ['is it visual ?', 'is it on fireworks ?'] }),
    });
    await appendUserEntry(journal, ctx, 'seed');

    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], true, null);

    expect(res.steered).toBe(true);
    expect(await projectTexts(journal)).toEqual([
      { role: 'user', text: 'seed' },
      { role: 'user', text: frameQueuedAdditions(['is it visual ?', 'is it on fireworks ?']) },
    ]);
  });

  it('a whitespace-only poll mints nothing: no entry, steered stays false', async () => {
    const journal = makeJournal('steer-blank');
    const ctx = buildCtx({ taskId: 'steer-blank', journal, drainSteerText: () => null, pollSteer: () => ({ text: '   ' }) });
    await appendUserEntry(journal, ctx, 'seed');

    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], true, null);

    expect(res.steered).toBe(false);
    expect(await projectTexts(journal)).toEqual([{ role: 'user', text: 'seed' }]);
  });

  it('includePoll=false (round head): pollSteer is NOT consulted even when armed', async () => {
    const pollSteer = vi.fn<() => SteerTurn | null>(() => ({ text: 'should not fire' }));
    const ctx = buildCtx({ taskId: 'steer-head', drainSteerText: () => null, pollSteer });
    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], false, null);
    expect(res.steered).toBe(false);
    expect(pollSteer).not.toHaveBeenCalled();
  });

  it('abort guard: an already-aborting signal consults NEITHER seam (no journal pollution on an unwinding turn)', async () => {
    const drainSteerText = vi.fn<() => string | null>(() => 'x');
    const pollSteer = vi.fn<() => SteerTurn | null>(() => ({ text: 'y' }));
    const journal = makeJournal('steer-aborted');
    const ctx = buildCtx({ taskId: 'steer-aborted', journal, signal: abortedSignal(), drainSteerText, pollSteer });
    await appendUserEntry(journal, ctx, 'seed');

    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), [], true, null);

    expect(res.steered).toBe(false);
    expect(drainSteerText).not.toHaveBeenCalled();
    expect(pollSteer).not.toHaveBeenCalled();
    expect(await projectTexts(journal)).toEqual([{ role: 'user', text: 'seed' }]);
  });

  it('boundary in-memory (no journal): a polled steer is pushed as a plain user entry', async () => {
    const ctx = buildCtx({ taskId: 'steer-poll-mem', drainSteerText: () => null, pollSteer: () => ({ text: 'now do X' }) });
    const history: ProviderHistory = [];
    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), history, true, null);
    expect(res.steered).toBe(true);
    expect(history).toEqual([{ role: 'user', text: frameQueuedAdditions(['now do X']) }]);
  });

  it('nothing staged → { steered:false } and the history is untouched (byte-identical no-op)', async () => {
    const ctx = buildCtx({ taskId: 'steer-noop', drainSteerText: () => null, pollSteer: () => null });
    const history: ProviderHistory = [];
    const res = await injectStagedSteer(ctx.config, ctx, new ProjectingTransport([]), history, true, null);
    expect(res.steered).toBe(false);
    expect(history).toEqual([]);
  });
});

// ── per-round Nami recall: consultRecall ─────────────────────────────────────

describe('consultRecall — read-on-relevance: append / dedupe / short-circuit / cap', () => {
  const FACT = '- keshav prefers staging-only deploys';
  const FENCED = `<recalled_memory authority="curated" source="nami">\n${FACT}\n</recalled_memory>`;

  async function seededCtx(taskId: string, readRelevant: RecallSeam['readRelevant'], onConsult?: RecallSeam['onConsult']) {
    const journal = makeJournal(taskId);
    const seam: RecallSeam = { readRelevant, ...(onConsult ? { onConsult } : {}) };
    const ctx = buildCtx({ taskId, journal, recall: seam });
    await appendUserEntry(journal, ctx, 'deploy the web app');
    return { journal, seam, ctx };
  }

  it('a hit is appended as its OWN fence entry; count increments; outcome=appended', async () => {
    const samples: RecallConsultSample[] = [];
    const { journal, seam, ctx } = await seededCtx('recall-hit', async () => FACT, (s) => samples.push(s));
    const state = newRecallTurnState();

    await consultRecall(seam, ctx.config, ctx, new ProjectingTransport([]), state, [], null);

    expect(state.count).toBe(1);
    expect(samples.at(-1)?.outcome).toBe('appended');
    expect(await projectTexts(journal)).toEqual([
      { role: 'user', text: 'deploy the web app' },
      { role: 'user', text: FENCED },
    ]);
  });

  it('durable dedupe: a fence already in the projection is NOT re-appended; outcome=duplicate; lastMissed set', async () => {
    const samples: RecallConsultSample[] = [];
    const { journal, seam, ctx } = await seededCtx('recall-dup', async () => FACT, (s) => samples.push(s));
    await appendUserEntry(journal, ctx, FENCED); // the fence is already present
    const state = newRecallTurnState();

    await consultRecall(seam, ctx.config, ctx, new ProjectingTransport([]), state, [], null);

    expect(state.count).toBe(0);
    expect(state.lastMissed).toBe(true);
    expect(samples.at(-1)?.outcome).toBe('duplicate');
  });

  it('short-circuit: an unchanged query after a miss skips the RPC entirely; outcome=short-circuit', async () => {
    const readRelevant = vi.fn<(q: string) => Promise<string | null>>(async () => null);
    const samples: RecallConsultSample[] = [];
    const { seam, ctx } = await seededCtx('recall-sc', readRelevant, (s) => samples.push(s));
    const transport = new ProjectingTransport([]);
    const state = newRecallTurnState();

    // Round 1: empty hit → arms the short-circuit (lastQuery set, lastMissed true).
    await consultRecall(seam, ctx.config, ctx, transport, state, [], null);
    expect(samples.at(-1)?.outcome).toBe('empty');
    const callsAfterFirst = readRelevant.mock.calls.length;

    // Round 2: SAME query (nothing changed) → no RPC this round.
    await consultRecall(seam, ctx.config, ctx, transport, state, [], null);
    expect(readRelevant.mock.calls.length).toBe(callsAfterFirst); // no new RPC
    expect(samples.at(-1)?.outcome).toBe('short-circuit');
  });

  it('maxPerTurn cap: once count reaches the bound, the consult is skipped (no RPC)', async () => {
    const readRelevant = vi.fn<(q: string) => Promise<string | null>>(async () => FACT);
    const { seam, ctx } = await seededCtx('recall-cap', readRelevant);
    const cappedSeam: RecallSeam = { ...seam, maxPerTurn: 1 };
    const state = { ...newRecallTurnState(), count: 1 };

    await consultRecall(cappedSeam, ctx.config, ctx, new ProjectingTransport([]), state, [], null);

    expect(readRelevant).not.toHaveBeenCalled();
    expect(state.count).toBe(1);
  });

  it('never-throw: a consult failure with the signal NOT aborted is swallowed (history unchanged)', async () => {
    const { journal, seam, ctx } = await seededCtx('recall-throw', async () => FACT);
    vi.spyOn(journal, 'project').mockRejectedValueOnce(new Error('disk gone'));
    const history: ProviderHistory = [];
    const state = newRecallTurnState();

    const out = await consultRecall(seam, ctx.config, ctx, new ProjectingTransport([]), state, history, null);

    expect(out).toBe(history);
    expect(state.count).toBe(0);
  });

  it('never-throw EXCEPT on abort: a consult failure once the signal aborted rethrows (routes to user_aborted)', async () => {
    const controller = new AbortController();
    const journal = makeJournal('recall-throw-abort');
    const seam: RecallSeam = { readRelevant: async () => FACT };
    const ctx = buildCtx({ taskId: 'recall-throw-abort', journal, recall: seam, signal: controller.signal });
    await appendUserEntry(journal, ctx, 'deploy the web app');
    // The abort races in mid-consult (not aborted at entry) → the catch rethrows.
    vi.spyOn(journal, 'project').mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted mid-project');
    });
    const state = newRecallTurnState();

    await expect(
      consultRecall(seam, ctx.config, ctx, new ProjectingTransport([]), state, [], null),
    ).rejects.toThrow('aborted mid-project');
  });

  it('abort guard: an already-aborting signal returns history unchanged and never calls the port', async () => {
    const readRelevant = vi.fn<(q: string) => Promise<string | null>>(async () => FACT);
    const journal = makeJournal('recall-abort');
    const seam: RecallSeam = { readRelevant };
    const ctx = buildCtx({ taskId: 'recall-abort', journal, recall: seam, signal: abortedSignal() });
    await appendUserEntry(journal, ctx, 'deploy the web app');
    const history: ProviderHistory = [];
    const state = newRecallTurnState();

    const out = await consultRecall(seam, ctx.config, ctx, new ProjectingTransport([]), state, history, null);

    expect(out).toBe(history);
    expect(readRelevant).not.toHaveBeenCalled();
    expect(state.count).toBe(0);
  });
});
