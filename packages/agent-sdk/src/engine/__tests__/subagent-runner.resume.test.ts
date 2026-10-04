/**
 * T11b (durable subagent deep-HITL, Phase B) — `runSubagentLoop`'s RESUME seam.
 *
 * The heart of Phase B: a paused subagent is RE-ENTERED from its journaled scope
 * projection instead of replayed from the top. `SubagentRunOptions.resume.seedEntries`
 * carries the subagent's prior rounds (ending with the paused tool's resolved result);
 * the loop SEEDS its provider history from them (plus a synthesized leading user
 * message) and proceeds DIRECTLY to the model loop — so the model is invoked ONLY for
 * forward progress and the prior rounds are NEITHER regenerated NOR re-billed.
 *
 * The headline ZERO-REPLAY proof lives here: a multi-round seed + a single forward
 * round ⇒ exactly ONE `callModel` (the forward one), whose history already carries the
 * seeded prior rounds. The contrast (no resume ⇒ N+1 `callModel` for the same logical
 * conversation) makes the saving explicit.
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';
const doneEv = (): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

/**
 * A transport that makes the seed VISIBLE: `historyFromJournal` returns one marker per
 * entry (so a seeded history is provably built from the journal, not regenerated), and
 * `callModel` SNAPSHOTS the history it received so the test can prove (a) how many model
 * rounds ran and (b) that the FIRST forward round already carried the prior context.
 */
class CountingTransport implements Transport {
  readonly api = 'fake';
  readonly provider = 'fake';
  /** A snapshot of `p.history` at each callModel — length === # model rounds driven. */
  readonly callModelHistories: unknown[][] = [];
  private i = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  emptyHistory(): ProviderHistory {
    return [] as unknown[];
  }
  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    // One marker per entry — a faithful (test-visible) projection of the seed.
    return entries.map((e) => ({ from: 'journal', type: e.payload.type })) as unknown[];
  }
  pushAssistant(h: ProviderHistory): void {
    (h as unknown[]).push({ role: 'assistant' });
  }
  pushToolResult(h: ProviderHistory): void {
    (h as unknown[]).push({ role: 'tool' });
  }
  pushUser(h: ProviderHistory, text: string): void {
    (h as unknown[]).push({ role: 'user', text });
  }
  buildTools(raw: unknown[]): unknown[] {
    return raw;
  }
  callModel(p: { history: ProviderHistory }): ProviderStream {
    this.callModelHistories.push([...(p.history as unknown[])]);
    return (this.rounds[this.i++] ?? [doneEv()]) as unknown as ProviderStream;
  }
  // eslint-disable-next-line require-yield
  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    for (const ev of stream as StreamEvent[]) yield ev;
  }
  computeCostUsd(u: NormalizedUsage): number {
    return (u.inputTokens + u.outputTokens) * 0.01;
  }
  buildModelUsage(): never {
    throw new Error('unused');
  }
  classifyError(): never {
    throw new Error('unused');
  }
  classifyTermination(): never {
    throw new Error('unused');
  }
  defaultModel(): string {
    return 'fake';
  }
}

/** N seed rounds: each = an assistant text + a tool_use + its tool_result. Ends with the
 *  paused tool's RESOLVED result (so the seed is complete and the next callModel is valid). */
function seedEntries(n: number): JournalEntry[] {
  const mk = (payload: JournalEntry['payload']): JournalEntry => ({
    uuid: `u${Math.random()}`, parentUuid: null, seq: 0, taskId: 't', rootTaskId: 't',
    spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '', agentPath: [{ depth: 1, agentToolUseId: 'A1', agentSlug: 's', agentName: 's' }],
    payload,
  });
  const out: JournalEntry[] = [];
  for (let r = 0; r < n; r++) {
    out.push(mk({ type: 'assistant', blocks: [{ type: 'text', text: `round ${r}` } as ContentBlock] }));
    out.push(mk({ type: 'tool_use', toolUseId: `c${r}`, name: 'Bash', input: { cmd: `step ${r}` } }));
    out.push(mk({ type: 'tool_result', toolUseId: `c${r}`, blocks: [{ type: 'text', text: `out ${r}` } as ContentBlock] }));
  }
  return out;
}

describe('runSubagentLoop — RESUME seam (T11b: zero-replay re-entry)', () => {
  it('ZERO REPLAY: a multi-round seed + one forward round ⇒ exactly ONE callModel (prior rounds not regenerated), whose history carries the seed', async () => {
    const N = 3;
    const seed = seedEntries(N);
    // Forward script: a single final-answer round (the subagent finishes).
    const transport = new CountingTransport([[{ kind: 'text', text: 'final answer' }, doneEv()]]);

    const res = await runSubagentLoop({
      transport,
      model: 'm',
      system: 'sys',
      userPrompt: 'do the research',
      tools: [],
      harness: allowHarness,
      onPause,
      maxTurns: 10,
      childId: 'A1',
      onEvent: () => {},
      resume: { seedEntries: seed },
    });

    // THE PROOF: the model ran ONCE — only the forward round. The N prior rounds were
    // re-entered from the journal, never regenerated (zero replayed model rounds).
    expect(transport.callModelHistories).toHaveLength(1);

    // The forward round's history already carried the seeded prior rounds (3N entries +
    // the synthesized leading user message) — proof the prior context was SEEDED, not
    // re-derived by re-asking the model.
    expect(transport.callModelHistories[0].length).toBe(1 + seed.length);

    // Billing-minimal: only the ONE forward round's tokens are charged.
    expect(res.costUsd).toBeCloseTo(0.02, 6); // (1 input + 1 output) * 0.01
    expect(res.text).toBe('final answer');
  });

  it('CONTRAST: the SAME logical conversation run FRESH (no resume) costs N+1 callModel — the replay the resume avoids', async () => {
    const N = 3;
    // A from-scratch run that re-generates the N seed rounds then the final answer.
    const rounds: StreamEvent[][] = [];
    for (let r = 0; r < N; r++) {
      rounds.push([{ kind: 'text', text: `round ${r}` }, doneEv()]);
    }
    rounds.push([{ kind: 'text', text: 'final answer' }, doneEv()]);
    // Each round but the last calls a tool so the loop keeps going.
    const withTools: StreamEvent[][] = rounds.map((evs, r) =>
      r < N
        ? [{ kind: 'text', text: `round ${r}` }, { kind: 'tool_use', toolUse: { id: `c${r}`, name: 'noop', input: {} } }, doneEv()]
        : evs,
    );
    const transport = new CountingTransport(withTools);

    await runSubagentLoop({
      transport,
      model: 'm',
      system: 'sys',
      userPrompt: 'do the research',
      tools: [{ name: 'noop', description: 'noop', parameters: {}, execute: async () => 'ok' }],
      harness: allowHarness,
      onPause,
      maxTurns: 10,
      childId: 'A1',
      onEvent: () => {},
      // NO resume ⇒ from-scratch.
    });

    // Fresh run drives the model N+1 times (regenerating every round). This is exactly
    // the replay the resume path eliminates.
    expect(transport.callModelHistories).toHaveLength(N + 1);
    // And the FIRST call started from a bare seed (just the user prompt), proving the
    // no-resume path is unchanged (emptyHistory + pushUser).
    expect(transport.callModelHistories[0]).toHaveLength(1);
  });

  it('the resumed loop seeds the leading user message from userPrompt (Anthropic-valid: user-first)', async () => {
    const transport = new CountingTransport([[{ kind: 'text', text: 'ok' }, doneEv()]]);
    await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'the prompt', tools: [],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'A1', onEvent: () => {},
      resume: { seedEntries: [] },
    });
    // With an EMPTY scope the seed is just the synthesized leading user message.
    expect(transport.callModelHistories[0]).toHaveLength(1);
  });
});
