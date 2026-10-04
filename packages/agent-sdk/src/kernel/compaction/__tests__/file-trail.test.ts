/**
 * COMPACTION_V2 — the mechanical file trail.
 *
 * Two properties matter and both are pinned here:
 *   1. The read/modified split keys off CAPABILITY (an injected classifier), so a
 *      tool nobody registered anywhere still lands in the trail.
 *   2. The trail ACCUMULATES — render/parse round-trip, because compaction N drops
 *      the summary compaction N-1 wrote, and a trail rebuilt from only the new span
 *      would forget every file before it.
 */
import { describe, it, expect } from 'vitest';
import {
  extractFileTrail,
  mergeFileTrail,
  renderFileTrail,
  parseFileTrail,
  FILE_TRAIL_MAX_PATHS,
  type TrailEffect,
} from '../file-trail.js';
import type { JournalEntry } from '../../../contract/journal.js';

let seq = 0;
function toolUse(name: string, input: unknown): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`,
    parentUuid: null,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2024-01-01T00:00:00.000Z',
    payload: { type: 'tool_use', toolUseId: `tu${seq}`, name, input },
  } as JournalEntry;
}

/** Stand-in for the real side-effect classifier: reads observe, everything else mutates. */
const classify = (name: string): TrailEffect => {
  if (name === 'Read' || name === 'Grep') return 'read';
  if (name === 'SendEmail') return 'ignore';
  return 'modified';
};

describe('extractFileTrail — capability, not tool names', () => {
  it('splits read from modified and preserves first-seen order', () => {
    const trail = extractFileTrail(
      [
        toolUse('Read', { file_path: '/a.ts' }),
        toolUse('Write', { file_path: '/b.ts' }),
        toolUse('Read', { file_path: '/c.ts' }),
      ],
      classify,
    );
    expect(trail).toEqual({ read: ['/a.ts', '/c.ts'], modified: ['/b.ts'] });
  });

  it('picks up a tool the trail has never heard of, purely from its classification', () => {
    const trail = extractFileTrail([toolUse('SomeBrandNewEditor', { file_path: '/new.ts' })], classify);
    expect(trail.modified).toEqual(['/new.ts']);
  });

  it('a file read and later modified appears in BOTH lists — that is the honest record', () => {
    const trail = extractFileTrail(
      [toolUse('Read', { file_path: '/x.ts' }), toolUse('Edit', { file_path: '/x.ts' })],
      classify,
    );
    expect(trail.read).toEqual(['/x.ts']);
    expect(trail.modified).toEqual(['/x.ts']);
  });

  it('dedupes repeats of the same path', () => {
    const trail = extractFileTrail(
      [toolUse('Read', { file_path: '/a.ts' }), toolUse('Read', { file_path: '/a.ts' })],
      classify,
    );
    expect(trail.read).toEqual(['/a.ts']);
  });

  it('reads notebook_path and path as well as file_path (the repo path-arg convention)', () => {
    const trail = extractFileTrail(
      [toolUse('NotebookEdit', { notebook_path: '/n.ipynb' }), toolUse('Write', { path: '/p.txt' })],
      classify,
    );
    expect(trail.modified).toEqual(['/n.ipynb', '/p.txt']);
  });

  it('ignores calls with no path-shaped argument — a glob is not a file that was read', () => {
    const trail = extractFileTrail(
      [
        toolUse('Grep', { pattern: '*.ts' }),
        toolUse('Bash', { command: 'ls -la' }),
        toolUse('SendEmail', { file_path: '/attachment.pdf' }), // classified 'ignore'
      ],
      classify,
    );
    expect(trail).toEqual({ read: [], modified: [] });
  });

  it('is TOTAL — a throwing classifier costs that entry, never the compaction', () => {
    const boom = (): TrailEffect => { throw new Error('nope'); };
    expect(() => extractFileTrail([toolUse('Read', { file_path: '/a.ts' })], boom)).not.toThrow();
    expect(extractFileTrail([toolUse('Read', { file_path: '/a.ts' })], boom)).toEqual({ read: [], modified: [] });
  });

  it('non-tool_use entries and malformed inputs contribute nothing', () => {
    const trail = extractFileTrail(
      [toolUse('Read', { file_path: '' }), toolUse('Read', null), toolUse('Read', 'not-an-object')],
      classify,
    );
    expect(trail).toEqual({ read: [], modified: [] });
  });
});

describe('the trail accumulates across compactions', () => {
  it('render → parse round-trips exactly, including paths containing commas and spaces', () => {
    const trail = {
      read: ['/a, with comma.ts', '/dir with spaces/b.ts'],
      modified: ['/c.ts'],
    };
    expect(parseFileTrail(renderFileTrail(trail))).toEqual(trail);
  });

  it('a previous summary\'s trail unions with the new span\'s', () => {
    const previous = parseFileTrail(renderFileTrail({ read: ['/old.ts'], modified: ['/oldw.ts'] }));
    const next = extractFileTrail(
      [toolUse('Read', { file_path: '/new.ts' }), toolUse('Write', { file_path: '/neww.ts' })],
      classify,
    );
    expect(mergeFileTrail(previous, next)).toEqual({
      read: ['/old.ts', '/new.ts'],
      modified: ['/oldw.ts', '/neww.ts'],
    });
  });

  it('merging is idempotent — re-reading a file already in the trail adds nothing', () => {
    const trail = { read: ['/a.ts'], modified: [] };
    expect(mergeFileTrail(trail, { read: ['/a.ts'], modified: [] })).toEqual(trail);
  });

  it('caps each list, dropping the OLDEST — the trail rides every future summary', () => {
    const many = Array.from({ length: FILE_TRAIL_MAX_PATHS + 10 }, (_, i) => `/f${i}.ts`);
    const capped = mergeFileTrail({ read: many, modified: [] }, { read: [], modified: [] });
    expect(capped.read).toHaveLength(FILE_TRAIL_MAX_PATHS);
    expect(capped.read[0]).toBe('/f10.ts'); // the ten oldest dropped
    expect(capped.read.at(-1)).toBe(`/f${FILE_TRAIL_MAX_PATHS + 9}.ts`);
  });

  it('an EMPTY trail renders as nothing — never a "Files read: none" line', () => {
    expect(renderFileTrail({ read: [], modified: [] })).toBe('');
  });

  it('parsing text with no trail block yields the empty trail', () => {
    expect(parseFileTrail('A summary that mentions /some/path.ts in prose.')).toEqual({
      read: [],
      modified: [],
    });
  });

  it('parsing stops at the end of the block — a note appended after it is not swallowed', () => {
    const text = `${renderFileTrail({ read: ['/a.ts'], modified: [] })}\n\n(Full pre-compaction transcript archived at /tmp/x.md — use Read to page through it.)`;
    expect(parseFileTrail(text)).toEqual({ read: ['/a.ts'], modified: [] });
  });
});
