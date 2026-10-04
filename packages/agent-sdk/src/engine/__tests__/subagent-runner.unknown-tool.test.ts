/**
 * T5 — a subagent's call to a tool it does not have answers in the one error shape, on both
 * of the nested loop's own dispatch paths (the round core's are covered in
 * tool-result-shape.errors.test.ts): the legacy round body, and the continue-at-dispatch
 * re-entry of a paused round. With the taxonomy on (every production run) the answer is
 * `Unknown tool: <name> [error:not_found]`; off, today's bare words.
 *
 * Revert proof: drop either site's `unknownToolText` and its case fails on the stamp.
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type { StreamEvent, Transport, NormalizedUsage, ProviderHistory, ProviderStream } from '../transport.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';
import type { Journal } from '../../kernel/index.js';

const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const done = (): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

class ScriptedTransport implements Transport {
  readonly api = 'fake';
  readonly provider = 'fake';
  private i = 0;
  constructor(private readonly rounds: StreamEvent[][]) {}
  emptyHistory(): ProviderHistory { return [] as unknown[]; }
  historyFromJournal(entries: JournalEntry[]): ProviderHistory { return entries.map((e) => ({ type: e.payload.type })) as unknown[]; }
  pushAssistant(h: ProviderHistory): void { (h as unknown[]).push({ role: 'assistant' }); }
  pushToolResult(h: ProviderHistory): void { (h as unknown[]).push({ role: 'tool' }); }
  pushUser(h: ProviderHistory, text: string): void { (h as unknown[]).push({ role: 'user', text }); }
  buildTools(raw: unknown[]): unknown[] { return raw; }
  callModel(): ProviderStream { return (this.rounds[this.i++] ?? [done()]) as unknown as ProviderStream; }
  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> { for (const ev of stream as StreamEvent[]) yield ev; }
  computeCostUsd(_u: NormalizedUsage): number { return 0; }
  buildModelUsage(): never { throw new Error('unused'); }
  classifyError(): never { throw new Error('unused'); }
  classifyTermination(): never { throw new Error('unused'); }
  defaultModel(): string { return 'fake'; }
}

const PATH: SubagentPathSegment[] = [{ depth: 1, agentToolUseId: 'node-1', agentSlug: 's', agentName: 's' }];

function mk(payload: JournalEntry['payload'], seq: number): JournalEntry {
  return {
    uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't',
    spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '', agentPath: PATH, payload,
  };
}

function fakeJournal(): { journal: Journal; entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  const journal = {
    taskId: 't', workspaceId: 'w',
    append: async (e: unknown) => {
      const entry = { ...(e as JournalEntry), seq: entries.length + 100 };
      entries.push(entry);
      return entry;
    },
    read: async function* () { for (const e of entries) yield e; },
  } as unknown as Journal;
  return { journal, entries };
}

describe('subagent: a call to a tool the helper does not have', () => {
  it('the round body answers `Unknown tool: <name> [error:not_found]`; off, the bare words', async () => {
    for (const taxonomy of [true, false]) {
      const seen: SubagentEvent[] = [];
      const transport = new ScriptedTransport([
        [{ kind: 'tool_use', toolUse: { id: 'c1', name: 'Nope', input: {} } }, done()],
        [{ kind: 'text', text: 'finished' }, done()],
      ]);
      const res = await runSubagentLoop({
        transport, model: 'm', system: 'sys', userPrompt: 'go', tools: [],
        harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, childId: 'c',
        onEvent: (ev) => seen.push(ev),
        ...(taxonomy && { toolErrorTaxonomy: true }),
      });
      const result = seen.find((e): e is Extract<SubagentEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
      expect(result).toMatchObject({ isError: true, result: taxonomy ? 'Unknown tool: Nope [error:not_found]' : 'Unknown tool: Nope' });
      expect(res.text).toBe('finished');
    }
  });

  it('the continue-at-dispatch re-entry answers the same way for a pending call to a missing tool', async () => {
    for (const taxonomy of [true, false]) {
      const transport = new ScriptedTransport([[{ kind: 'text', text: 'carried on' }, done()]]);
      const { journal, entries } = fakeJournal();
      const seed = [
        mk({ type: 'assistant', blocks: [{ type: 'text', text: 'calling it' } as ContentBlock] }, 1),
        mk({ type: 'tool_use', toolUseId: 'leaf-1', name: 'Gone', input: { q: 1 } }, 2),
      ];
      await runSubagentLoop({
        transport, model: 'm', system: 'sys', userPrompt: 'go', tools: [],
        harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, childId: 'node-1',
        onEvent: () => {}, journal, subagentPath: PATH,
        resume: { seedEntries: seed, continuePending: true },
        ...(taxonomy && { toolErrorTaxonomy: true }),
      });
      const results = entries.filter((e) => e.payload.type === 'tool_result');
      expect(results).toHaveLength(1);
      const p = results[0].payload as { toolUseId: string; isError?: boolean; blocks?: Array<{ text?: string }> };
      expect(p.toolUseId).toBe('leaf-1');
      expect(p.isError).toBe(true);
      expect(p.blocks?.[0]?.text).toBe(taxonomy ? 'Unknown tool: Gone [error:not_found]' : 'Unknown tool: Gone');
    }
  });
});
