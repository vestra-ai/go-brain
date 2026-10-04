/**
 * P3.5b Fix 1 (Weave HITL pre-flip) — `runSubagentLoop`'s CONTINUE-AT-DISPATCH re-entry.
 *
 * A Weave node pauses at a GATED leaf call: its journaled scope ends with the round's
 * assistant text + the pending leaf's `tool_use` entry and NO `tool_result` (the loop
 * journals the attempt pre-dispatch and withholds the result on a pause). The T11b seed
 * alone cannot resume this shape byte-stably: `historyFromJournal`'s validity floor
 * STRIPS a dangling tool_use (unanswered ⇒ 400), so the model would be asked to
 * RE-COMPOSE the leaf call — and composed content (an email body) drifts at normal
 * temperature, missing the one-shot approval hash.
 *
 * `resume.continuePending` closes that: the loop SPLITS the trailing unresolved round
 * off the seed, re-pushes it in-memory as ONE assistant message (round text + tool_use
 * blocks — the exact live-push shape), and DISPATCHES each pending call with its
 * JOURNALED input verbatim — so the re-run continues AT the gated leaf call and the
 * approved hash matches by construction, with zero model involvement in regeneration.
 *
 * Absent `continuePending` (every T11b caller) the seed path is byte-identical.
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import type { Journal } from '../../kernel/index.js';

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const doneEv = (): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

/** Marker-history transport (the T11b resume-test pattern): journal entries project to
 *  one marker each; pushes append tagged markers; callModel snapshots what it saw. */
class CountingTransport implements Transport {
  readonly api = 'fake';
  readonly provider = 'fake';
  readonly callModelHistories: unknown[][] = [];
  /** Every pushAssistant's blocks — the re-pushed pending round is proven here. */
  readonly pushedAssistant: ContentBlock[][] = [];
  private i = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  emptyHistory(): ProviderHistory {
    return [] as unknown[];
  }
  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return entries.map((e) => ({ from: 'journal', type: e.payload.type })) as unknown[];
  }
  pushAssistant(h: ProviderHistory, blocks: ContentBlock[]): void {
    this.pushedAssistant.push(blocks);
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

const PATH: SubagentPathSegment[] = [{ depth: 1, agentToolUseId: 'node-1', agentSlug: 's', agentName: 's' }];

function mk(payload: JournalEntry['payload'], seq: number): JournalEntry {
  return {
    uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't',
    spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '', agentPath: PATH, payload,
  };
}

/** A Weave-node-shaped seed: one resolved round, then the paused round — assistant
 *  text + the PENDING leaf tool_use, and NO tool_result for it. */
function pausedNodeSeed(): JournalEntry[] {
  return [
    mk({ type: 'assistant', blocks: [{ type: 'text', text: 'research round' } as ContentBlock] }, 1),
    mk({ type: 'tool_use', toolUseId: 'c0', name: 'Bash', input: { command: 'gather-data' } }, 2),
    mk({ type: 'tool_result', toolUseId: 'c0', blocks: [{ type: 'text', text: 'data' } as ContentBlock] }, 3),
    mk({ type: 'assistant', blocks: [{ type: 'text', text: 'now sending the email' } as ContentBlock] }, 4),
    mk({ type: 'tool_use', toolUseId: 'leaf-1', name: 'Bash', input: { command: 'send email: EXACT COMPOSED BODY v1' } }, 5),
  ];
}

function fakeJournal(): { journal: Journal; entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  const journal = {
    taskId: 't',
    workspaceId: 'w',
    append: async (e: unknown) => {
      const entry = { ...(e as JournalEntry), seq: entries.length + 100 };
      entries.push(entry);
      return entry;
    },
    read: async function* () { for (const e of entries) yield e; },
  } as unknown as Journal;
  return { journal, entries };
}

describe('runSubagentLoop — continuePending re-entry (P3.5b: byte-stable continuation at the gated leaf)', () => {
  it('dispatches the trailing pending tool_use with its JOURNALED input verbatim (no model regeneration), then continues forward', async () => {
    const executed: unknown[] = [];
    const bash = {
      name: 'Bash', description: 'd', parameters: {},
      execute: async (input: unknown) => { executed.push(input); return 'SENT'; },
    };
    // ONE scripted forward round: the final answer AFTER the pending leaf resolved.
    const transport = new CountingTransport([[{ kind: 'text', text: 'all done' }, doneEv()]]);
    const { journal, entries } = fakeJournal();

    const res = await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'send the invoice email', tools: [bash],
      harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 10, childId: 'node-1',
      onEvent: () => {},
      journal, subagentPath: PATH,
      resume: { seedEntries: pausedNodeSeed(), continuePending: true },
    });

    // The pending leaf executed EXACTLY once, with the journaled input byte-verbatim.
    expect(executed).toEqual([{ command: 'send email: EXACT COMPOSED BODY v1' }]);
    // The model ran ONCE — the forward round only. It was never asked to re-compose
    // the leaf call (the drift vector Fix 1 closes).
    expect(transport.callModelHistories).toHaveLength(1);
    expect(res.text).toBe('all done');
    expect(res.pausedHalt).toBe(false);

    // The pending round was re-pushed as ONE assistant message: the round's text
    // block + the pending tool_use block (the live-push shape — never two
    // consecutive assistant messages, which Anthropic 400s on).
    expect(transport.pushedAssistant[0].map((b) => b.type)).toEqual(['text', 'tool_use']);
    const tub = transport.pushedAssistant[0][1] as { toolUseId?: string; toolInput?: unknown };
    expect(tub.toolUseId).toBe('leaf-1');
    expect(tub.toolInput).toEqual({ command: 'send email: EXACT COMPOSED BODY v1' });

    // The seeded prefix fed to historyFromJournal EXCLUDES the pending round (the
    // validity floor would strip its dangling tool_use): first callModel history =
    // the user-seed marker + 3 resolved-prefix markers (the paused round's assistant
    // text and tool_use are NOT among them) + the re-pushed assistant + its result.
    const h = transport.callModelHistories[0] as Array<{ from?: string; role?: string }>;
    expect(h.filter((m) => m.from === 'journal')).toHaveLength(4);
    expect(h.filter((m) => m.from === 'journal').map((m) => (m as { type?: string }).type))
      .toEqual(['user', 'assistant', 'tool_use', 'tool_result']);
    expect(h[h.length - 2]).toEqual({ role: 'assistant' });
    expect(h[h.length - 1]).toEqual({ role: 'tool' });

    // The resolved leaf's tool_result journaled scope-tagged (cycle-2 continuity).
    const results = entries.filter((e) => e.payload.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as { toolUseId: string }).toolUseId).toBe('leaf-1');
    // The tool_use entry is NOT re-journaled (it already exists in the scope —
    // a duplicate would project two tool_use blocks for one id and 400).
    expect(entries.filter((e) => e.payload.type === 'tool_use')).toHaveLength(0);
  });

  it('the pending leaf pays its fee once when it runs here (the pause sent none); a pending call that pauses again pays nothing', async () => {
    const bash = { name: 'Bash', description: 'd', parameters: {}, execute: async () => 'SENT' };
    const fees = (events: Array<{ kind: string; event?: { data?: unknown } }>) => events.filter((e) => e.kind === 'billing').map((e) => e.event?.data);

    const ran: Array<{ kind: string; event?: { data?: unknown } }> = [];
    await runSubagentLoop({
      transport: new CountingTransport([[{ kind: 'text', text: 'all done' }, doneEv()]]), model: 'm', system: 'sys', userPrompt: 'send it', tools: [bash],
      harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 10, childId: 'node-1', taskId: 'owner',
      onEvent: (ev) => { ran.push(ev as never); },
      journal: fakeJournal().journal, subagentPath: PATH,
      resume: { seedEntries: pausedNodeSeed(), continuePending: true },
    });
    expect(fees(ran)).toEqual([{ taskId: 'owner', toolName: 'Bash', toolUseId: 'leaf-1', isSubagent: true }]);

    const held: Array<{ kind: string; event?: { data?: unknown } }> = [];
    await runSubagentLoop({
      transport: new CountingTransport([[{ kind: 'text', text: 'never reached' }, doneEv()]]), model: 'm', system: 'sys', userPrompt: 'send it', tools: [bash],
      harness: { gateTool: async (): Promise<GateResult> => ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult) },
      onPause: async () => 'PAUSED', maxTurns: 10, childId: 'node-1', taskId: 'owner',
      onEvent: (ev) => { held.push(ev as never); },
      journal: fakeJournal().journal, subagentPath: PATH,
      resume: { seedEntries: pausedNodeSeed(), continuePending: true },
    });
    expect(fees(held)).toEqual([]);
  });

  it('a pending dispatch that PAUSES (deny path / fresh gate) halts BEFORE any model call and journals no result', async () => {
    const executed: unknown[] = [];
    const bash = {
      name: 'Bash', description: 'd', parameters: {},
      execute: async (input: unknown) => { executed.push(input); return 'SENT'; },
    };
    const gatedHarness = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolName === 'Bash'
          ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult)
          : ({ decision: 'allow' } as GateResult),
    };
    const pauses: ToolCall[] = [];
    const transport = new CountingTransport([[{ kind: 'text', text: 'never reached' }, doneEv()]]);
    const { journal, entries } = fakeJournal();

    const res = await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'send it', tools: [bash],
      harness: gatedHarness, onPause: async (c) => { pauses.push(c); return 'PAUSED_HALT_SENTINEL'; },
      maxTurns: 10, childId: 'node-1', onEvent: () => {},
      journal, subagentPath: PATH,
      resume: { seedEntries: pausedNodeSeed(), continuePending: true },
    });

    expect(res.pausedHalt).toBe(true);
    expect(executed).toEqual([]); // gate said no — the side-effect never fired
    expect(transport.callModelHistories).toHaveLength(0); // no model call at all
    // The pause carried the JOURNALED call verbatim (the one-shot deny in the Weave
    // wrap matches this byte-stably; a drifted re-composition would miss it).
    expect(pauses[0].toolInput).toEqual({ command: 'send email: EXACT COMPOSED BODY v1' });
    expect(pauses[0].toolCallId).toBe('leaf-1');
    // No result journaled — the scope still ends dangling, so the NEXT cycle
    // re-derives the same pending call (monotonic, never lossy).
    expect(entries.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0);
  });

  it('IMPORTANT-B: a SHARED-LOOP-shaped seed (scope-tagged usage entry between the round text and the dangling tool_use) still splits correctly — the lead text rides the re-pushed assistant, never a consecutive-assistant 400', async () => {
    const executed: unknown[] = [];
    const bash = {
      name: 'Bash', description: 'd', parameters: {},
      execute: async (input: unknown) => { executed.push(input); return 'SENT'; },
    };
    // The P2.2 shared round core persists [assistant text, usage] BEFORE the tool
    // batch journals the tool_use — so a paused shared-loop node's scope tail is
    // [assistant, usage, tool_use(dangling)]. A split that only walks contiguous
    // tool_use entries breaks at the usage entry: the lead text stays in the
    // prefix, the wire history ends assistant(text), and the re-pushed tool_use
    // message becomes a consecutive assistant message (Anthropic 400s).
    const seed = [
      mk({ type: 'assistant', blocks: [{ type: 'text', text: 'research round' } as ContentBlock] }, 1),
      mk({ type: 'tool_use', toolUseId: 'c0', name: 'Bash', input: { command: 'gather-data' } }, 2),
      mk({ type: 'tool_result', toolUseId: 'c0', blocks: [{ type: 'text', text: 'data' } as ContentBlock] }, 3),
      mk({ type: 'assistant', blocks: [{ type: 'text', text: 'now sending the email' } as ContentBlock] }, 4),
      mk({ type: 'usage', costUsd: 0.01, model: 'm', inputTokens: 1, outputTokens: 1 } as never, 5),
      mk({ type: 'tool_use', toolUseId: 'leaf-1', name: 'Bash', input: { command: 'send email: EXACT COMPOSED BODY v1' } }, 6),
    ];
    const transport = new CountingTransport([[{ kind: 'text', text: 'all done' }, doneEv()]]);

    const res = await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'send it', tools: [bash],
      harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 10, childId: 'node-1',
      onEvent: () => {},
      resume: { seedEntries: seed, continuePending: true },
    });

    expect(executed).toEqual([{ command: 'send email: EXACT COMPOSED BODY v1' }]);
    expect(res.text).toBe('all done');
    expect(transport.callModelHistories).toHaveLength(1);
    // The paused round's TEXT rides the SAME re-pushed assistant message as the
    // pending tool_use (never its own trailing prefix message).
    expect(transport.pushedAssistant[0].map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect((transport.pushedAssistant[0][0] as { text?: string }).text).toBe('now sending the email');
    // The prefix keeps the resolved round + the (mapper-ignored) usage entry, and
    // EXCLUDES both the lead assistant and the dangling tool_use.
    const h = transport.callModelHistories[0] as Array<{ from?: string; type?: string; role?: string }>;
    expect(h.filter((m) => m.from === 'journal').map((m) => m.type))
      .toEqual(['user', 'assistant', 'tool_use', 'tool_result', 'usage']);
    expect(h[h.length - 2]).toEqual({ role: 'assistant' });
    expect(h[h.length - 1]).toEqual({ role: 'tool' });
  });

  it('a resolved-tail seed with continuePending finds nothing pending — behaves exactly like the T11b seed path', async () => {
    const transport = new CountingTransport([[{ kind: 'text', text: 'final' }, doneEv()]]);
    const resolvedSeed = pausedNodeSeed().slice(0, 3); // ends with c0's tool_result
    const res = await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'p', tools: [],
      harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 5, childId: 'node-1',
      onEvent: () => {},
      resume: { seedEntries: resolvedSeed, continuePending: true },
    });
    expect(res.text).toBe('final');
    // No split, no extra pushes: the whole seed feeds historyFromJournal (+ user seed).
    expect(transport.callModelHistories[0]).toHaveLength(1 + resolvedSeed.length);
    // The ONLY assistant push is the forward round's own (the loop's normal push).
    expect(transport.pushedAssistant).toHaveLength(1);
    expect(transport.pushedAssistant[0].map((b) => b.type)).toEqual(['text']);
  });

  it('WITHOUT continuePending a dangling-tail seed is untouched (T11b callers byte-identical: the floor owns the strip)', async () => {
    const executed: unknown[] = [];
    const bash = {
      name: 'Bash', description: 'd', parameters: {},
      execute: async (input: unknown) => { executed.push(input); return 'SENT'; },
    };
    const seed = pausedNodeSeed();
    const transport = new CountingTransport([[{ kind: 'text', text: 'final' }, doneEv()]]);
    await runSubagentLoop({
      transport, model: 'm', system: 'sys', userPrompt: 'p', tools: [bash],
      harness: allowHarness, onPause: async () => 'PAUSED', maxTurns: 5, childId: 'node-1',
      onEvent: () => {},
      resume: { seedEntries: seed },
    });
    // Nothing mechanically dispatched, nothing re-pushed before the model loop:
    // the legacy seed shape (the forward round's own push is the only one).
    expect(executed).toEqual([]);
    expect(transport.pushedAssistant).toHaveLength(1);
    expect(transport.pushedAssistant[0].map((b) => b.type)).toEqual(['text']);
    expect(transport.callModelHistories[0]).toHaveLength(1 + seed.length);
  });
});
