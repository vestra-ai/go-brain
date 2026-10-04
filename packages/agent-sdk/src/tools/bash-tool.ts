import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { checkDangerousBashCommand } from '../policy/index.js';
import {
  spawnBackground, waitForProcess, readNewOutput, releaseProcess, stopProcess, registerLineListener,
} from './process-registry.js';
import { getSession, type TerminalSession } from './terminal-session.js';
import { toolDescription } from './descriptions/trimmed.js';
import { truncateOutput } from './output-limits.js';
import { shellSessionEnabled, toolDescTrimEnabled, toolOutputTokenBudgetEnabled, toolResultShapeEnabled } from '../policy/feature-flags.js';
import { truncationMarker, softFail, REDIRECT_RECOVERY } from './result-shape.js';
import { formatCwdTrailer } from './cwd-trailer.js';
import { newOutputMarker } from './process-tool.js';
import { toolError } from './tool-types.js';
import type { RawToolOptions, ToolExecuteContext, ToolErrorSentinel } from './tool-types.js';

/** Same directory, tolerant of symlink spellings (macOS /var vs /private/var). */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false; // either path unreadable — treat as different (trailer shows)
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** The longest one foreground command may run (its own declared cap). Exported for the tool watchdog window pin (L5). */
export const BASH_MAX_TIMEOUT_MS = 600_000;
const MAX_EXEC_BUFFER = 8 * 1024 * 1024; // 8MB, matching grep/glob
const DEFAULT_KILL_GRACE_MS = 2000;      // SIGTERM → grace → SIGKILL, matching the background path

/** C2 on: the bound on what one command hands the spill (a whole output up to it). */
const SPILL_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The 50 KB byte cap. C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1) on: the dispatcher spills the output to
 * a file and holds the model's token budget, so the cap rises to 2 MB: an output up to that is
 * spilled whole, and above it a 2 MB head and tail whose marker says to redirect to a file.
 */
function capOutput(text: string): string {
  return truncateOutput(text, toolOutputTokenBudgetEnabled() ? SPILL_CAP_BYTES : undefined).text;
}

/**
 * The screen clears a login shell writes on its way out. The wrapper runs `bash -l` and ends
 * with the `exit` builtin, which makes bash source `~/.bash_logout`; a logout that clears the
 * screen (Debian's stock one, at SHLVL 1, or a plain `clear`) prints it for `$TERM` to stdout, AFTER
 * the command's own output: `ESC[3J ESC[H ESC[J` under TERM=linux, on every result and in
 * every spill (drill f5c905bd). These exact sequences (the clear with and without the
 * scrollback erase, for linux and xterm) are cut from the END of stdout only; any other
 * escape, and a clear anywhere else, is left alone. Pure terminal noise: the model has no screen.
 */
const TRAILING_CLEARS = ['\x1b[3J\x1b[H\x1b[J', '\x1b[3J\x1b[H\x1b[2J', '\x1b[H\x1b[J', '\x1b[H\x1b[2J']; // longest first

export function stripTrailingClearScreen(stdout: string): string {
  let out = stdout;
  let seq: string | undefined;
  while ((seq = TRAILING_CLEARS.find((s) => out.endsWith(s)))) out = out.slice(0, -seq.length);
  return out;
}

/**
 * Grace between the group SIGTERM and the SIGKILL escalation. Reads the SAME env
 * knob the background process registry does (VESTRA_KILL_GRACE_MS) so foreground and
 * background kills tune together; defaults to 2s.
 */
function killGraceMs(): number {
  const v = Number(process.env.VESTRA_KILL_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_KILL_GRACE_MS;
}

/**
 * An execFile-shaped rejection: the same fields node's execFile attaches to its
 * error, so the Bash tool's failure branch (below) is byte-identical whether the
 * child ran under the old `execFileAsync` or this group-exec.
 */
type ExecGroupError = Error & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };

/**
 * Signal a DETACHED child's whole process GROUP (pgid === pid). A negative pid
 * targets the group so a forked subtree dies with the shell. ESRCH ⇒ already gone;
 * any other errno falls back to signalling the direct child. Never throws. Mirrors
 * process-registry.signalGroup (the background path), kept local because that module
 * does not export it and is out of this change's grant.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid !== 'number') { try { child.kill(signal); } catch { /* never-throw */ } return; }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    try { child.kill(signal); } catch { /* never-throw */ }
  }
}

/**
 * Group-kill a detached child with escalation: SIGTERM now, then — only if the group
 * is still alive after the grace — SIGKILL. The escalation timer is unref'd (never
 * holds the host open) and probes the group first so a process that exited during the
 * grace never gets a needless SIGKILL. Mirrors process-registry.killProcessTree.
 */
function killGroupTree(child: ChildProcess): void {
  signalGroup(child, 'SIGTERM');
  const pid = child.pid;
  if (typeof pid !== 'number') return;
  const timer = setTimeout(() => {
    try { process.kill(-pid, 0); } catch { return; } // ESRCH ⇒ gone; skip SIGKILL
    signalGroup(child, 'SIGKILL');
  }, killGraceMs());
  timer.unref();
}

/** execFile's non-zero-exit error: `Command failed: <cmd>\n<stderr>` + the exit fields. */
function commandFailed(cmd: string, stdout: string, stderr: string, x: { code: number | null; killed: boolean }): ExecGroupError {
  const e = new Error(`Command failed: ${cmd}\n${stderr}`) as ExecGroupError;
  if (x.code !== null) e.code = x.code;
  e.killed = x.killed;
  e.stdout = stdout;
  e.stderr = stderr;
  return e;
}

/** execFile's maxBuffer error: the `.code` the tool special-cases into a truncated-partial return. */
function maxBufferError(cmd: string, stdout: string, stderr: string): ExecGroupError {
  const e = new Error(`Command failed: ${cmd}\nstdout maxBuffer length exceeded`) as ExecGroupError;
  e.code = 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED';
  e.killed = true;
  e.stdout = stdout;
  e.stderr = stderr;
  return e;
}

/** execFile's abort error shape (name 'AbortError', message 'The operation was aborted'). */
function abortError(stdout: string, stderr: string): ExecGroupError {
  const e = new Error('The operation was aborted') as ExecGroupError;
  e.name = 'AbortError';
  e.killed = true;
  e.stdout = stdout;
  e.stderr = stderr;
  return e;
}

type ExecGroupOptions = {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal;
  /** L5: called on every stdout/stderr chunk (the tool watchdog's progress for Bash). */
  onData?: () => void;
};

/**
 * Run `file args` in its OWN process group and resolve/reject with the SAME contract
 * node's execFile did — so the Bash tool's success/failure handling stays byte-identical.
 * The ONLY behavioral change vs execFile: on abort OR timeout the whole GROUP is killed
 * (SIGTERM → grace → SIGKILL), so a command that forks a subtree (`foo &`, a dev server,
 * a build worker pool) dies WITH the shell instead of being orphaned in the persistent
 * one-user sandbox — the foreground half of Hardening-H (#1700 did the background half).
 *
 * Non-interrupt paths reproduce execFile exactly: per-stream utf8 decoding
 * (multibyte-safe across chunk boundaries), a per-stream maxBuffer cap that truncates
 * the partial and stops the runaway, `resolve({stdout, stderr})` on exit 0, and a
 * `Command failed: <cmd>\n<stderr>` error carrying `{stdout, stderr, code, killed}` on a
 * non-zero exit. `signal` is NOT forwarded to spawn (that would SIGTERM only the child
 * pid) — abort is handled here as a group kill.
 */
function execFileGroup(file: string, args: string[], opts: ExecGroupOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true });
    const cmd = `${file} ${args.join(' ')}`; // execFile's error `cmd` (file + args joined)
    const mk = () => ({ decoder: new StringDecoder('utf8'), parts: [] as string[], bytes: 0 });
    const out = mk();
    const err = mk();
    let killReason: '' | 'abort' | 'timeout' | 'maxbuffer' = '';
    let settled = false;

    const timer = opts.timeout > 0
      ? setTimeout(() => { if (!killReason) killReason = 'timeout'; killGroupTree(child); }, opts.timeout)
      : null;
    timer?.unref();
    const onAbort = () => { if (!killReason) killReason = 'abort'; killGroupTree(child); };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    // Decode a chunk (utf8, multibyte-safe across boundaries, exactly as execFile's
    // setEncoding did) and enforce the per-stream byte cap: on overflow keep the head
    // up to the cap, then group-kill the runaway (execFile likewise kills the child on
    // maxBuffer overflow and returns the partial).
    const feed = (buf: ReturnType<typeof mk>, chunk: Buffer) => {
      opts.onData?.();
      if (killReason) return;
      const text = buf.decoder.write(chunk);
      if (!text) return;
      const len = Buffer.byteLength(text);
      if (buf.bytes + len > opts.maxBuffer) {
        buf.parts.push(text.slice(0, Math.max(0, opts.maxBuffer - buf.bytes)));
        buf.bytes = opts.maxBuffer;
        killReason = 'maxbuffer';
        killGroupTree(child);
        return;
      }
      buf.parts.push(text);
      buf.bytes += len;
    };

    child.stdout?.on('data', (c: Buffer) => feed(out, c));
    child.stderr?.on('data', (c: Buffer) => feed(err, c));

    // A spawn failure (e.g. ENOENT) mirrors execFile: reject with the raw error.
    child.on('error', (e) => { if (settled) return; settled = true; cleanup(); reject(e); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = out.parts.join('') + out.decoder.end();
      const stderr = err.parts.join('') + err.decoder.end();
      if (killReason === 'maxbuffer') return reject(maxBufferError(cmd, stdout, stderr));
      if (killReason === 'timeout') return reject(commandFailed(cmd, stdout, stderr, { code: null, killed: true }));
      if (killReason === 'abort') return reject(abortError(stdout, stderr));
      if (code === 0) return resolve({ stdout, stderr });
      reject(commandFailed(cmd, stdout, stderr, { code, killed: false }));
    });

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort);
    }
  });
}

/**
 * Build the canonical Bash tool, scoped to a specific owning Vestra task/session id.
 *
 * Returns a fresh RawToolOptions whose `execute` closure captures `ownerTaskId`
 * so that background processes spawned by run_in_background:true are owned by the
 * correct task. StateManager.cleanupTask calls killByTask(ownerTaskId) on session
 * end, ensuring only THAT task's background processes are killed — parallel tasks'
 * processes are unaffected (per-session isolation invariant).
 *
 * Registered through the arm's gate (wrapApprovedTool for openai;
 * gateAndDispatchTool for native). It ALSO runs the shared security guard BEFORE
 * exec — defense in depth.
 *
 * Schema mirrors the SDK's BashInput: command, timeout, description,
 * run_in_background, dangerouslyDisableSandbox. run_in_background:true (K5-T6)
 * spawns the command via the process registry and returns IMMEDIATELY — the model
 * reads its output with TaskOutput and stops it with TaskStop. The synchronous
 * path (run to completion, return output inline) is the default.
 * dangerouslyDisableSandbox is accepted for schema parity but has no effect here
 * (Vestra always runs the security guard).
 *
 * `getWorkingDir` is a thunk invoked at execute time — the SDK reads no
 * environment, so the caller supplies the working directory (read live so a
 * test/runtime that swaps the workspace per call is honored).
 */
/** SHELL_SESSION_V1: the line a yielded command that is still running ends with. */
function handBackNote(bgId: string, ms: number): string {
  const after = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
  return `[Still running as ${bgId} after ${after}. Read what is new with process({action:"read",id:"${bgId}",block:true,timeout:30000}), `
    + `answer a prompt with process({action:"submit",id:"${bgId}",data:"..."}), stop it with process({action:"kill",id:"${bgId}"}).]`;
}

/**
 * SHELL_SESSION_V1: a command that hands back. It starts as a background job of this task
 * in the foreground wrapper (bash -lc, this session's cwd and env), and the call waits up
 * to `yieldMs` (capped at the foreground maximum, so the wait sits under the tool watchdog's
 * window) for it to end.
 *
 * Ended inside the window: the result is a foreground result. Its output, a non-zero exit
 * as `exec_failed`, its cd and exports applied to the session, and the registry forgets it.
 * Still running: what it printed so far and the hand-back line; it keeps running under this
 * task (session end reaps it), the process tool reads only what is new from here on, and
 * its cd and exports never apply (they would land at an unpredictable later moment).
 * A user interrupt during the window kills it, as it would a foreground command.
 */
async function runYielded(
  session: TerminalSession,
  command: string,
  yieldMs: number,
  pty: boolean,
  ownerTaskId: string,
  context: ToolExecuteContext,
  trailer: () => string,
): Promise<string | ToolErrorSentinel> {
  const ms = Math.min(yieldMs, BASH_MAX_TIMEOUT_MS);
  const tag = randomUUID().slice(0, 8);
  // A pty run goes through script(1), which takes a command string, so it keeps the plain
  // background shell (no wrapper: its cd never applies), exactly as run_in_background does.
  const x = pty ? undefined : session.buildYieldExec(command, tag);
  const bgId = x
    ? spawnBackground(command, ownerTaskId, x.cwd, { env: x.env, exec: { file: x.file, args: x.args } })
    : spawnBackground(command, ownerTaskId, session.cwd, { pty: true, env: session.childEnv() });
  try {
    await waitForProcess(bgId, ms, {
      ownerTaskId,
      ...(context.signal !== undefined && { signal: context.signal }),
      // L5 (TOOL_PROGRESS_WATCHDOG_V1): output bytes are progress, as on the foreground path.
      ...(context.noteProgress !== undefined && { onData: context.noteProgress }),
    });
  } catch {
    const cut = readNewOutput(bgId, ownerTaskId);
    const partial = withDropMarker(bgId, cut.lost, stripTrailingClearScreen(cut.text));
    stopProcess(bgId, ownerTaskId);
    if (x) session.discardYield(tag);
    return toolError('aborted', `Command failed: The operation was aborted${partial ? `\n${capOutput(partial)}` : ''}${trailer()}`);
  }
  const out = readNewOutput(bgId, ownerTaskId);
  // The byte budget may have dropped its earliest lines inside the window: say so (one marker).
  const text = withDropMarker(bgId, out.lost, stripTrailingClearScreen(out.text));
  if (out.closed) {
    releaseProcess(bgId, ownerTaskId);
    if (x) session.captureYield(tag);
    if (out.exitCode === 0) return capOutput(text) + trailer();
    return toolError('exec_failed', `Command failed (exit ${out.exitCode ?? 'by signal'}): ${capOutput(text)}${trailer()}`);
  }
  if (x) registerLineListener(bgId, () => { /* its lines are read through the process tool */ }, () => session.discardYield(tag));
  return `${text ? `${capOutput(text)}\n` : ''}${handBackNote(bgId, ms)}${trailer()}`;
}

/** SHELL_SESSION_V1: a yielded command's output, led by the one truncation marker when its earliest lines were dropped. */
function withDropMarker(bgId: string, lost: number, text: string): string {
  const marker = newOutputMarker(bgId, { lost, skipped: 0, skippedAt: 0 });
  return marker ? `${marker}\n${text}` : text;
}

/** Bash's parameter text, as the SDK's BashInput words it. Flag-off builds advertise exactly this. */
const BASH_PARAM_TEXT = {
  command: 'The command to execute',
  timeout: 'Optional timeout in milliseconds (max 600000)',
  description: 'Clear, concise description of what this command does in active voice (5-10 words).',
  run_in_background: 'Set to true to run this command in the background.',
  dangerouslyDisableSandbox: 'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
  pty: 'Set true for interactive programs (REPLs, ssh, prompting installers) so they get a pseudo-terminal. Only meaningful with run_in_background:true.',
  yield_ms: 'For a long or interactive command (a build, an install, a test run, a prompt), e.g. 30000: after this many milliseconds (max 600000) you get what it printed so far while it keeps running, then read more, answer it or stop it with the process tool.',
};

/**
 * TOOL_DESC_TRIM_V1 — the same meanings, said once. `dangerouslyDisableSandbox` now says
 * what it does here (nothing: the field exists for schema parity and the guard always runs)
 * instead of inviting a bypass that does not exist. Read when the tool is built.
 */
const BASH_PARAM_TEXT_TRIMMED: typeof BASH_PARAM_TEXT = {
  command: 'The command to execute.',
  timeout: 'Milliseconds, max 600000.',
  description: 'What it does, in active voice, 5-10 words.',
  run_in_background: 'Run it in the background.',
  dangerouslyDisableSandbox: 'Has no effect: the safety checks always run.',
  pty: 'A pseudo-terminal for interactive programs (REPLs, ssh, prompting installers); background runs only.',
  yield_ms: 'For a long or interactive command, e.g. 30000: hand back after this many ms (max 600000) with the output so far while it keeps running; then read, answer or stop it with the process tool.',
};

export function makeBashTool(getWorkingDir: () => string, ownerTaskId: string, opts: { envCapture?: boolean } = {}): RawToolOptions {
  const p = toolDescTrimEnabled() ? BASH_PARAM_TEXT_TRIMMED : BASH_PARAM_TEXT;
  // SHELL_SESSION_V1, read when the tool is built: `yield_ms` joins the schema LAST, so the
  // flag-off schema is the same keys in the same order, byte for byte.
  const sessionOn = shellSessionEnabled();
  const shape = {
    command: z.string().describe(p.command),
    timeout: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(p.timeout),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(p.description),
    run_in_background: z
      .boolean()
      .nullable()
      .optional()
      .describe(p.run_in_background),
    dangerouslyDisableSandbox: z
      .boolean()
      .nullable()
      .optional()
      .describe(p.dangerouslyDisableSandbox),
    pty: z
      .boolean()
      .nullable()
      .optional()
      .describe(p.pty),
  };
  return {
    name: 'Bash',
    description: toolDescription('Bash'),
    strict: true,
    parameters: z.object(sessionOn
      ? { ...shape, yield_ms: z.number().int().positive().nullable().optional().describe(p.yield_ms) }
      : shape),
    execute: async (args: unknown, context: ToolExecuteContext = {}) => {
      const { command, timeout, run_in_background, pty, yield_ms } = args as {
        command: string; timeout?: number | null; run_in_background?: boolean | null; pty?: boolean | null;
        yield_ms?: number | null;
      };
      const danger = checkDangerousBashCommand(command);
      if (danger.blocked) {
        // T5: a policy refusal is a failed call: the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1).
        return softFail('permission', `Blocked dangerous command (${danger.pattern ?? 'policy'}): ${danger.description ?? 'not permitted'}`);
      }
      const session = getSession(ownerTaskId, getWorkingDir(), { envCapture: !!opts.envCapture });
      await session.ready(); // SHELL_CREDENTIAL_BROKER_V1: the loopback route exists before any child env is built
      if (run_in_background) {
        const bgId = spawnBackground(command, ownerTaskId, session.cwd, { pty: !!pty, env: session.childEnv() });
        return `Started background task ${bgId}. Read its output with process({action:"read",id:"${bgId}"}), stop it with process({action:"kill",id:"${bgId}"}).`;
      }
      const ms = Math.min(timeout && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
      const { file, args: execArgs, env, cwd } = session.buildExec(command);
      // File-tool senses (wordware fix): the shell's cwd persists across calls and
      // drifts with cd, invisibly — a relative path resolved from the wrong directory
      // fabricated a "missing" file and the whole turn was redone. When the shell sits
      // anywhere other than the workspace root, say so on every result (success AND
      // failure — the failure is where the drift bites). At the root: empty, no noise.
      const cwdTrailer = () => (sameDir(session.cwd, getWorkingDir()) ? '' : formatCwdTrailer(session.cwd));
      // SHELL_EGRESS_V1=enforce: this task's refused connections as one note ('' when none).
      const trailer = () => cwdTrailer() + session.takeEgressRefusalNote();
      if (sessionOn && typeof yield_ms === 'number' && yield_ms > 0) {
        return runYielded(session, command, yield_ms, !!pty, ownerTaskId, context, trailer);
      }
      try {
        const { stdout, stderr } = await execFileGroup(file, execArgs, {
          cwd,
          env,
          timeout: ms,
          maxBuffer: MAX_EXEC_BUFFER,
          // The foreground shell runs in its OWN process group; on a user interrupt
          // (context.signal abort) OR timeout, execFileGroup kills the whole GROUP
          // (SIGTERM → grace → SIGKILL) so a forked subtree dies with the shell
          // instead of being orphaned in the persistent sandbox (Hardening-H fg half).
          ...(context.signal !== undefined && { signal: context.signal }),
          // L5 (TOOL_PROGRESS_WATCHDOG_V1): output bytes are Bash's progress. Present
          // only while the watchdog is armed for this call.
          ...(context.noteProgress !== undefined && { onData: context.noteProgress }),
        });
        session.captureCwd();
        session.captureEnv();
        const combined = stripTrailingClearScreen(stdout ?? '') + (stderr ? `\n${stderr}` : '');
        return capOutput(combined) + trailer();
      } catch (err) {
        session.captureCwd(); // cwd may have changed even on a non-zero exit
        session.captureEnv();
        const e = err as { stdout?: string; stderr?: string; message?: string; code?: string; killed?: boolean };
        const stdout = stripTrailingClearScreen(e.stdout ?? '');
        // Output exceeded 8MB: the command likely RAN; return its partial output
        // truncated, NOT a failure. (Node kills the child on maxBuffer overflow.)
        if (e.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED' || /maxBuffer/i.test(e.message ?? '')) {
          const partial = stdout + (e.stderr ? `\n${e.stderr}` : '');
          const mb = MAX_EXEC_BUFFER / 1024 / 1024;
          // T5 (TOOL_RESULT_SHAPE_V1): the one truncation marker. Off: today's notice.
          const stopped = toolResultShapeEnabled()
            ? truncationMarker({
                omitted: `all output past ${mb} MB`,
                from: 'end',
                recovery: `The process was stopped at ${mb} MB. ${REDIRECT_RECOVERY}`,
              })
            : `...[output exceeded ${mb} MB - process stopped]...`;
          return `${capOutput(partial)}\n${stopped}${trailer()}`;
        }
        const failBody = (e.stderr || e.message || String(err)) + (stdout ? `\n${stdout}` : '');
        // Hardening-G: return a typed sentinel (never-throw). The MESSAGE is byte-identical
        // to the classic `Command failed:` string, so the dispatcher's flag-OFF path
        // reproduces today verbatim; only the CODE splits the failure kind.
        // P3 charter C: a user abort (ctx.signal aborted → execFile rejects with an
        // AbortError) classifies as 'aborted', NOT 'timeout' — checked FIRST because
        // Node's abort error shape (`killed`/`signal`) varies across versions, so the
        // signal state is the version-independent truth. The exec `timeout` kill (node
        // sets `killed:true`) stays 'timeout'; a generic non-zero exit stays exec_failed.
        const code = context.signal?.aborted === true ? 'aborted' : e.killed === true ? 'timeout' : 'exec_failed';
        return toolError(code, `Command failed: ${capOutput(failBody)}${trailer()}`);
      }
    },
  };
}
