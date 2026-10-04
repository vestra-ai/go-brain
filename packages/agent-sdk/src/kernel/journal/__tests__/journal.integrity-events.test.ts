import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `integrity-events-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '', principal: { kind: 'system' } as const };
const userMsg = (text: string): NewEntry => ({
  ...base,
  principal: { kind: 'user', userId: 'u' },
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});
const goodLine = (seq: number): string => JSON.stringify({
  uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'system', event: 'x' },
} satisfies JournalEntry);

const make = (taskId: string, onIntegrityEvent?: (e: JournalIntegrityEvent) => void) => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  ...(onIntegrityEvent ? { onIntegrityEvent } : {}),
});

describe('Journal integrity events (P2.0 review fix)', () => {
  it('forwards a quarantined line as ONE journal_line_quarantined event with salvage fields', async () => {
    await fs.mkdir(dir, { recursive: true });
    // Shape-broken (parseable JSON, missing required header fields) mid-file line
    // whose payload still carries identifying fields — the HITL-visibility case.
    const brokenInteraction = JSON.stringify({
      payload: { type: 'interaction', interactionId: 'i-42', toolUseId: 'tu-7', resolved: false },
    });
    await fs.writeFile(
      join(dir, 't-salvage.jsonl'),
      goodLine(0) + '\n' + brokenInteraction + '\n' + goodLine(1) + '\n',
      'utf8',
    );
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-salvage', (e) => events.push(e));
    await j.project();
    await j.project(); // projection cache repopulates; either way the store dedups
    const quarantined = events.filter((e) => e.kind === 'journal_line_quarantined');
    expect(quarantined).toEqual([
      expect.objectContaining({
        kind: 'journal_line_quarantined',
        lineNo: 2,
        reason: 'shape',
        payloadType: 'interaction',
        interactionId: 'i-42',
        toolUseId: 'tu-7',
      }),
    ]); // exactly once — deduped at the store
  });

  it('a parse-broken mid-file line gets NO salvage (unparseable), but still one event', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 't-parse.jsonl'),
      goodLine(0) + '\n' + '{"torn' + '\n' + goodLine(1) + '\n',
      'utf8',
    );
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-parse', (e) => events.push(e));
    await j.project();
    const quarantined = events.filter((e) => e.kind === 'journal_line_quarantined');
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).not.toHaveProperty('payloadType');
  });

  it('falls back to a loud [JOURNAL_INTEGRITY] console.warn when onIntegrityEvent is absent', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 't-fallback.jsonl'),
      goodLine(0) + '\n' + '{"not":"an entry"}\n' + goodLine(1) + '\n',
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const j = make('t-fallback'); // NO onIntegrityEvent dep
      await j.project();
      const integrityWarns = warn.mock.calls.filter((c) => String(c[0]).startsWith('[JOURNAL_INTEGRITY]'));
      expect(integrityWarns.length).toBeGreaterThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * R68 — the journal is the biggest writer on the box, so a full disk fails HERE
   * first. The rejection alone reads as one more failed turn; the event carries the
   * errno, which is what lets the runner latch "out of space" and the server act on
   * it. The append still rejects: the entry never became durable.
   */
  it('a full disk is reported as journal_append_failed carrying the errno, and still rejects', async () => {
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-enospc', (e) => events.push(e));
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    // The STORE is what runs out of room — patched here rather than filling a real
    // disk, which is the one thing a unit test cannot do.
    const jsonl = (j as unknown as { deps: { jsonl: { append: (e: JournalEntry) => Promise<void> } } }).deps.jsonl;
    jsonl.append = async () => { throw enospc; };

    await expect(j.append(userMsg('this one has nowhere to go'))).rejects.toThrow('ENOSPC');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'journal_append_failed', code: 'ENOSPC' }),
    ]);
    // The whole point of the code: the runner's latch discriminates on it, never on
    // the message (apps/sandbox services/tidy/disk-full.ts noteWriteError).
    expect((events[0] as { code?: string }).code).toBe('ENOSPC');
  });

  it('an append that fails for a reason with no errno still reports, with no code', async () => {
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-plainfail', (e) => events.push(e));
    const jsonl = (j as unknown as { deps: { jsonl: { append: (e: JournalEntry) => Promise<void> } } }).deps.jsonl;
    jsonl.append = async () => { throw new Error('something else entirely'); };

    await expect(j.append(userMsg('nope'))).rejects.toThrow('something else entirely');
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('code');
  });

  it('healthy journals emit zero integrity events', async () => {
    const events: JournalIntegrityEvent[] = [];
    const j = make('t-healthy', (e) => events.push(e));
    await j.append(userMsg('hello'));
    await j.project();
    expect(events).toEqual([]);
  });
});
