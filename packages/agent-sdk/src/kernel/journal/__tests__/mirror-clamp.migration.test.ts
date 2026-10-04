import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampForMirror } from '../mirror-clamp.js';
import type { JournalEntry } from '../../../contract/journal.js';

/**
 * The server counts a task's CLAMPED mirror rows with one SQL predicate (migration
 * 20270105090600_kernel_journal_holdings.sql), and the tidy sweeper prunes a local journal
 * only when that count is zero. A clamp shape this file writes that the predicate does not
 * name would read as a whole entry, and license deleting the only full copy of it. So the
 * predicate is checked against what clampForMirror actually writes. (The server's own clamp,
 * capEntry, has the same test on its side, and the server runs the predicate itself in pglite:
 * apps/server/tests/journal-mirror-pg.)
 */
const MIGRATION = join(__dirname, '../../../../../../supabase/migrations/20270105090600_kernel_journal_holdings.sql');
const sql = readFileSync(MIGRATION, 'utf8');
/** The SQL keywords are upper case in the file; the markers are compared as written. */
const lower = sql.toLowerCase();
const big = 'x'.repeat(300_000);
const envelope = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' }, timestamp: 'T', uuid: 'u1', parentUuid: null, seq: 3,
} as const;
/** The text a marker starts with, up to and including its first colon — what the predicate's LIKE names. */
const prefix = (text: string): string => text.slice(0, text.indexOf(':') + 1);

describe('the holdings predicate names every clamp the runner writes', () => {
  it('an oversize tool_result', () => {
    const out = clampForMirror({ ...envelope, payload: { type: 'tool_result', toolUseId: 'tu', blocks: [{ type: 'text', text: big }] } } as unknown as JournalEntry, 250_000);
    const text = (out.payload as { blocks: Array<{ text: string }> }).blocks[0].text;
    expect(lower).toContain(`like '${prefix(text)}%'`);
  });

  it('any other oversize entry, which becomes a system note', () => {
    const out = clampForMirror({ ...envelope, payload: { type: 'assistant', blocks: [{ type: 'text', text: big }] } } as unknown as JournalEntry, 250_000);
    const event = (out.payload as { type: string; event: string });
    expect(event.type).toBe('system');
    expect(lower).toContain(`like '${prefix(event.event)}%'`);
  });

  /**
   * The image clause is a jsonpath: `<placeholder> AND NOT <names a file id>`, both
   * like_regex. The two patterns are read out of the function's copy of the predicate (the
   * server's pglite test holds the three copies equal) and run here as JavaScript regexes,
   * whose syntax agrees with Postgres's for everything they use. In the file each backslash
   * is doubled (a jsonpath string literal), so `\\[` there is the regex `\[`.
   */
  const fn = sql.slice(sql.indexOf('clamped AS ('));
  const [placeholder, namesFile] = [...fn.matchAll(/like_regex "((?:[^"\\]|\\.)*)"/g)]
    .slice(0, 2)
    .map((m) => new RegExp(m[1].replace(/\\\\/g, '\\')));
  const placeholderOf = (block: Record<string, unknown>): string => {
    const out = clampForMirror(
      { ...envelope, payload: { type: 'user', blocks: [{ type: 'image', filename: 'a.png', mediaType: 'image/png', data: 'AAAA', ...block }] } } as unknown as JournalEntry,
      250_000,
    );
    return (out.payload as { blocks: Array<{ text: string }> }).blocks[0].text;
  };
  const clamped = (text: string): boolean => placeholder.test(text) && !namesFile.test(text);

  it('an image placeholder with NO file id: the image bytes are gone from the mirror', () => {
    expect(placeholder).toBeInstanceOf(RegExp);
    expect(namesFile).toBeInstanceOf(RegExp);
    expect(clamped(placeholderOf({}))).toBe(true);
    expect(clamped(placeholderOf({ contentSha: 'abc123' }))).toBe(true);
    expect(clamped(placeholderOf({ filename: '' }))).toBe(true);
  });

  it('never an image placeholder that names its file id: the file stays on the box, so it is no loss', () => {
    expect(clamped(placeholderOf({ fileId: 'f-1' }))).toBe(false);
    expect(clamped(placeholderOf({ fileId: 'f-1', contentSha: 'abc123' }))).toBe(false);
  });
});
