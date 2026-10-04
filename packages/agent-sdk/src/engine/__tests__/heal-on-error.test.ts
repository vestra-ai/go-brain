/**
 * L5 (#3332 site a) — a failed post-throw heal is an integrity event, never an empty catch,
 * and never a terminal error for the person (the one-shot history heal, #3946, still gets its
 * turn at an orphan the failed heal left behind).
 */
import { describe, it, expect, vi } from 'vitest';
import { healOnError } from '../heal-on-error.js';
import type { Journal } from '../../kernel/index.js';

const journalWith = (heal: () => Promise<unknown>) => {
  const reportIntegrity = vi.fn();
  const journal = { healOrphanedToolUse: vi.fn(heal), reportIntegrity } as unknown as Journal;
  return { journal, reportIntegrity };
};

describe('healOnError', () => {
  it('a heal that fails reports heal_failed through the journal integrity seam, with the errno code, and never throws', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const { journal, reportIntegrity } = journalWith(async () => { throw enospc; });
    // Mutation: restore the empty catch → no report, and the orphan dies in silence.
    await expect(healOnError(journal, true)).resolves.toBeUndefined();
    expect(reportIntegrity).toHaveBeenCalledWith({
      kind: 'heal_failed', interrupted: true, code: 'ENOSPC', detail: 'ENOSPC: no space left on device',
    });
  });

  it('a non-Error failure without a code still reports, with no code key', async () => {
    const { journal, reportIntegrity } = journalWith(async () => { throw 'gone'; });
    await healOnError(journal, false);
    expect(reportIntegrity).toHaveBeenCalledWith({ kind: 'heal_failed', interrupted: false, detail: 'gone' });
  });

  it('a heal that succeeds reports nothing; no journal is a no-op', async () => {
    const { journal, reportIntegrity } = journalWith(async () => undefined);
    await healOnError(journal, false);
    expect(journal.healOrphanedToolUse).toHaveBeenCalledWith(false);
    expect(reportIntegrity).not.toHaveBeenCalled();
    await expect(healOnError(undefined, false)).resolves.toBeUndefined();
  });
});
