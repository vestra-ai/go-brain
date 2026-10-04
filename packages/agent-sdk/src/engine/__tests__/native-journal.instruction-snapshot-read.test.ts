/**
 * readInstructionSnapshot — the continue-path baseline read (CACHE_TIERING_V1).
 *
 * The fresh session journals ONE `custom`/`instruction_snapshot` entry
 * (appendInstructionSnapshot); a continue reads it back to assert the rebuilt
 * session-frozen layers against the original hashes. Contracts: first-match
 * scan, undefined on legacy journals without one, and never-throws on a broken
 * journal.
 */

import { describe, it, expect } from 'vitest';
import { readInstructionSnapshot } from '../native-journal.js';
import type { InstructionSnapshot } from '../../contract/instruction-stack.js';
import type { Journal } from '../../kernel/journal/journal.js';

const SNAPSHOT: InstructionSnapshot = {
  harnessId: 'native',
  layers: [
    { id: 'soul', static: true, hash: 'aaaaaaaaaaaa' },
    { id: 'situation', static: false, hash: 'bbbbbbbbbbbb' },
    { id: 'nami', static: false, hash: 'cccccccccccc' },
  ],
  assembledHash: 'dddddddddddd',
};

/** Minimal fake journal over a fixed entry list. */
function fakeJournal(payloads: Array<Record<string, unknown>>): Journal {
  return {
    async *read() {
      for (const payload of payloads) yield { payload } as never;
    },
  } as unknown as Journal;
}

describe('readInstructionSnapshot', () => {
  it('returns the snapshot when it heads the journal (the fresh-session shape)', async () => {
    const j = fakeJournal([
      { type: 'custom', key: 'instruction_snapshot', data: SNAPSHOT },
      { type: 'user', text: 'hello' },
    ]);
    expect(await readInstructionSnapshot(j)).toEqual(SNAPSHOT);
  });

  it('finds it behind earlier entries too (teammate_def-headed journals)', async () => {
    const j = fakeJournal([
      { type: 'teammate_def', name: 'prober' },
      { type: 'custom', key: 'instruction_snapshot', data: SNAPSHOT },
    ]);
    expect(await readInstructionSnapshot(j)).toEqual(SNAPSHOT);
  });

  it('ignores OTHER custom entries and returns undefined on a legacy journal without one', async () => {
    const j = fakeJournal([
      { type: 'custom', key: 'something_else', data: { nope: true } },
      { type: 'user', text: 'hello' },
    ]);
    expect(await readInstructionSnapshot(j)).toBeUndefined();
  });

  it('is total: undefined journal and a throwing journal both resolve undefined', async () => {
    expect(await readInstructionSnapshot(undefined)).toBeUndefined();
    const broken = {
      // eslint-disable-next-line require-yield
      async *read(): AsyncIterable<never> {
        throw new Error('corrupt tail');
      },
    } as unknown as Journal;
    expect(await readInstructionSnapshot(broken)).toBeUndefined();
  });
});
