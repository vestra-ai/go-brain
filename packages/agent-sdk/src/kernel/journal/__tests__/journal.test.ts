import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { NewEntry, JournalEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `journal-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});
const userMsg = (text: string): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: '',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});

describe('Journal.append', () => {
  it('assigns uuid, monotonic seq, links parent to prior leaf, stamps clock time', async () => {
    const j = make();
    const a = await j.append(userMsg('hi'));
    const b = await j.append(userMsg('again'));
    expect(a.uuid).toBe('entry-0');
    expect(b.uuid).toBe('entry-1');
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.parentUuid).toBeNull();
    expect(b.parentUuid).toBe('entry-0');
    expect(a.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(await j.leaf()).toBe('entry-1');
  });

  it('serializes concurrent appends into one linear chain (single-writer invariant)', async () => {
    const j = make();
    // Fire both WITHOUT awaiting between them — concurrent callers must not interleave
    // the leaf/seq/parentUuid mutation.
    const [a, b] = await Promise.all([j.append(userMsg('x')), j.append(userMsg('y'))]);
    expect(b.parentUuid).toBe(a.uuid); // a single linear chain, not two roots
    expect(a.parentUuid).toBeNull();
    expect([a.seq, b.seq].sort((p, q) => p - q)).toEqual([0, 1]); // distinct seqs
    expect(a.seq).not.toBe(b.seq);
    expect(await j.leaf()).toBe(b.uuid); // last write owns the leaf
  });

  it('does NOT await the mirror on append (mirror flushed at turn boundary)', async () => {
    const mirror = new InMemorySessionStore();
    const spy = vi.spyOn(mirror, 'appendBatch');
    const j = new Journal({
      taskId: 't', workspaceId: 'w',
      jsonl: new JsonlStore(join(dir, 't.jsonl')),
      mirror, clock: sequentialClock('2026-01-01T00:00:00.000Z'),
    });
    await j.append(userMsg('hi'));
    await j.append(userMsg('again'));
    expect(spy).not.toHaveBeenCalled(); // append never touches the mirror
    await j.flushMirror();
    expect(spy).toHaveBeenCalledTimes(1); // only the turn-boundary flush does
  });
});

describe('Journal.project (warm cache)', () => {
  it('does no disk read when warm (cache valid for current leaf)', async () => {
    const jsonl = new JsonlStore(join(dir, 't.jsonl'));
    const j = new Journal({
      taskId: 't', workspaceId: 'w', jsonl,
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-01-01T00:00:00.000Z'),
    });
    await j.append(userMsg('hi'));
    await j.project(); // warms the cache (reads disk once)
    const spy = vi.spyOn(jsonl, 'read');
    const warm = await j.project();
    expect(spy).not.toHaveBeenCalled(); // warm projection serves from cache, no replay
    expect(warm.messages).toHaveLength(1);
  });
});

describe('Journal.project', () => {
  it('rehydrates the conversation after a simulated restart (resume-survives-restart)', async () => {
    const j1 = make();
    await j1.append(userMsg('first'));
    await j1.append(userMsg('second'));
    // Simulate a fresh process: a new Journal over the same on-disk files.
    const j2 = make();
    const state = await j2.project();
    expect(state.messages.map((m) => m.payload.type)).toEqual(['user', 'user']);
    expect(state.messages).toHaveLength(2);
  });
});

describe('Journal.project — todos (Phase 3, §1.4)', () => {
  const planEntry = (op: 'create' | 'update' | 'delete', id: string, fields?: Record<string, unknown>): NewEntry => ({
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
    principal: { kind: 'system' }, timestamp: '',
    payload: { type: 'plan', op, id, ...fields } as never,
  });

  it('folds `plan` entries into state.todos', async () => {
    const j = make();
    await j.append(planEntry('create', 'a', { content: 'Alpha', status: 'pending' }));
    await j.append(planEntry('create', 'b', { content: 'Bravo', status: 'pending' }));
    await j.append(planEntry('update', 'a', { status: 'completed' }));
    const state = await j.project();
    expect(state.todos).toEqual([
      { id: 'a', content: 'Alpha', status: 'completed' },
      { id: 'b', content: 'Bravo', status: 'pending' },
    ]);
  });

  it('AC-P1 — todos rehydrate identically after a simulated process restart', async () => {
    const j1 = make('t-todos-cold');
    await j1.append(planEntry('create', 'a', { content: 'Alpha', status: 'pending' }));
    await j1.append(planEntry('update', 'a', { status: 'in_progress' }));
    const j2 = make('t-todos-cold'); // fresh process, same on-disk jsonl
    const state = await j2.project();
    expect(state.todos).toEqual([{ id: 'a', content: 'Alpha', status: 'in_progress' }]);
  });

  it('todos survive compaction (folded from the pre-compaction scope, not the post-compaction messages)', async () => {
    const j = make('t-todos-compact');
    const base = { taskId: 't-todos-compact', rootTaskId: 't-todos-compact', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' as const }, timestamp: '' };
    await j.append(planEntry('create', 'a', { content: 'Survives compaction', status: 'pending' }));
    const turn2 = await j.append(userMsg('later turn'));
    const summary = await j.append(userMsg('[summary of earlier turns]'));
    await j.compact({
      summaryUuid: summary.uuid,
      preservedUuids: [],
      firstKeptId: turn2.uuid,
      trigger: 'auto',
      preTokens: 0,
      postTokens: 0,
      base,
    });
    const state = await j.project();
    // The plan entry itself predates the compaction cut and is non-context anyway —
    // but todos must still reflect it (it is not part of the summarized-away span
    // from the todo panel's point of view).
    expect(state.todos).toEqual([{ id: 'a', content: 'Survives compaction', status: 'pending' }]);
    // Sanity: the compaction actually ran (messages lead with the summary).
    expect(state.messages[0].uuid).toBe(summary.uuid);
  });
});

describe('Journal.branch', () => {
  it('branch moves the leaf so subsequent appends fork from the chosen entry', async () => {
    const j = make();
    const a = await j.append(userMsg('a'));
    await j.append(userMsg('b'));
    await j.branch(a.uuid);
    const c = await j.append(userMsg('c'));
    expect(c.parentUuid).toBe(a.uuid);
    expect(await j.leaf()).toBe(c.uuid);
  });
});

describe('Journal.healOrphanedToolUse (D3 interrupt seal)', () => {
  // NewEntry base mirroring the file's userMsg() helper (no `baseFor` exists here;
  // the brief authorizes reusing whatever this file already defines).
  const base = (): Omit<NewEntry, 'payload'> => ({
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
    principal: { kind: 'system' }, timestamp: '',
  });

  it('healOrphanedToolUse(true) seals an orphan with a non-empty "Interrupted by user." text block (D3)', async () => {
    const journal = make('t-d3');
    await journal.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await journal.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: {} } });
    await journal.healOrphanedToolUse(true);
    const all: JournalEntry[] = [];
    for await (const e of journal.read()) all.push(e);
    const result = all.find((e) => e.payload.type === 'tool_result');
    expect(result).toBeDefined();
    const p = result!.payload as { blocks: { type: string; text?: string }[]; isError?: boolean };
    expect(p.isError).toBe(true);
    expect(p.blocks).toEqual([{ type: 'text', text: 'Interrupted by user.' }]);
  });

  it('healOrphanedToolUse() (default/non-interrupt) seals an orphan with a NEUTRAL empty-blocks result (crash case)', async () => {
    const journal = make('t-crash');
    await journal.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await journal.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: {} } });
    await journal.healOrphanedToolUse();
    const all: JournalEntry[] = [];
    for await (const e of journal.read()) all.push(e);
    const result = all.find((e) => e.payload.type === 'tool_result');
    expect(result).toBeDefined();
    const p = result!.payload as { blocks: { type: string; text?: string }[]; isError?: boolean };
    expect(p.isError).toBe(true);
    // A genuine crash/continue-orphan must NOT be mislabeled "Interrupted by user."
    expect(p.blocks).toEqual([]);
  });
});

// ─── Task 6: project() is the SINGLE native screenshot-prune authority ─────────
// prune runs AFTER suspendPending+applyCompaction+filter, so "keep latest 2" =
// the latest 2 the model actually sees. The durable JSONL (read()) is never
// touched (projection-only). Pairing stays intact; user/assistant entries are
// byte-identical.
describe('Journal.project — screenshot prune (Task 6)', () => {
  const base = (): Omit<NewEntry, 'payload'> => ({
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
    principal: { kind: 'system' }, timestamp: '',
  });
  const PLACEHOLDER = '[screenshot from earlier turn — truncated for context efficiency]';
  const IMG = { type: 'image', data: 'B64', mediaType: 'image/jpeg' } as never;
  const toolUse = (id: string): NewEntry => ({
    ...base(), payload: { type: 'tool_use', toolUseId: id, name: 'computer_screenshot', input: {} },
  });
  const shotResult = (id: string): NewEntry => ({
    ...base(), payload: { type: 'tool_result', toolUseId: id, blocks: [IMG] },
  });
  const resBlocks = (e: JournalEntry): Array<{ type: string }> =>
    (e.payload as { blocks: Array<{ type: string }> }).blocks;
  const isShot = (e: JournalEntry): boolean =>
    e.payload.type === 'tool_result' && resBlocks(e).some((b) => b.type === 'image');

  it('keeps the latest 2 screenshots intact, stubs older ones — pairing intact, raw read() unchanged', async () => {
    const j = make('t-prune');
    await j.append(userMsg('browse'));
    // 4 screenshot tool_use/tool_result pairs.
    for (const id of ['s1', 's2', 's3', 's4']) {
      await j.append(toolUse(id));
      await j.append(shotResult(id));
    }
    const state = await j.project();
    const results = state.messages.filter((m) => m.payload.type === 'tool_result');
    expect(results).toHaveLength(4);
    // The 2 newest keep image data; the 2 oldest are stubbed to a placeholder.
    expect(isShot(results[0])).toBe(false);
    expect(isShot(results[1])).toBe(false);
    expect(isShot(results[2])).toBe(true);
    expect(isShot(results[3])).toBe(true);
    expect(resBlocks(results[0])).toEqual([{ type: 'text', text: PLACEHOLDER }]);

    // Pairing intact: every tool_use still has its tool_result in the projection.
    for (const id of ['s1', 's2', 's3', 's4']) {
      const hasUse = state.messages.some((m) => m.payload.type === 'tool_use' && (m.payload as { toolUseId: string }).toolUseId === id);
      const hasRes = state.messages.some((m) => m.payload.type === 'tool_result' && (m.payload as { toolUseId: string }).toolUseId === id);
      expect(hasUse && hasRes).toBe(true);
    }

    // The raw durable JSONL is NEVER mutated — every persisted tool_result still
    // carries its real image block.
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    const rawShots = raw.filter((e) => e.payload.type === 'tool_result' && resBlocks(e).some((b) => b.type === 'image'));
    expect(rawShots).toHaveLength(4); // all 4 still have images on disk
  });

  it('prune runs POST-compaction: a screenshot compacted away is NOT one of the kept 2', async () => {
    const j = make('t-prune-compact');
    // 4 screenshot pairs; compaction will DROP the 2 newest so the surviving
    // projection keeps the 2 newest SURVIVING images, not placeholders.
    const ids = ['s1', 's2', 's3', 's4'];
    for (const id of ids) {
      await j.append(toolUse(id));
      await j.append(shotResult(id));
    }
    // Compact: keep only the s1 pair (firstKept = s1's tool_use), drop s2/s3/s4 +
    // their results EXCEPT the s1 pair. We choose firstKept so exactly s1's pair
    // survives, leaving 1 real screenshot ≤ keep-window → no stub.
    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    const s1Use = all.find((e) => e.payload.type === 'tool_use' && (e.payload as { toolUseId: string }).toolUseId === 's1')!;
    const s2Use = all.find((e) => e.payload.type === 'tool_use' && (e.payload as { toolUseId: string }).toolUseId === 's2')!;
    const summary = await j.append({ ...base(), payload: { type: 'assistant', blocks: [{ type: 'text', text: 'SUMMARY' } as never] } });
    // firstKept = s2's tool_use → s1 dropped, s2/s3/s4 survive = 3 real images.
    await j.compact({
      base: base(), summaryUuid: summary.uuid, preservedUuids: [],
      firstKeptId: s2Use.uuid, trigger: 'auto', preTokens: 100, postTokens: 10,
    });

    const state = await j.project();
    const shotResults = state.messages.filter((m) => m.payload.type === 'tool_result');
    // 3 survive compaction (s2,s3,s4) → > keep-window(2) → oldest SURVIVOR (s2)
    // stubbed, the 2 newest survivors (s3,s4) keep real images.
    expect(shotResults).toHaveLength(3);
    expect(shotResults.filter(isShot)).toHaveLength(2);
    // s1 (dropped by compaction) is NOT in the projection at all.
    expect(state.messages.some((m) => m.payload.type === 'tool_result' && (m.payload as { toolUseId: string }).toolUseId === 's1')).toBe(false);
    expect(s1Use.uuid).not.toBe(s2Use.uuid); // sanity
  });

  it('user/assistant entries are byte-identical (prune only stubs tool_result images)', async () => {
    const j = make('t-prune-bytes');
    await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'find a flight' }, IMG] } });
    for (const id of ['s1', 's2', 's3']) {
      await j.append(toolUse(id));
      await j.append(shotResult(id));
    }
    const state = await j.project();
    const user = state.messages.find((m) => m.payload.type === 'user')!;
    // The user-uploaded image is NEVER stubbed and NEVER counted.
    expect((user.payload as { blocks: Array<{ type: string }> }).blocks).toEqual([
      { type: 'text', text: 'find a flight' },
      { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
    ]);
    // Of 3 tool_result screenshots, the oldest is stubbed; the 2 newest kept.
    const results = state.messages.filter((m) => m.payload.type === 'tool_result');
    expect(results.filter(isShot)).toHaveLength(2);
  });
});
