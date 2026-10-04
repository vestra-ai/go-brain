import { describe, it, expect } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

/**
 * X1 (HOOK_PARITY_V1), review of #4284 MED-3 (CR5): a helper's SubagentStop hook is asked only
 * where the helper could take another turn. The rail is unit-tested with a stub predicate; this
 * drives the real loop to its last turn with a hook that always says go on.
 *
 * Revert proof: replace the loop's predicate with `() => true` and the hook is asked on the last
 * turn too (asked 2), its words go nowhere, and the helper ends on `turn_cap` instead of its answer.
 */
function answeringTransport(): Transport & { calls: number } {
  let calls = 0;
  const t: Partial<Transport> & { calls: number } = {
    api: 'fake',
    provider: 'fake',
    get calls() { return calls; },
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h, text) => { (h as unknown[]).push({ role: 'user', text }); },
    pushAssistant: (h) => { (h as unknown[]).push({ role: 'assistant' }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool', id: r.toolUseId }); },
    buildTools: (raw) => raw as unknown[],
    // Every round answers with text and no tool call: the helper has finished, each time.
    callModel: () => {
      const i = calls++;
      return [
        { kind: 'text', text: `answer-${i}` },
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ] as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: () => 0,
  };
  return t as Transport & { calls: number };
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

describe('runSubagentLoop: the SubagentStop rail on the helper\'s last turn', () => {
  it('a hook that always says go on is asked only while a turn is left; the helper ends on its answer, not the cap', async () => {
    const transport = answeringTransport();
    const asked: string[] = [];
    const res = await runSubagentLoop({
      transport,
      model: 'm',
      system: 's',
      userPrompt: 'p',
      tools: [],
      harness: passHarness,
      onPause: noPause,
      maxTurns: 2,
      onEvent: () => {},
      childId: 'helper-1',
      onStop: async (last) => { asked.push(last); return 'Keep going: check once more.'; },
    });
    expect(asked).toEqual(['answer-0']); // turn 1 of 2: asked, and the helper goes on
    expect(transport.calls).toBe(2); // turn 2 of 2 answered; no turn left, so the hook is not asked
    expect(res.stopReason).toBe('completed');
    expect(res.text).toBe('answer-1');
  });
});
