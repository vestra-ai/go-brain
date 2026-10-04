/**
 * L5 (#3332 site a) — inside the real loop: a turn that throws, whose post-throw heal ALSO
 * fails, still ends with exactly one terminal turn_end, and the heal failure reaches the
 * journal's integrity seam (the driver's [JOURNAL_INTEGRITY] line) instead of an empty
 * catch. No terminal error is added for the person: the model error the turn already
 * ended with is what they see, and the one-shot history heal (#3946) gets its turn next.
 *
 * Real timers, a real tmp Journal, a scripted transport that fails the model call.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent } from '../transport.js';
import { Journal, type JournalIntegrityEvent } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

/** Engine drives get an explicit ceiling at birth. */
const DRIVE_TIMEOUT_MS = 20_000;

class FailingTransport extends FakeTransport {
  constructor() { super([]); }
  override callModel(): StreamEvent[] { throw new Error('upstream exploded'); }
}

describe('NativeHarness × a failed post-throw heal', () => {
  it('one terminal turn_end, the heal failure on the integrity seam, and nothing escapes run()', async () => {
    const events: JournalIntegrityEvent[] = [];
    const journal = new Journal({
      taskId: 't-heal', workspaceId: 'w',
      jsonl: new JsonlStore(join(tmpdir(), `heal-failed-${process.pid}-${Math.random().toString(36).slice(2)}`, 't-heal.jsonl')),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2024-01-01T00:00:00.000Z'),
      onIntegrityEvent: (e) => events.push(e),
    });
    const heal = vi.spyOn(journal, 'healOrphanedToolUse').mockRejectedValue(new Error('EIO: append failed'));
    const cfg = {
      onAttached: () => {}, maxTurns: 5, transport: new FailingTransport(), journal,
      retry: { backoffMs: 1 },
      toolHost: { buildTools: async () => ({ tools: [], onAuthHalt: async () => {} }) },
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = { taskId: 't-heal', sessionId: 's', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg };
    const out: HarnessEvent[] = [];
    const turns = (async function* () { yield { text: 'go' } as UserTurn; })();

    for await (const ev of new NativeHarness().run(turns, ctx)) out.push(ev);

    const ends = out.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).not.toBe('completed');
    expect(heal).toHaveBeenCalled();
    // Mutation: an empty catch in the heal → this stays empty.
    expect(events.filter((e) => e.kind === 'heal_failed')).toEqual([
      expect.objectContaining({ kind: 'heal_failed', detail: 'EIO: append failed' }),
    ]);
  }, DRIVE_TIMEOUT_MS);
});
