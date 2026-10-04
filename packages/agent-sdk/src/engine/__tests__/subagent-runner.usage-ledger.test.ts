/**
 * C5 (SUBAGENT_USAGE_LEDGER_V1) — an in-process subagent's rounds reach the token ledger.
 *
 * Measured on prod (7 days to 2026-10-02, BILLING_SERVER_REPRICE_V1 on): every subagent
 * turn billed server = claimed - child cost, to the micro-dollar. The claimed total always
 * carried the children (the Agent tool folds their cost), but no subagent round ever emitted
 * a usage event, so the server's re-priced total and the ledger had nothing for them. Driven
 * through the REAL runSubagentLoop on the live shared round core (the factory sets
 * sharedLoop on every native run) with the REAL GeminiTransport.
 *
 * Revert-proof: remove the 'subagent' branch in emitRoundUsage, or the forward in the
 * subagent-runner's round adapter, and the ON case finds no usage event.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import type { GeminiStreamChunk } from '../../transports/gemini-messages.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';
import { toAgentUsageWire } from '../../contract/usage-wire.js';

const FLAG = 'SUBAGENT_USAGE_LEDGER_V1';
afterEach(() => {
  delete process.env[FLAG];
});

const FINAL: GeminiStreamChunk[] = [
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 9_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 40, thoughtsTokenCount: 60 },
  },
];

async function* scripted(chunks: GeminiStreamChunk[]): AsyncIterable<GeminiStreamChunk> {
  for (const c of chunks) yield c;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };

async function runChild(): Promise<{ usage: Extract<HarnessEvent, { kind: 'usage' }>[]; costUsd: number }> {
  const events: SubagentEvent[] = [];
  const transport = new GeminiTransport({ streamFactory: () => scripted(FINAL) });
  const result = await runSubagentLoop({
    transport, model: 'gemini-3.8-flash', system: 'sys', userPrompt: 'go', tools: [],
    harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 3, childId: 'c',
    onEvent: (ev) => events.push(ev), sharedLoop: true,
  });
  const usage = events
    .filter((e): e is Extract<SubagentEvent, { kind: 'raw' }> => e.kind === 'raw')
    .map((e) => e.event)
    .filter((e): e is Extract<HarnessEvent, { kind: 'usage' }> => e.kind === 'usage');
  return { usage, costUsd: result.costUsd };
}

describe('SUBAGENT_USAGE_LEDGER_V1: a subagent round reaches the ledger', () => {
  it('on: the round leaves the nested loop as ONE usage event on the subagent lane, carrying the provider\'s numbers', async () => {
    process.env[FLAG] = 'true';
    const { usage, costUsd } = await runChild();
    expect(usage).toHaveLength(1);
    const ev = usage[0];
    expect(ev.lane).toBe('subagent');
    expect(ev.laneStatus).toBe('ok');
    expect(ev.model).toBe('gemini-3.8-flash');
    expect(ev.turnNumber).toBeUndefined();
    expect(typeof ev.messageId).toBe('string');
    expect(toAgentUsageWire(ev.usage)).toMatchObject({
      input_tokens: 1_000,
      cache_read_input_tokens: 8_000,
      cache_creation_input_tokens: 0,
      output_tokens: 100,
      reasoning_tokens: 60,
    });
    // The child's claimed cost (what the Agent tool folds into the parent turn) is the cost of
    // exactly this usage, so the server's re-price of the row and the claim agree.
    expect(costUsd).toBeCloseTo(new GeminiTransport().computeCostUsd(ev.usage, 'gemini-3.8-flash'), 12);
  });

  it('off: no usage event leaves the nested loop (byte-identical)', async () => {
    const { usage } = await runChild();
    expect(usage).toHaveLength(0);
  });
});
