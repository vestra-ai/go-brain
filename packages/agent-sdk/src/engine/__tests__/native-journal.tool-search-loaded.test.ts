/**
 * TOOL_SEARCH_V1 — the loaded set survives a runner recycle.
 *
 * THE DEFECT THIS EXISTS TO PREVENT is silent and delayed. A model loads the
 * browser ring on turn 3, pauses for a human, and the continue arrives hours later
 * on a fresh runtime. If the loaded set lived only in process memory, that resume
 * would come back with the ring withheld again — no error, no log line, just an
 * agent whose hands quietly narrowed mid-task, calling a tool it can no longer see
 * and reading "Unknown tool". This is the same shape as
 * `native-todo-store-volatile-on-resume`, and the fix is the same: derive the state
 * by replaying the journal, so a cold process reads exactly what a warm one does.
 *
 * ORDER, not just membership, is asserted: the tools array is rebuilt in load
 * order, so a replay that returned the same names in a different order would
 * produce a different (cache-busting) wire shape on the first resumed turn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { appendUserEntry, appendToolSearchLoaded, readToolSearchLoaded } from '../native-journal.js';
import { createToolSearchState } from '../tool-search.js';

const dir = join(tmpdir(), `native-journal-tool-search-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const file = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId: string) =>
  new Journal({
    taskId,
    workspaceId: 'u',
    jsonl: new JsonlStore(file(taskId)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });
const ctxFor = (taskId: string): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId: 'u' } } }) as unknown as HarnessContext<NativeConfigLike>;

describe('tool_search_loaded — journal round trip', () => {
  it('rides the FROZEN `custom` kind, so it never replays into the model context', async () => {
    const j = make('t-kind');
    await appendUserEntry(j, ctxFor('t-kind'), 'go');
    await appendToolSearchLoaded(j, ctxFor('t-kind'), ['mcp__browser-control__computer_click']);

    const lines = (await fs.readFile(file('t-kind'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { payload: { type: string; key?: string; data?: unknown } });
    const entry = lines.find((e) => e.payload.type === 'custom' && e.payload.key === 'tool_search_loaded');
    expect(entry).toBeDefined();
    expect(entry!.payload.data).toEqual({ names: ['mcp__browser-control__computer_click'] });

    // CONTEXT_POLICY:false — the projection the wire is built from never sees it.
    const projected = await j.project();
    expect(JSON.stringify(projected.messages)).not.toContain('tool_search_loaded');
  });

  it('A COLD PROCESS READS WHAT THE WARM ONE WROTE, in load order', async () => {
    const warm = make('t-recycle');
    const ctx = ctxFor('t-recycle');
    await appendUserEntry(warm, ctx, 'go');
    await appendToolSearchLoaded(warm, ctx, ['mcp__os-hands__os_open']);
    await appendToolSearchLoaded(warm, ctx, ['mcp__browser-control__computer_click', 'mcp__browser-control__computer_type']);

    // A fresh Journal over the same file — exactly what a recycled runner builds.
    const cold = make('t-recycle');
    expect(await readToolSearchLoaded(cold)).toEqual([
      'mcp__os-hands__os_open',
      'mcp__browser-control__computer_click',
      'mcp__browser-control__computer_type',
    ]);
  });

  it('dedupes across entries while keeping FIRST-load position', async () => {
    const j = make('t-dedupe');
    const ctx = ctxFor('t-dedupe');
    await appendToolSearchLoaded(j, ctx, ['a', 'b']);
    await appendToolSearchLoaded(j, ctx, ['b', 'c']);
    expect(await readToolSearchLoaded(make('t-dedupe'))).toEqual(['a', 'b', 'c']);
  });

  it('the replayed state reconstructs the same set the live one held', async () => {
    const j = make('t-state');
    const ctx = ctxFor('t-state');
    await appendToolSearchLoaded(j, ctx, ['a']);
    await appendToolSearchLoaded(j, ctx, ['b']);
    const replayed = createToolSearchState(await readToolSearchLoaded(make('t-state')));
    expect(replayed.order).toEqual(['a', 'b']);
    expect(replayed.loaded.has('a')).toBe(true);
  });

  it('a task that never searched replays as empty — a cold start is a fresh start', async () => {
    const j = make('t-none');
    await appendUserEntry(j, ctxFor('t-none'), 'go');
    expect(await readToolSearchLoaded(make('t-none'))).toEqual([]);
  });

  it('never throws, and writes nothing, when the journal or the name list is absent', async () => {
    await expect(appendToolSearchLoaded(undefined, ctxFor('t-x'), ['a'])).resolves.toBeUndefined();
    await expect(readToolSearchLoaded(undefined)).resolves.toEqual([]);
    const j = make('t-empty');
    await appendToolSearchLoaded(j, ctxFor('t-empty'), []);
    expect(await j.snapshot()).toHaveLength(0);
  });

  it('ignores a malformed record rather than poisoning the whole replay', async () => {
    const j = make('t-junk');
    const ctx = ctxFor('t-junk');
    await appendToolSearchLoaded(j, ctx, ['good']);
    await j.append({
      taskId: 't-junk', rootTaskId: 't-junk', spawnDepth: 0, workspaceId: 'u',
      agentId: 'system', principal: { kind: 'system' }, timestamp: '',
      payload: { type: 'custom', key: 'tool_search_loaded', data: { names: 'not-an-array' } },
    });
    await appendToolSearchLoaded(j, ctx, ['alsogood']);
    expect(await readToolSearchLoaded(make('t-junk'))).toEqual(['good', 'alsogood']);
  });
});
