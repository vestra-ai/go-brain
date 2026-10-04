/**
 * T5 — one truncation marker for every tool result (TOOL_RESULT_SHAPE_V1).
 *
 * Every cut a tool result can take is driven here through its real code path, flag off and
 * flag on. Off, each keeps today's notice byte for byte. On, each carries the ONE marker
 * (result-shape.ts truncationMarker), names what was dropped and where, and the exact next
 * step. The token-budget marker (C2) is the target: it reads the same either way.
 *
 * Revert proof: route any site back to its own notice and its 'flag on' case fails on
 * ONE_MARKER; drop the flag check and its 'flag off' case fails on today's literal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { truncationMarker, stampToolError, spillRecovery, NARROW_RECOVERY, REDIRECT_RECOVERY } from '../result-shape.js';
import { truncateOutput, truncateToTokenBudget } from '../output-limits.js';
import { parseToolErrorCode } from '../tool-types.js';
import { guardToolOutput, TOOL_OUTPUT_MAX_CHARS } from '../../engine/tool-output-guard.js';
import { offloadIfOversized } from '../../engine/context-offload.js';
import { clipWebText } from '../web-fetch-tool.js';
import { truncateAndStoreWeb } from '../web-content-store.js';
import { makeBashTool } from '../bash-tool.js';
import { processToolOptions } from '../process-tool.js';
import { spawnBackground, stopProcess } from '../process-registry.js';

const FLAG = 'TOOL_RESULT_SHAPE_V1';
const spawned: string[] = [];
afterEach(() => {
  delete process.env[FLAG];
  delete process.env.VESTRA_BG_BUFFER_BYTES;
  for (const id of spawned) stopProcess(id);
  spawned.length = 0;
});

/** The one marker's envelope. Every cut matches it with the flag on. */
const ONE_MARKER = /\.\.\.\[OUTPUT TRUNCATED(?: to the [^:\]]+)?: [^\]]+ omitted from the (middle|end|start), (head and tail|head|tail) shown\. [^\]]+\]\.\.\./;
const markers = (text: string): string[] => text.match(new RegExp(ONE_MARKER.source, 'g')) ?? [];
const omittedCount = (text: string): number => Number(/: (\d+) [a-z]+ omitted/.exec(text)?.[1]);

describe('result shape: the one marker and the one error shape', () => {
  it('shape: one envelope for every cut, the budget named when there is one', () => {
    expect(truncationMarker({ omitted: '10 characters', from: 'middle', recovery: 'Do X.' }))
      .toBe('...[OUTPUT TRUNCATED: 10 characters omitted from the middle, head and tail shown. Do X.]...');
    expect(truncationMarker({ omitted: '3 lines', from: 'end', recovery: 'Do Y.' }))
      .toBe('...[OUTPUT TRUNCATED: 3 lines omitted from the end, head shown. Do Y.]...');
    expect(truncationMarker({ omitted: '9 bytes', from: 'start', recovery: 'Do Z.', budget: '100-token budget' }))
      .toBe('...[OUTPUT TRUNCATED to the 100-token budget: 9 bytes omitted from the start, tail shown. Do Z.]...');
    for (const from of ['middle', 'end', 'start'] as const) {
      expect(truncationMarker({ omitted: '1 line', from, recovery: 'R.' })).toMatch(ONE_MARKER);
    }
  });

  it('shape: the error shape is the message with its code at the tail, and the code reads back', () => {
    const text = stampToolError('Glob failed: boom', 'exec_failed');
    expect(text).toBe('Glob failed: boom [error:exec_failed]');
    expect(parseToolErrorCode(text)).toBe('exec_failed');
  });

  it('shape: the token-budget marker is the target and reads the same, flag off or on', () => {
    const text = 'z'.repeat(100_000);
    const off = truncateToTokenBudget(text, 1_000).text;
    process.env[FLAG] = 'true';
    const on = truncateToTokenBudget(text, 1_000).text;
    expect(on).toBe(off);
    expect(markers(on)).toHaveLength(1);
    expect(on).toContain(`...[OUTPUT TRUNCATED to the 1000-token budget: `);
    expect(on).toContain(`omitted from the middle, head and tail shown. ${NARROW_RECOVERY}]...`);
    expect(truncateToTokenBudget(text, 1_000, '/w/spill.txt').text).toContain(spillRecovery('/w/spill.txt'));
  });
});

describe('result shape: every cut, flag off and on', () => {
  it('shape: the command-output cap (Bash, execute_code)', () => {
    const text = 'a'.repeat(60_000);
    const off = truncateOutput(text).text;
    expect(off).toContain('\n...[OUTPUT TRUNCATED - 10000 bytes omitted from the middle; head and tail shown. To see all of it, re-run redirecting to a file (`<command> > out.txt 2>&1`) and Read that file with offset/limit]...\n');
    process.env[FLAG] = 'true';
    const on = truncateOutput(text).text;
    expect(markers(on)).toEqual([truncationMarker({ omitted: '10000 bytes', from: 'middle', recovery: REDIRECT_RECOVERY })]);
    expect(on).toContain(`\n${markers(on)[0]}\n`);
  });

  it('shape: the last-resort character cap', () => {
    const text = 'b'.repeat(TOOL_OUTPUT_MAX_CHARS + 5_000);
    const off = guardToolOutput(text);
    expect(off).toContain('…[truncated: tool output exceeded');
    process.env[FLAG] = 'true';
    const on = guardToolOutput(text);
    expect(markers(on)).toHaveLength(1);
    expect(on).toContain(`omitted from the end, head shown. ${NARROW_RECOVERY}]...`);
    expect(on.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    // The count is exact: what is gone is exactly what is not shown.
    const kept = on.indexOf('\n...[OUTPUT TRUNCATED');
    expect(omittedCount(on)).toBe(text.length - kept);
    // Under the cap, nothing changes.
    expect(guardToolOutput('short')).toBe('short');
  });

  it('shape: the offload preview names the absolute spill path', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 't5-offload-'));
    const text = Array.from({ length: 2_000 }, (_, i) => `row ${i} `.padEnd(20, '.')).join('\n');
    const off = await offloadIfOversized({ text, workingDir, taskId: 't5', toolCallId: 'off', thresholdChars: 1_000 });
    expect(off.text).toContain('…[offloaded: ');
    process.env[FLAG] = 'true';
    const on = await offloadIfOversized({ text, workingDir, taskId: 't5', toolCallId: 'on', thresholdChars: 1_000 });
    expect(on.offloaded).toBe(true);
    const abs = resolve(workingDir, '.kernel-offload/t5/on.txt');
    expect(markers(on.text)).toEqual([
      truncationMarker({ omitted: `${text.length - 3_000} characters`, from: 'middle', recovery: spillRecovery(abs) }),
    ]);
    expect(readFileSync(abs, 'utf8')).toBe(text);
  });

  it('shape: the WebFetch clip', async () => {
    const text = 'c'.repeat(31_000);
    expect(await clipWebText(text)).toBe(`${'c'.repeat(30_000)}\n\n…[truncated]`);
    process.env[FLAG] = 'true';
    const on = await clipWebText(text);
    expect(on).toBe(`${'c'.repeat(30_000)}\n${truncationMarker({ omitted: '1000 characters', from: 'end', recovery: 'Fetch a more specific page for the rest.' })}`);
  });

  it('shape: the stored WebFetch page window carries its paging call in the marker', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the page`).join('\n');
    const off = await truncateAndStoreWeb(text, 't5-web-off', 2_000);
    expect(off).toContain(' lines omitted] …');
    expect(off).toContain('[page truncated: showing ');
    process.env[FLAG] = 'true';
    const on = await truncateAndStoreWeb(text, 't5-web-on', 2_000);
    expect(markers(on)).toHaveLength(1);
    expect(on).not.toContain('[page truncated');
    expect(on).toMatch(/omitted from the middle, head and tail shown\. The page is in .+webfetch-t5-web-on-g\d+\.txt; read the omitted lines with Read\(file_path=".+", offset=\d+, limit=\d+\)\.\]\.\.\./);
    // The marker sits where the lines went: head lines above it, tail lines below.
    const [head, tail] = on.split(markers(on)[0]);
    expect(head).toContain('line 0 of the page');
    expect(tail).toContain('line 399 of the page');
  });

  it("shape: Bash's 8 MB stop", async () => {
    process.env[FLAG] = 'true';
    const tool = makeBashTool(() => process.cwd(), 'task_t5');
    const out = (await tool.execute({ command: `node -e "process.stdout.write('x'.repeat(9*1024*1024))"` }, {})) as string;
    expect(out).not.toMatch(/^Command failed/);
    expect(out).not.toContain('output exceeded');
    const found = markers(out);
    // The command-output cap's cut in the middle, then the stop at the end: both the one marker.
    expect(found).toHaveLength(2);
    expect(found[1]).toBe(truncationMarker({
      omitted: 'all output past 8 MB', from: 'end', recovery: `The process was stopped at 8 MB. ${REDIRECT_RECOVERY}`,
    }));
  });

  it('shape: the process read window says what it skipped', async () => {
    const lines = `i=1; while [ $i -le 300 ]; do echo "L$i"; i=$((i+1)); done`;
    const read = (id: string) => processToolOptions.execute({ action: 'read', id, block: true, timeout: 3_000 }, {}) as Promise<string>;
    // Off: the default last-200-line window skipped 100 lines and said nothing.
    const offId = spawnBackground(lines, 'task-t5-off', process.cwd(), {});
    spawned.push(offId);
    const off = await read(offId);
    expect(off).not.toContain('OUTPUT TRUNCATED');
    expect(off).toContain('L300');
    process.env[FLAG] = 'true';
    const onId = spawnBackground(lines, 'task-t5-on', process.cwd(), {});
    spawned.push(onId);
    const on = await read(onId);
    expect(markers(on)).toHaveLength(1);
    // 300 lines, a 200-line window: at least the first 100 were skipped, and the marker
    // carries the exact read that pages them back.
    const m = /OUTPUT TRUNCATED: (\d+) lines omitted from the start, tail shown\. Read the skipped lines with process\(action="read", id="([^"]+)", offset=0, limit=(\d+)\)\.\]\.\.\./.exec(on);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(100);
    expect(m![2]).toBe(onId);
    expect(m![3]).toBe(m![1]);
    expect(on).toContain('L300');
  });

  it('shape: the process ring buffer says what it no longer keeps', async () => {
    process.env.VESTRA_BG_BUFFER_BYTES = '2048';
    const cmd = `i=1; while [ $i -le 300 ]; do printf 'LINE%04d-XXXXXXXXXXXXXXXXXXXXXXXX\\n' $i; i=$((i+1)); done`;
    const read = (id: string) => processToolOptions.execute({ action: 'read', id, block: true, timeout: 3_000 }, {}) as Promise<string>;
    const offId = spawnBackground(cmd, 'task-t5-ring-off', process.cwd(), {});
    spawned.push(offId);
    expect(await read(offId)).toMatch(/\[dropped \d+ bytes of earlier output\]/);
    process.env[FLAG] = 'true';
    const onId = spawnBackground(cmd, 'task-t5-ring-on', process.cwd(), {});
    spawned.push(onId);
    const on = await read(onId);
    expect(markers(on)).toHaveLength(1);
    expect(on).toMatch(/OUTPUT TRUNCATED: \d+ bytes of the earliest output \(no longer kept\) omitted from the start, tail shown\. Only the latest output is kept\.\]\.\.\./);
    expect(on).not.toContain('[dropped');
  });
});
