/**
 * UNIT C — billing tripwire promotion (log → wire-visible).
 *
 * The per-turn billing keystone (parentOwn + Σchild vs turnDelta, plus a zero-spend
 * check) was console.error ONLY. The no-throw decision stays (a throw false-positives
 * on the resume-seed / epilogue-fold paths), but a violation now ALSO:
 *  (1) journals a CONTEXT_POLICY:false `custom` entry (never replayed into context),
 *  (2) emits a raw HarnessEvent so the server can persist an error_event,
 *  (3) keeps the console warning.
 *
 * A clean turn does none of it; a resume-seed turn (initialCostUsd + initialChildUsage)
 * does NOT false-fire (the invariant holds across the seed boundary).
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

// Inlined literal (equals the native-harness BILLING_TRIPWIRE_EVENT constant).
const BILLING_TRIPWIRE_EVENT = 'agent:billing_tripwire';

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}
function doneEvent(costUsd: number): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: usage(costUsd) };
}

class ScriptTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const r = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return r;
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

/**
 * A tool host whose child ATTRIBUTES its cost to childUsage but does NOT fold it into
 * cumulative — the exact "a child cost was lost" shape (parentOwn + Σchild > turnDelta)
 * the reconcile tripwire exists to catch.
 */
function lostChildToolHost(childUsd: number): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const tool: RawToolOptions = {
        name: 'Agent',
        description: 'child whose cost is dropped from cumulative',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: (_args, context) => {
          const rec: ChildCostRecord = {
            childId: 'lost-child',
            model: 'child-model',
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: childUsd,
          };
          // addChildCost WITHOUT addCostUsd → the reconcile identity breaks by childUsd.
          context.addChildCost?.(rec);
          return 'child done';
        },
      };
      return { tools: [tool], onAuthHalt: async () => {} };
    },
  };
}

function noopToolHost(): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [], onAuthHalt: async () => {} };
    },
  };
}

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `tripwire-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

async function tripwireEntries(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) {
    if (e.payload.type === 'custom' && e.payload.key === 'billing_tripwire') out.push(e);
  }
  return out;
}
function tripwireEvents(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === BILLING_TRIPWIRE_EVENT);
}

async function runTurn(opts: {
  taskId: string;
  journal: Journal;
  rounds: StreamEvent[][];
  toolHost: ToolHost;
  initialCostUsd?: number;
  initialChildUsage?: ChildCostRecord[];
  continueInteraction?: boolean;
}): Promise<HarnessEvent[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: new ScriptTransport(opts.rounds),
    toolHost: opts.toolHost,
    journal: opts.journal,
    ...(opts.initialCostUsd !== undefined && { initialCostUsd: opts.initialCostUsd }),
    ...(opts.initialChildUsage && { initialChildUsage: opts.initialChildUsage }),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-trip',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go', ...(opts.continueInteraction ? { continueInteraction: true } : {}) };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

describe('UNIT C — billing tripwire on the wire', () => {
  it('a seeded reconcile mismatch → journal entry + raw event + console warn, NOT replayed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const taskId = 't-trip-mismatch';
      const j = makeJournal(taskId);
      const events = await runTurn({
        taskId,
        journal: j,
        toolHost: lostChildToolHost(0.05),
        // round 1: the model calls the (cost-dropping) Agent tool; round 2 completes.
        rounds: [
          [{ kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Agent', input: {} } }, doneEvent(0.03)],
          [{ kind: 'text', text: 'done' }, doneEvent(0)],
        ],
      });

      // (1) durable custom entry with the anomaly payload.
      const entries = await tripwireEntries(j);
      expect(entries).toHaveLength(1);
      const data = (entries[0].payload as { data?: Record<string, unknown> }).data ?? {};
      expect(data.reason).toBe('reconcile_drift');
      expect(data.taskId).toBe(taskId);
      expect(data.runId).toBe('s-trip');
      expect(typeof data.round).toBe('number');
      // parentOwn(0.03) + Σchild(0.05) = 0.08 expected vs 0.03 actual → delta 0.05.
      expect(data.expected as number).toBeCloseTo(0.08, 9);
      expect(data.actual as number).toBeCloseTo(0.03, 9);
      expect(data.delta as number).toBeCloseTo(0.05, 9);

      // (2) raw event on the stream (server persists an error_event off this).
      const raws = tripwireEvents(events);
      expect(raws).toHaveLength(1);
      expect((raws[0] as { data?: { reason?: string } }).data?.reason).toBe('reconcile_drift');

      // (3) the console warning is kept.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[billing-tripwire]'))).toBe(true);

      // NOT replayed into the model context (custom = CONTEXT_POLICY:false).
      const { messages } = await j.project();
      const leaked = messages.some((m) => m.payload.type === 'custom' && (m.payload as { key?: string }).key === 'billing_tripwire');
      expect(leaked).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a clean turn writes NOTHING (no entry, no event, no warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const taskId = 't-trip-clean';
      const j = makeJournal(taskId);
      const events = await runTurn({
        taskId,
        journal: j,
        toolHost: noopToolHost(),
        rounds: [[{ kind: 'text', text: 'done' }, doneEvent(0.02)]],
      });
      expect(await tripwireEntries(j)).toHaveLength(0);
      expect(tripwireEvents(events)).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[billing-tripwire]'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a resume-seed turn (initialCostUsd + initialChildUsage) does NOT false-fire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const taskId = 't-trip-seed';
      const j = makeJournal(taskId);
      const replay: ChildCostRecord = {
        childId: 'replay',
        model: 'child-model',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0.07,
      };
      const events = await runTurn({
        taskId,
        journal: j,
        toolHost: noopToolHost(),
        // One parent's-own billed round; the replay cost was folded via the seeds.
        rounds: [[{ kind: 'text', text: 'resumed' }, doneEvent(0.02)]],
        initialCostUsd: 0.07,
        initialChildUsage: [replay],
        continueInteraction: true,
      });
      // parentOwn(0.02) + Σchild(0.07 seeded) = 0.09 === turnDelta(0.09) → no drift.
      expect(await tripwireEntries(j)).toHaveLength(0);
      expect(tripwireEvents(events)).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[billing-tripwire]'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
