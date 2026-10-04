/**
 * native-iterate-phase-seams.test.ts — the phase boundaries D01 introduced.
 *
 * `iterateTurn`'s body was lifted into native-iterate-turn.ts (turn level) and
 * native-iterate-round.ts (per-round policy). A phase cannot assign the loop's
 * variables across a function boundary, so each one declares a local with the same
 * name, mutates that, and RETURNS it — and `iterateTurn` writes it back.
 *
 * That write-back is the whole seam. Drop one line and the extraction silently
 * changes behaviour, which is exactly the failure mode a refactor must not ship. A
 * mutation run over the eight write-backs found FIVE that no existing test could
 * see; this file is those five. Each test was verified to FAIL with its own
 * write-back removed and to PASS with it restored — the mutation and the failure
 * are recorded in the PR.
 *
 * Seams pinned here:
 *   1. `pausedHalt`             <- closeRoundBoundary   (run() must skip the Stop hook)
 *   2. `emptyFallbackModel`     <- settleEmptyRound     (the wedged-model escape hatch)
 *   3. `emptyRecoveryAttempts`  <- settleEmptyRound     (the ladder is BOUNDED)
 *   4. `nextRoundKind`          <- prepareRoundHead     (TTFT cause tagging)
 *   5. `history`                <- compactTurnHead      (the compacted context is USED)
 *
 * Seams already pinned elsewhere, listed so the set reads complete: `preempted`
 * (initiative-preemption.test.ts), the round-catch rethrow (severed-stream,
 * bounded-drain, reactive-compact, recall — 17 tests), and
 * `reactiveCompactionAttempted` (native-harness.reactive-compact.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { _resetFuelTanksForTest } from '../fuel-tank.js';
import { MAX_EMPTY_RECOVERY_ATTEMPTS } from '../empty-recovery.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HookDispatcher } from '../../kernel/index.js';
import type { NewEntry, JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn, ToolCall, GateResult } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ProviderHistory } from '../transport.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const MODEL = 'claude-sonnet-4-6';

const done = (stopReason: string): StreamEvent => ({
  kind: 'done',
  stopReason,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } as NormalizedUsage,
});

/** Records the model + history length of every call so a test can read the wire. */
class RecordingTransport extends FakeTransport {
  readonly models: string[] = [];
  readonly historyLengths: number[] = [];
  calls = 0;
  constructor(private readonly script: (call: number) => StreamEvent[]) {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    this.models.push(p.model);
    this.historyLengths.push((p.history as unknown[]).length);
    this.calls += 1;
    return this.script(this.calls);
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

async function drive(
  cfg: Partial<NativeConfig>,
  transport: RecordingTransport,
  model: string = MODEL,
): Promise<HarnessEvent[]> {
  _resetFuelTanksForTest();
  const full = { onAttached: () => {}, maxTurns: 12, transport, ...cfg } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'seam-t',
    sessionId: 'seam-s',
    cwd: '/tmp',
    model,
    signal: new AbortController().signal,
    config: full,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

// ─── SEAM 1: pausedHalt <- closeRoundBoundary ────────────────────────────────

describe('D01 seam — pausedHalt rides back from closeRoundBoundary', () => {
  it('a paused-halt turn never dispatches the Stop hook (run() breaks on the flag)', async () => {
    // Round 1 emits a tool_use; the policy pauses it for a human. The turn must end
    // there. run() skips the Stop dispatch ENTIRELY for a paused turn — re-feeding one
    // would put a synthetic user turn between a paused tool_use and its resolution.
    let stopDispatches = 0;
    const transport = new RecordingTransport((n) =>
      n === 1
        ? [{ kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Ask', input: {} } }, done('tool_use')]
        : [{ kind: 'text', text: 'round 2 must never run' }, done('end_turn')],
    );
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return {
          tools: [{
            name: 'Ask',
            description: 'a tool the policy pauses',
            parameters: { type: 'object', properties: {}, additionalProperties: true },
            execute: () => 'never runs — the gate pauses first',
          }],
          onAuthHalt: async () => {},
        };
      },
    };
    await drive(
      {
        toolHost,
        policy: {
          gate: async (_c: ToolCall): Promise<GateResult> =>
            ({ decision: 'needs_human', interactionKind: 'tool_permission' }) as GateResult,
          permissionMode: () => 'default',
          seedModeFromEnv: () => {},
        },
        interaction: { requestInteraction: async () => 'int-1' },
        registerHooks: (d: HookDispatcher) => {
          d.register('Stop', {}, async () => {
            stopDispatches += 1;
            return {};
          });
        },
      } as unknown as Partial<NativeConfig>,
      transport,
    );
    expect(stopDispatches).toBe(0);
    expect(transport.calls).toBe(1); // the turn ended at the pause
  });
});

// ─── SEAMS 2 + 3: the empty-completion ladder <- settleEmptyRound ────────────

describe('D01 seam — the empty ladder’s counters ride back from settleEmptyRound', () => {
  /** A model wedged returning empty rounds forever. */
  const alwaysEmpty = (): RecordingTransport => new RecordingTransport(() => [done('end_turn')]);

  it('the attempt counter advances, so the ladder is BOUNDED at MAX_EMPTY_RECOVERY_ATTEMPTS + 1 calls', async () => {
    // No fallback configured: recover x MAX, then give up and finalize. If the counter
    // never advanced, every round would decide 'recover' and the turn would burn all
    // of maxTurns (12) instead of stopping at 4.
    const transport = alwaysEmpty();
    await drive({}, transport);
    expect(transport.calls).toBe(MAX_EMPTY_RECOVERY_ATTEMPTS + 1);
  });

  it('the fallback model is actually ACTIVATED — later rounds go to the wedged model’s escape hatch', async () => {
    // Exhausting in-place recovery switches the rest of the turn to cfg.retry.fallbackModel.
    // Without the write-back the switch is computed and thrown away: no call ever
    // reaches the fallback and the turn spins to maxTurns on the primary.
    const transport = alwaysEmpty();
    await drive({ retry: { fallbackModel: 'fallback-model-x' } }, transport);
    expect(transport.models).toContain('fallback-model-x');
    // One ladder on the primary, one on the fallback, then finalize — not maxTurns.
    expect(transport.calls).toBe((MAX_EMPTY_RECOVERY_ATTEMPTS + 1) * 2);
    expect(transport.models.slice(0, MAX_EMPTY_RECOVERY_ATTEMPTS + 1)).toEqual(
      Array(MAX_EMPTY_RECOVERY_ATTEMPTS + 1).fill(MODEL),
    );
  });
});

// ─── SEAM 4: nextRoundKind <- prepareRoundHead ───────────────────────────────

describe('D01 seam — nextRoundKind rides back from prepareRoundHead', () => {
  it('a round-head steer drain tags the round it feeds as ‘steer’, not ‘fresh’', async () => {
    // The armed drain is pulled at the round HEAD (an ESC+queue with no round in
    // flight has nothing to abort). The round it feeds is caused by that steer, and
    // the per-round usage event must say so — that tag is how a [TTFT] line
    // attributes latency. Without the write-back the round reports 'fresh'.
    const transport = new RecordingTransport(() => [{ kind: 'text', text: 'ok' }, done('end_turn')]);
    let drained = false;
    const events = await drive(
      {
        drainSteerText: (): string | null => {
          if (drained) return null;
          drained = true;
          return 'do this instead';
        },
      },
      transport,
    );
    const usage = events.filter((e) => e.kind === 'usage') as Array<{ roundKind?: string }>;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0].roundKind).toBe('steer');
  });

  it('with NO steer armed the same round reports ‘fresh’ (the tag discriminates)', async () => {
    const transport = new RecordingTransport(() => [{ kind: 'text', text: 'ok' }, done('end_turn')]);
    const events = await drive({}, transport);
    const usage = events.filter((e) => e.kind === 'usage') as Array<{ roundKind?: string }>;
    expect(usage[0].roundKind).toBe('fresh');
  });
});

// ─── SEAM 5: history <- compactTurnHead ──────────────────────────────────────

/**
 * A transport whose provider history is one entry per journal message, so a test can
 * read the SIZE of the context each model call was handed. FakeTransport projects to
 * `[]`, which cannot tell a compacted history from an uncompacted one.
 */
class SizedTransport extends RecordingTransport {
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return entries.map((_e, i) => ({ role: 'msg', i })) as unknown as ProviderHistory;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `seam-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

describe('D01 seam — the compacted history rides back from compactTurnHead', () => {
  afterEach(() => {
    delete process.env.COMPACTION_V2;
  });

  it('the round AFTER a round-head compaction is sent the COMPACTED context, not the one that triggered it', async () => {
    // The whole point of compacting at the round head is that the next model call is
    // smaller. compactTurnHead re-projects and RETURNS the rebuilt history; if the
    // caller drops it, the compaction still happens, still bills, still emits its
    // event — and the next request replays the full pre-compaction context anyway.
    // Nothing else in the suite reads the request SIZE, so only this can see it.
    process.env.COMPACTION_V2 = '1'; // fires at the 200k preferred ceiling, not 800k
    const taskId = 'seam-compact';
    const journal = makeJournal(taskId);
    const chunk = 'context '.repeat(500); // ~4000 chars ~ 1000 tokens
    for (let i = 0; i < 130; i++) {
      await journal.append({
        ...base(taskId),
        principal: { kind: 'user', userId: 'u' },
        payload: { type: 'user', blocks: [{ type: 'text', text: `q${i} ${chunk}` } as ContentBlock] },
      });
      await journal.append({
        ...base(taskId),
        payload: {
          type: 'assistant',
          blocks: [{ type: 'text', text: `a${i} ${chunk}` } as ContentBlock],
          api: 'anthropic_messages',
          provider: 'anthropic',
          model: 'claude-sonnet-5',
        },
      });
    }
    const seeded = (await journal.project()).messages.length;
    const transport = new SizedTransport((n) =>
      n === 1
        ? [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, done('end_turn')]
        : [{ kind: 'text', text: 'answer' }, done('end_turn')],
    );
    const events = await drive(
      { journal, compaction: { keepWindowTokens: 2_000 } },
      transport,
      'claude-sonnet-5',
    );

    // Guard the guard: the test is only discriminating if a compaction actually fired.
    const compacted = events.filter(
      (e) => e.kind === 'raw' && (e as { event?: string }).event === 'session:compacted',
    );
    expect(compacted).toHaveLength(1);
    expect(transport.calls).toBe(2); // the summarize one-shot, then the real round

    // The real round is the LAST call, and it must be sent the compacted context.
    const mainRoundContext = transport.historyLengths[transport.historyLengths.length - 1];
    expect(seeded).toBeGreaterThan(100);
    expect(mainRoundContext).toBeLessThan(seeded);
  });
});
