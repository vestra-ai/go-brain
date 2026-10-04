import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, liveSuspendedToolUseIds, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `anchor-loss-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '', principal: { kind: 'system' } as const };
const userMsg = (text: string): NewEntry => ({
  ...base,
  principal: { kind: 'user', userId: 'u' },
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});
const assistantMsg = (text: string): NewEntry => ({
  ...base,
  principal: { kind: 'agent', agentId: 'g' },
  payload: { type: 'assistant', blocks: [{ type: 'text', text } as never] },
});

const make = (taskId: string, onIntegrityEvent?: (e: JournalIntegrityEvent) => void) => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  ...(onIntegrityEvent ? { onIntegrityEvent } : {}),
});

/** Build a compacted journal, then corrupt the SUMMARY line on disk so the P2.0
 *  quarantine drops it at hydration — the compact_boundary now references a
 *  summaryUuid that no readable entry carries (the anchor-loss brick fixture). */
async function writeJournalWithQuarantinedSummary(taskId: string): Promise<void> {
  const j1 = make(taskId);
  await j1.append(userMsg('m1-old'));
  const keep = await j1.append(userMsg('m2-kept'));
  const summary = await j1.append(assistantMsg('THE-SUMMARY'));
  await j1.compact({
    base, summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid,
    trigger: 'auto', preTokens: 100, postTokens: 10,
  });
  const p = join(dir, `${taskId}.jsonl`);
  const lines = (await fs.readFile(p, 'utf8')).split('\n');
  const idx = lines.findIndex((l) => l.includes('THE-SUMMARY'));
  expect(idx).toBeGreaterThanOrEqual(0);
  lines[idx] = '{"torn'; // parse-fails → quarantined at read → summary anchor is GONE
  await fs.writeFile(p, lines.join('\n'), 'utf8');
}

describe('Journal anchor-loss degrade (P2.0)', () => {
  it('a lost compaction anchor degrades to the pre-compaction projection with a loud event, not a throw', async () => {
    await writeJournalWithQuarantinedSummary('t-loss');
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-loss', (e) => events.push(e));
    const state = await j.project();               // TODAY: throws 'compaction summaryUuid not found'
    expect(state.messages.length).toBeGreaterThan(0); // degraded but alive
    expect(state.messages.map((m) => (m.payload as { blocks: { text: string }[] }).blocks[0]?.text))
      .toEqual(['m1-old', 'm2-kept']);             // the pre-compaction view
    // The corrupted line ALSO reports as a quarantine event (same channel); the
    // anchor loss itself must be exactly one loud event.
    expect(events.filter((e) => e.kind === 'compaction_anchor_missing'))
      .toEqual([expect.objectContaining({ kind: 'compaction_anchor_missing' })]);
  });

  it('a degraded projection is NOT cached — recompute next round (the anchor may be restored)', async () => {
    await writeJournalWithQuarantinedSummary('t-nocache');
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-nocache', (e) => events.push(e));
    await j.project();
    await j.project(); // same leaf — a healthy projection would hit the cache
    // Anchor loss re-reports on BOTH projections (recomputed each time); the
    // quarantine event is store-deduped and appears only once.
    expect(events.filter((e) => e.kind === 'compaction_anchor_missing')).toHaveLength(2);
  });

  it('liveSuspendedToolUseIds and reconcileInteractions survive the same loss', async () => {
    await writeJournalWithQuarantinedSummary('t-paths');
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-paths', (e) => events.push(e));
    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    expect(() => liveSuspendedToolUseIds(all)).not.toThrow();      // the :113 path
    await expect(j.reconcileInteractions(async () => null)).resolves.toEqual({
      reExecute: [], forwardResume: [],
    });                                                             // the :422 path
    expect(events.filter((e) => e.kind === 'compaction_anchor_missing'))
      .toEqual([expect.objectContaining({ kind: 'compaction_anchor_missing' })]);
  });
});
