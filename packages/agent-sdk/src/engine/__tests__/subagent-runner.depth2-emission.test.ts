/**
 * Depth-2+ EMISSION — REAL-PATH regression (fix/subagent-block-lookup).
 *
 * The scenario: a subagent that is itself an ORCHESTRATOR dispatches a nested Agent
 * tool through runSubagentLoop's own `dispatchExecCtx`. That nested Agent tool speaks
 * by calling `ctx.pushEvent?.(...)` (apps/sandbox/src/harness/tools/agent-tool.ts's
 * `emit` helper) — exactly the shape mimicked below.
 *
 * Before the fix `dispatchExecCtx` supplied NO push channel, so `ctx.pushEvent` was
 * undefined, every `?.()` optional-chained into nothing, and a depth-2 subagent went
 * COMPLETELY silent: no start, no text, no tools, no end, for as long as the
 * grandchild ran — while it billed the whole time. The parent pane rendered an empty
 * run (prod, since at least 2026-08-24). Dropping an event was free and traceless,
 * which is why it survived: there was nothing to grep.
 *
 * This suite pins the channel's EXISTENCE and its VERBATIM relay. The identity half
 * matters as much as the delivery half: the inner event is already stamped with the
 * nested Task call's own toolUseId, and that id is exactly what the web nests the
 * lane under (tool-dispatcher.ts hands the tool `toolCallId`, and the same id is
 * reported upward as `subToolUseId`). Re-stamping it would attribute the grandchild
 * to its parent and the lane would render flat.
 *
 * Runs against BOTH loop bodies — they are alternatives on `opts.sharedLoop`, and the
 * legacy body dispatches `gateAndDispatchTool(..., dispatchExecCtx)` directly while
 * the shared body reaches the same ctx through round-tool-batch's sub branch. The
 * channel lives on the ctx they share, so one fix covers both; these cases prove it.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { HarnessEvent } from '../../contract/events.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';

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

/** Narrow a relayed HarnessEvent to the `raw` arm the Agent tool emits. */
type RawHarnessEvent = Extract<HarnessEvent, { kind: 'raw' }>;
function asRaw(e: HarnessEvent): RawHarnessEvent {
  if (e.kind !== 'raw') throw new Error(`expected a raw event, got kind=${e.kind}`);
  return e;
}

/**
 * A stand-in for the nested Agent tool. It emits the way agent-tool.ts's `emit`
 * helper does — a `raw` HarnessEvent stamped with its OWN toolCallId, which is the
 * id the web nests the depth-2 lane under. Records the runtime type of
 * `ctx.pushEvent` so the test can prove the channel was supplied at all.
 */
function makeNestedAgentTool(seen: { pushEventType?: string }): RawToolOptions {
  return {
    name: 'Agent',
    description: 'nested orchestrator that streams its own lane',
    parameters: z.object({}),
    execute: async (_input, ctx) => {
      seen.pushEventType = typeof ctx.pushEvent;
      ctx.pushEvent?.({
        kind: 'raw',
        engine: 'native',
        event: 'subagent:start',
        data: { taskId: 'task-root', toolUseId: ctx.toolCallId, agentSlug: 'fact-checker' },
      } as HarnessEvent);
      ctx.pushEvent?.({
        kind: 'raw',
        engine: 'native',
        event: 'subagent:text_delta',
        data: { taskId: 'task-root', toolUseId: ctx.toolCallId, delta: 'checking the numbers' },
      } as HarnessEvent);
      return { text: 'grandchild done', pausedHalt: false };
    },
  };
}

/** Round 1: the middle subagent's model calls the nested Agent tool. Round 2: it answers. */
const emissionScript = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'nested-task-1', name: 'Agent', input: {} } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
  ],
  [
    { kind: 'text', text: 'middle answer' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
  ],
];

/** Collect the SubagentEvents the loop hands its caller (the Agent tool). */
async function runAndCollect(sharedLoop: boolean, seen: { pushEventType?: string }): Promise<SubagentEvent[]> {
  const events: SubagentEvent[] = [];
  await runSubagentLoop({
    transport: makeScriptedTransport(emissionScript()),
    model: 'm',
    system: 'sys',
    userPrompt: 'go',
    tools: [makeNestedAgentTool(seen)],
    harness: allowHarness,
    onPause,
    maxTurns: 5,
    childId: 'c',
    onEvent: (ev) => { events.push(ev); },
    ...(sharedLoop ? { sharedLoop: true } : {}),
  });
  return events;
}

describe('runSubagentLoop — a nested Agent tool can speak through the REAL dispatchExecCtx', () => {
  for (const sharedLoop of [false, true]) {
    const label = sharedLoop ? 'shared loop' : 'legacy loop';

    it(`${label}: the nested dispatch supplies a push channel (it used to be undefined)`, async () => {
      const seen: { pushEventType?: string } = {};
      await runAndCollect(sharedLoop, seen);
      expect(seen.pushEventType).toBe('function');
    });

    it(`${label}: a depth-2 lane's events reach the caller instead of vanishing`, async () => {
      const raws = (await runAndCollect(sharedLoop, {}))
        .filter((e): e is Extract<SubagentEvent, { kind: 'raw' }> => e.kind === 'raw');

      expect(raws.map(r => asRaw(r.event).event)).toEqual(['subagent:start', 'subagent:text_delta']);
    });

    it(`${label}: the relay is VERBATIM — the grandchild keeps its own toolUseId`, async () => {
      const raws = (await runAndCollect(sharedLoop, {}))
        .filter((e): e is Extract<SubagentEvent, { kind: 'raw' }> => e.kind === 'raw');

      // Pin the COUNT first: a `for` over an empty array asserts nothing, so without
      // this line the identity check below would pass vacuously on a severed channel.
      expect(raws).toHaveLength(2);
      // 'nested-task-1' is the id the middle model gave the nested Agent call, which
      // tool-dispatcher hands the tool as `toolCallId` AND which is reported upward as
      // this lane's subToolUseId. Attributing these to the middle subagent instead
      // would render the depth-2 lane flat rather than nested.
      for (const r of raws) {
        expect((asRaw(r.event).data as { toolUseId?: string }).toolUseId).toBe('nested-task-1');
      }
    });

    it(`${label}: the lane is announced BEFORE it streams (the nested block must exist first)`, async () => {
      const events = await runAndCollect(sharedLoop, {});

      // The web creates the nested block from the parent's tool_use for the nested
      // Task, and only then can a depth-2 event be routed into it. If the grandchild
      // spoke first the events would arrive unroutable.
      const toolUseIdx = events.findIndex(e => e.kind === 'tool_use' && e.subToolUseId === 'nested-task-1');
      const firstRawIdx = events.findIndex(e => e.kind === 'raw');
      expect(toolUseIdx).toBeGreaterThanOrEqual(0);
      expect(firstRawIdx).toBeGreaterThan(toolUseIdx);
    });
  }
});

/** A plain leaf tool — no nesting. Used for the deny path, which is not Agent-specific. */
function makeLeafTool(): RawToolOptions {
  return {
    name: 'Write',
    description: 'writes a file',
    parameters: z.object({}),
    execute: async () => ({ text: 'wrote it' }),
  };
}

const denyHarness = {
  gateTool: async (_c: ToolCall): Promise<GateResult> =>
    ({ decision: 'deny' as const, message: 'Not allowed in this workspace.' }),
};

const denyScript = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'leaf-write-1', name: 'Write', input: {} } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
  ],
  [
    { kind: 'text', text: 'ok, I could not write' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } },
  ],
];

/**
 * A denied tool INSIDE a subagent now tells the user. It used to tell them nothing:
 * the deny emit rides the dispatch execCtx's push channel, the subagent dispatch had
 * none, so the refusal reached the model as an error tool_result and the human never
 * learned their agent had been blocked. That is the same disease as the nested-lane
 * blackout — silence that costs nothing to produce — so it ships as an intentional
 * behavior change, not a side effect.
 *
 * NOTE THE DEPTH: this fires for a denied tool inside ANY subagent, depth 1 included,
 * because a depth-1 subagent's own tools already dispatch through this same ctx. It is
 * not limited to the nested case that motivated the fix.
 */
describe('runSubagentLoop — a denied tool inside a subagent is no longer silent', () => {
  for (const sharedLoop of [false, true]) {
    const label = sharedLoop ? 'shared loop' : 'legacy loop';

    it(`${label}: a deny at DEPTH 1 surfaces permission:denied instead of nothing`, async () => {
      const events: SubagentEvent[] = [];
      await runSubagentLoop({
        transport: makeScriptedTransport(denyScript()),
        model: 'm', system: 'sys', userPrompt: 'go',
        tools: [makeLeafTool()],
        harness: denyHarness,
        onPause, maxTurns: 5, childId: 'c',
        onEvent: (ev) => { events.push(ev); },
        ...(sharedLoop ? { sharedLoop: true } : {}),
      });

      const denies = events
        .filter((e): e is Extract<SubagentEvent, { kind: 'raw' }> => e.kind === 'raw')
        .map((e) => asRaw(e.event))
        .filter((e) => e.event === 'permission:denied');

      expect(denies).toHaveLength(1);
      expect((denies[0].data as { toolUseId?: string; toolName?: string })).toMatchObject({
        toolUseId: 'leaf-write-1',
        toolName: 'Write',
      });
    });
  }
});
