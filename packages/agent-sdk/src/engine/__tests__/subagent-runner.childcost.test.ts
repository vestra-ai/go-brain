import { describe, it, expect } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

/**
 * Task 2 (Agent v2 billing-attribution) — `runSubagentLoop` returns an own-cost
 * `ChildCostRecord` carrying the summed per-round cost, the model, the childId,
 * and the aggregate usage. For a leaf subagent (no recursion yet) the record's
 * `costUsd` (own) equals the returned scalar `costUsd` (inclusive).
 */
function usage(inputTokens: number, outputTokens: number): NormalizedUsage {
  return { inputTokens, outputTokens };
}

/**
 * A scripted transport that plays one stream per round. Every round but the last
 * emits a `tool_use` so the loop keeps going (a round with no tool_use is the
 * subagent's final answer and breaks the loop). `computeCostUsd` returns the
 * pre-scripted per-round cost in call order.
 */
function fakeTransport(opts: { rounds: NormalizedUsage[]; costPerRound: number[] }): Transport {
  const { rounds, costPerRound } = opts;
  let callIdx = 0;
  let costIdx = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h, text) => {
      (h as unknown[]).push({ role: 'user', text });
    },
    pushAssistant: (h) => {
      (h as unknown[]).push({ role: 'assistant' });
    },
    pushToolResult: (h, r) => {
      (h as unknown[]).push({ role: 'tool', id: r.toolUseId });
    },
    buildTools: (raw) => raw as unknown[],
    callModel: () => {
      const i = callIdx++;
      const u = rounds[i] ?? { inputTokens: 0, outputTokens: 0 };
      const isLast = i >= rounds.length - 1;
      const evs: StreamEvent[] = [
        { kind: 'text', text: `round-${i}` },
        ...(isLast
          ? []
          : [{ kind: 'tool_use', toolUse: { id: `tu-${i}`, name: 'noop', input: {} } } as StreamEvent]),
        { kind: 'done', stopReason: isLast ? 'end_turn' : 'tool_use', usage: u },
      ];
      return evs as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: () => costPerRound[costIdx++] ?? 0,
  };
  return t as Transport;
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

describe('runSubagentLoop — Task 2: own-cost ChildCostRecord', () => {
  it('returns a childCost record whose costUsd equals the summed per-round cost and carries model+usage', async () => {
    const transport = fakeTransport({ rounds: [usage(100, 50), usage(40, 20)], costPerRound: [0.1, 0.04] });
    const res = await runSubagentLoop({
      transport,
      model: 'claude-opus-4-8',
      system: 's',
      userPrompt: 'p',
      tools: [],
      harness: passHarness,
      onPause: noPause,
      maxTurns: 5,
      onEvent: () => {},
      childId: 'child-1',
    });
    expect(res.childCost.costUsd).toBeCloseTo(0.14, 9);
    expect(res.childCost.costUsd).toBeCloseTo(res.costUsd, 9); // own-cost === the scalar today
    expect(res.childCost.childId).toBe('child-1');
    expect(res.childCost.model).toBe('claude-opus-4-8');
    expect(res.childCost.usage.inputTokens).toBe(140);
  });
});
