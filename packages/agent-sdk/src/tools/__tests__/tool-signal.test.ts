/**
 * tool-signal.test.ts — Harness 2.0 P3 (PR-2): the blocking tools consume the
 * abort signal the engine already delivers on `ToolExecuteContext.signal`.
 *
 * Each test spawns a REAL child that would otherwise block far past the test's own
 * 5s vitest bound; aborting mid-flight must return promptly. The 5s bound IS the
 * assertion — if the tool ignored the signal, the child runs to its own (much
 * longer) timeout and vitest fails the test. No fake timers: child-process abort
 * is a real-clock event.
 *
 * `rg` is not a standalone binary on PATH in local dev (it ships inside the CLI),
 * so the glob/grep cases stub an executable `rg` on PATH that blocks — the tools'
 * real `execFile('rg', …, { signal })` path runs unchanged against it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { makeBashTool } from '../bash-tool.js';
import { makeGlobTool } from '../glob-tool.js';
import { makeGrepTool } from '../grep-tool.js';
import { processToolOptions } from '../process-tool.js';
import { spawnBackground, stopProcess } from '../process-registry.js';
import { isToolError } from '../tool-types.js';

/** Write an executable `rg` stub that blocks until killed, prepend it to PATH,
 *  and return a restore fn. `exec sleep` so the abort SIGTERM hits the sleep
 *  directly (no orphaned grandchild). */
function stubBlockingRg(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-rg-stub-'));
  const rg = join(dir, 'rg');
  writeFileSync(rg, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(rg, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ''}`;
  return {
    dir,
    restore: () => {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('P3 tools consume ctx.signal', () => {
  it('bash foreground child dies on abort instead of waiting out the timeout, classified aborted', async () => {
    const ac = new AbortController();
    const bash = makeBashTool(() => process.cwd(), 'task_signal_bash');
    const p = bash.execute(
      { command: `${process.execPath} -e "setTimeout(()=>{}, 600000)"`, timeout: 600_000 },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    const res = await p; // returns promptly (does NOT hang 600s)
    // Charter C: a user abort classifies as 'aborted', NOT 'timeout'.
    expect(isToolError(res)).toBe(true);
    if (!isToolError(res)) throw new Error('unreachable');
    expect(res.__toolError.code).toBe('aborted');
    // Flag-OFF byte-identity: the message stays a plain "Command failed:" string,
    // so the dispatcher's flag-OFF path (result = message) is unchanged.
    expect(res.__toolError.message).toMatch(/^Command failed:/);
  }, 5_000);

  it('glob child dies on abort instead of blocking on a wedged rg', async () => {
    const stub = stubBlockingRg();
    const ws = mkdtempSync(join(tmpdir(), 'sdk-glob-ws-'));
    try {
      const ac = new AbortController();
      const glob = makeGlobTool(() => ws);
      const p = glob.execute({ pattern: '**/*' }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      const res = (await p) as string;
      expect(res.toLowerCase()).toMatch(/abort/);
    } finally {
      stub.restore();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 5_000);

  it('grep child dies on abort instead of blocking on a wedged rg', async () => {
    const stub = stubBlockingRg();
    const ws = mkdtempSync(join(tmpdir(), 'sdk-grep-ws-'));
    try {
      const ac = new AbortController();
      const grep = makeGrepTool(() => ws);
      const p = grep.execute({ pattern: 'needle', output_mode: 'content' }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      const res = (await p) as string;
      expect(res.toLowerCase()).toMatch(/abort/);
    } finally {
      stub.restore();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 5_000);

  it('process read(block:true) returns on abort instead of blocking on a live child', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-proc-ws-'));
    const id = spawnBackground('sleep 30', 'task_signal_proc', ws);
    try {
      const ac = new AbortController();
      const p = processToolOptions.execute(
        { action: 'read', id, block: true, timeout: 600_000 },
        { signal: ac.signal },
      );
      setTimeout(() => ac.abort(), 50);
      const res = (await p) as string;
      expect(res.toLowerCase()).toMatch(/abort/);
    } finally {
      stopProcess(id);
      rmSync(ws, { recursive: true, force: true });
    }
  }, 5_000);

  it('no-signal calls are byte-identical: a plain bash failure still classifies normally', async () => {
    // Regression guard for the conditional-spread: with no ctx.signal, the abort
    // branch is never taken — a non-zero exit stays exec_failed, a timeout stays
    // timeout (proven together with bash-tool.tool-error.test.ts).
    const bash = makeBashTool(() => process.cwd(), 'task_signal_none');
    const res = await bash.execute({ command: `node -e "process.exit(2)"` }, {});
    expect(isToolError(res)).toBe(true);
    if (!isToolError(res)) throw new Error('unreachable');
    expect(res.__toolError.code).toBe('exec_failed');
  }, 5_000);
});
