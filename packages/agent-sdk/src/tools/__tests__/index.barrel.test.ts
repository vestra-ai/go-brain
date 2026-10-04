/**
 * index.barrel.test.ts — the generic tool barrel (tools/index.ts) must re-export
 * the Hardening-I file-view-state factory so consumers (the sandbox harness) can
 * `import { createFileViewState } from '@vestra/agent-sdk/tools'` and thread a
 * per-session store into the read/edit/write tools (harness-9.5 activation).
 */
import { describe, it, expect } from 'vitest';
import * as toolsBarrel from '../index.js';
import { createFileViewState, checkFreshness } from '../index.js';

describe('tools barrel — file-view-state re-export', () => {
  it('re-exports createFileViewState and checkFreshness from the barrel', () => {
    expect(typeof toolsBarrel.createFileViewState).toBe('function');
    expect(typeof toolsBarrel.checkFreshness).toBe('function');
  });

  it('the re-exported factory produces an independent, working store', () => {
    const store = createFileViewState();
    expect(store.get('/ws/a.txt')).toBeUndefined();
    store.record('/ws/a.txt', { mtimeMs: 10, size: 3 });
    expect(store.get('/ws/a.txt')).toMatchObject({ mtimeMs: 10, size: 3 });
    // Freshness classification rides through the same barrel export.
    expect(checkFreshness(store.get('/ws/a.txt'), { mtimeMs: 10, size: 3 })).toBe('fresh');
    expect(checkFreshness(store.get('/ws/a.txt'), { mtimeMs: 11, size: 3 })).toBe('stale');
    expect(checkFreshness(undefined, { mtimeMs: 10, size: 3 })).toBe('unread');
  });
});
