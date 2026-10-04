import { JOURNAL_PAYLOAD_TYPES, type JournalEntry } from '../../contract/journal.js';

/**
 * P2.0 — total-shape runtime validation for hydrated journal lines, closing the
 * unchecked `JSON.parse(line) as JournalEntry` cast in jsonl-store.ts. Style is
 * contract/validate-output.ts (zero-dep, `$`-path error accumulator, never throws)
 * — NO ajv, NO zod in the kernel.
 */
export type EntryValidation =
  | { ok: true; entry: JournalEntry }
  | { ok: false; errors: string[] };

/**
 * The journal schema version this build reads and writes. An entry with NO `v`
 * field is legacy v1. Unknown FUTURE versions (entry.v > CURRENT) are invalid —
 * a downgraded process must not misread a newer schema.
 */
export const CURRENT_JOURNAL_VERSION = 1;

const PRINCIPAL_KINDS = ['user', 'agent', 'system'] as const;

const REQUIRED_STRING_FIELDS = ['uuid', 'taskId', 'rootTaskId', 'workspaceId', 'agentId', 'timestamp'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Total-shape check. Accumulates every error (never fails fast, never throws). */
export function validateJournalEntry(raw: unknown): EntryValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['$: entry must be an object'] };
  }
  const errors: string[] = [];

  // Version first: a FUTURE version means the rest of the shape may be unknowable
  // to this build, so it must lead the error list.
  if (raw.v !== undefined) {
    if (typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) {
      errors.push('$.v: journal schema version must be a positive integer');
    } else if (raw.v > CURRENT_JOURNAL_VERSION) {
      errors.push(`$.v: unknown FUTURE journal version ${raw.v} (this build reads <= ${CURRENT_JOURNAL_VERSION})`);
    }
  }

  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof raw[f] !== 'string') errors.push(`$.${f}: required string field missing or wrong type`);
  }
  if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) {
    errors.push('$.seq: required finite number');
  }
  if (raw.parentUuid !== null && typeof raw.parentUuid !== 'string') {
    errors.push('$.parentUuid: must be a string or null');
  }
  if (!isPlainObject(raw.principal) || !(PRINCIPAL_KINDS as readonly unknown[]).includes(raw.principal.kind)) {
    errors.push(`$.principal.kind: must be one of ${PRINCIPAL_KINDS.join('|')}`);
  }
  if (!isPlainObject(raw.payload) || typeof raw.payload.type !== 'string') {
    errors.push('$.payload: must be an object with a string `type`');
  } else if (!(JOURNAL_PAYLOAD_TYPES as readonly string[]).includes(raw.payload.type)) {
    errors.push(`$.payload.type: unknown payload type "${raw.payload.type}"`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: raw as unknown as JournalEntry };
}

/**
 * Migration hook: raise an older entry to CURRENT. v1→v1 is identity today; the
 * chain exists so an in-place sandbox upgrade reading an old journal has a seam,
 * not a cast.
 */
export function migrateEntry(entry: JournalEntry): JournalEntry {
  return entry;
}
