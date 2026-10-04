/**
 * tool-dispatcher.offload.test.ts — Phase 3 (§1.5).
 *
 * Exercises the FS context-offload wiring through the REAL `gateAndDispatchTool`
 * chokepoint (not a mock that ignores the execCtx), against a real temp
 * filesystem — so a passing test here proves the file actually lands on disk
 * and the returned tool_result text actually shrinks, not that a stub says so.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';

const workingDir = join(tmpdir(), `tool-dispatcher-offload-test-${process.pid}`);
afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

const gate = { gateTool: vi.fn(async () => ({ decision: 'allow' as const })) };
const onPause = async () => 'PAUSED_HALT';

function bigResultTool(text: string): RawToolOptions {
  return {
    name: 'BigTool',
    description: 'test',
    parameters: { type: 'object', properties: {} } as any,
    execute: async () => text,
  };
}

describe('gateAndDispatchTool — FS context-offload (Phase 3, §1.5)', () => {
  it('AC-F1 — offloads an oversized result to the namespaced volume path and returns a small preview+path', async () => {
    const big = 'X'.repeat(30_000);
    const result = await gateAndDispatchTool(
      bigResultTool(big),
      {},
      'call-1',
      gate as any,
      onPause,
      undefined,
      { taskId: 'task-1', workingDir },
    );
    expect(result.isError).toBe(false);
    expect(result.text.length).toBeLessThan(big.length);
    expect(result.text).toContain('.kernel-offload/task-1/call-1.txt');

    const onDisk = await fs.readFile(join(workingDir, '.kernel-offload/task-1/call-1.txt'), 'utf8');
    expect(onDisk).toBe(big);
  });

  it('offload is a no-op when workingDir is absent — byte-identical to pre-offload behavior', async () => {
    const big = 'X'.repeat(30_000);
    const result = await gateAndDispatchTool(
      bigResultTool(big),
      {},
      'call-2',
      gate as any,
      onPause,
      undefined,
      { taskId: 'task-1' }, // no workingDir
    );
    expect(result.text).toBe(big); // unchanged — under guardToolOutput's 256K cap too
  });

  it('offload is a no-op when taskId is absent (no execCtx at all)', async () => {
    const big = 'X'.repeat(30_000);
    const result = await gateAndDispatchTool(bigResultTool(big), {}, 'call-3', gate as any, onPause);
    expect(result.text).toBe(big);
  });

  it('metering is byte-identical: addCostUsd fires from execute() with the FULL text still resolved, offload only changes the RETURNED text afterward', async () => {
    const seenCosts: number[] = [];
    const tool: RawToolOptions = {
      name: 'BillingTool',
      description: 'test',
      parameters: { type: 'object', properties: {} } as any,
      execute: async (_a: unknown, ctx: ToolExecuteContext) => {
        ctx.addCostUsd?.(0.05); // the tool's own cost — fired BEFORE offload ever runs
        return 'Y'.repeat(30_000);
      },
    };
    const result = await gateAndDispatchTool(
      tool, {}, 'call-4', gate as any, onPause, undefined,
      { taskId: 'task-2', workingDir, addCostUsd: (usd: number) => seenCosts.push(usd) },
    );
    expect(seenCosts).toEqual([0.05]); // cost capture untouched by the offload transform
    expect(result.text).toContain('.kernel-offload/task-2/call-4.txt'); // result WAS offloaded
  });

  it('emergency kill switch — a raised offloadThresholdChars override suppresses offload for a result that would otherwise trigger it', async () => {
    const big = 'X'.repeat(30_000);
    const result = await gateAndDispatchTool(
      bigResultTool(big), {}, 'call-killswitch', gate as any, onPause, undefined,
      { taskId: 'task-killswitch', workingDir, offloadThresholdChars: 1_000_000 },
    );
    expect(result.text).toBe(big); // untouched — the override raised the bar above this result's size
  });

  it('a small result under the threshold is never offloaded', async () => {
    const small = 'tiny result';
    const result = await gateAndDispatchTool(
      bigResultTool(small), {}, 'call-5', gate as any, onPause, undefined,
      { taskId: 'task-3', workingDir },
    );
    expect(result.text).toBe(small);
    await expect(fs.access(join(workingDir, '.kernel-offload'))).rejects.toThrow();
  });
});
