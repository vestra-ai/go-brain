/**
 * A subagent's call pays its action fee on its RESULT, through the one toolBillingEvent, on both
 * loop bodies (the shared round core, which production runs, and the legacy body). Before, the
 * Agent tool billed every subagent tool_use as it was made, so a call the gate refused inside a
 * child was charged like one that ran.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { StreamEvent, Transport, NormalizedUsage, ProviderHistory, ProviderStream } from '../transport.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';

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
  };
  return t as Transport;
}

const SEND = 'mcp__composio__GMAIL_SEND_EMAIL';
const sendTool = (): RawToolOptions => ({
  name: SEND, description: 'Send an email.', parameters: z.object({ to: z.string() }), execute: async () => 'sent',
});
/** Round 1: two sends (the gate refuses the second, a duplicate); round 2: the answer. */
const script = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'send-1', name: SEND, input: { to: 'a@x.com' } } },
    { kind: 'tool_use', toolUse: { id: 'send-2', name: SEND, input: { to: 'a@x.com' } } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ],
  [
    { kind: 'text', text: 'Sent once.' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 7 } },
  ],
];
/** The deliver-guard's shape: the first send goes, the duplicate is denied. */
const dedupeGate = { gateTool: async (c: ToolCall): Promise<GateResult> =>
  (c.toolCallId === 'send-2' ? { decision: 'deny', message: 'This email already went out in this task.', reasonType: 'delivery' } : { decision: 'allow' }) };

async function run(sharedLoop: boolean): Promise<SubagentEvent[]> {
  const events: SubagentEvent[] = [];
  await runSubagentLoop({
    transport: makeScriptedTransport(script()),
    model: 'm', system: 'sys', userPrompt: 'email Ashish', tools: [sendTool()],
    harness: dedupeGate, onPause: async () => 'PAUSED', maxTurns: 5, childId: 'c1', taskId: 'task-owner',
    onEvent: (ev) => events.push(ev),
    ...(sharedLoop ? { sharedLoop: true } : {}),
  });
  return events;
}

for (const sharedLoop of [true, false]) {
  describe(`a subagent's action fee is on its result (${sharedLoop ? 'shared round core' : 'legacy body'})`, () => {
    it('the send that ran is charged once, as a subagent call of the owner task; the refused duplicate is not charged', async () => {
      const events = await run(sharedLoop);
      const billing = events.filter((e): e is Extract<SubagentEvent, { kind: 'billing' }> => e.kind === 'billing');
      expect(billing.map((b) => b.event)).toEqual([{
        kind: 'raw', engine: 'native', event: 'agent:tool_billing',
        data: { taskId: 'task-owner', toolName: SEND, toolUseId: 'send-1', isSubagent: true },
      }]);
      // Both calls still show to the person, the duplicate as an error.
      const results = events.filter((e): e is Extract<SubagentEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
      expect(results.map((r) => [r.subToolUseId, r.isError])).toEqual([['send-1', false], ['send-2', true]]);
    });

    it('the frame follows its own result, never its tool_use', async () => {
      const events = await run(sharedLoop);
      const kinds = events.filter((e) => e.kind !== 'text').map((e) => (e.kind === 'billing' ? 'billing' : `${e.kind}:${(e as { subToolUseId?: string }).subToolUseId}`));
      expect(kinds.indexOf('billing')).toBe(kinds.indexOf('tool_result:send-1') + 1);
    });
  });
}
