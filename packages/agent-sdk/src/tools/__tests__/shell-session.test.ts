/**
 * SHELL_SESSION_V1 (harness to nine T4) — a shell session that hands back and takes more input.
 *
 * The contract's drill, proven on the real tools (real shells, no mocks):
 *  1. A long build returns partial output after `yield_ms` and keeps running; a later read
 *     returns only what is new, then the exit.
 *  2. Input reaches an interactive prompt: the waiting prompt is visible in the hand-back,
 *     and submit returns the program's reply.
 *  3. Per-session isolation (NOT behind the flag, a bug fix): one task can never read, feed,
 *     stop or list another task's process, through process, TaskOutput or TaskStop.
 * Plus: flag off is byte-identical; a command that ends inside its window is a foreground
 * result (its cd applies, the registry forgets it); a handed-back command's cd never
 * applies; a user interrupt during the window kills the command.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toToolJsonSchema } from '../../contract/tool-json-schema.js';
import { makeBashTool } from '../bash-tool.js';
import { makeProcessTool, processToolOptions } from '../process-tool.js';
import { makeTaskOutputTool } from '../task-output-tool.js';
import { makeTaskStopTool } from '../task-stop-tool.js';
import { TOOL_DESCRIPTIONS } from '../descriptions/index.js';
import { cleanupSession } from '../terminal-session.js';
import { spawnBackground, stopProcess, getStatus, killByTask, _processCount, readNewOutput, waitForProcess } from '../process-registry.js';
import { isToolError } from '../tool-types.js';

const FLAG = 'SHELL_SESSION_V1';
const prev = process.env[FLAG];
const owners = new Set<string>();
afterEach(() => {
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
  for (const id of owners) { killByTask(id); cleanupSession(id); }
  owners.clear();
});

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
}

/** A Bash tool and a process tool for one task, built under the flag value given. */
function shell(task: string, flag: string | undefined = 'true', dir = mkdtempSync(join(tmpdir(), 'vt-sess-'))) {
  setFlag(flag);
  owners.add(task);
  const bash = makeBashTool(() => dir, task);
  const proc = makeProcessTool(task);
  return {
    dir,
    bash: (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) => bash.execute(args, ctx),
    proc: (args: Record<string, unknown>) => proc.execute(args, {}) as Promise<string>,
  };
}

/** The bg_ id a hand-back names (the test reads the text the model reads). */
function handedBackId(out: unknown): string {
  const m = /Still running as (bg_[0-9a-f]+)/.exec(String(out));
  if (!m) throw new Error(`no hand-back in: ${String(out)}`);
  return m[1] as string;
}

describe('SHELL_SESSION_V1 off: byte-identical', () => {
  it('Bash has no yield_ms and keeps its key order; process keeps its text and schema', () => {
    for (const v of [undefined, 'false', '0', '']) {
      setFlag(v);
      const bash = toToolJsonSchema(makeBashTool(() => '/tmp', 'task-off').parameters) as unknown as { properties: Record<string, unknown> };
      expect(Object.keys(bash.properties)).toEqual(['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox', 'pty']);
      const proc = makeProcessTool('task-off');
      expect(proc.description).toBe(TOOL_DESCRIPTIONS.process);
      expect(toToolJsonSchema(proc.parameters)).toEqual(toToolJsonSchema(processToolOptions.parameters));
    }
  });

  it('a yield_ms the model sends anyway is ignored: the command runs in the foreground', async () => {
    const s = shell('task-off-run', 'false');
    const out = await s.bash({ command: 'echo fg-ran', yield_ms: 50 });
    expect(out).toContain('fg-ran');
    expect(String(out)).not.toContain('Still running');
  });
});

describe('SHELL_SESSION_V1 on: the schema', () => {
  it('Bash gains yield_ms LAST, an optional positive integer; process names the session read', () => {
    setFlag('true');
    const bash = toToolJsonSchema(makeBashTool(() => '/tmp', 'task-on').parameters) as unknown as { properties: Record<string, unknown> };
    const keys = Object.keys(bash.properties);
    expect(keys[keys.length - 1]).toBe('yield_ms');
    expect(makeProcessTool('task-on').description).toMatch(/since your last read/);
  });
});

describe('SHELL_SESSION_V1 on: a long build returns partial output and continues', () => {
  it('hands back the first lines after yield_ms, keeps running, and the next read returns only what is new', async () => {
    const s = shell('task-build');
    const out = await s.bash({ command: 'echo step-1; sleep 3; echo step-2; echo done', yield_ms: 1000 });
    expect(isToolError(out)).toBe(false);
    expect(out).toContain('step-1');
    expect(String(out)).not.toContain('step-2');
    const id = handedBackId(out);
    expect(getStatus(id, 'task-build')).toBe('running');

    const more = await s.proc({ action: 'read', id, block: true, timeout: 15_000 });
    expect(more).toContain('step-2');
    expect(more).toContain('done');
    expect(more).not.toContain('step-1'); // already read in the hand-back
    expect(more).toMatch(/^\[exited exit=0\]/);

    const again = await s.proc({ action: 'read', id });
    expect(again).toContain('(no new output)');
  }, 30_000);

  it('a read keeps the newest lines within limit and counts the rest; offset still pages the whole output', async () => {
    const s = shell('task-limit');
    const out = await s.bash({ command: 'echo a-1; sleep 1.5; for i in 1 2 3 4 5 6; do echo b-$i; done; sleep 5', yield_ms: 600 });
    expect(out).toContain('a-1');
    const id = handedBackId(out);
    expect(await s.proc({ action: 'read', id })).toContain('(no new output)');
    const page = await s.proc({ action: 'read', id, limit: 2, block: true, timeout: 2500 });
    expect(page).toContain('b-5');
    expect(page).toContain('b-6');
    expect(page).not.toContain('b-4');
    // The one truncation marker (T5), naming the exact read that pages the skipped lines back.
    expect(page).toContain(
      `...[OUTPUT TRUNCATED: 4 lines omitted from the start, tail shown. Read the skipped lines with process(action="read", id="${id}", offset=1, limit=4).]...`,
    );
    const skipped = await s.proc({ action: 'read', id, offset: 1, limit: 4 });
    for (const l of ['b-1', 'b-2', 'b-3', 'b-4']) expect(skipped).toContain(l);
    expect(skipped).not.toContain('a-1');
    expect(skipped).not.toContain('b-5');
    const whole = await s.proc({ action: 'read', id, offset: 0 });
    expect(whole).toContain('a-1');
    expect(whole).toContain('b-4');
  }, 30_000);
});

describe('SHELL_SESSION_V1 on: output that never ends its line, and output the budget dropped', () => {
  it('a flood without newlines stays bounded: it lands as lines, and a read shows only the newest of the pending line', async () => {
    const s = shell('task-flood');
    // The flood's last bytes may all have been pushed as lines (pipe chunking decides), so a known
    // tail without a newline follows it: the pending line is never empty when the reads look.
    const out = await s.bash({ command: 'head -c 300000 /dev/zero | tr "\\0" a; sleep 0.5; printf tail-end; sleep 30', yield_ms: 1500 });
    const id = handedBackId(out);
    // The pending line is capped where it is kept: past 64 KB it became lines in the buffer,
    // which the whole-output read pages (before: an empty buffer, the flood held in memory).
    const whole = await s.proc({ action: 'read', id, offset: 0, limit: 2 });
    expect(whole.length).toBeGreaterThan(65_536);
    // ...and where it is shown: the next read is the pending line's newest 2 KB, not 300 KB again.
    const next = await s.proc({ action: 'read', id });
    expect(next.length).toBeLessThan(4096);
    expect(next.endsWith('tail-end')).toBe(true);
  }, 30_000);

  it('the shown partial never starts on half of a character (a surrogate pair cut at the 2 K edge)', async () => {
    owners.add('task-surrogate');
    // X, 1100 four-byte characters (each a surrogate pair), Y: 2202 UTF-16 units, so the newest
    // 2048 would start on the low half of a pair.
    const id = spawnBackground(
      "printf X; i=0; while [ $i -lt 1100 ]; do printf '\\360\\237\\230\\200'; i=$((i+1)); done; printf Y; sleep 30",
      'task-surrogate',
      process.cwd(),
    );
    await waitForProcess(id, 10_000, { ownerTaskId: 'task-surrogate', settleMs: 500 });
    const shown = readNewOutput(id, 'task-surrogate').text;
    expect(shown.endsWith('Y')).toBe(true);
    expect(shown.charCodeAt(0) & 0xfc00).not.toBe(0xdc00);
    expect(shown).toHaveLength(2047);
  }, 30_000);

  it("a progress bar shows its current frame, and stdout's and stderr's pending lines never run together", async () => {
    const s = shell('task-frames');
    const out = String(await s.bash({
      command: "printf 'loading 10%%\\rloading 20%%\\rloading 30%%'; printf 'err-part' >&2; sleep 30",
      yield_ms: 1000,
    }));
    expect(out).toContain('loading 30%\nerr-part');
    expect(out).not.toContain('loading 10%');
    expect(out).not.toContain('30%err-part');
  }, 30_000);

  it('a yielded command whose earliest lines the byte budget dropped says so in the one marker', async () => {
    process.env.VESTRA_BG_BUFFER_BYTES = '64';
    try {
      const s = shell('task-dropped');
      // Ends inside its window: the foreground-style result.
      const done = String(await s.bash({ command: 'for i in $(seq 1 50); do echo line-$i; done', yield_ms: 10_000 }));
      expect(done).toMatch(/^\.\.\.\[OUTPUT TRUNCATED: \d+ earlier lines \(no longer kept\) omitted from the start, tail shown\. Only the latest output is kept\.\]\.\.\./);
      expect(done).toContain('line-50');
      expect(done).not.toContain('line-1\n');
      // Still running: the hand-back carries it too.
      const handed = String(await s.bash({ command: 'for i in $(seq 1 50); do echo row-$i; done; sleep 30', yield_ms: 1000 }));
      expect(handed).toContain('earlier lines (no longer kept) omitted from the start');
      expect(handed).toContain('Still running as');
    } finally {
      delete process.env.VESTRA_BG_BUFFER_BYTES;
    }
  }, 30_000);
});

describe('SHELL_SESSION_V1 on: input reaches an interactive prompt', () => {
  it('the waiting prompt shows in the hand-back, and submit returns the reply and the exit', async () => {
    const s = shell('task-prompt');
    const out = await s.bash({ command: 'printf "Name? "; read n; echo "hi $n"', yield_ms: 1000 });
    expect(out).toContain('Name? ');
    const id = handedBackId(out);

    const reply = await s.proc({ action: 'submit', id, data: 'Ada', timeout: 10_000 });
    expect(reply).toContain('Submitted input to');
    expect(reply).toContain('hi Ada');
    expect(reply).toContain('[exited exit=0]');
  }, 30_000);

  it('write returns what the program echoes back, and a dangerous submit is still refused', async () => {
    const s = shell('task-cat');
    const id = handedBackId(await s.bash({ command: 'cat', yield_ms: 300 }));
    const reply = await s.proc({ action: 'write', id, data: 'echo-me\n', timeout: 5000 });
    expect(reply).toContain('echo-me');
    expect(await s.proc({ action: 'submit', id, data: 'rm -rf /' })).toMatch(/Blocked dangerous input/);
  }, 30_000);
});

describe('SHELL_SESSION_V1 on: a command that ends inside its window', () => {
  it('returns as a foreground result, applies its cd, and is forgotten', async () => {
    const s = shell('task-quick');
    const before = _processCount();
    const out = await s.bash({ command: 'mkdir -p sub && cd sub && echo quick-ok', yield_ms: 10_000 });
    expect(out).toContain('quick-ok');
    expect(String(out)).not.toContain('Still running');
    expect(_processCount()).toBe(before);
    const pwd = await s.bash({ command: 'pwd' });
    expect(String(pwd)).toContain('/sub');
  }, 30_000);

  it('a non-zero exit is an exec_failed sentinel carrying the output', async () => {
    const s = shell('task-fail');
    const out = await s.bash({ command: 'echo about-to-fail; exit 4', yield_ms: 10_000 });
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('exec_failed');
    expect(out.__toolError.message).toContain('exit 4');
    expect(out.__toolError.message).toContain('about-to-fail');
  }, 30_000);

  it('a handed-back command never moves the shell, even after it ends', async () => {
    const s = shell('task-nocd');
    const id = handedBackId(await s.bash({ command: 'mkdir -p away && cd away && sleep 1.5', yield_ms: 300 }));
    await s.proc({ action: 'read', id, block: true, timeout: 10_000 });
    const pwd = await s.bash({ command: 'pwd' });
    expect(String(pwd)).not.toContain('/away');
  }, 30_000);

  it('a user interrupt during the window kills the command', async () => {
    const s = shell('task-abort');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const out = await s.bash({ command: 'echo started; sleep 20', yield_ms: 10_000 }, { signal: ac.signal });
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('aborted');
  }, 30_000);
});

describe('per-session isolation (not behind the flag)', () => {
  for (const flag of [undefined, 'true']) {
    it(`flag ${flag ?? 'unset'}: another task can never read, feed, stop or list a process`, async () => {
      setFlag(flag);
      owners.add('task-iso-a');
      const id = spawnBackground('echo secret-a; sleep 10', 'task-iso-a', process.cwd());
      try {
        const other = makeProcessTool('task-iso-b');
        const read = await other.execute({ action: 'read', id, block: true, timeout: 300 }, {}) as string;
        expect(read).toContain('Unknown background task');
        expect(read).not.toContain('secret-a');
        expect(await other.execute({ action: 'list' }, {})).toBe('No background tasks.');
        expect(await other.execute({ action: 'submit', id, data: 'x' }, {})).toMatch(/Unknown background task/);
        expect(await other.execute({ action: 'close', id }, {})).toMatch(/Unknown background task/);
        expect(await other.execute({ action: 'kill', id }, {})).toMatch(/Unknown background task/);
        expect(await makeTaskOutputTool('task-iso-b').execute({ task_id: id, block: false, timeout: 0 }, {})).toMatch(/^\[unknown\]/);
        expect(await makeTaskStopTool('task-iso-b').execute({ task_id: id }, {})).toMatch(/Unknown background task/);
        expect(getStatus(id)).toBe('running');

        // The owner reads, lists and stops it.
        const mine = makeProcessTool('task-iso-a');
        expect(await mine.execute({ action: 'read', id, block: true, timeout: 500 }, {})).toContain('secret-a');
        expect(await mine.execute({ action: 'list' }, {})).toContain(id);
        expect(await makeTaskStopTool('task-iso-a').execute({ task_id: id }, {})).toMatch(/Stopped/);
      } finally {
        stopProcess(id);
      }
    }, 15_000);
  }
});
