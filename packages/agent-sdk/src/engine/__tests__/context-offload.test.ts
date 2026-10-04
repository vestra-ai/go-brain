import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offloadIfOversized, DEFAULT_OFFLOAD_THRESHOLD_CHARS } from '../context-offload.js';

const workingDir = join(tmpdir(), `context-offload-test-${process.pid}`);
afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

describe('offloadIfOversized', () => {
  it('returns text unchanged when under the threshold — no file written', async () => {
    const result = await offloadIfOversized({
      text: 'small result', workingDir, taskId: 't1', toolCallId: 'tc1',
    });
    expect(result).toEqual({ text: 'small result', offloaded: false });
    await expect(fs.access(join(workingDir, '.kernel-offload'))).rejects.toThrow();
  });

  it('AC-F1 — writes the FULL content to the namespaced path BEFORE returning, and returns a head/tail preview + path', async () => {
    const big = 'A'.repeat(30_000);
    const result = await offloadIfOversized({
      text: big, workingDir, taskId: 'task-42', toolCallId: 'call-7', thresholdChars: 100,
    });
    expect(result.offloaded).toBe(true);
    expect(result.path).toBe('.kernel-offload/task-42/call-7.txt');
    // Namespaced by BOTH taskId and toolCallId (AC-F9) — never a bare toolCallId.
    expect(result.path).toContain('task-42');
    expect(result.path).toContain('call-7');

    const onDisk = await fs.readFile(join(workingDir, result.path!), 'utf8');
    expect(onDisk).toBe(big); // byte-identical full fidelity on disk

    expect(result.text.length).toBeLessThan(big.length);
    expect(result.text).toContain('.kernel-offload/task-42/call-7.txt');
    expect(result.text).toContain('30000 chars total');
  });

  it('AC-F9 — two different tasks writing the same toolCallId never collide', async () => {
    const a = await offloadIfOversized({ text: 'x'.repeat(200), workingDir, taskId: 'task-a', toolCallId: 'same-id', thresholdChars: 10 });
    const b = await offloadIfOversized({ text: 'y'.repeat(200), workingDir, taskId: 'task-b', toolCallId: 'same-id', thresholdChars: 10 });
    expect(a.path).not.toBe(b.path);
    const onDiskA = await fs.readFile(join(workingDir, a.path!), 'utf8');
    const onDiskB = await fs.readFile(join(workingDir, b.path!), 'utf8');
    expect(onDiskA).toBe('x'.repeat(200));
    expect(onDiskB).toBe('y'.repeat(200));
  });

  it('never offloads content guardToolOutput would refuse as binary', async () => {
    const binary = '%PDF-1.4\x00\x00\x00'.repeat(5000); // NUL-laced, oversized
    const result = await offloadIfOversized({ text: binary, workingDir, taskId: 't1', toolCallId: 'tc1', thresholdChars: 10 });
    expect(result.offloaded).toBe(false);
    expect(result.text).toBe(binary); // left untouched — guardToolOutput refuses it next
  });

  it('uses the DEFAULT_OFFLOAD_THRESHOLD_CHARS floor when no threshold is passed', async () => {
    const justUnder = 'a'.repeat(DEFAULT_OFFLOAD_THRESHOLD_CHARS);
    const result = await offloadIfOversized({ text: justUnder, workingDir, taskId: 't1', toolCallId: 'tc1' });
    expect(result.offloaded).toBe(false);
  });

  it('degrades gracefully (never throws) when the write fails — returns the original text', async () => {
    // workingDir points inside a FILE (not a directory) so mkdir/writeFile fail.
    await fs.mkdir(workingDir, { recursive: true });
    const blockerFile = join(workingDir, 'not-a-dir');
    await fs.writeFile(blockerFile, 'x');
    const big = 'z'.repeat(1000);
    const result = await offloadIfOversized({
      text: big, workingDir: blockerFile, taskId: 't1', toolCallId: 'tc1', thresholdChars: 10,
    });
    expect(result).toEqual({ text: big, offloaded: false });
  });
});
