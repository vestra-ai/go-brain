/**
 * CONTEXT_APPEND_V1 — the ledger behind the held prefix (engine/context-append.ts): what is
 * frozen, what is appended, what forces a fresh prompt, what survives a compaction, a checkpoint
 * rebuild and a mirror hydrate, and when the rail stands down. The wire proof across the five
 * formats is context-append.prefix-replay.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import { assembleInstructionStack, type InstructionLayer } from '../../contract/instruction-stack.js';
import { isRealUserTurn } from '../../contract/injected-user-text.js';
import {
  CONTEXT_FROZEN_KEY,
  CONTEXT_TOLD_KEY,
  CONTEXT_UPDATE_DOOR,
  effortText,
  heldAppendLayerIds,
  holdSessionPrefix,
  reassertSessionContext,
  renderContextPart,
} from '../context-append.js';

const FLAG = 'CONTEXT_APPEND_V1';
const dir = join(tmpdir(), `context-append-${process.pid}`);
afterEach(async () => {
  delete process.env[FLAG];
  await fs.rm(dir, { recursive: true, force: true });
});

/** A journal whose view the test controls: `hidden` uuids are what a compaction summarized away. */
function fakeJournal(opts: { failOn?: (e: NewEntry) => boolean } = {}) {
  const entries: JournalEntry[] = [];
  const hidden = new Set<string>();
  const j = {
    async snapshot() {
      return entries;
    },
    async project() {
      return { messages: entries.filter((e) => e.payload.type === 'user' && !hidden.has(e.uuid)), leaf: null };
    },
    async append(e: NewEntry) {
      if (opts.failOn?.(e)) throw new Error('disk full');
      const full = { ...e, uuid: `u${entries.length + 1}`, seq: entries.length + 1, parentUuid: null, timestamp: 't' } as JournalEntry;
      entries.push(full);
      return full;
    },
  };
  return { j: j as unknown as Journal, entries, hidden };
}

const MEM_A = '<user_memory>\nA\n</user_memory>';
const MEM_B = '<user_memory>\nB\n</user_memory>';
const layersOf = (over: Partial<Record<string, string>> = {}, stable?: string): InstructionLayer[] => [
  { id: 'soul', text: 'You are a careful assistant.', static: true },
  { id: 'operational', text: over.operational ?? 'Keep files tidy.', static: true },
  ...(over.connected_accounts !== undefined ? [{ id: 'connected_accounts' as const, text: over.connected_accounts, static: false }] : []),
  { id: 'nami', text: over.nami ?? MEM_A, static: false, ...(stable !== undefined && { stableText: stable }) },
];

function ctxOf(j: Journal, layers: InstructionLayer[]): HarnessContext<NativeConfig> {
  return {
    taskId: 'task-context-append', sessionId: 's', cwd: '/tmp', model: 'm', signal: new AbortController().signal,
    config: { journal: j, instructionLayers: layers, runtimeConfig: { userId: 'u' } } as unknown as NativeConfig,
  };
}

const sys = (layers: InstructionLayer[], index = '') => {
  const body = assembleInstructionStack(layers, 'native');
  return index ? `${body}\n\n${index}` : body;
};
const updates = (entries: readonly JournalEntry[]) =>
  entries.filter((e) => e.payload.type === 'user' && (e.payload as { injected?: string }).injected === CONTEXT_UPDATE_DOOR);
const textOf = (e: JournalEntry) => (e.payload as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text).join('\n');
const records = (entries: readonly JournalEntry[], key: string) =>
  entries.filter((e) => e.payload.type === 'custom' && (e.payload as { key: string }).key === key);

async function run(j: Journal, layers: InstructionLayer[], opts: { index?: string; sessionStart?: string; model?: string; effort?: string } = {}) {
  return holdSessionPrefix(ctxOf(j, layers), {
    system: sys(layers, opts.index), toolIndex: opts.index ?? '', sessionStart: opts.sessionStart ?? '',
    ...(opts.model !== undefined && { settings: { model: opts.model, effort: opts.effort } }),
  });
}

describe('APPEND parts: held in the prompt, a change told once', () => {
  it('first run: freezes, serves the prompt as built, tells nothing', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    expect(await run(j, layersOf())).toBe(sys(layersOf()));
    expect(records(entries, CONTEXT_FROZEN_KEY)).toHaveLength(1);
    expect(updates(entries)).toHaveLength(0);
  });

  it('a moved memory: the FIRST prompt is served and ONE update carries the new block, by field, one block per part', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf());
    expect(await run(j, layersOf({ nami: MEM_B }))).toBe(sys(layersOf()));
    const [u] = updates(entries);
    expect(u!.principal).toEqual({ kind: 'system' });
    expect(isRealUserTurn(u!)).toBe(false);
    const blocks = (u!.payload as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe(renderContextPart('nami', MEM_B));
    // Stored once: the record holds a hash and the block index, never the text again.
    const told = records(entries, CONTEXT_TOLD_KEY)[0]!.payload as { data: { entryUuid: string; parts: Record<string, { block: number }> } };
    expect(told.data.entryUuid).toBe(u!.uuid);
    expect(told.data.parts.nami!.block).toBe(1);
    expect(JSON.stringify(told.data)).not.toContain('user_memory');
    // The same world tells nothing; the old memory back tells it again (the model was told B).
    await run(j, layersOf({ nami: MEM_B }));
    expect(updates(entries)).toHaveLength(1);
    await run(j, layersOf());
    expect(updates(entries)).toHaveLength(2);
    expect(textOf(updates(entries)[1]!)).toContain(MEM_A);
  });

  it('the clock-only line is never a change: the stable text decides (memory\'s "refreshed N hours ago")', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    const at = (h: number) => layersOf({ nami: `<this_week>\nrefreshed ${h} hours ago\nweek\n</this_week>` }, '<this_week>\nweek\n</this_week>');
    await run(j, at(2));
    expect(await run(j, at(9))).toBe(sys(at(2)));
    expect(updates(entries)).toHaveLength(0);
  });

  it('SessionStart context never enters the system prompt; it is told', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    expect(await run(j, layersOf(), { sessionStart: 'Repo is on branch main.' })).toBe(sys(layersOf()));
    expect(textOf(updates(entries)[0]!)).toContain('<part name="session start">\nRepo is on branch main.\n</part>');
  });

  it('the wide tool index is held at the end of the prompt and its change is told', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf(), { index: 'Tools you can load: gmail_send' });
    expect(await run(j, layersOf(), { index: 'Tools you can load: gmail_send, slack_post' })).toBe(sys(layersOf(), 'Tools you can load: gmail_send'));
    expect(textOf(updates(entries)[0]!)).toContain('Tools you can load: gmail_send, slack_post');
  });
});

describe('REBUILD parts: a change serves a fresh prompt, never an argument with it', () => {
  it('a new account roster: fresh prompt, a new base, and no notice when nothing was told before', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf());
    const two = layersOf({ connected_accounts: 'Two Gmail accounts: work and home.' });
    expect(await run(j, two)).toBe(sys(two));
    expect(records(entries, CONTEXT_FROZEN_KEY)).toHaveLength(2);
    expect(updates(entries)).toHaveLength(0);
    // The new base holds: a later moved memory is appended against IT.
    expect(await run(j, layersOf({ connected_accounts: 'Two Gmail accounts: work and home.', nami: MEM_B }))).toBe(sys(two));
  });

  it('edited workspace instructions after an update was told: fresh prompt plus ONE notice that earlier updates no longer apply', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf());
    await run(j, layersOf({ nami: MEM_B }));
    const edited = layersOf({ nami: MEM_B, operational: 'Never delete files.' });
    expect(await run(j, edited)).toBe(sys(edited));
    expect(updates(entries)).toHaveLength(2);
    expect(textOf(updates(entries)[1]!)).toContain('no longer applies');
    // Said once.
    await run(j, layersOf({ nami: MEM_B, operational: 'Never delete anything.' }));
    expect(updates(entries)).toHaveLength(2);
  });
});

describe('C7: settings', () => {
  it('an effort change is appended, effort only, never a model id; the same effort tells nothing', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    expect(await run(j, layersOf(), { model: 'gpt-6.1-sol', effort: 'medium' })).toBe(sys(layersOf()));
    expect(updates(entries)).toHaveLength(0);
    expect(await run(j, layersOf(), { model: 'gpt-6.1-sol', effort: 'high' })).toBe(sys(layersOf()));
    const text = textOf(updates(entries)[0]!);
    expect(text).toContain(renderContextPart('effort', effortText('high')));
    expect(text).not.toContain('gpt');
    await run(j, layersOf(), { model: 'gpt-6.1-sol', effort: 'high' });
    expect(updates(entries)).toHaveLength(1);
  });

  it('a model change serves the fresh prompt as a new base (caches are per model), nothing appended', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf(), { model: 'gpt-6.1-sol', effort: 'medium' });
    // The product renders the memory, the index and the catalog for the NEW model: served fresh.
    const picked = layersOf({ nami: MEM_B });
    expect(await run(j, picked, { model: 'claude-opus-5-5', effort: 'medium' })).toBe(sys(picked));
    expect(records(entries, CONTEXT_FROZEN_KEY)).toHaveLength(2);
    expect(updates(entries)).toHaveLength(0);
  });
});

describe('the record wins once it exists', () => {
  it('flag rolled back: a frozen session stays held and still told', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf());
    delete process.env[FLAG];
    expect(await run(j, layersOf({ nami: MEM_B }))).toBe(sys(layersOf()));
    expect(updates(entries)).toHaveLength(1);
  });

  it('flag off and never frozen: inert, nothing journaled', async () => {
    const { j, entries } = fakeJournal();
    expect(await run(j, layersOf())).toBeUndefined();
    expect(entries).toHaveLength(0);
  });

  it('a prompt not built from its layers after updates were told: released, served as built, ONE notice', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    await run(j, layersOf());
    await run(j, layersOf({ nami: MEM_B }));
    const layers = layersOf({ nami: MEM_B });
    expect(await holdSessionPrefix(ctxOf(j, layers), { system: `${sys(layers)} extra`, sessionStart: '' })).toBeUndefined();
    const frozen = records(entries, CONTEXT_FROZEN_KEY);
    expect((frozen[frozen.length - 1]!.payload as { data: { released?: boolean } }).data.released).toBe(true);
    expect(textOf(updates(entries)[1]!)).toContain('no longer applies');
    // Released and the flag on: the next built prompt freezes a new base, with no second notice.
    expect(await run(j, layers)).toBe(sys(layers));
    expect(updates(entries)).toHaveLength(2);
  });

  it('a base too big for the mirror: never frozen, inert', async () => {
    process.env[FLAG] = 'true';
    const { j, entries } = fakeJournal();
    expect(await run(j, layersOf({ nami: 'x'.repeat(250_000) }))).toBeUndefined();
    expect(entries).toHaveLength(0);
  });
});

describe('re-review: the refresh notice is paid before the record that needs it', () => {
  it('a release whose record write fails: the notice is already in, it voids the earlier update, and the next run tells current again', async () => {
    process.env[FLAG] = 'true';
    let failRelease = false;
    const { j, entries } = fakeJournal({
      failOn: (e) => failRelease && e.payload.type === 'custom' && (e.payload as { data?: { released?: boolean } }).data?.released === true,
    });
    await run(j, layersOf());
    await run(j, layersOf({ nami: MEM_B }));
    failRelease = true;
    const layers = layersOf({ nami: MEM_B });
    expect(await holdSessionPrefix(ctxOf(j, layers), { system: `${sys(layers)} extra`, sessionStart: '' })).toBeUndefined();
    // The notice landed before the failed write: the debt is paid.
    expect(updates(entries)).toHaveLength(2);
    expect(textOf(updates(entries)[1]!)).toContain('no longer applies');
    failRelease = false;
    // Still held at the first base, but the notice voided the B update: B is told again.
    expect(await run(j, layers)).toBe(sys(layersOf()));
    expect(updates(entries)).toHaveLength(3);
    expect(textOf(updates(entries)[2]!)).toContain(MEM_B);
  });

  it('a rebuild whose base write fails: the notice is in, and the next rebuild does not say it twice', async () => {
    process.env[FLAG] = 'true';
    let failBase = false;
    const { j, entries } = fakeJournal({
      failOn: (e) => failBase && e.payload.type === 'custom' && (e.payload as { key?: string }).key === CONTEXT_FROZEN_KEY,
    });
    await run(j, layersOf());
    await run(j, layersOf({ nami: MEM_B }));
    failBase = true;
    expect(await run(j, layersOf({ nami: MEM_B, operational: 'Never delete files.' }))).toBeUndefined();
    expect(updates(entries)).toHaveLength(2);
    failBase = false;
    const edited = layersOf({ nami: MEM_B, operational: 'Never delete files.' });
    expect(await run(j, edited)).toBe(sys(edited));
    expect(updates(entries)).toHaveLength(2);
  });
});

describe('heldAppendLayerIds (what the continue-path drift warning skips)', () => {
  it('a held session: only the append layers, flag on or off; never frozen or released: nothing', async () => {
    process.env[FLAG] = 'true';
    const { j } = fakeJournal();
    expect(await heldAppendLayerIds(j)).toEqual([]);
    expect(await heldAppendLayerIds(undefined)).toEqual([]);
    await run(j, layersOf());
    const skip = await heldAppendLayerIds(j);
    expect([...skip].sort()).toEqual(['nami', 'nami_wiki', 'situation', 'tool_search']);
    delete process.env[FLAG]; // the record wins: a held session stays held with the flag off
    expect(await heldAppendLayerIds(j)).toEqual(skip);
    process.env[FLAG] = 'true';
    const layers = layersOf();
    await holdSessionPrefix(ctxOf(j, layers), { system: `${sys(layers)} extra`, sessionStart: '' }); // stands down
    expect(await heldAppendLayerIds(j)).toEqual([]);
  });

  it('an unreadable journal skips nothing and never throws', async () => {
    const broken = { snapshot: async () => { throw new Error('gone'); } } as unknown as Journal;
    expect(await heldAppendLayerIds(broken)).toEqual([]);
  });
});

describe('reassertSessionContext', () => {
  it('copies, byte for byte, the block of an update a compaction summarized away; nothing while it is in view; flag or no flag', async () => {
    process.env[FLAG] = 'true';
    const { j, entries, hidden } = fakeJournal();
    await run(j, layersOf());
    await run(j, layersOf({ nami: MEM_B }));
    delete process.env[FLAG];
    await reassertSessionContext(j, ctxOf(j, layersOf()));
    expect(updates(entries)).toHaveLength(1);
    hidden.add(updates(entries)[0]!.uuid);
    await reassertSessionContext(j, ctxOf(j, layersOf()));
    expect(updates(entries)).toHaveLength(2);
    const blocks = (u: JournalEntry) => (u.payload as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text);
    expect(blocks(updates(entries)[1]!)).toEqual(blocks(updates(entries)[0]!));
  });
});

// ── the real journal: the projection, a checkpoint rebuild, a mirror hydrate ──

const BASE: Omit<NewEntry, 'payload'> = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'system' }, timestamp: '',
};
const text = (t: string) => [{ type: 'text', text: t } as never];
let opened = 0;
function journalAt(path: string, opts: { checkpoint?: boolean; mirror?: InMemorySessionStore; hydrate?: boolean } = {}): Journal {
  const tag = `j${++opened}`;
  let n = 0;
  return new Journal({
    taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path), mirror: opts.mirror ?? new InMemorySessionStore(),
    clock: { now: () => '2026-10-02T00:00:00.000Z', uuid: () => `${tag}-${n++}` },
    ...(opts.checkpoint ? { checkpoint: true } : {}),
    ...(opts.hydrate ? { hydrateFromMirror: true } : {}),
  });
}
const ask = (j: Journal, t: string) => j.append({ ...BASE, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: text(t) } });
const answer = (j: Journal, t: string) => j.append({ ...BASE, payload: { type: 'assistant', blocks: text(t) } });

describe('on the real journal', () => {
  it('a resumed approval: the update lands between the paused call and its result, and the projection keeps the result on its call', async () => {
    process.env[FLAG] = 'true';
    await fs.mkdir(dir, { recursive: true });
    const j = journalAt(join(dir, 'pause.jsonl'));
    await ask(j, 'send the report');
    await run(j, layersOf());
    await answer(j, 'sending');
    await j.append({ ...BASE, payload: { type: 'tool_use', toolUseId: 'tu-1', name: 'Send', input: {} } });
    // The pause ended the run; the continuation's run opens with a moved memory, then the result lands.
    await run(j, layersOf({ nami: MEM_B }));
    await j.append({ ...BASE, payload: { type: 'tool_result', toolUseId: 'tu-1', blocks: text('sent') } });
    const types = (await j.project()).messages.map((m) => (m.payload.type === 'user' && (m.payload as { injected?: string }).injected ? 'update' : m.payload.type));
    expect(types.slice(-3)).toEqual(['tool_use', 'tool_result', 'update']);
  });

  it('rebuilt from a checkpoint (JOURNAL_CHECKPOINT_V1): the base survives, and an update the cut dropped is told again', async () => {
    process.env[FLAG] = 'true';
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, 'checkpoint.jsonl');
    const j1 = journalAt(path, { checkpoint: true });
    const first = await ask(j1, 'the ask');
    await run(j1, layersOf());
    await run(j1, layersOf({ nami: MEM_B }));
    let kept = first;
    for (let r = 0; r < 24; r++) {
      const a = await ask(j1, `ask ${r}`);
      await answer(j1, `answer ${r}`);
      if (r === 23) kept = a;
    }
    const summary = await ask(j1, 'SUMMARY');
    await j1.compact({ summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: kept.uuid, trigger: 'auto', preTokens: 1000, postTokens: 100, base: BASE });
    // A fresh process: reads back to the checkpoint only.
    const j2 = journalAt(path, { checkpoint: true });
    expect(await run(j2, layersOf({ nami: MEM_B }))).toBe(sys(layersOf()));
    const all = await j2.snapshot();
    expect(records(all, CONTEXT_FROZEN_KEY)).toHaveLength(1);
    expect(updates(all)).toHaveLength(2);
  });

  it('hydrated from the mirror on a fresh machine: the base and the visible update are there, nothing is told twice', async () => {
    process.env[FLAG] = 'true';
    await fs.mkdir(dir, { recursive: true });
    const mirror = new InMemorySessionStore();
    const prior = journalAt(join(dir, 'prior.jsonl'), { mirror });
    await ask(prior, 'the ask');
    await run(prior, layersOf());
    await run(prior, layersOf({ nami: MEM_B }));
    await prior.flushMirror();
    const fresh = journalAt(join(dir, 'fresh.jsonl'), { mirror, hydrate: true });
    expect(await run(fresh, layersOf({ nami: MEM_B }))).toBe(sys(layersOf()));
    expect(updates(await fresh.snapshot())).toHaveLength(1);
  });
});

describe('renderContextPart', () => {
  it('plain words: no em or en dash, never names the provider; an emptied part says so', () => {
    const text = renderContextPart('nami', '');
    expect(text).toBe('<part name="memory">\nThis part no longer applies.\n</part>');
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/claude/i);
  });
});
