import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeBashTool } from '../bash-tool.js';
import { stripCwdTrailer, formatCwdTrailer } from '../cwd-trailer.js';
import { isToolError } from '../tool-types.js';
import { cleanupSession } from '../terminal-session.js';
import { getOutputBlocking } from '../process-registry.js';

const owners: string[] = [];
const run = (id: string, dir: string, cmd: string) => {
  owners.push(id);
  const tool = makeBashTool(() => dir, id);
  return tool.execute({ command: cmd }, {}) as Promise<string>;
};
afterEach(() => { for (const id of owners.splice(0)) cleanupSession(id); });

describe('Bash foreground cwd persistence (P2)', () => {
  it('persists cd across two Bash calls in the same task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-cd-'));
    const id = 'task_cd';
    await run(id, dir, 'mkdir -p sub && cd sub');
    const out = await run(id, dir, 'pwd');
    expect(out.trim()).toContain('/sub');
  });

  it('does NOT leak cwd across different tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-iso-'));
    await run('task_a', dir, 'mkdir -p aaa && cd aaa');
    const out = await run('task_b', dir, 'pwd');
    expect(out.trim()).not.toContain('/aaa');
  });

  it('falls back to the working dir when the persisted cwd was deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-del-'));
    const id = 'task_del';
    await run(id, dir, 'mkdir -p gone && cd gone');
    await run(id, dir, 'rmdir "$(pwd)"'); // delete the cwd we are sitting in
    const out = await run(id, dir, 'pwd'); // must not hard-fail
    expect(out).not.toMatch(/^Command failed/);
    expect(out.trim()).toContain(dir);
  });

  // ── File-tool senses (wordware fix): the [cwd: …] trailer ──────────────────

  it('a drifted cwd is announced on every result: [cwd: …] trailer after cd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-trail-'));
    const id = 'task_trailer';
    await run(id, dir, 'mkdir -p sub && cd sub');
    const out = await run(id, dir, 'echo hello');
    expect(out).toContain('hello');
    expect(out).toMatch(/\[cwd: .*\/sub\]$/);
  });

  it('at the workspace root there is NO trailer (zero noise, incl. symlinked spellings)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-root-'));
    const out = await run('task_root', dir, 'echo clean');
    expect(out).toContain('clean');
    expect(out).not.toContain('[cwd:');
  });

  it('a FAILING command from a drifted cwd carries the trailer too — the failure is where drift bites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-trailfail-'));
    const id = 'task_trailfail';
    await run(id, dir, 'mkdir -p deep && cd deep');
    const out = (await run(id, dir, 'ls no-such-thing-here')) as unknown;
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.message).toMatch(/^Command failed/);
    expect(out.__toolError.message).toMatch(/\[cwd: .*\/deep\]$/);
  });

  it('stripCwdTrailer removes exactly one engine trailer and is idempotent (consumers that parse Bash bytes rely on it)', () => {
    const body = '{"type":"item_created","item":{"id":"i1"}}';
    const withTrailer = body + formatCwdTrailer('/app/workspace/sub');
    expect(stripCwdTrailer(withTrailer)).toBe(body);
    expect(stripCwdTrailer(stripCwdTrailer(withTrailer))).toBe(body); // idempotent
    expect(stripCwdTrailer(body)).toBe(body); // no trailer → untouched
    // A [cwd: …] that is NOT the final line is user content, not the trailer.
    const interior = `[cwd: /fake]\nreal output`;
    expect(stripCwdTrailer(interior)).toBe(interior);
  });

  it('cd back to the root removes the trailer again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-return-'));
    const id = 'task_return';
    await run(id, dir, 'mkdir -p away && cd away');
    await run(id, dir, `cd "${dir}"`);
    const out = await run(id, dir, 'echo back');
    expect(out).not.toContain('[cwd:');
  });

  it('still truncates very large output with a marker (P0 preserved)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-big-'));
    const out = await run('task_big', dir, `node -e "process.stdout.write('y'.repeat(200*1024))"`);
    expect(out).toContain('OUTPUT TRUNCATED');
  });

  it('still reports a genuinely failing command as a Command failed error sentinel', async () => {
    // Hardening-G: the tool now returns a typed sentinel (never-throw) on failure; the
    // message stays the classic `Command failed:` string (the dispatcher's flag-OFF path
    // unwraps it back to that string, so the model still sees today's output).
    const dir = mkdtempSync(join(tmpdir(), 'vt-fail-'));
    const out = (await run('task_fail', dir, 'exit 3')) as unknown;
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('exec_failed');
    expect(out.__toolError.message).toMatch(/^Command failed/);
  });
});

describe('Bash background inherits session cwd (P2)', () => {
  it('starts a background job in the persisted cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-bg-'));
    const id = 'task_bg';
    await run(id, dir, 'mkdir -p bgsub && cd bgsub');
    const tool = makeBashTool(() => dir, id);
    owners.push(id);
    const started = (await tool.execute({ command: 'pwd', run_in_background: true }, {})) as string;
    const bgId = started.match(/bg_[a-f0-9]+/)?.[0] as string;
    expect(bgId).toBeTruthy();
    const { output } = await getOutputBlocking(bgId, 3000);
    expect(output).toContain('/bgsub');
  });
});

const runEnv = (id: string, dir: string, cmd: string) => {
  owners.push(id);
  const tool = makeBashTool(() => dir, id, { envCapture: true });
  return tool.execute({ command: cmd }, {}) as Promise<string>;
};

// `env -0` is GNU/Linux-only; macOS dev hosts skip the live round-trip.
describe.skipIf(process.platform === 'darwin')('Bash exported-env persistence (P3, flag on)', () => {
  it('persists export across two Bash calls when envCapture is on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-env-'));
    const id = 'task_env_on';
    await runEnv(id, dir, 'export FOO=bar');
    const out = await runEnv(id, dir, 'echo "FOO=$FOO"');
    expect(out).toContain('FOO=bar');
  });
});

// Default-off safety: this guard must run on ALL platforms (no env -0 needed).
describe('Bash exported-env does NOT persist when envCapture is off (default)', () => {
  it('NOPE is empty on second call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-env-off-'));
    const id = 'task_env_off';
    await run(id, dir, 'export NOPE=1'); // run() uses the default factory (no envCapture)
    const out = await run(id, dir, 'echo "NOPE=$NOPE"');
    expect(out).toContain('NOPE=');
    expect(out).not.toContain('NOPE=1');
  });
});
