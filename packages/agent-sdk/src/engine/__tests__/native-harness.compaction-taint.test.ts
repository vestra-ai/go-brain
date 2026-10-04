/**
 * W4-1 — the untrusted-content fence survives compaction.
 *
 * The summarize prompt instructs the model to keep carried-forward third-party
 * content inside the fence markers, and the compaction PIPELINE (summarize →
 * splice → summary user entry → projection) must preserve those bytes verbatim:
 * nothing between the model's summary text and the journal may strip or rewrite
 * the markers. The summarizer is scripted (keyless), so what this pins is
 * (a) the instruction reaching the summarize call's system prompt, and (b) the
 * fence bytes riding the spliced summary + the post-compaction projection intact.
 *
 * Injection payloads are DESCRIBED, never reproduced (test content only ever says
 * that an instruction-shaped sentence exists at a path).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import {
  fenceUntrustedText,
  UNTRUSTED_CONTENT_OPEN,
  UNTRUSTED_CONTENT_CLOSE,
} from '../../tools/tool-types.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import type { NewEntry, JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

afterEach(() => {
  delete process.env.COMPACTION_V2;
});

function doneEvent(stopReason: string | null = 'end_turn'): StreamEvent {
  return { kind: 'done', stopReason, usage: { inputTokens: 1000, outputTokens: 20 } as NormalizedUsage };
}

class ScriptedTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly steps: StreamEvent[][]) {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    return step;
  }
  override computeCostUsd(): number {
    return 0.02;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `cvt-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

async function seedTokens(j: Journal, taskId: string, targetTokens: number): Promise<void> {
  const chunk = 'context '.repeat(500);
  const turns = Math.ceil(targetTokens / 2000);
  for (let i = 0; i < turns; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i} ${chunk}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i} ${chunk}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    });
  }
}

async function runTurn(opts: { taskId: string; journal: Journal; transport: ScriptedTransport }): Promise<HarnessEvent[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 4,
    transport: opts.transport,
    journal: opts.journal,
    compaction: { keepWindowTokens: 2_000 },
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-cvt',
    cwd: '/tmp',
    model: 'claude-sonnet-5',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'continue' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

describe('W4-1 — compaction preserves the untrusted-content fence', () => {
  it('ON: the summarize prompt carries the taint instruction, and the spliced summary keeps the fence bytes', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cvt-fence';
    const j = makeJournal(taskId);

    // A tainted web read early in the span the compaction will drop: the fenced
    // result of a page that, per its own text, contains an instruction-shaped
    // sentence (described, not reproduced).
    const fencedResult = fenceUntrustedText(
      'Fetched page for the research task. The page also contains a sentence shaped like a command addressed to an automated reader.',
    );
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: 'tu-web-1', name: 'WebFetch', input: { url: 'https://example.com/report' } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: 'tu-web-1',
        blocks: [{ type: 'text', text: fencedResult } as ContentBlock],
        isError: false,
        taint: 'external',
      },
    });
    await seedTokens(j, taskId, 260_000);

    // The scripted summarizer OBEYS the instruction: its summary carries the
    // fenced excerpt forward. The pipeline under test must not strip it.
    const carried = fenceUntrustedText('carried-forward excerpt of the fetched page, still third-party material');
    const transport = new ScriptedTransport([
      [{ kind: 'text', text: `SUMMARY OF EARLIER WORK. ${carried}` }, doneEvent()],
      [{ kind: 'text', text: 'answer' }, doneEvent()],
    ]);
    await runTurn({ taskId, journal: j, transport });

    // (a) The summarize call's system prompt named the markers and the rule.
    expect(transport.systems[0]).toContain(UNTRUSTED_CONTENT_OPEN);
    expect(transport.systems[0]).toContain(UNTRUSTED_CONTENT_CLOSE);
    expect(transport.systems[0]).toContain('not instructions');

    // (b) The spliced summary entry retains the fence bytes verbatim.
    const entries: JournalEntry[] = [];
    for await (const e of j.read()) entries.push(e);
    const boundary = entries.find((e) => e.payload.type === 'compact_boundary');
    expect(boundary).toBeDefined();
    const summaryUuid = (boundary!.payload as { summaryUuid: string }).summaryUuid;
    const summaryEntry = entries.find((e) => e.uuid === summaryUuid)!;
    const summaryText = ((summaryEntry.payload as { blocks: ContentBlock[] }).blocks[0] as { text: string }).text;
    expect(summaryText).toContain(carried);

    // (c) The post-compaction PROJECTION still carries the fence — the model's
    // next request reads the carried content as fenced third-party material.
    const projected = journalToAnthropicMessages((await j.project()).messages);
    const flat = JSON.stringify(projected);
    expect(flat).toContain(UNTRUSTED_CONTENT_OPEN);
    expect(flat).toContain('carried-forward excerpt');
  });
});
