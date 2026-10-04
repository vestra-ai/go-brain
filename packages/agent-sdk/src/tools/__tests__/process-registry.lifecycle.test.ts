import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBackground, getOutput, stopProcess, killAll } from '../process-registry.js';
import { processToolOptions } from '../process-tool.js';

// Hardening-H — background-process lifecycle: detached process groups, escalating
// tree-kill, multibyte-safe + byte-budgeted buffering, and cross-restart orphan
// reaping. Real short-lived processes (matching the existing registry tests).
const flush = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const CWD = process.cwd();

// Env knobs read at spawn/kill time so a test can shrink the buffer budget and the
// SIGTERM→SIGKILL grace for fast, deterministic assertions.
const ENV_KEYS = ['VESTRA_KILL_GRACE_MS', 'VESTRA_BG_BUFFER_BYTES', 'VESTRA_TERM_SCRATCH_ROOT'] as const;

describe('process-registry lifecycle (Hardening-H)', () => {
  const spawned: string[] = [];
  let envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup = {};
    for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  });

  afterEach(() => {
    for (const id of spawned) stopProcess(id);
    spawned.length = 0;
    killAll();
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  // ── Multibyte-safe decoding across chunk boundaries ─────────────────────────
  it('decodes a multibyte char split across two stdout chunks', async () => {
    // Emit the 4 UTF-8 bytes of 😀 (F0 9F 98 80) in two writes with a gap so they
    // land as SEPARATE 'data' events. Per-chunk chunk.toString('utf8') corrupts
    // the codepoint into replacement chars; a per-stream StringDecoder keeps it.
    const id = spawnBackground(`printf '\\360\\237'; sleep 0.2; printf '\\230\\200\\n'`, 'task-mb', CWD);
    spawned.push(id);
    await flush(500);
    const out = getOutput(id).output;
    expect(out).toContain('😀');
    expect(out).not.toContain('�');
  });

  // ── Byte-budget ring buffer + cumulative droppedBytes ───────────────────────
  it('enforces the byte budget, keeps newest lines, and reports droppedBytes', async () => {
    process.env.VESTRA_BG_BUFFER_BYTES = '2048';
    const id = spawnBackground(
      `i=1; while [ $i -le 300 ]; do printf 'LINE%04d-XXXXXXXXXXXXXXXXXXXXXXXX\\n' $i; i=$((i+1)); done`,
      'task-cap',
      CWD,
    );
    spawned.push(id);
    await flush(600);
    const res = getOutput(id);
    expect(res.droppedBytes).toBeGreaterThan(0);
    // Buffer bounded to roughly the budget (allow one line of slack).
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(2048 + 200);
    // Oldest dropped, newest kept.
    expect(res.output).toContain('LINE0300');
    expect(res.output).not.toContain('LINE0001');
  });

  it('reports droppedBytes as 0 when nothing is dropped', async () => {
    const id = spawnBackground(`echo small-output`, 'task-nodrop', CWD);
    spawned.push(id);
    await flush(300);
    expect(getOutput(id).droppedBytes).toBe(0);
  });

  // ── Detached process group: kill reaches grandchildren ──────────────────────
  it('group-kills a grandchild that the direct child spawned', async () => {
    // sh backgrounds a grandchild and waits. The OLD child-only SIGKILL orphans
    // the grandchild (reparented, still alive); a group kill reaps it.
    const id = spawnBackground(`sleep 8 & echo GPID:$!; wait`, 'task-tree', CWD);
    spawned.push(id);
    await flush(300);
    const gpid = Number(getOutput(id).output.match(/GPID:(\d+)/)?.[1]);
    expect(Number.isInteger(gpid)).toBe(true);
    expect(() => process.kill(gpid, 0)).not.toThrow(); // grandchild alive
    stopProcess(id);
    await flush(400);
    expect(() => process.kill(gpid, 0)).toThrow(); // group kill reached it
  });

  // ── Escalation: SIGTERM first, SIGKILL only if still alive after the grace ───
  it('SIGTERMs the group but skips SIGKILL when the process exits promptly', async () => {
    process.env.VESTRA_KILL_GRACE_MS = '150';
    const killSpy = vi.spyOn(process, 'kill');
    const id = spawnBackground('sleep 30', 'task-fast', CWD); // dies on SIGTERM
    spawned.push(id);
    await flush(200);
    stopProcess(id);
    await flush(400); // well past the grace
    const groupCalls = killSpy.mock.calls.filter(([p]) => typeof p === 'number' && (p as number) < 0);
    // A graceful group SIGTERM was sent. Old code used child.kill('SIGKILL') and
    // never called process.kill(-pid, ...), so this assertion is red on old code.
    expect(groupCalls.some(([, s]) => s === 'SIGTERM')).toBe(true);
    // Escalation skipped: the group was already gone at the grace deadline.
    expect(groupCalls.some(([, s]) => s === 'SIGKILL')).toBe(false);
    killSpy.mockRestore();
  });

  it('escalates to a group SIGKILL when the process ignores SIGTERM', async () => {
    process.env.VESTRA_KILL_GRACE_MS = '150';
    const killSpy = vi.spyOn(process, 'kill');
    // The direct child traps (ignores) SIGTERM and stays alive; bounded loop is a
    // safety net so a red run can't leak the process indefinitely.
    const id = spawnBackground(
      `trap '' TERM; i=0; while [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done`,
      'task-ign',
      CWD,
    );
    spawned.push(id);
    await flush(200);
    stopProcess(id);
    await flush(500); // past the grace
    const groupCalls = killSpy.mock.calls.filter(([p]) => typeof p === 'number' && (p as number) < 0);
    expect(groupCalls.some(([, s]) => s === 'SIGTERM')).toBe(true); // graceful first
    expect(groupCalls.some(([, s]) => s === 'SIGKILL')).toBe(true); // then escalated
    killSpy.mockRestore();
  });

  // ── Retain final output after an explicit kill ──────────────────────────────
  it('retains buffered output after stopProcess (killed status, still readable)', async () => {
    const id = spawnBackground('echo RETAINED; sleep 30', 'task-ret', CWD);
    spawned.push(id);
    await flush(250);
    expect(getOutput(id).output).toContain('RETAINED');
    stopProcess(id);
    await flush(150);
    const res = getOutput(id);
    expect(res.status).toBe('killed');
    expect(res.output).toContain('RETAINED'); // buffer survives the kill
  });

  // ── Orphan reaping across a process restart (sidecar sweep) ──────────────────
  it('sweepOrphanProcesses kills a sidecar-recorded stale pgid and clears the file', async () => {
    const { sweepOrphanProcesses } = await import('../process-registry.js');
    const root = mkdtempSync(join(tmpdir(), 'vestra-orphan-'));
    process.env.VESTRA_TERM_SCRATCH_ROOT = root;

    // A detached child forming its own group — a leaked process from a "previous run".
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pgid = child.pid as number;
    const exited = new Promise<void>((r) => child.on('exit', () => r()));

    // Hand-write the sidecar exactly as a previous runner would have.
    const sidecarPath = join(root, 'bg-processes.json');
    writeFileSync(
      sidecarPath,
      JSON.stringify({ bg_old1: { pgid, taskId: 'old-task', startedAt: Date.now(), command: 'sleep 30' } }),
    );

    const reaped = sweepOrphanProcesses();
    expect(reaped).toBeGreaterThanOrEqual(1);

    await Promise.race([exited, flush(1500)]);
    expect(() => process.kill(pgid, 0)).toThrow(); // orphan group reaped

    // Sidecar cleared (empty map or removed).
    const after = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf8').trim() : '';
    expect(after === '' || after === '{}').toBe(true);
  });

  it('sweepOrphanProcesses is a no-op (0 reaped) when no sidecar exists', async () => {
    const { sweepOrphanProcesses } = await import('../process-registry.js');
    process.env.VESTRA_TERM_SCRATCH_ROOT = mkdtempSync(join(tmpdir(), 'vestra-orphan-empty-'));
    expect(sweepOrphanProcesses()).toBe(0);
  });

  // ── process tool surfaces droppedBytes in its read output ────────────────────
  it('process tool read surfaces a dropped-bytes note', async () => {
    process.env.VESTRA_BG_BUFFER_BYTES = '1024';
    const id = spawnBackground(
      `i=1; while [ $i -le 300 ]; do printf 'L%04d-XXXXXXXXXXXXXXXXXXXX\\n' $i; i=$((i+1)); done`,
      'task-tool-cap',
      CWD,
    );
    spawned.push(id);
    await flush(600);
    const out = (await processToolOptions.execute({ action: 'read', id, limit: 5 }, {})) as string;
    expect(out).toMatch(/dropped \d+ bytes of earlier output/i);
  });
});
