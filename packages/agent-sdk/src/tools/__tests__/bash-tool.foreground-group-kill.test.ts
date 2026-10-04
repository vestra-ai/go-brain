/**
 * bash-tool.foreground-group-kill.test.ts — Hardening-H, FOREGROUND half.
 *
 * #1700 gave the BACKGROUND bash path a detached process group + escalating
 * tree-kill (see process-registry.lifecycle.test.ts). The FOREGROUND path was
 * left on a plain execFile: on interrupt/timeout Node SIGTERMs only the `bash -lc`
 * shell, so a command that forks a subtree (`foo &`, dev server, worker pool)
 * ORPHANS that subtree — it survives in the persistent one-user sandbox.
 *
 * These tests use REAL short-lived processes (matching the registry suite). A
 * grandchild pid is recorded to a file; after interrupt/timeout it MUST be dead.
 * The two kill tests are RED on the pre-#1700-foreground code (the orphaned
 * grandchild stays alive); the regression tests guard byte-identical non-interrupt
 * behavior (output fidelity is also pinned by bash-tool.output/tool-error suites).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBashTool } from '../bash-tool.js';
import { isToolError } from '../tool-types.js';

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is true or the deadline passes; returns fn()'s final value. */
async function until(fn: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await flush(stepMs);
  }
  return fn();
}

/** Signal-0 liveness probe: true while the pid (or a reused pid) exists. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('Bash foreground — process-group kill (Hardening-H foreground half)', () => {
  let dir: string;
  const savedGrace = process.env.VESTRA_KILL_GRACE_MS;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fg-group-'));
    process.env.VESTRA_KILL_GRACE_MS = '150'; // fast SIGTERM → SIGKILL escalation for tests
  });
  afterEach(() => {
    if (savedGrace === undefined) delete process.env.VESTRA_KILL_GRACE_MS;
    else process.env.VESTRA_KILL_GRACE_MS = savedGrace;
    rmSync(dir, { recursive: true, force: true });
  });

  it('abort reaps the whole subtree: a forked grandchild dies with the shell, classified aborted', async () => {
    const gpidFile = join(dir, 'gpid');
    const ac = new AbortController();
    const bash = makeBashTool(() => process.cwd(), 'task_fg_abort_tree');
    // `sleep 30 &` is a grandchild of node (backgrounded under the wrapper bash),
    // then the shell waits. Child-only SIGTERM kills the wrapper bash and ORPHANS
    // sleep (reparented, still alive). A process-GROUP kill reaps sleep too.
    const p = bash.execute(
      { command: `sleep 30 & echo $! > ${gpidFile}; wait`, timeout: 600_000 },
      { signal: ac.signal },
    );
    await until(() => existsSync(gpidFile) && readFileSync(gpidFile, 'utf8').trim() !== '');
    const gpid = Number(readFileSync(gpidFile, 'utf8').trim());
    expect(Number.isInteger(gpid)).toBe(true);
    expect(alive(gpid)).toBe(true); // grandchild running before the abort

    ac.abort();
    const res = await p; // returns promptly (does NOT hang out the 600s timeout)
    expect(isToolError(res)).toBe(true);
    if (!isToolError(res)) throw new Error('unreachable');
    expect(res.__toolError.code).toBe('aborted'); // classification preserved (charter C)

    expect(await until(() => !alive(gpid))).toBe(true); // subtree reaped
  }, 5_000);

  it('timeout reaps the whole subtree and classifies as timeout', async () => {
    const gpidFile = join(dir, 'gpid2');
    const bash = makeBashTool(() => process.cwd(), 'task_fg_timeout_tree');
    const p = bash.execute(
      { command: `sleep 30 & echo $! > ${gpidFile}; wait`, timeout: 300 }, // short real timeout
      {},
    );
    const res = await p;
    expect(isToolError(res)).toBe(true);
    if (!isToolError(res)) throw new Error('unreachable');
    expect(res.__toolError.code).toBe('timeout'); // killed-by-timeout, not aborted

    const gpid = Number(readFileSync(gpidFile, 'utf8').trim());
    expect(Number.isInteger(gpid)).toBe(true);
    expect(await until(() => !alive(gpid))).toBe(true); // subtree reaped on timeout
  }, 5_000);

  it('non-interrupt success is unchanged: output preserved, not a tool error', async () => {
    const bash = makeBashTool(() => process.cwd(), 'task_fg_ok');
    const res = await bash.execute({ command: `printf 'line1\\nline2\\n'` }, {});
    expect(isToolError(res)).toBe(false);
    expect(res as string).toContain('line1');
    expect(res as string).toContain('line2');
  });

  it('non-interrupt non-zero exit is unchanged: exec_failed, stderr captured', async () => {
    const bash = makeBashTool(() => process.cwd(), 'task_fg_fail');
    const res = await bash.execute({ command: `echo boom 1>&2; exit 7` }, {});
    expect(isToolError(res)).toBe(true);
    if (!isToolError(res)) throw new Error('unreachable');
    expect(res.__toolError.code).toBe('exec_failed');
    expect(res.__toolError.message).toMatch(/^Command failed:/);
    expect(res.__toolError.message).toContain('boom');
  });

  it('multibyte output split across stdout chunks stays intact', async () => {
    const bash = makeBashTool(() => process.cwd(), 'task_fg_mb');
    // Emit the 4 UTF-8 bytes of 😀 (F0 9F 98 80) in two writes with a gap so they land
    // as SEPARATE stdout chunks. A per-chunk Buffer→string corrupts the codepoint; a
    // stream utf8 decoder (as execFile did) keeps it whole.
    const res = await bash.execute(
      { command: `printf '\\360\\237'; sleep 0.2; printf '\\230\\200\\n'` },
      {},
    );
    expect(isToolError(res)).toBe(false);
    expect(res as string).toContain('😀');
    expect(res as string).not.toContain('�');
  });
});
