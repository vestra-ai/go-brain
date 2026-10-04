/**
 * Raw failures → journal integrity events.
 *
 * One job, and it is the reason this is a module rather than three helpers at the
 * bottom of journal.ts: something went wrong at the STORE layer (a line that would not
 * parse, an append that rejected) and the driver has to be told WHAT, in a shape it can
 * act on rather than a string it has to read. Every function here is pure and takes the
 * raw thing — an unknown error, a bad-line report — and answers the event.
 *
 * `JournalIntegrityEvent` is imported as a TYPE from journal.ts, which imports these
 * functions back: erased at compile time, so there is no module cycle at runtime.
 */
import type { JsonlBadLineInfo } from './jsonl-store.js';
import type { JournalIntegrityEvent } from './journal.js';

/**
 * The errno, when there is one — `{ code }` or nothing, so the field is absent
 * rather than undefined on an error that carries no code (R68). Read off `code` and
 * NEVER off the message: a wrapped or localized errno keeps the code and loses the
 * words, and a message that merely mentions space is not an ENOSPC.
 */
export function errCode(err: unknown): { code?: string } {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? { code } : {};
}

/** One line of WHY for the log, without the stack. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * P2.0 review fix — map a store quarantine report to its integrity event,
 * salvaging identifying payload fields when the bad line is parseable JSON
 * (shape/version failures are; parse failures get no salvage).
 */
export function quarantineEvent(info: JsonlBadLineInfo): JournalIntegrityEvent {
  const e: Extract<JournalIntegrityEvent, { kind: 'journal_line_quarantined' }> = {
    kind: 'journal_line_quarantined',
    lineNo: info.lineNo,
    reason: info.reason,
  };
  if (info.reason === 'parse' || info.reason === 'torn') return e; // not JSON: nothing to salvage
  try {
    const parsed = JSON.parse(info.line) as Record<string, unknown>;
    const payload =
      typeof parsed.payload === 'object' && parsed.payload !== null && !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : undefined;
    if (typeof payload?.type === 'string') e.payloadType = payload.type;
    if (typeof payload?.toolUseId === 'string') e.toolUseId = payload.toolUseId;
    if (typeof payload?.interactionId === 'string') e.interactionId = payload.interactionId;
  } catch {
    // no salvage — the event still reports lineNo + reason
  }
  return e;
}
