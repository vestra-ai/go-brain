/**
 * Depth-2+ FAILURE propagation — REAL-PATH regression (prod task 381d8797).
 *
 * The sibling suite `subagent-runner.depth2-pause-bubble.test.ts` pins that a
 * grandchild PAUSE bubbles out of the middle subagent's loop. Nothing pinned the
 * same for a grandchild FAILURE: `agent-tool.terminal-sentinel.test.ts` covers the
 * Agent TOOL at a single level and contains zero depth mentions, and the gate-10
 * reviewer measured that staging has **never recorded a turn at depth >= 2**. The
 * deep mode met its first honest exercise in production, where a `researcher` at
 * depth 2 hung for 46 minutes while every layer above it waited.
 *
 * What must hold, and is asserted here on the REAL `runSubagentLoop` (only the
 * transport and the nested tool are stand-ins — the loop, the dispatcher and the
 * round core are the shipping ones):
 *
 *   1. a grandchild failure ESCAPES the middle loop rather than being swallowed
 *   2. the middle model is NOT asked to continue past it (no extra round, no
 *      "the child failed, carry on" laundered into an ordinary tool result)
 *   3. a provider that goes SILENT inside a nested loop raises, rather than
 *      blocking the loop — the 381d8797 shape itself
 *
 * Both loops are exercised: `sharedLoop: false` is the legacy path, and it is the
 * one the incident actually ran through.
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
import { withStallGuard, StreamStalledError } from '../stream-stall-guard.js';

/** Everything the loop hands back to the middle model as a tool result. */
const toolResults: unknown[] = [];

function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); toolResults.push(r); },
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

/** A nested Agent tool whose own subagent died — it throws, as agent-tool.ts does. */
function throwingNestedAgentTool(err: () => Error): RawToolOptions {
  return {
    name: 'Agent',
    description: 'nested orchestrator whose subagent failed',
    parameters: z.object({}),
    execute: async () => { throw err(); },
  };
}

/** Round 1 calls the nested Agent; round 2 is the parent reacting to the error it
 *  was handed. Round 2 IS reached, and should be — see the header. */
const failureScript = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'a1', name: 'Agent', input: {} } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
  ],
  [
    { kind: 'text', text: 'the parent routed around the failed child' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
  ],
];

describe('runSubagentLoop — a grandchild FAILURE escapes the middle loop', () => {
  for (const sharedLoop of [false, true]) {
    const label = sharedLoop ? 'shared loop' : 'legacy loop (the path 381d8797 ran)';

    it(`${label}: a nested Agent throw is DELIVERED to the middle model, never dropped`, async () => {
      // NOT asserted: that the loop stops. I first wrote it that way, copying the
      // pause suite — wrong. A pause SUSPENDS, so it must break the loop; a failure
      // is information the parent can act on, and turning a tool throw into an error
      // result so the model can route around it is the desirable behaviour. What
      // must never happen is the failure VANISHING, which is what depth-2 silence
      // actually did in prod.
      toolResults.length = 0;
      const transport = makeScriptedTransport(failureScript());
      let callModelCount = 0;
      const orig = transport.callModel.bind(transport);
      transport.callModel = (req) => { callModelCount += 1; return orig(req); };

      const result = await runSubagentLoop({
        transport,
        model: 'm',
        system: 'sys',
        userPrompt: 'go',
        tools: [throwingNestedAgentTool(() => new Error('grandchild died'))],
        harness: allowHarness,
        onPause,
        maxTurns: 5,
        childId: 'c',
        onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true } : {}),
      });

      // The middle model was TOLD, and told that it was a FAILURE. Gate 11 mutated
      // `isError` to false — laundering the failure into an ordinary result the model
      // cannot distinguish from success — and this test survived 4/4, because it only
      // checked that the message appeared somewhere. The message is not the property;
      // being MARKED an error is.
      const errored = (toolResults as Array<{ isError?: boolean; text?: string }>).filter(
        (r) => r.isError === true,
      );
      expect(errored.length).toBeGreaterThan(0);
      expect(JSON.stringify(errored)).toContain('grandchild died');

      // The loop continues, deliberately: with an error result in hand the parent can
      // route around the dead child. Pinned so the header and the behaviour agree.
      expect(callModelCount).toBe(2);
      expect(result).toBeDefined();
    });

    it(`${label}: a STALLED provider inside the nested loop raises instead of blocking`, async () => {
      // The 381d8797 shape: the deepest level's provider simply stops yielding.
      // With the guard the level raises a typed error; without it, this test hangs —
      // which is precisely what the incident did for 46 minutes.
      const stalling: Transport = makeScriptedTransport([]);
      stalling.readStream = () =>
        withStallGuard(
          (async function* () {
            yield { kind: 'text', text: 'partial' } as StreamEvent;
            await new Promise(() => {}); // never settles
          })() as AsyncIterable<never>,
          { stallMs: 50 },
        ) as AsyncIterable<StreamEvent>;

      await expect(
        runSubagentLoop({
          transport: stalling,
          model: 'm',
          system: 'sys',
          userPrompt: 'go',
          tools: [],
          harness: allowHarness,
          onPause,
          maxTurns: 5,
          childId: 'c',
          onEvent: () => {},
          ...(sharedLoop ? { sharedLoop: true } : {}),
        }),
      ).rejects.toThrow(StreamStalledError);
    });
  }
});
