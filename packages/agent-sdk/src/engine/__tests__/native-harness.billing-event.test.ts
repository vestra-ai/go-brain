/**
 * Agent v2 — Task 5: `turn_end.billing.childUsage` carries attribution off the harness
 * on the NORMAL terminal turn_end (non-budget, non-refused, non-paused).
 *
 * The brief required a focused test to lock in this surface independently of the
 * broader reconciliation assertions in native-harness.reconcile.test.ts. Task 4
 * (commit 8f4bdee05) already wired `perTurnBilling()` into the normal `terminalTurnEnd`
 * call at run():932 — this suite arrived GREEN on first run, confirming the gap was
 * already closed. Kept as a regression guard scoped to exactly the property name and
 * value shape the brief calls for.
 */
import { it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ChildCostRecord } from '../../contract/child-cost.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

// ── scripted transport ────────────────────────────────────────────────────────

function doneEvent(costUsd: number): StreamEvent {
  return {
    kind: 'done',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd } as NormalizedUsage,
  };
}

/** A transport that serves scripted rounds in order; prices off `usage.costUsd`. */
class ScriptTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

/**
 * Build one-turn round scripts: a billed parent round that emits child tool_use
 * calls, followed by a zero-cost terminator round that ends the turn cleanly.
 */
function buildRounds(parentCostUsd: number, childIds: string[]): StreamEvent[][] {
  const childCalls: StreamEvent[] = childIds.map((id, i) => ({
    kind: 'tool_use',
    toolUse: { id: `tu-${i}`, name: 'spawn_child', input: { costUsd: 0.1, childId: id } },
  }));
  return [
    [...childCalls, doneEvent(parentCostUsd)], // parent billed round
    [{ kind: 'text', text: 'done' }, doneEvent(0)], // terminator
  ];
}

// ── child tool host ───────────────────────────────────────────────────────────

/** A ToolHost with a single `spawn_child` tool that folds a fixed $0.10 child cost. */
class ChildToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'spawn_child',
      description: 'simulated leaf subagent',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: (args, context) => {
        const { costUsd, childId } = args as { costUsd: number; childId: string };
        context.addCostUsd?.(costUsd);
        const rec: ChildCostRecord = {
          childId,
          model: 'child-model',
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd,
        };
        context.addChildCost?.(rec);
        return `child ${childId} done`;
      },
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

function buildCtx(transport: FakeTransport, toolHost: ToolHost): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost,
  } as unknown as NativeConfig;
  return { taskId: 't5', sessionId: 's5', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg };
}

/**
 * Run a single turn and return the terminal turn_end event (the NORMAL completion
 * path, not max_budget or refused). Drives the real `run()` async generator.
 */
async function runTurnWith(opts: {
  parentRoundsUsd: number[];
  children: number[];
}): Promise<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  const parentCost = opts.parentRoundsUsd.reduce((a, b) => a + b, 0);
  const childIds = opts.children.map((_, i) => `child-${i}`);
  const transport = new ScriptTransport(buildRounds(parentCost, childIds));
  const toolHost = new ChildToolHost();
  const ctx = buildCtx(transport, toolHost);
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go' };
  })();

  let last: Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'turn_end') {
      last = ev as Extract<HarnessEvent, { kind: 'turn_end' }>;
    }
  }
  if (!last) throw new Error('no turn_end emitted');
  return last;
}

// ── test ─────────────────────────────────────────────────────────────────────

it('emits childUsage on the terminal turn_end billing block (normal completion, non-budget)', async () => {
  // 1 parent round ($0.03) + 1 child ($0.10) → cumulative = $0.13.
  const ev = await runTurnWith({ parentRoundsUsd: [0.03], children: [0.10] });
  expect(ev.billing).toBeDefined();
  expect(ev.billing!.cumulativeCostUsd).toBeCloseTo(0.13, 9);
  expect(ev.billing!.childUsage).toHaveLength(1);
  expect(ev.billing!.childUsage![0].costUsd).toBeCloseTo(0.10, 9);
  expect(ev.billing!.childUsage![0].childId).toBe('child-0');
});
