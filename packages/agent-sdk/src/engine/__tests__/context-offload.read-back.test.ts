/**
 * context-offload.read-back.test.ts — Phase 3 (§1.5), AC-F2 + the "missing file
 * on resume" invariant.
 *
 * Proves offloaded content is readable back THROUGH THE REAL `Read` tool (the
 * ordinary sandbox filesystem tool — no new tool exists for this), in pages via
 * its existing offset/limit params, and that a later-missing file degrades to a
 * normal "could not read" tool result — never a throw, never any re-dispatch of
 * the tool that originally produced the offloaded result (there is no code path
 * connecting a Read-tool miss back to the source tool at all).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offloadIfOversized } from '../context-offload.js';
import { makeReadTool } from '../../tools/read-tool.js';
import { isToolError } from '../../tools/tool-types.js';

const workingDir = join(tmpdir(), `context-offload-readback-test-${process.pid}`);
afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

describe('offloaded content — read back via the real Read tool', () => {
  it('AC-F2 — the model can page through the offloaded file via Read.offset/limit', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const offload = await offloadIfOversized({
      text: lines, workingDir, taskId: 'task-x', toolCallId: 'call-x', thresholdChars: 10,
    });
    expect(offload.offloaded).toBe(true);

    const readTool = makeReadTool(() => workingDir);
    const page1 = (await readTool.execute({ file_path: offload.path, offset: 1, limit: 10 }, {})) as string;
    // Hardening-I: a partial read now ends with a truncation marker line, so the page
    // carries 10 numbered content lines (those with a tab) plus the marker.
    expect(page1.split('\n').filter((l) => l.includes('\t'))).toHaveLength(10);
    expect(page1).toContain('line 0');
    expect(page1).not.toContain('line 10\t'); // still on page 1

    const page2 = (await readTool.execute({ file_path: offload.path, offset: 11, limit: 10 }, {})) as string;
    expect(page2).toContain('line 10');
    expect(page2).toContain('line 19');
  });

  it('missing-file-on-resume — a deleted offload file reads as a graceful "could not read" result, never a throw, never a re-dispatch', async () => {
    const big = 'z'.repeat(1000);
    const offload = await offloadIfOversized({
      text: big, workingDir, taskId: 'task-y', toolCallId: 'call-y', thresholdChars: 10,
    });
    expect(offload.offloaded).toBe(true);

    // Simulate GC / volume eviction between turns.
    await fs.rm(join(workingDir, offload.path!));

    const readTool = makeReadTool(() => workingDir);
    let result: unknown;
    let threw = false;
    try {
      result = await readTool.execute({ file_path: offload.path }, {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // never throws
    // Hardening-G: the miss is now a typed not_found sentinel (still never-throw); its
    // message is the same "could not read" string the dispatcher's flag-OFF path unwraps.
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error('unreachable');
    expect(result.__toolError.code).toBe('not_found');
    expect(result.__toolError.message).toMatch(/could not read/i);
  });
});
