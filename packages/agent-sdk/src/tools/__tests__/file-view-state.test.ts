/**
 * file-view-state.test.ts — Hardening-I read-state store.
 *
 * The store is a FACTORY (createFileViewState), never a module-global Map: each
 * call returns an independent per-session instance so parallel sessions sharing
 * one sandbox process never cross-contaminate their read-state. checkFreshness is
 * the pure staleness classifier Edit/Write consult before mutating a file.
 */
import { describe, it, expect } from 'vitest';
import {
  createFileViewState,
  checkFreshness,
  MSG_UNREAD,
  MSG_STALE,
} from '../file-view-state.js';

describe('createFileViewState', () => {
  it('records a read and returns it by absolute path', () => {
    const s = createFileViewState();
    expect(s.get('/ws/a.ts')).toBeUndefined();
    s.record('/ws/a.ts', { mtimeMs: 111, size: 42 });
    const rec = s.get('/ws/a.ts');
    expect(rec?.mtimeMs).toBe(111);
    expect(rec?.size).toBe(42);
    expect(typeof rec?.lastReadAt).toBe('number');
  });

  it('two separate instances do NOT share read-state (session isolation)', () => {
    const a = createFileViewState();
    const b = createFileViewState();
    a.record('/ws/shared.ts', { mtimeMs: 1, size: 1 });
    expect(a.get('/ws/shared.ts')).toBeDefined();
    expect(b.get('/ws/shared.ts')).toBeUndefined();
  });

  it('a later record overwrites the earlier one for the same path', () => {
    const s = createFileViewState();
    s.record('/ws/a.ts', { mtimeMs: 1, size: 1 });
    s.record('/ws/a.ts', { mtimeMs: 2, size: 9 });
    expect(s.get('/ws/a.ts')).toMatchObject({ mtimeMs: 2, size: 9 });
  });
});

describe('checkFreshness', () => {
  it('classifies a never-recorded path as unread', () => {
    expect(checkFreshness(undefined, { mtimeMs: 1, size: 1 })).toBe('unread');
  });

  it('classifies a mtime mismatch as stale', () => {
    const rec = { mtimeMs: 100, size: 10, lastReadAt: 0 };
    expect(checkFreshness(rec, { mtimeMs: 200, size: 10 })).toBe('stale');
  });

  it('classifies a size mismatch as stale', () => {
    const rec = { mtimeMs: 100, size: 10, lastReadAt: 0 };
    expect(checkFreshness(rec, { mtimeMs: 100, size: 11 })).toBe('stale');
  });

  it('classifies an exact mtime+size match as fresh', () => {
    const rec = { mtimeMs: 100, size: 10, lastReadAt: 0 };
    expect(checkFreshness(rec, { mtimeMs: 100, size: 10 })).toBe('fresh');
  });
});

describe('contract messages', () => {
  it('exposes the unread + stale guidance strings', () => {
    expect(MSG_UNREAD).toContain('has not been Read');
    expect(MSG_STALE).toContain('changed on disk');
  });
});
