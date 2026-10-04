import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RetrievalContextPort } from '../retrieval-context-port.js';

const MEMORY = [
  'The user lives in Bangalore India.',
  'The user prefers dark mode.',
  'The capital of France is Paris.',
].join('\n');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nami-rcp-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'user.md'), MEMORY);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RetrievalContextPort', () => {
  it('returns the whole file fenced when there is no query (session-open parity)', async () => {
    const out = await new RetrievalContextPort(dir).readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out.startsWith('<user_memory>')).toBe(true);
    expect(out).toContain('Bangalore');
    expect(out).toContain('Paris');
  });

  it('returns only the ranked top-k chunk fenced when given a query', async () => {
    const out = await new RetrievalContextPort(dir, { k: 1 }).readSnapshot({
      workspaceId: 'w',
      taskId: 't',
      query: 'where in India does the user live',
    });
    expect(out.startsWith('<user_memory>')).toBe(true);
    expect(out).toContain('Bangalore');
    expect(out).not.toContain('Paris');
  });

  it('abstains to empty string when the query matches nothing', async () => {
    const out = await new RetrievalContextPort(dir).readSnapshot({
      workspaceId: 'w',
      taskId: 't',
      query: 'quantum chromodynamics lagrangian',
    });
    expect(out).toBe('');
  });

  it('falls back to a legacy MEMORY.md when user.md is absent (pre-collapse volume)', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'nami-rcp-legacy-'));
    mkdirSync(join(legacyDir, 'memory'), { recursive: true });
    writeFileSync(join(legacyDir, 'memory', 'MEMORY.md'), MEMORY);
    const out = await new RetrievalContextPort(legacyDir).readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('Bangalore');
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it('prefers user.md over a stale MEMORY.md when both exist as regular files', async () => {
    writeFileSync(join(dir, 'memory', 'MEMORY.md'), 'STALE LEGACY BYTES');
    const out = await new RetrievalContextPort(dir).readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('Bangalore');
    expect(out).not.toContain('STALE LEGACY BYTES');
  });

  it('degrades to empty string when no memory file exists (never throws)', async () => {
    const out = await new RetrievalContextPort('/no/such/dir').readSnapshot({
      workspaceId: 'w',
      taskId: 't',
      query: 'anything',
    });
    expect(out).toBe('');
  });
});
