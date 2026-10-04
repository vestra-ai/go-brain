import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

/**
 * Weave Phase 2b — SETTLE-ON-ABORT (design §6.3 / AC-2b-3). A subagent whose model
 * call is aborted MID-STREAM (the real APIUserAbortError path: the provider stream
 * throws while it is being read) must NOT lose the cost of the rounds it already
 * COMPLETED. Before this fix `runSubagentLoop` threw out of the `for await`, so the
 * accumulated `costUsd` (and the whole run's `childCost`) vanished → a systematic
 * under-bill of every aborted subagent (Weave node or main-loop `:turnbatch` node).
 */
function usage(inputTokens: number, outputTokens: number): NormalizedUsage {
  return { inputTokens, outputTokens };
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

/**
 * A transport that plays round 0 to completion (emitting a tool_use so the loop
 * continues), then on round 1 aborts the caller's signal MID-STREAM and throws the
 * way the Anthropic stream does when its signal fires. `computeCostUsd` returns the
 * per-round cost in call order (only completed rounds reach it).
 */
function abortMidStreamTransport(controller: AbortController, costPerRound: number[]): Transport {
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
      const round = callIdx++;
      return { round } as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      const { round } = stream as unknown as { round: number };
      if (round === 0) {
        yield { kind: 'text', text: 'round-0' } as StreamEvent;
        yield { kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } } as StreamEvent;
        yield { kind: 'done', stopReason: 'tool_use', usage: usage(100, 50) } as StreamEvent;
        return;
      }
      // Round 1: the model starts streaming, THEN the user aborts mid-generation — the
      // provider stream throws before the `done` event carrying usage ever arrives.
      yield { kind: 'text', text: 'partial-' } as StreamEvent;
      controller.abort();
      throw new DOMException('The user aborted a request.', 'AbortError');
    },
    computeCostUsd: () => costPerRound[costIdx++] ?? 0,
  };
  return t as Transport;
}

describe('runSubagentLoop — settle-on-abort (AC-2b-3, no under-bill)', () => {
  it('folds the completed round-0 cost when round-1 aborts mid-stream (does not lose it to a throw)', async () => {
    const controller = new AbortController();
    const transport = abortMidStreamTransport(controller, [0.1 /* round 0 */]);

    const res = await runSubagentLoop({
      transport,
      model: 'claude-opus-4-8',
      system: 's',
      userPrompt: 'p',
      tools: [],
      harness: passHarness,
      onPause: noPause,
      signal: controller.signal,
      maxTurns: 5,
      onEvent: () => {},
      childId: 'child-abort',
    });

    // Round 0 completed and cost $0.10; round 1 aborted mid-stream with no `done` event.
    // The completed-round cost MUST survive the abort (it was really incurred).
    expect(res.costUsd).toBeCloseTo(0.1, 9);
    expect(res.childCost.costUsd).toBeCloseTo(0.1, 9);
    // Aggregate usage reflects only the completed round.
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(50);
  });

  it('does NOT abort a mid-flight TOOL: an interrupt during tool execution lets the tool finish (safe boundary, AC-2b-2)', async () => {
    // The settle-on-abort wrap covers only the MODEL stream, never the tool dispatch — so
    // a side-effecting tool (curl/write) that is mid-execution when the turn aborts runs to
    // COMPLETION (no partial side effect), and the loop only stops at the next round boundary.
    const controller = new AbortController();
    let toolFinished = false;
    let modelCalls = 0;
    const sideEffectingTool: RawToolOptions = {
      name: 'curl',
      description: 'a side-effecting tool',
      parameters: z.object({}),
      execute: async () => {
        controller.abort(); // the interrupt fires WHILE the tool is running
        await new Promise((r) => setTimeout(r, 10));
        toolFinished = true; // the tool was NOT force-killed
        return 'POSTed';
      },
    };
    const rounds: StreamEvent[][] = [
      [
        { kind: 'tool_use', toolUse: { id: 'tu1', name: 'curl', input: {} } } as StreamEvent,
        { kind: 'done', stopReason: 'tool_use', usage: usage(10, 5) } as StreamEvent,
      ],
      // A 2nd model call would only happen if the loop did NOT honor the abort at the boundary.
      [{ kind: 'text', text: 'should-not-reach' } as StreamEvent, { kind: 'done', stopReason: 'end_turn', usage: usage(1, 1) } as StreamEvent],
    ];
    let idx = 0;
    const transport: Partial<Transport> = {
      api: 'fake', provider: 'fake',
      emptyHistory: () => [] as unknown as ProviderHistory,
      pushUser: (h) => { (h as unknown[]).push({}); },
      pushAssistant: (h) => { (h as unknown[]).push({}); },
      pushToolResult: (h) => { (h as unknown[]).push({}); },
      buildTools: (raw) => raw as unknown[],
      callModel: () => { modelCalls += 1; return (rounds[idx++] ?? []) as unknown as ProviderStream; },
      readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
      computeCostUsd: () => 0.01,
    };

    await runSubagentLoop({
      transport: transport as Transport,
      model: 'claude-opus-4-8',
      system: 's',
      userPrompt: 'p',
      tools: [sideEffectingTool],
      harness: passHarness,
      onPause: noPause,
      signal: controller.signal,
      maxTurns: 5,
      onEvent: () => {},
      childId: 'child-tool-abort',
    });

    expect(toolFinished).toBe(true); // the side-effecting tool ran to completion
    expect(modelCalls).toBe(1); // the loop broke at the round boundary, no second model call
  });
});
