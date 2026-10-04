/**
 * L5 (redo of #3333): every blocking read of a background task (the `process` tool's read
 * and its TaskOutput alias) is clamped to MAX_BLOCKING_WAIT_MS and honours the
 * dispatcher's signal. Before: the raw model value and (TaskOutput) no signal, so a
 * 30-minute wait held the round for all of it and Stop could not end it. Under the tool
 * watchdog, an uncapped wait on a working, printing build would read as a stalled call.
 */
import { describe, it, expect, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  getOutputBlocking: vi.fn(async () => ({ output: 'o', status: 'running', exitCode: null, pty: false, droppedBytes: 0 })),
  getOutput: vi.fn(() => ({ output: 'o', status: 'running', exitCode: null, pty: false, droppedBytes: 0 })),
}));
vi.mock('../process-registry.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ...registry }));

import { MAX_BLOCKING_WAIT_MS } from '../process-registry.js';
import { taskOutputToolOptions, makeTaskOutputTool } from '../task-output-tool.js';
import { processToolOptions, makeProcessTool } from '../process-tool.js';

const HALF_HOUR = 30 * 60_000;

describe('TaskOutput: a bounded wait that Stop can end', () => {
  it('a model-supplied timeout past the cap is clamped, and the dispatcher signal is passed through', async () => {
    const signal = new AbortController().signal;
    await taskOutputToolOptions.execute({ task_id: 'bg_1', block: true, timeout: HALF_HOUR }, { toolCallId: 'tu', signal });
    // Mutation: pass `a.timeout` raw -> 1,800,000 here; drop the signal -> undefined.
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_1', MAX_BLOCKING_WAIT_MS, signal, undefined);
  });

  it('a timeout under the cap is kept as given', async () => {
    await taskOutputToolOptions.execute({ task_id: 'bg_2', block: true, timeout: 5_000 }, { toolCallId: 'tu' });
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_2', 5_000, undefined, undefined);
  });

  it('block:false never waits', async () => {
    registry.getOutputBlocking.mockClear();
    await taskOutputToolOptions.execute({ task_id: 'bg_3', block: false, timeout: 5_000 }, { toolCallId: 'tu' });
    expect(registry.getOutputBlocking).not.toHaveBeenCalled();
    expect(registry.getOutput).toHaveBeenCalledWith('bg_3', undefined);
  });
});

describe('process read: the same cap, so a long poll of a working build returns [running]', () => {
  it('a half-hour blocking read is clamped and keeps the signal; the answer is [running] with the output', async () => {
    const signal = new AbortController().signal;
    const out = await processToolOptions.execute({ action: 'read', id: 'bg_9', block: true, timeout: HALF_HOUR }, { toolCallId: 'tu', signal });
    // Mutation: pass `a.timeout` raw (the review's finding 1) -> 1,800,000 here.
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_9', MAX_BLOCKING_WAIT_MS, signal, undefined);
    expect(out).toMatch(/^\[running\]\no$/);
  });

  it('the default wait (30 s) and a short one are kept as given', async () => {
    await processToolOptions.execute({ action: 'read', id: 'bg_a', block: true }, { toolCallId: 'tu' });
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_a', 30_000, undefined, undefined);
    await processToolOptions.execute({ action: 'read', id: 'bg_b', block: true, timeout: 5_000 }, { toolCallId: 'tu' });
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_b', 5_000, undefined, undefined);
  });
});

describe('the scoped builds the catalog registers pass their owner to every wait and read', () => {
  it('TaskOutput and process read carry the task id (another task reads as unknown)', async () => {
    const signal = new AbortController().signal;
    await makeTaskOutputTool('task-own').execute({ task_id: 'bg_c', block: true, timeout: HALF_HOUR }, { toolCallId: 'tu', signal });
    expect(registry.getOutputBlocking).toHaveBeenLastCalledWith('bg_c', MAX_BLOCKING_WAIT_MS, signal, 'task-own');
    await makeProcessTool('task-own').execute({ action: 'read', id: 'bg_d' }, { toolCallId: 'tu' });
    expect(registry.getOutput).toHaveBeenLastCalledWith('bg_d', 'task-own');
  });
});
