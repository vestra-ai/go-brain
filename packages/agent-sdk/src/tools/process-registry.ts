import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { checkDangerousBashCommand } from '../policy/index.js';

/**
 * In-process background-process registry for the native/openai arms (K5-T6).
 *
 * Bash run_in_background:true spawns a shell, registers it under a bg_ task_id,
 * and returns immediately. TaskOutput polls accumulated output; TaskStop kills +
 * cleans up; killByTask(ownerTaskId) terminates only the ending task's processes
 * (per-session isolation invariant); killAll is retained for full-sandbox shutdown.
 * NOTHING here throws into a turn — callers get model-visible strings.
 *
 * Process-global (the sandbox runs one user; task_ids are unique).
 *
 * Hardening-H — background-process lifecycle:
 *  - Shells are spawned `detached:true` so each owns a process GROUP (pgid === pid);
 *    kills target the group (`process.kill(-pid, …)`) so grandchildren die too.
 *  - Kills escalate: SIGTERM, then — only if the group is still alive after a grace
 *    window — SIGKILL. All kill paths go through killProcessTree.
 *  - Output is decoded with a per-stream StringDecoder (+ partial-line carry) so a
 *    multibyte character split across two chunks survives, and buffered under a
 *    per-process BYTE budget (newest kept, oldest dropped) with a cumulative
 *    droppedBytes counter surfaced to the reader.
 *  - Running pgids are mirrored to a sidecar file so a fresh runner can reap groups
 *    leaked by a crashed previous incarnation (sweepOrphanProcesses, called at boot).
 */
type BgStatus = 'running' | 'exited' | 'killed';
type StreamName = 'stdout' | 'stderr';

/**
 * Per-line subscriber (K5-T7). `onLine` fires once per NEW line as the process
 * emits it (the live push the Monitor tool turns into AGENT_TOOL_PROGRESS); the
 * optional `onExit` fires once when the process ends so a watcher can stop
 * without polling. Both are best-effort: a throwing callback is swallowed so one
 * bad subscriber never breaks output buffering or another subscriber.
 */
interface LineListener {
  onLine: (line: string, stream: StreamName) => void;
  // `| undefined` is required by the SDK's exactOptionalPropertyTypes: registerLineListener
  // builds `{ onLine, onExit }` where `onExit` may be an explicit `undefined`. Runtime-identical
  // to the original `onExit?: () => void` (the param is still optional).
  onExit?: (() => void) | undefined;
}

/** Per-stream decode state: a StringDecoder plus the partial (un-newline-terminated) line. */
interface StreamBuf {
  decoder: StringDecoder;
  carry: string;
}

interface BgEntry {
  proc: ChildProcess;
  buffer: string[];          // line-buffered stdout+stderr (byte-budgeted, newest kept)
  bufferBytes: number;       // approximate byte size of `buffer` (drives the drop-oldest budget)
  droppedBytes: number;      // cumulative bytes dropped to stay under budget
  maxBufferBytes: number;    // per-process byte budget, captured at spawn
  status: BgStatus;
  exitCode: number | null;
  command: string;
  /** The Vestra task/session id that owns this background process. */
  ownerTaskId: string;
  /** Wall-clock spawn time — persisted to the sidecar for orphan diagnostics. */
  startedAt: number;
  pty: boolean;
  /** Live per-line subscribers (K5-T7 Monitor fan-out). */
  listeners: Set<LineListener>;
  streams: { stdout: StreamBuf; stderr: StreamBuf };
  /** Lines ever pushed: the absolute index of the next line (the read mark counts in it). */
  totalLines: number;
  /** SHELL_SESSION_V1: the absolute index of the first line the owner has not read yet. */
  readMark: number;
  /** Both pipes closed (after 'exit'): every byte the process wrote is in the buffer. */
  closed: boolean;
}

const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024; // ~2MB per process
/**
 * A line with no newline yet is pushed as a line of its own once it passes this many
 * characters, so a flood without newlines (a `base64 -w0`, a minified bundle, a progress bar
 * that only ever writes `\r`) lands in the byte-budgeted buffer instead of growing without bound.
 */
const MAX_CARRY_CHARS = 64 * 1024;
/** SHELL_SESSION_V1: the most of a pending partial line a read shows (its newest characters). */
const MAX_PARTIAL_SHOWN_CHARS = 2 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;               // SIGTERM → grace → SIGKILL
const registry = new Map<string, BgEntry>();

/** Per-process output byte budget (env-overridable for tests/tuning). */
function maxBufferBytes(): number {
  const v = Number(process.env.VESTRA_BG_BUFFER_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BUFFER_BYTES;
}

/** Grace between the group SIGTERM and the SIGKILL escalation (env-overridable). */
function killGraceMs(): number {
  const v = Number(process.env.VESTRA_KILL_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_KILL_GRACE_MS;
}

/** Test-only: number of live (non-cleaned) registry entries. */
export function _processCount(): number {
  return registry.size;
}

function notifyExit(entry: BgEntry): void {
  for (const l of entry.listeners) {
    try { l.onExit?.(); } catch { /* never-throw: a bad subscriber can't break the registry */ }
  }
}

/**
 * Append one line to a process's buffer under the byte budget: push the newest,
 * then drop oldest lines until we are back under budget (recording the bytes
 * dropped), and fan the line out to live subscribers. Never drops the sole line.
 */
function pushLine(entry: BgEntry, line: string, stream: StreamName): void {
  entry.buffer.push(line);
  entry.totalLines += 1;
  entry.bufferBytes += Buffer.byteLength(line) + 1; // +1 approximates the '\n' join separator
  while (entry.bufferBytes > entry.maxBufferBytes && entry.buffer.length > 1) {
    const dropped = entry.buffer.shift() as string;
    const droppedLen = Buffer.byteLength(dropped) + 1;
    entry.bufferBytes -= droppedLen;
    entry.droppedBytes += droppedLen;
  }
  for (const l of entry.listeners) {
    try { l.onLine(line, stream); } catch { /* never-throw */ }
  }
}

/**
 * Feed a raw stdout/stderr chunk through the stream's StringDecoder so a multibyte
 * character split across chunk boundaries decodes intact, carry the trailing partial
 * line until its newline arrives, and push each completed (non-empty) line.
 */
function appendChunk(entry: BgEntry, chunk: Buffer, stream: StreamName): void {
  const sb = entry.streams[stream];
  const text = sb.carry + sb.decoder.write(chunk);
  const parts = text.split('\n');
  sb.carry = parts.pop() ?? ''; // trailing fragment with no newline yet
  for (const line of parts) {
    if (line.length === 0) continue;
    pushLine(entry, line, stream);
  }
  // Bounded carry: past the cap the fragment becomes a line, under the byte budget like any other.
  if (sb.carry.length > MAX_CARRY_CHARS) {
    pushLine(entry, sb.carry, stream);
    sb.carry = '';
  }
}

/**
 * SHELL_SESSION_V1: a pending partial line as a read shows it: what follows its last carriage
 * return (a progress bar's current frame, as a terminal would show it), its newest characters
 * up to MAX_PARTIAL_SHOWN_CHARS (a waiting prompt is at the end).
 */
function shownPartial(carry: string): string {
  const frames = carry.replace(/\r+$/, '');
  const frame = frames.slice(frames.lastIndexOf('\r') + 1);
  if (frame.length <= MAX_PARTIAL_SHOWN_CHARS) return frame;
  // Never start on the low half of a surrogate pair (a character cut in two at the edge).
  let s = frame.length - MAX_PARTIAL_SHOWN_CHARS;
  if ((frame.charCodeAt(s) & 0xfc00) === 0xdc00) s++;
  return frame.slice(s);
}

/** Flush a stream's residual carry (a final line with no trailing newline) once it ends. */
function flushStream(entry: BgEntry, stream: StreamName): void {
  const sb = entry.streams[stream];
  const tail = sb.carry + sb.decoder.end();
  sb.carry = '';
  if (tail.length > 0) pushLine(entry, tail, stream);
}

/**
 * Subscribe to a background process's per-line output + exit (K5-T7).
 *
 * Returns an unsubscribe function. Subscribing to an unknown id returns a no-op
 * unsubscribe (never throws) — the caller treats a missing process as already
 * gone. Lines emitted BEFORE subscription are not replayed (this is a live push,
 * not a buffer drain; the Monitor tool subscribes immediately on spawn so it
 * sees every line). If the process has ALREADY exited when subscribing, `onExit`
 * fires on the next microtask so a watcher started after a fast exit still stops.
 */
export function registerLineListener(
  id: string,
  onLine: (line: string, stream: StreamName) => void,
  onExit?: () => void,
): () => void {
  const entry = registry.get(id);
  if (!entry) return () => { /* unknown id — no-op */ };
  const listener: LineListener = { onLine, onExit };
  entry.listeners.add(listener);
  // Already-exited process: deliver onExit asynchronously so the watcher unwinds.
  if (entry.status !== 'running' && onExit) {
    queueMicrotask(() => { try { onExit(); } catch { /* never-throw */ } });
  }
  return () => { entry.listeners.delete(listener); };
}

// PTY via script(1): util-linux (Linux sandbox/CI) and BSD (macOS dev) differ. Both
// spawn detached so the pty-wrapped child owns a killable process group.
function spawnPty(command: string, workingDir: string, env?: NodeJS.ProcessEnv) {
  if (process.platform === 'darwin') {
    // BSD: script [-q] [file] [command ...]
    return spawn('script', ['-q', '/dev/null', '/bin/sh', '-c', command], { cwd: workingDir, env, detached: true });
  }
  // util-linux: script -qfc "cmd" /dev/null
  return spawn('script', ['-qfc', command, '/dev/null'], { cwd: workingDir, env, detached: true });
}

/**
 * Spawn a backgrounded shell command; returns its bg_ task_id immediately.
 *
 * `ownerTaskId` is the Vestra session/task id of the OWNING task (NOT the bg_
 * process id). It is stored on the entry so `killByTask` can scope cleanup to
 * only the processes belonging to the task that is ending, preserving parallel
 * tasks' background processes (per-session isolation invariant).
 *
 * `workingDir` is the cwd the child shell runs in — supplied by the caller (the
 * SDK reads no environment; the product injects its sandbox working directory).
 *
 * The shell is spawned `detached:true` so it leads its own process GROUP: a
 * grandchild the command backgrounds (`foo &`) is reaped when the group is killed,
 * instead of being orphaned by a child-only signal.
 *
 * `opts.pty` — when true, wraps the command in `script(1)` so the child process
 * sees a pseudo-terminal on stdout. Useful for interactive programs (REPLs, SSH,
 * prompting installers) that behave differently when not attached to a TTY.
 * Note: exit-code fidelity through `script` is imperfect (script may report its
 * own exit, not the child's) — callers should not rely on exitCode when pty:true.
 *
 * NO SHELL INJECTION: the command runs as the single argument to `/bin/sh -c`
 * passed via the args array (NOT a concatenated shell string), exactly like the
 * synchronous Bash path (`exec`). The args-array form means no host-shell
 * interpolation of the command into a larger string. The command itself is the
 * model-authored shell to run, gated upstream by checkDangerousBashCommand in
 * bash-tool.ts before this is ever called.
 *
 * `opts.exec` (SHELL_SESSION_V1, a yielded Bash command): spawn this file and args
 * instead of `/bin/sh -c command`: the foreground wrapper (`bash -lc`, the persisted cwd
 * and env), so a command that may outlive its call starts in the same shell a foreground
 * one would. `command` is still what `list` shows. Ignored when `pty` is set.
 */
export function spawnBackground(
  command: string,
  ownerTaskId: string,
  workingDir: string,
  opts: { pty?: boolean; env?: NodeJS.ProcessEnv; exec?: { file: string; args: string[] } } = {},
): string {
  const id = `bg_${randomUUID().slice(0, 8)}`;
  const proc = opts.pty
    ? spawnPty(command, workingDir, opts.env)
    : opts.exec
      ? spawn(opts.exec.file, opts.exec.args, { cwd: workingDir, env: opts.env, detached: true })
      : spawn('/bin/sh', ['-c', command], { cwd: workingDir, env: opts.env, detached: true });
  // A background task must NOT pin the sandbox process open: unref the child so a
  // still-running bg process can't block host exit. We still buffer its output via
  // the 'data' listeners below, and killByTask/killAll/stopProcess reap it
  // explicitly — unref only removes the event-loop ref, not the handle or the
  // registry entry.
  proc.unref();
  const entry: BgEntry = {
    proc, buffer: [], bufferBytes: 0, droppedBytes: 0, maxBufferBytes: maxBufferBytes(),
    status: 'running', exitCode: null, command, ownerTaskId, startedAt: Date.now(),
    pty: !!opts.pty,
    listeners: new Set<LineListener>(),
    streams: {
      stdout: { decoder: new StringDecoder('utf8'), carry: '' },
      stderr: { decoder: new StringDecoder('utf8'), carry: '' },
    },
    totalLines: 0,
    readMark: 0,
    closed: false,
  };
  registry.set(id, entry);
  proc.stdout?.on('data', (c: Buffer) => appendChunk(entry, c, 'stdout'));
  proc.stderr?.on('data', (c: Buffer) => appendChunk(entry, c, 'stderr'));
  proc.stdout?.on('end', () => flushStream(entry, 'stdout'));
  proc.stderr?.on('end', () => flushStream(entry, 'stderr'));
  proc.on('exit', (code) => {
    entry.exitCode = code;
    if (entry.status !== 'killed') entry.status = 'exited';
    persistSidecar();
    notifyExit(entry);
  });
  proc.on('close', () => { entry.closed = true; });
  proc.on('error', (err) => {
    pushLine(entry, `[spawn error] ${err.message}`, 'stderr');
    entry.status = 'exited';
    entry.closed = true; // a child that never spawned has no pipes to drain
    persistSidecar();
    notifyExit(entry);
  });
  persistSidecar();
  return id;
}

/**
 * The entry for `id` as `ownerTaskId` may see it. An entry another task owns reads as
 * unknown, the same answer a missing id gets, so one session can neither read, feed, stop
 * nor learn of another session's process (per-session isolation invariant). The tools
 * always pass their owner. `ownerTaskId` undefined is unscoped: the runtime's own callers
 * (a watcher stopping the process it spawned) and the legacy unscoped tool objects.
 */
function entryFor(id: string, ownerTaskId?: string): BgEntry | undefined {
  const entry = registry.get(id);
  if (!entry || (ownerTaskId !== undefined && entry.ownerTaskId !== ownerTaskId)) return undefined;
  return entry;
}

/** Snapshot a process's accumulated output + status (non-blocking). `ownerTaskId`: see entryFor. */
export function getOutput(id: string, ownerTaskId?: string): { output: string; status: BgStatus | 'unknown'; exitCode: number | null; pty: boolean; droppedBytes: number } {
  const entry = entryFor(id, ownerTaskId);
  if (!entry) return { output: `Unknown background task: ${id} (not found)`, status: 'unknown', exitCode: null, pty: false, droppedBytes: 0 };
  return { output: entry.buffer.join('\n'), status: entry.status, exitCode: entry.exitCode, pty: entry.pty, droppedBytes: entry.droppedBytes };
}

/**
 * L5 (redo of #3333): the longest ANY blocking read of a background task may wait (the
 * `process` tool's read and its TaskOutput alias). The model supplies the wait unclamped,
 * and a 30-minute value used to hold the round for all of it. Ten minutes is the longest
 * one foreground shell wait may take (Bash's own cap), and it sits under the tool
 * watchdog's window, so a capped wait returns `[running]` with the output so far (the task
 * keeps going) and a working background build is never read as a stalled call. Every
 * caller clamps to it; the watchdog's window test pins the relation.
 */
export const MAX_BLOCKING_WAIT_MS = 600_000;

/**
 * Block until the process exits or `timeoutMs` elapses, then snapshot.
 *
 * P3: an optional `signal` lets a user interrupt unblock the wait promptly — on
 * abort the wait REJECTS with an AbortError (the caller maps it to a model-visible
 * string; the never-throw boundary lives in the tool). Signal-less calls are
 * byte-identical to before (no listener attached, resolve-on-exit/timeout only).
 */
export async function getOutputBlocking(
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
  ownerTaskId?: string,
): Promise<{ output: string; status: BgStatus | 'unknown'; exitCode: number | null; pty: boolean; droppedBytes: number }> {
  const entry = entryFor(id, ownerTaskId);
  if (!entry) return getOutput(id, ownerTaskId);
  if (entry.status !== 'running') return getOutput(id, ownerTaskId);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, timeoutMs));
    const onExit = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(makeAbortError()); };
    const cleanup = () => {
      clearTimeout(timer);
      entry.proc.off('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) { cleanup(); reject(makeAbortError()); return; }
    entry.proc.on('exit', onExit);
    signal?.addEventListener('abort', onAbort);
  });
  return getOutput(id, ownerTaskId);
}

/** An AbortError-shaped rejection so the caller can recognise a user interrupt. */
function makeAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** SHELL_SESSION_V1: what a process wrote since its owner last read it (readNewOutput). */
export interface NewOutput {
  /** The new complete lines, then the pending partial line (a prompt waiting for input), joined by newlines. */
  text: string;
  /** New lines left out to stay within `limit` (the oldest of them). */
  skipped: number;
  /** The whole-output line (a read's `offset`) of the first new line, so the first skipped one. */
  skippedAt: number;
  /** New lines the byte budget dropped before they were read. */
  lost: number;
  status: BgStatus | 'unknown';
  exitCode: number | null;
  /** The process has ended and both pipes closed: `text` holds the last of its output. */
  closed: boolean;
  pty: boolean;
}

/**
 * SHELL_SESSION_V1: the output since the owner's last read, and move the read mark past it,
 * so a session reads a long build in pieces and never pays for a line twice. The pending
 * partial line of each stream (text with no newline yet: the `Name? ` an interactive prompt
 * prints while it waits) is shown at the end and stays pending, so the model sees the prompt
 * it is answering. `limit` keeps the newest lines and counts the rest in `skipped`. An
 * unknown id (or another task's process) returns the not-found text with status 'unknown'.
 */
export function readNewOutput(id: string, ownerTaskId: string | undefined, limit?: number): NewOutput {
  const entry = entryFor(id, ownerTaskId);
  if (!entry) {
    return { text: `Unknown background task: ${id} (not found)`, skipped: 0, skippedAt: 0, lost: 0, status: 'unknown', exitCode: null, closed: true, pty: false };
  }
  const first = entry.totalLines - entry.buffer.length; // absolute index of buffer[0]
  const lost = Math.max(0, first - entry.readMark);
  const at = Math.max(entry.readMark, first) - first; // buffer index of the first new line
  let fresh = entry.buffer.slice(at);
  let skipped = 0;
  if (limit !== undefined && limit >= 0 && fresh.length > limit) {
    skipped = fresh.length - limit;
    fresh = limit === 0 ? [] : fresh.slice(-limit);
  }
  entry.readMark = entry.totalLines;
  // Each stream's pending line on a line of its own (stdout's, then stderr's), never run together.
  const partials = [shownPartial(entry.streams.stdout.carry), shownPartial(entry.streams.stderr.carry)].filter((p) => p.length > 0);
  const text = [...fresh, ...partials].join('\n');
  return { text, skipped, skippedAt: at, lost, status: entry.status, exitCode: entry.exitCode, closed: entry.closed, pty: entry.pty };
}

/**
 * SHELL_SESSION_V1: wait on a process until it has ended with both pipes closed, or
 * `timeoutMs` passes. With `settleMs`, also stop once output has arrived and then gone quiet
 * that long: the reply to an input. `onData` fires on every chunk (the tool watchdog's
 * progress). A signal abort REJECTS with an AbortError, as getOutputBlocking does. An
 * unknown id, or one already closed, returns at once. Never mutates the entry.
 */
export async function waitForProcess(
  id: string,
  timeoutMs: number,
  opts: { ownerTaskId?: string; signal?: AbortSignal; settleMs?: number; onData?: () => void } = {},
): Promise<void> {
  const entry = entryFor(id, opts.ownerTaskId);
  if (!entry || entry.closed) return;
  const { proc } = entry;
  await new Promise<void>((resolve, reject) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, timeoutMs));
    const onClose = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(makeAbortError()); };
    const onChunk = () => {
      try { opts.onData?.(); } catch { /* never-throw */ }
      if (opts.settleMs === undefined) return;
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => { cleanup(); resolve(); }, opts.settleMs);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      proc.off('close', onClose);
      proc.stdout?.off('data', onChunk);
      proc.stderr?.off('data', onChunk);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    if (opts.signal?.aborted) { cleanup(); reject(makeAbortError()); return; }
    proc.on('close', onClose);
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    opts.signal?.addEventListener('abort', onAbort);
  });
}

/**
 * SHELL_SESSION_V1: forget a process that has ended, closed and been read in full (a
 * yielded Bash command that finished inside its window), so a session that yields every
 * command does not hold every finished buffer until it ends. A running or unread process
 * is kept. Never throws.
 */
export function releaseProcess(id: string, ownerTaskId?: string): void {
  const entry = entryFor(id, ownerTaskId);
  if (!entry || entry.status === 'running' || !entry.closed || entry.readMark < entry.totalLines) return;
  registry.delete(id);
}

/**
 * Signal a process GROUP (detached spawn ⇒ pgid === pid). A negative pid targets
 * the whole group so grandchildren die with the shell. ESRCH ⇒ already gone. On
 * EPERM/other, fall back to signalling the direct child (best-effort, never-throw).
 */
function signalGroup(pid: number, signal: NodeJS.Signals, proc: ChildProcess): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    try { proc.kill(signal); } catch { /* never-throw */ }
  }
}

/**
 * Kill a background process's whole group with escalation: SIGTERM now, then —
 * only if the group is still alive after the grace — SIGKILL. The escalation timer
 * is unref'd so it never holds the host open, and it probes the group first so a
 * process that exited during the grace never gets a needless SIGKILL. Sets the
 * entry's status to 'killed'; the caller decides whether to retain or delete it.
 */
function killProcessTree(entry: BgEntry): void {
  entry.status = 'killed';
  const pid = entry.proc.pid;
  if (typeof pid !== 'number') {
    try { entry.proc.kill('SIGKILL'); } catch { /* never-throw */ }
    return;
  }
  signalGroup(pid, 'SIGTERM', entry.proc);
  const timer = setTimeout(() => {
    try { process.kill(-pid, 0); } catch { return; } // ESRCH ⇒ already gone; skip SIGKILL
    signalGroup(pid, 'SIGKILL', entry.proc);
  }, killGraceMs());
  timer.unref();
}

/**
 * Kill a single process + escalating group-kill. RETAINS the entry (status
 * 'killed') so a subsequent process-read still returns the final buffered output;
 * session cleanup (killByTask) / shutdown (killAll) free it. Returns a model-visible
 * string.
 */
export function stopProcess(id: string, ownerTaskId?: string): string {
  const entry = entryFor(id, ownerTaskId);
  if (!entry) return `Unknown background task: ${id}`;
  killProcessTree(entry);
  persistSidecar(); // a killed process is no longer an orphan risk
  return `Stopped background task ${id}`;
}

/**
 * Kill ONLY the background processes owned by `ownerTaskId`. Never throws.
 * Use this in StateManager.cleanupTask so ending ONE task does not kill
 * another parallel task's background processes (per-session isolation invariant).
 */
export function killByTask(ownerTaskId: string): void {
  for (const [id, entry] of registry.entries()) {
    if (entry.ownerTaskId !== ownerTaskId) continue;
    killProcessTree(entry);
    registry.delete(id);
  }
  persistSidecar();
}

/**
 * Kill EVERY registered process. Full-sandbox shutdown primitive — use when the
 * entire sandbox is shutting down, NOT for per-task cleanup (use killByTask for that).
 * Never throws.
 */
export function killAll(): void {
  for (const [id, entry] of registry.entries()) {
    killProcessTree(entry);
    registry.delete(id);
  }
  persistSidecar();
}

interface SidecarEntry { pgid: number; taskId: string; startedAt: number; command: string; }

/** Base scratch root shared with the terminal-session scratch convention. */
function scratchRoot(): string {
  return process.env.VESTRA_TERM_SCRATCH_ROOT || '/tmp/vestra-term';
}
function sidecarPath(): string {
  return join(scratchRoot(), 'bg-processes.json');
}

/**
 * Persist the pgids of currently-RUNNING background processes to a sidecar file so
 * a fresh runner can reap them if this process dies without cleaning up. A pure
 * projection of the live registry (killed/exited entries are not orphan risks and
 * are excluded). Best-effort + atomic (tmp + rename); never throws.
 */
function persistSidecar(): void {
  try {
    const out: Record<string, SidecarEntry> = {};
    for (const [id, entry] of registry.entries()) {
      if (entry.status !== 'running') continue;
      const pgid = entry.proc.pid;
      if (typeof pgid !== 'number') continue;
      out[id] = { pgid, taskId: entry.ownerTaskId, startedAt: entry.startedAt, command: entry.command.slice(0, 200) };
    }
    const path = sidecarPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, path);
  } catch { /* best-effort: orphan reaping is a safety net, never a hard dependency */ }
}

/**
 * Reap background-process groups leaked by a PREVIOUS runner incarnation. Reads the
 * sidecar written by persistSidecar, group-kills any recorded pgid whose group is
 * still alive, then clears the file. Runs ONCE at boot (before this run spawns any
 * background process), so a recorded pgid can only be a leftover — never a live
 * process of the current run. SIGKILL directly (the group is already abandoned).
 * Defensive throughout: a missing/corrupt file or an ESRCH (already gone) is fine.
 * Returns the number of live groups it signalled.
 *
 * Residual risk: PID reuse could target an unrelated group; mitigated because the
 * sweep runs before any new spawn and a negative-pid signal only reaches a group
 * LED by that exact pgid. A follow-up could add a /proc cmdline identity check.
 */
export function sweepOrphanProcesses(): number {
  const path = sidecarPath();
  let parsed: Record<string, SidecarEntry>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, SidecarEntry>;
  } catch {
    return 0; // no file / unreadable / corrupt ⇒ nothing to reap
  }
  let reaped = 0;
  for (const entry of Object.values(parsed ?? {})) {
    const pgid = entry?.pgid;
    if (typeof pgid !== 'number' || pgid <= 1) continue; // never signal pid 0 (self group) / 1 (init)
    try {
      process.kill(-pgid, 0); // group still alive?
    } catch {
      continue; // ESRCH ⇒ already gone
    }
    try { process.kill(-pgid, 'SIGKILL'); reaped += 1; } catch { /* raced away */ }
  }
  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  return reaped;
}

/**
 * Write to a process's stdin, raw (`enter` false) or followed by Enter (`enter` true, answer
 * a prompt), and say whether anything was written: the structured result the session read
 * (SHELL_SESSION_V1) waits on, so it never reads the message. Never throws.
 */
export function sendInput(
  id: string,
  data: string,
  opts: { enter: boolean; ownerTaskId?: string },
): { written: boolean; message: string } {
  const entry = entryFor(id, opts.ownerTaskId);
  if (!entry) return { written: false, message: `Unknown background task: ${id}` };
  if (entry.status !== 'running') return { written: false, message: `Background task ${id} is not running (${entry.status})` };
  if (!opts.enter) {
    try { entry.proc.stdin?.write(data); } catch { /* never-throw */ }
    return { written: true, message: `Wrote ${data.length} chars to ${id}` };
  }
  // Defense-in-depth: a submitted line into an interactive shell bypasses the Bash command gate. Re-scan it. (Does NOT cover interpreter REPLs like python/node, whose input is not bash syntax - tracked as a follow-up.)
  const danger = checkDangerousBashCommand(data);
  if (danger.blocked) return { written: false, message: `Blocked dangerous input (${danger.pattern ?? 'policy'}): ${danger.description ?? 'not permitted'}` };
  try { entry.proc.stdin?.write(`${data}\n`); } catch { /* never-throw */ }
  return { written: true, message: `Submitted input to ${id}` };
}

/** Write raw bytes to a process's stdin (no trailing newline). Never throws. */
export function writeStdin(id: string, data: string, ownerTaskId?: string): string {
  return sendInput(id, data, { enter: false, ...(ownerTaskId !== undefined && { ownerTaskId }) }).message;
}

/** Write to stdin followed by Enter (answer a prompt). Never throws. */
export function submitStdin(id: string, data = '', ownerTaskId?: string): string {
  return sendInput(id, data, { enter: true, ...(ownerTaskId !== undefined && { ownerTaskId }) }).message;
}

/** Close a process's stdin (EOF). Never throws. */
export function closeStdin(id: string, ownerTaskId?: string): string {
  const entry = entryFor(id, ownerTaskId);
  if (!entry) return `Unknown background task: ${id}`;
  try { entry.proc.stdin?.end(); } catch { /* never-throw */ }
  return `Closed stdin for ${id}`;
}

/** List running+finished processes, optionally scoped to one owner task. */
export function listProcesses(ownerTaskId?: string): Array<{ id: string; command: string; status: BgStatus }> {
  const out: Array<{ id: string; command: string; status: BgStatus }> = [];
  for (const [id, entry] of registry.entries()) {
    if (ownerTaskId && entry.ownerTaskId !== ownerTaskId) continue;
    out.push({ id, command: entry.command, status: entry.status });
  }
  return out;
}

/** Current status of a process, or 'unknown'. */
export function getStatus(id: string, ownerTaskId?: string): BgStatus | 'unknown' {
  return entryFor(id, ownerTaskId)?.status ?? 'unknown';
}
