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
 * PR5 item 2 — the nested subagent loop threads an OPTIONAL `cacheKey` onto every
 * callModel so a subagent's distinct prefix routes to its OWN OpenAI cache shard
 * (never the parent task's). Absent ⇒ every callModel sees `undefined` ⇒ Anthropic
 * byte-identical (no prompt_cache_key sent).
 */
function makeScriptedTransport(
  rounds: StreamEvent[][],
): Transport & { cacheKeysSeen: Array<string | undefined> } {
  let i = 0;
  const t: Partial<Transport> & { cacheKeysSeen: Array<string | undefined> } = {
    api: 'fake',
    provider: 'fake',
    cacheKeysSeen: [],
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
    callModel: (p) => {
      t.cacheKeysSeen.push(p.cacheKey);
      return (rounds[i++] ?? [
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]) as unknown as ProviderStream;
    },
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.000001,
  };
  return t as Transport & { cacheKeysSeen: Array<string | undefined> };
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';
const doneEv = (input = 1, output = 1): StreamEvent => ({
  kind: 'done',
  stopReason: 'end_turn',
  usage: { inputTokens: input, outputTokens: output },
});

describe('runSubagentLoop — PR5 item 2: optional cacheKey threading', () => {
  it('forwards the cacheKey onto every callModel when present', async () => {
    const transport = makeScriptedTransport([
      [{ kind: 'text', text: 'done' }, doneEv()],
    ]);
    await runSubagentLoop({
      transport,
      model: 'm',
      system: 'sys',
      userPrompt: 'go',
      tools: [],
      harness: allowHarness,
      onPause,
      maxTurns: 10,
      childId: 'child-cache-test',
      onEvent: () => {},
      cacheKey: 'task-abc:sub:researcher',
    });
    expect(transport.cacheKeysSeen.length).toBeGreaterThan(0);
    expect(transport.cacheKeysSeen.every((k) => k === 'task-abc:sub:researcher')).toBe(true);
  });

  it('passes undefined to callModel when no cacheKey is given (byte-identical)', async () => {
    const transport = makeScriptedTransport([
      [{ kind: 'text', text: 'done' }, doneEv()],
    ]);
    await runSubagentLoop({
      transport,
      model: 'm',
      system: 'sys',
      userPrompt: 'go',
      tools: [],
      harness: allowHarness,
      onPause,
      maxTurns: 10,
      childId: 'child-cache-test',
      onEvent: () => {},
    });
    expect(transport.cacheKeysSeen.length).toBeGreaterThan(0);
    expect(transport.cacheKeysSeen.every((k) => k === undefined)).toBe(true);
  });
});
