/**
 * fixture.ts — the on-disk shape of a replay fixture.
 *
 * A fixture is JSONL. Almost every line is a REAL journal entry (a redacted row of
 * `kernel_journal_mirror`, exactly as the engine wrote it — the harvest script never
 * invents or reorders entries). The one other line kind is a REPLAY DIRECTIVE:
 * `{"replay": {...}}` — something the provider did that the journal does not record,
 * which the replay must re-enact at that point. Today the only directive is a
 * `stream_error` fault: an in-stream SSE `event: error` frame the model call must
 * throw instead of serving the next recorded round. A retryable frame writes NOTHING
 * to the journal (startStreamWithRetry re-issues before the first event commits), so
 * without the directive a recording could not tell a clean round from a retried one.
 *
 * Directives are positional: a fault sits immediately before the journal entry whose
 * round it precedes, and attaches to the next assistant round (see groupRounds).
 */
import type { JournalEntry } from '../../contract/journal.js';
import { validateJournalEntry } from '../../kernel/journal/validate-entry.js';

/** An in-stream provider error frame — the SSE `event: error` body the SDK wraps in APIError. */
export interface ReplayFault {
  kind: 'stream_error';
  error: { type: string; message?: string };
}

export interface ReplayDirective {
  replay: ReplayFault;
}

/** A directive with its position: the index (into `entries`) of the entry that follows it. */
export interface PlacedFault {
  beforeEntryIndex: number;
  fault: ReplayFault;
}

export interface ParsedFixture {
  entries: JournalEntry[];
  directives: PlacedFault[];
}

export function isReplayDirective(v: unknown): v is ReplayDirective {
  if (typeof v !== 'object' || v === null) return false;
  const r = (v as { replay?: unknown }).replay;
  if (typeof r !== 'object' || r === null) return false;
  const f = r as { kind?: unknown; error?: { type?: unknown } };
  return f.kind === 'stream_error' && typeof f.error === 'object' && f.error !== null && typeof f.error.type === 'string';
}

/** Parse fixture JSONL. Every non-blank line must be a valid journal entry or a directive. */
export function parseFixture(text: string): ParsedFixture {
  const entries: JournalEntry[] = [];
  const directives: PlacedFault[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`replay fixture line ${i + 1}: not JSON`);
    }
    if (isReplayDirective(parsed)) {
      directives.push({ beforeEntryIndex: entries.length, fault: parsed.replay });
      continue;
    }
    const v = validateJournalEntry(parsed);
    if (!v.ok) throw new Error(`replay fixture line ${i + 1}: neither a journal entry nor a directive (${v.errors.join('; ')})`);
    entries.push(v.entry);
  }
  return { entries, directives };
}
