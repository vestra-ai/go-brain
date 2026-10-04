/**
 * Engines T5 (spec 2026-09-28 §6.9) — the `beforeFirstTurn` seam.
 *
 * The host gets ONE awaited call per run open, with the run's journal, after the prologue and
 * before the first user turn is read: the place a host can put something into the journal that
 * the run's first model call must see (the sandbox brings a subscription engine's conversation
 * over there). Pinned here because the properties are about WHEN, and none is visible from the
 * seam's type: once per open, awaited, after the prologue (so a prologue that failed never
 * reaches it), only on the journal path, and absent = nothing happens.
 */
import { describe, it, expect, vi } from 'vitest';
import { HookDispatcher } from '../../kernel/index.js';
import { openRun, type RunOpenDeps, type RunPrologue } from '../native-run-open.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { Transport } from '../transport.js';

function fakeJournal(order: string[]): NonNullable<NativeConfig['journal']> {
  return {
    project: async () => {
      order.push('project');
      return { messages: [] };
    },
  } as unknown as NonNullable<NativeConfig['journal']>;
}

const transport = {
  emptyHistory: () => [],
  classifyError: () => ({ kind: 'model_error', text: 'boom', raw: { subtype: 'error', errors: [] } }),
} as unknown as Transport;

function ctxWith(cfg: Partial<NativeConfig>): HarnessContext<NativeConfig> {
  return {
    taskId: 'task-1', sessionId: 'task-1', cwd: '/w', model: 'm', signal: new AbortController().signal,
    config: cfg as NativeConfig,
  } as unknown as HarnessContext<NativeConfig>;
}

function deps(order: string[], opts: { prologueThrows?: boolean } = {}): RunOpenDeps {
  return {
    buildPrologue: async () => {
      order.push('prologue');
      if (opts.prologueThrows) throw new Error('mcp connect exhausted');
      return { system: '', dispatcher: new HookDispatcher() } as unknown as RunPrologue;
    },
    runSignal: () => new AbortController().signal,
  };
}

/** Drive openRun to its return; collect what it yielded. */
async function open(ctx: HarnessContext<NativeConfig>, d: RunOpenDeps) {
  const gen = openRun(ctx, transport, d);
  const yielded: HarnessEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    yielded.push(r.value);
    r = await gen.next();
  }
  return { yielded, state: r.value };
}

describe('openRun — the beforeFirstTurn seam', () => {
  it('is awaited exactly once, with the run\'s journal and ctx, after the prologue and before openRun returns', async () => {
    const order: string[] = [];
    const journal = fakeJournal(order);
    let release: () => void = () => {};
    const hook = vi.fn(async () => {
      order.push('hook:start');
      await new Promise<void>((r) => { release = r; });
      order.push('hook:end');
    });
    const ctx = ctxWith({ journal, beforeFirstTurn: hook });

    const pending = open(ctx, deps(order));
    await vi.waitFor(() => expect(order).toContain('hook:start'));
    expect(order).not.toContain('hook:end'); // openRun is still waiting on the host
    release();
    const { state } = await pending;

    expect(state).not.toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(journal, ctx);
    // After the prologue; before the round-counter seed reads the journal, so what the host
    // appended is part of what the run starts from.
    expect(order).toEqual(['prologue', 'hook:start', 'hook:end', 'project']);
  });

  it('a seam that throws costs only itself: logged, and the run opens and goes on', async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = vi.fn(async () => { throw new Error('record unreadable'); });
    const { yielded, state } = await open(ctxWith({ journal: fakeJournal(order), beforeFirstTurn: hook }), deps(order));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(state).not.toBeNull();
    expect(yielded).toEqual([]);
    expect(order).toEqual(['prologue', 'project']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('beforeFirstTurn failed'));
    warn.mockRestore();
  });

  it('a prologue that failed never reaches it: the run ends with its one terminal turn_end', async () => {
    const order: string[] = [];
    const hook = vi.fn(async () => {});
    const { yielded, state } = await open(ctxWith({ journal: fakeJournal(order), beforeFirstTurn: hook }), deps(order, { prologueThrows: true }));

    expect(state).toBeNull();
    expect(yielded).toHaveLength(1);
    expect(hook).not.toHaveBeenCalled();
  });

  it('journal-less run: never called (there is nothing to put anything into)', async () => {
    const hook = vi.fn(async () => {});
    const { state } = await open(ctxWith({ beforeFirstTurn: hook }), deps([]));

    expect(state).not.toBeNull();
    expect(hook).not.toHaveBeenCalled();
  });

  it('absent: the open is exactly today\'s', async () => {
    const order: string[] = [];
    const { state } = await open(ctxWith({ journal: fakeJournal(order) }), deps(order));

    expect(state).not.toBeNull();
    expect(order).toEqual(['prologue', 'project']);
  });
});
