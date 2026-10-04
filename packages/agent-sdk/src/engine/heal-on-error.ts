/**
 * heal-on-error — the post-throw journal heal, and what happens when the heal itself fails
 * (harness to nine L5, harvest of #3332 site (a)).
 *
 * After a thrown turn the harness seals every orphan tool_use (one with no matching
 * tool_result) with a synthetic error result, via Journal.healOrphanedToolUse(interrupted).
 * `interrupted` scopes the seal text: a user-abort gets "Interrupted by user.", a true
 * crash gets a neutral empty-blocks result (see Journal.synthesizedErrorResult). No-op
 * when the journal is absent.
 *
 * A heal that FAILS used to vanish in an empty catch. It now reports `heal_failed` through
 * the journal's own integrity seam (the [JOURNAL_INTEGRITY] error line the driver ships to
 * log_events, the channel every other journal-damage kind uses), carrying the errno `code`
 * so an out-of-space disk is named by the disk-full rail. It is NOT a terminal error for the
 * person: an orphan it may have left is healed on the next request that the provider
 * rejects (the one-shot history heal, engine/history-heal.ts, #3946), and only when that
 * heal is refused too does the turn fail visibly (with its own error_events row). The
 * never-throw contract holds: nothing escapes run().
 *
 * Extracted from NativeHarness.healOnError (native-harness.ts only ratchets down).
 */
import type { Journal } from '../kernel/index.js';

export async function healOnError(journal: Journal | undefined, interrupted: boolean): Promise<void> {
  if (!journal) return;
  try {
    await journal.healOrphanedToolUse(interrupted);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    journal.reportIntegrity({
      kind: 'heal_failed',
      interrupted,
      ...(typeof code === 'string' ? { code } : {}),
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
