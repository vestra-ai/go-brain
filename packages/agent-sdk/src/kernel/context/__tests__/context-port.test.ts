import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoopContextPort } from '../context-port.js';
import { VolumeContextPort } from '../volume-context-port.js';

describe('NoopContextPort', () => {
  it('readSnapshot returns ""', async () => {
    expect(await NoopContextPort.readSnapshot({ workspaceId: 'w', taskId: 't' })).toBe('');
  });
  it('readSnapshot returns "" even with a free-text query', async () => {
    expect(
      await NoopContextPort.readSnapshot({ workspaceId: 'w', taskId: 't', query: 'recall renewals' }),
    ).toBe('');
  });
  it('onPreCompact resolves undefined (no-op)', async () => {
    await expect(
      NoopContextPort.onPreCompact({ dropped: [], summaryText: 'sum' }),
    ).resolves.toBeUndefined();
  });
});

describe('VolumeContextPort', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'context-port-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeMemory = (name: 'user.md' | 'MEMORY.md', body: string) => {
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', name), body, 'utf8');
  };

  it('returns "" when neither memory/user.md nor memory/MEMORY.md exists (the common/fresh-sandbox case)', async () => {
    const port = new VolumeContextPort(dir);
    expect(await port.readSnapshot({ workspaceId: 'w', taskId: 't' })).toBe('');
  });

  it('wraps existing MEMORY.md content in a fenced <user_memory> data block (no user.md yet — pre-Keeper parity)', async () => {
    writeMemory('MEMORY.md', '- prefers concise replies\n- renewal due June');
    const port = new VolumeContextPort(dir);
    const out = await port.readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('prefers concise replies');
    expect(out).toContain('renewal due June');
    // Data-only fence: opens with <user_memory>, closes with </user_memory>.
    expect(out.trimStart().match(/^<user_memory>/)).not.toBeNull();
    expect(out.trimEnd().match(/<\/user_memory>$/)).not.toBeNull();
  });

  it('prefers memory/user.md (the Keeper profile) over MEMORY.md when both exist', async () => {
    writeMemory('user.md', '- the curated Keeper profile');
    writeMemory('MEMORY.md', '- the legacy pre-Keeper memory');
    const port = new VolumeContextPort(dir);
    const out = await port.readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('the curated Keeper profile');
    expect(out).not.toContain('the legacy pre-Keeper memory');
    expect(out.trimStart().match(/^<user_memory>/)).not.toBeNull();
  });

  it('falls back to MEMORY.md when user.md is empty/whitespace-only', async () => {
    writeMemory('user.md', '   \n\n  ');
    writeMemory('MEMORY.md', '- the legacy pre-Keeper memory');
    const port = new VolumeContextPort(dir);
    const out = await port.readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('the legacy pre-Keeper memory');
  });

  it('wraps a non-empty user.md in the fenced <user_memory> data block', async () => {
    writeMemory('user.md', '- prefers concise replies');
    const port = new VolumeContextPort(dir);
    const out = await port.readSnapshot({ workspaceId: 'w', taskId: 't' });
    expect(out).toContain('prefers concise replies');
    expect(out.trimStart().match(/^<user_memory>/)).not.toBeNull();
    expect(out.trimEnd().match(/<\/user_memory>$/)).not.toBeNull();
  });

  it('returns "" when both user.md and MEMORY.md are empty/whitespace-only (nothing to recall)', async () => {
    writeMemory('user.md', '  \n ');
    writeMemory('MEMORY.md', '   \n\n  ');
    const port = new VolumeContextPort(dir);
    expect(await port.readSnapshot({ workspaceId: 'w', taskId: 't' })).toBe('');
  });

  it('never throws — a directory at the MEMORY.md path → "" (unreadable)', async () => {
    // Create a DIRECTORY where the file is expected → readFileSync throws EISDIR.
    mkdirSync(join(dir, 'memory', 'MEMORY.md'), { recursive: true });
    const port = new VolumeContextPort(dir);
    await expect(port.readSnapshot({ workspaceId: 'w', taskId: 't' })).resolves.toBe('');
  });

  it('onPreCompact resolves undefined and writes nothing (no-op; keeps server-side extraction the only writer)', async () => {
    const port = new VolumeContextPort(dir);
    await expect(
      port.onPreCompact({ dropped: [], summaryText: 'a compacted span' }),
    ).resolves.toBeUndefined();
    // The MEMORY.md must NOT have been created by onPreCompact (anti-race).
    const port2 = new VolumeContextPort(dir);
    expect(await port2.readSnapshot({ workspaceId: 'w', taskId: 't' })).toBe('');
  });
});
