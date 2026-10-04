/**
 * Depth-2+ HITL pause bubble — REAL-PATH regression (fix/depth2-pause-bubble).
 *
 * The scenario: a subagent that is itself an ORCHESTRATOR dispatches a nested Agent
 * tool through runSubagentLoop's own `dispatchExecCtx`. When a tool inside THAT
 * nested Agent's subagent pauses-for-human, the nested Agent tool surfaces the pause
 * onto its dispatch result by calling `ctx.markPausedHalt?.()`
 * (apps/sandbox/src/harness/tools/agent-tool.ts) — exactly the shape mimicked below.
 *
 * The present-as-sentinel contract (packages/agent-sdk/src/engine/tool-dispatcher.ts):
 * the dispatcher installs its pausedHalt-capturing closure onto the tool's execute ctx
 * ONLY when the CALLER's execCtx carries `markPausedHalt` (any value — a no-op sentinel
 * is the opt-in). The MAIN loop opts in via its baseExecCtx (round-engine.ts). This
 * suite pins that runSubagentLoop's `dispatchExecCtx` ALSO opts in, so a grandchild
 * pause breaks the middle subagent's loop (`round.results.some(r => r.pausedHalt)`) and
 * propagates `pausedHalt` UP — instead of the pause text reaching the middle model as an
 * ordinary tool result and the loop running a SECOND round (the turn then completes
 * instead of suspending, and the interaction never survives durably).
 *
 * Before the fix, `dispatchExecCtx` omitted the sentinel: `ctx.markPausedHalt` was
 * undefined, `ctx.markPausedHalt?.()` optional-chained into nothing, the loop did not
 * break, and the model was asked to continue past the pause. This test fails on that
 * code for exactly those reasons (markPausedHalt undefined, a second model round,
 * result.pausedHalt not set), and passes once the one-key sentinel is restored.
 *
 * The companion suite apps/sandbox/src/harness/tools/__tests__/agent-tool.subagent-bubble.test.ts
 * MOCKS runSubagentLoop and hand-rolls the child ctx WITH markPausedHalt, so it exercises
 * the path-segment bubble but NOT this contract — this file is the guard for it.
 */
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

/** A scripted transport: each callModel returns the next pre-baked round of events. */
function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';

/**
 * A stand-in for the nested Agent tool: a tool inside ITS subagent (the grandchild)
 * paused-for-human, so it surfaces the pause to the parent dispatch via
 * `ctx.markPausedHalt?.()`, then returns the paused-sentinel shape agent-tool.ts returns.
 * Records the runtime type of `ctx.markPausedHalt` so the test can prove the dispatcher
 * installed the capturing closure (function) rather than leaving it undefined.
 */
function makeNestedAgentTool(seen: { markPausedHaltType?: string }): RawToolOptions {
  return {
    name: 'Agent',
    description: 'nested orchestrator whose subagent paused-for-human',
    parameters: z.object({}),
    execute: async (_input, ctx) => {
      seen.markPausedHaltType = typeof ctx.markPausedHalt;
      ctx.markPausedHalt?.();
      return { text: 'Subagent paused awaiting human approval.', pausedHalt: true };
    },
  };
}

/**
 * Round 1: the middle subagent's model calls the nested Agent tool. Round 2 is the
 * answer it would emit if the pause were swallowed — it must NEVER be reached, because
 * the grandchild pause breaks the loop after round 1.
 */
const bubbleScript = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'a1', name: 'Agent', input: {} } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
  ],
  [
    { kind: 'text', text: 'MODEL CONTINUED PAST THE PAUSE — bubble was swallowed' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
  ],
];

describe('runSubagentLoop — depth-2+ HITL pause bubbles through the REAL dispatchExecCtx', () => {
  for (const sharedLoop of [false, true]) {
    const label = sharedLoop ? 'shared loop' : 'legacy loop';
    it(`${label}: a nested Agent tool's grandchild pause breaks the loop and surfaces pausedHalt (no second model round)`, async () => {
      const seen: { markPausedHaltType?: string } = {};
      const transport = makeScriptedTransport(bubbleScript());
      let callModelCount = 0;
      const origCall = transport.callModel.bind(transport);
      transport.callModel = (req) => {
        callModelCount += 1;
        return origCall(req);
      };

      const result = await runSubagentLoop({
        transport,
        model: 'm',
        system: 'sys',
        userPrompt: 'go',
        tools: [makeNestedAgentTool(seen)],
        harness: allowHarness,
        onPause,
        maxTurns: 5,
        childId: 'c',
        onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true } : {}),
      });

      // The fix: dispatchExecCtx carries the markPausedHalt sentinel, so the dispatcher
      // substitutes its capturing closure onto the tool's ctx (a function, not undefined).
      expect(seen.markPausedHaltType).toBe('function');
      // The grandchild pause propagates UP out of the middle subagent's loop.
      expect(result.pausedHalt).toBe(true);
      // The loop BROKE at the pause — the model was never asked to continue past it.
      expect(callModelCount).toBe(1);
    });
  }
});
