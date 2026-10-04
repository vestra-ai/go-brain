import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBashTool, stripTrailingClearScreen } from '../bash-tool.js';

const run = (cmd: string) => {
  const tool = makeBashTool(() => process.cwd(), 'task_test');
  return tool.execute({ command: cmd }, {}) as Promise<string>;
};

describe('Bash foreground output safety', () => {
  it('does NOT report a successful large-output command as failed', async () => {
    // ~2MB of output on stdout; exit 0. Today this throws maxBuffer and is
    // returned as "Command failed". After the fix it must be a success.
    const out = await run(`node -e "process.stdout.write('x'.repeat(2*1024*1024))"`);
    expect(out).not.toMatch(/^Command failed/);
    expect(out).toContain('x');
  });

  it('truncates very large success output with a marker', async () => {
    const out = await run(`node -e "process.stdout.write('y'.repeat(200*1024))"`);
    expect(out).toContain('OUTPUT TRUNCATED');
  });

  it('returns truncated output (not a failure) when output exceeds the 8MB buffer', async () => {
    const out = await run(`node -e "process.stdout.write('x'.repeat(9*1024*1024))"`);
    expect(out).toMatch(/output exceeded/);
    expect(out).not.toMatch(/^Command failed/);
  });
});

// L5 (TOOL_PROGRESS_WATCHDOG_V1): Bash's progress is its output. Every stdout and stderr chunk
// reaches ctx.noteProgress, so a command that keeps printing is never read as stalled.
describe('Bash output is its progress', () => {
  it('each stdout/stderr chunk calls ctx.noteProgress; absent, nothing is called', async () => {
    const tool = makeBashTool(() => process.cwd(), 'task_test');
    let beats = 0;
    const out = await tool.execute({ command: 'echo one; sleep 0.2; echo two 1>&2' }, { noteProgress: () => { beats += 1; } });
    expect(out).toContain('one');
    // Mutation: drop `onData` from the exec options (or the feed's call) → 0.
    expect(beats).toBeGreaterThanOrEqual(2);
    await expect(run('echo quiet')).resolves.toContain('quiet');
  });
});

// The drill (f5c905bd): every Bash result on the box ended `\n\x1b[3J\x1b[H\x1b[J`. The wrapper
// runs `bash -l` and ends with the `exit` builtin, so bash sources ~/.bash_logout, and a logout
// that clears the console prints the clear AFTER the command's output.
const CLEAR_LINUX = '\x1b[3J\x1b[H\x1b[J';

describe('stripTrailingClearScreen: exact trailing clears only', () => {
  it('cuts the clear forms from the end, repeated, and nothing else', () => {
    expect(stripTrailingClearScreen(`443\n${CLEAR_LINUX}`)).toBe('443\n');
    expect(stripTrailingClearScreen('443\n\x1b[3J\x1b[H\x1b[2J')).toBe('443\n'); // xterm, with the scrollback erase
    expect(stripTrailingClearScreen('443\n\x1b[H\x1b[J')).toBe('443\n');
    expect(stripTrailingClearScreen('443\n\x1b[H\x1b[2J')).toBe('443\n');
    expect(stripTrailingClearScreen(`443\n${CLEAR_LINUX}${CLEAR_LINUX}`)).toBe('443\n');
  });

  it('leaves every other escape, and a clear anywhere but the end, untouched', () => {
    expect(stripTrailingClearScreen(`${CLEAR_LINUX}443\n`)).toBe(`${CLEAR_LINUX}443\n`);
    expect(stripTrailingClearScreen('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
    expect(stripTrailingClearScreen('443\n\x1b[3J')).toBe('443\n\x1b[3J'); // not a whole clear
    expect(stripTrailingClearScreen(`${CLEAR_LINUX} `)).toBe(`${CLEAR_LINUX} `);
    expect(stripTrailingClearScreen('')).toBe('');
  });
});

describe('Bash: a login shell whose logout clears the screen', () => {
  const home = mkdtempSync(join(tmpdir(), 'bash-logout-home-'));
  const savedHome = process.env.HOME;
  let n = 0;
  // A fresh task per call: the persistent session is keyed by task id.
  const runAt = (cmd: string) =>
    makeBashTool(() => process.cwd(), `task_logout_${n++}`).execute({ command: cmd }, {}) as Promise<string>;

  beforeAll(() => {
    writeFileSync(join(home, '.bash_logout'), "printf '\\033[3J\\033[H\\033[J'\n");
    process.env.HOME = home;
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('the clear the logout prints never reaches the result', async () => {
    expect(await runAt('echo 443')).toBe('443\n');
  });

  it('a failing command, and one with stderr, lose it too', async () => {
    const failed = (await runAt('echo out; exit 3')) as unknown as { __toolError: { message: string } };
    expect(failed.__toolError.message).toMatch(/^Command failed:[\s\S]*\nout\n$/);
    expect(failed.__toolError.message).not.toContain('\x1b[');
    const withStderr = await runAt('echo out; echo warn >&2');
    expect(withStderr).toBe('out\n\nwarn\n');
  });
});
