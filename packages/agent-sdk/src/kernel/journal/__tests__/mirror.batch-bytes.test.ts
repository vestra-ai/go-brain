/**
 * Triage 2026-08-19 item 8 — the mirror flushed 200-row windows with NO byte budget in
 * front of Fastify's 1 MiB default body limit: an oversize window 413s, flushMirror keeps
 * the failed window at the HEAD, and the SAME bytes are re-POSTed every turn boundary
 * forever (prod: 14× "Request body is too large" on the same stuck batch). Every later
 * entry for that task is blocked behind it until mirror_overflow_dropped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { sequentialClock } from '../clock.js';
import { validateJournalEntry } from '../validate-entry.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';
import type { SessionStore } from '../session-store.js';

const dir = join(tmpdir(), `mirror-bytes-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

type RecordingMirror = SessionStore & { batches: Array<{ rows: number; bytes: number }> };
function recordingMirror(): RecordingMirror {
  const batches: Array<{ rows: number; bytes: number }> = [];
  return {
    batches,
    appendBatch: async (_t, entries) => { batches.push({ rows: entries.length, bytes: JSON.stringify(entries).length }); },
    load: async () => null,
    listTasks: async () => [],
  };
}
const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' as const }, timestamp: '' };
const sys = (text: string): NewEntry => ({ ...base, payload: { type: 'system', event: text } });
const toolResult = (text: string): NewEntry => ({
  ...base,
  payload: { type: 'tool_result', toolUseId: 'tu1', isError: false, blocks: [{ type: 'text', text }] },
});
const toolUse = (arg: string): NewEntry => ({
  ...base,
  payload: { type: 'tool_use', toolUseId: 'tu2', name: 'Write', input: { content: arg } },
});

describe('mirror windows are byte-budgeted', () => {
  it('splits a flush so no single POST exceeds MIRROR_BATCH_BYTES', async () => {
    const mirror = recordingMirror();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'a.jsonl')), mirror, clock: sequentialClock('T') });
    // 30 entries × ~100KB = ~3MB: would be ONE 200-row window before; must become several POSTs.
    for (let i = 0; i < 30; i++) await j.append(sys('x'.repeat(100 * 1024)));
    // drain fully (flushMirror caps windows per call — loop until empty)
    for (let k = 0; k < 20 && mirror.batches.reduce((n, b) => n + b.rows, 0) < 30; k++) await j.flushMirror();
    expect(mirror.batches.reduce((n, b) => n + b.rows, 0)).toBe(30);
    for (const b of mirror.batches) expect(b.bytes).toBeLessThanOrEqual(768 * 1024 + 4096); // + envelope slack
    expect(mirror.batches.length).toBeGreaterThan(1);
  });

  it('still caps rows at 200 per window for small entries', async () => {
    const mirror = recordingMirror();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'b.jsonl')), mirror, clock: sequentialClock('T') });
    for (let i = 0; i < 250; i++) await j.append(sys('tiny'));
    await j.flushMirror();
    expect(mirror.batches[0].rows).toBe(200);
  });

  it('an oversize tool_result entry is CLAMPED before send (slot stays answered), never sent raw', async () => {
    const mirror = recordingMirror();
    const sent: unknown[] = [];
    mirror.appendBatch = async (_t, entries) => { sent.push(...entries); mirror.batches.push({ rows: entries.length, bytes: JSON.stringify(entries).length }); };
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'c.jsonl')), mirror, clock: sequentialClock('T') });
    await j.append(toolResult('y'.repeat(2 * 1024 * 1024))); // 2MB single entry — would 413 forever
    await j.flushMirror();
    expect(mirror.batches).toHaveLength(1);
    expect(mirror.batches[0].bytes).toBeLessThan(300 * 1024);
    const e = sent[0] as { payload: { type: string; toolUseId: string; blocks: Array<{ type: string; text: string }> } };
    expect(e.payload.type).toBe('tool_result');
    expect(e.payload.toolUseId).toBe('tu1');
    expect(e.payload.blocks).toHaveLength(1);
    expect(e.payload.blocks[0].text).toMatch(/omitted|truncated/i);
  });

  it('the runner clamps everything the SERVER would clamp (its cap is the ceiling)', async () => {
    // The server clamps at MAX_ENTRY_BYTES = 250_000 (kernel-journal-mirror-routes.handler.ts).
    // A runner cap above that leaves a band where an entry ships whole and is clamped on
    // arrival anyway — the same loss, with none of the control over what survives.
    const mirror = recordingMirror();
    const sent: JournalEntry[] = [];
    mirror.appendBatch = async (_t, entries) => { sent.push(...entries); };
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'e.jsonl')), mirror, clock: sequentialClock('T') });
    await j.append(toolResult('q'.repeat(255_000))); // inside the old 256 KiB cap, over the server's
    await j.flushMirror();
    expect(JSON.stringify(sent[0]).length).toBeLessThan(250_000);
  });

  it('an oversize NON-tool_result clamps to a payload every consumer can read', async () => {
    // The clamped payload must not keep its original `type` with the bulky fields dropped:
    // validateJournalEntry gates only `payload.type`, never the variant's internals, so such
    // a stub passes hydrate and breaks whoever reads `name`/`input`/`toolUseId` one layer
    // later (the 2026-07-15 computeSuspendedToolUseIds crash on "the mirror's legacy
    // oversize stub"). Degrading to `system` — one required field, and it is filled — is
    // what keeps the row both valid and safe.
    const mirror = recordingMirror();
    const sent: JournalEntry[] = [];
    mirror.appendBatch = async (_t, entries) => { sent.push(...entries); };
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'f.jsonl')), mirror, clock: sequentialClock('T') });
    await j.append(toolUse('w'.repeat(300 * 1024)));
    await j.flushMirror();

    const clamped = sent[0];
    expect(clamped.payload.type).toBe('system');
    expect(clamped.payload).not.toHaveProperty('toolUseId');
    expect(clamped.payload).not.toHaveProperty('input');
    expect(validateJournalEntry(clamped).ok).toBe(true);
    // The envelope survives whole — that is what keeps the parentUuid chain walkable.
    expect(clamped.uuid).toBe('entry-0');
    expect(clamped.seq).toBe(0);
  });

  it('the local JSONL keeps the FULL entry (clamp is mirror-only)', async () => {
    const mirror = recordingMirror();
    const path = join(dir, 'd.jsonl');
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path), mirror, clock: sequentialClock('T') });
    await j.append(toolResult('z'.repeat(2 * 1024 * 1024)));
    await j.flushMirror();
    const raw = await fs.readFile(path, 'utf8');
    expect(raw.length).toBeGreaterThan(2 * 1024 * 1024);
  });
});
