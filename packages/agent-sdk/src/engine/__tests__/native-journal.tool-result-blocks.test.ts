/**
 * Task 2 — Persist tool-result image blocks in the native journal.
 *
 * T1 added `blocks?: ContentBlock[]` to ToolDispatchResult (set only when a tool
 * with returnsContentBlocks:true returns an image envelope). These tests pin that
 * the journal appenders persist those `blocks` verbatim (so a screenshot survives a
 * recycle) instead of flattening everything to a single text block — while the
 * NO-blocks path stays byte-identical to the historic `[{type:'text',text}]` shape.
 *
 * Persistence is asserted at the JOURNAL layer (raw read() + project()), not the
 * Anthropic wire projection: the journal is the durable carrier of the ImageBlock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { appendToolResultEntry, appendToolResultByTaskId } from '../native-journal.js';

const dir = join(tmpdir(), `native-journal-tr-blocks-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

/** Minimal HarnessContext for the ctx-family appender (reads taskId + runtimeConfig.userId only). */
const ctxFor = (taskId = 't', userId = 'u'): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId } } } as unknown as HarnessContext<NativeConfigLike>);

const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
};

const toolResultPayload = (e: JournalEntry) =>
  e.payload as Extract<JournalEntry['payload'], { type: 'tool_result' }>;

const IMAGE_BLOCKS: ContentBlock[] = [
  { type: 'text', text: 'Scrolled down' },
  { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
];

describe('appendToolResultEntry — persists tool-result image blocks (T2)', () => {
  it('writes r.blocks verbatim when present (text + image survive)', async () => {
    const j = make();
    await appendToolResultEntry(j, ctxFor(), {
      toolUseId: 'tu1',
      text: 'Scrolled down',
      isError: false,
      blocks: IMAGE_BLOCKS,
    });
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(toolResultPayload(tr!).blocks).toEqual(IMAGE_BLOCKS);
  });

  it('falls back to [{type:text,text}] when r.blocks is absent (byte-identical to today)', async () => {
    const j = make();
    await appendToolResultEntry(j, ctxFor(), {
      toolUseId: 'tu1',
      text: 'plain result',
      isError: false,
    });
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(toolResultPayload(tr!).blocks).toEqual([{ type: 'text', text: 'plain result' }]);
    expect(toolResultPayload(tr!).isError).toBe(false);
  });
});

describe('appendToolResultByTaskId — persists tool-result image blocks (T2)', () => {
  it('falls back to [{type:text,text}] when r.blocks is absent (byte-identical to today)', async () => {
    const j = make();
    await appendToolResultByTaskId(j, 't', {
      toolUseId: 'tu2',
      text: 'continue result',
      isError: true,
    }, 'u');
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(toolResultPayload(tr!).blocks).toEqual([{ type: 'text', text: 'continue result' }]);
    expect(toolResultPayload(tr!).isError).toBe(true);
  });

  it('writes r.blocks verbatim when present', async () => {
    const j = make();
    await appendToolResultByTaskId(j, 't', {
      toolUseId: 'tu2',
      text: 'Scrolled down',
      isError: false,
      blocks: IMAGE_BLOCKS,
    }, 'u');
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(toolResultPayload(tr!).blocks).toEqual(IMAGE_BLOCKS);
  });
});

describe('resume round-trip — ImageBlock survives a re-projection (T2)', () => {
  it('project() on a fresh Journal over the same files still carries the ImageBlock', async () => {
    // Append a user turn + a tool_use so the tool_result has a valid context chain,
    // then the image tool_result.
    const j1 = make('t-resume');
    await j1.append({
      taskId: 't-resume', rootTaskId: 't-resume', spawnDepth: 0, workspaceId: 'w', agentId: 'native',
      principal: { kind: 'user', userId: 'u' }, timestamp: '',
      payload: { type: 'user', blocks: [{ type: 'text', text: 'screenshot please' }] },
    });
    await j1.append({
      taskId: 't-resume', rootTaskId: 't-resume', spawnDepth: 0, workspaceId: 'w', agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
      payload: { type: 'tool_use', toolUseId: 'tu-shot', name: 'browser_screenshot', input: {} },
    });
    await appendToolResultEntry(j1, ctxFor('t-resume'), {
      toolUseId: 'tu-shot',
      text: 'Scrolled down',
      isError: false,
      blocks: IMAGE_BLOCKS,
    });

    // Simulate a recycle: a fresh Journal over the same on-disk files, re-project.
    const j2 = make('t-resume');
    const { messages } = await j2.project();
    const tr = messages.find((m) => m.payload.type === 'tool_result');
    expect(tr).toBeDefined();
    const blocks = toolResultPayload(tr!).blocks;
    expect(blocks).toEqual(IMAGE_BLOCKS);
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });
});

describe('raw-JSONL durability — project() never mutates the append-only image blocks (T2)', () => {
  it('after project(), raw read() still returns the original ImageBlocks', async () => {
    const j = make('t-raw');
    await appendToolResultEntry(j, ctxFor('t-raw'), {
      toolUseId: 'tu-raw',
      text: 'Scrolled down',
      isError: false,
      blocks: IMAGE_BLOCKS,
    });
    await j.project(); // T6 will prune at projection time; the raw JSONL must stay intact.
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(toolResultPayload(tr!).blocks).toEqual(IMAGE_BLOCKS);
  });
});
