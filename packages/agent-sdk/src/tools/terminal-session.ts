import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { egressProxyVars } from './egress-proxy-env.js';
import { CredentialBroker } from './credential-broker.js';
import { credentialBrokerEnabled } from '../policy/feature-flags.js';

/** Root for per-task terminal scratch state (cwd/env files). Env-overridable so the
 *  native runner keeps session scratch under its own home; containers use /tmp. */
const SCRATCH_ROOT = process.env.VESTRA_TERM_SCRATCH_ROOT || '/tmp/vestra-term';

/** SHELL_EGRESS_V1=enforce: the most refusals one note counts; more reads "20 or more". */
const MAX_REFUSALS_NOTED = 20;

/**
 * Per-task extra environment (Platform API v1, L17: a company's variables for its user's shell).
 * Keyed per task, never process.env: one box runs many sessions, and a company's secret must not
 * reach a sibling task or shadow the runner's own keys. Read live at every exec, so a new value
 * applies on the next command.
 */
const extraEnvByTask = new Map<string, Record<string, string>>();

export function setTaskExtraEnv(ownerTaskId: string, env: Record<string, string> | undefined): void {
  if (env && Object.keys(env).length > 0) extraEnvByTask.set(ownerTaskId, { ...env });
  else extraEnvByTask.delete(ownerTaskId);
}

/**
 * Phase A wrapper script (cwd persistence + login shell). The model's command
 * arrives via the VESTRA_CMD *environment variable* and is run with `eval` so it
 * is NEVER interpolated into this script string (no shell injection). The wrapper
 * cd's into the persisted cwd (falling back to the seed workdir), runs the
 * command in the same shell so its `cd` is observable, then records the final
 * pwd. `bash -l` sources profile so a venv/PATH set there re-applies each call.
 */
const PHASE_A_SCRIPT = [
  'cd "${VESTRA_CWD:-$VESTRA_WORKDIR}" 2>/dev/null || cd "$VESTRA_WORKDIR" || exit 1',
  'eval "$VESTRA_CMD"',
  '__vrc=$?',
  'pwd > "$VESTRA_CWDFILE" 2>/dev/null || true',
  'exit $__vrc',
].join('\n');

/**
 * Phase B wrapper (env capture). Adds, around the Phase A body: re-source the
 * persisted exported env on entry, and dump the post-command env NUL-delimited
 * for the session to filter/validate/commit in TypeScript. `env -0` is GNU-only
 * (the container); hosts without it (BSD env on the native runner) fall back to a
 * node dump in the identical `KEY=VALUE\0` format. If both fail we keep last-good.
 */
const PHASE_B_SCRIPT = [
  'cd "${VESTRA_CWD:-$VESTRA_WORKDIR}" 2>/dev/null || cd "$VESTRA_WORKDIR" || exit 1',
  '[ -f "$VESTRA_ENVFILE" ] && . "$VESTRA_ENVFILE"',
  'eval "$VESTRA_CMD"',
  '__vrc=$?',
  'pwd > "$VESTRA_CWDFILE" 2>/dev/null || true',
  'env -0 > "$VESTRA_ENVRAW" 2>/dev/null || node -e '
    + `'for (const [k, v] of Object.entries(process.env)) process.stdout.write(k + "=" + v + "\\0");'`
    + ' > "$VESTRA_ENVRAW" 2>/dev/null || true',
  'exit $__vrc',
].join('\n');

/** Vars that must never accumulate in the persisted env (ephemeral shell-internal vars). */
const EPHEMERAL = new Set([
  'PWD', 'OLDPWD', 'SHLVL', '_', 'RANDOM', 'LINENO', 'BASHPID', 'PPID', 'SECONDS',
]);

/**
 * Vars the login shell's profile manages (PATH and friends). `bash -l` re-derives
 * these from profile each command, so they show up in the delta vs the Node-runner
 * baseline even when the model exported nothing — which would defeat the empty-delta
 * no-op and persist profile noise. Exclude them: the profile re-applies them every
 * command anyway, so there is nothing to persist. (A model that truly needs a custom
 * PATH gets it from profile/venv, not from cross-call persistence.)
 */
const PROFILE_MANAGED = new Set([
  'PATH', 'MANPATH', 'INFOPATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
]);

/**
 * Names matching ANY of these are treated as credentials and are NEVER persisted
 * to the scratch env file (default-ON makes this the last line of defense). A
 * denylist errs on the side of dropping: a missed-but-innocuous var simply won't
 * survive across calls, whereas a leaked secret would be written to /tmp.
 *
 * `(^|_)KEY($|_)` matches a bare KEY *token* (`KEY`, `FOO_KEY`, `KEY_ID`) without
 * over-matching KEY-containing words (`KEYBOARD`, `MONKEY`) — the K must sit at a
 * name boundary. `PRIVATE` (superset of the old `PRIVATE[_-]?KEY`), `SIGNING`,
 * `BEARER`, `CREDENTIAL`, `ACCESS[_-]?KEY` (AWS), and `SESSION_{TOKEN,SECRET,KEY}`
 * cover the families the reviews flagged as missing.
 */
const SECRET_RE = [
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /(^|_)KEY($|_)/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
  /SIGNING/i,
  /BEARER/i,
  /SESSION[_-]?(TOKEN|SECRET|KEY)/i,
  /ANTHROPIC/i,
  /OPENAI/i,
  /SUPABASE/i,
  /BLAXEL/i,
];

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a NUL-delimited `env -0` dump into a filtered name->value map. Splits on
 * the FIRST `=` so values may contain `=`/newlines/quotes. Drops invalid
 * identifiers, ephemeral/wrapper vars, and secret-looking names. Pure + total:
 * never throws, anything unparseable is simply dropped (never breaks the next command).
 */
export function parseEnvDump(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('\0')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    if (!SAFE_NAME.test(name)) continue;
    if (name.startsWith('VESTRA_')) continue; // drop all wrapper/internal VESTRA_* vars (spec glob)
    if (EPHEMERAL.has(name)) continue;
    if (SECRET_RE.some((re) => re.test(name))) continue;
    out[name] = pair.slice(eq + 1);
  }
  return out;
}

export interface TerminalSessionOpts {
  /** P3: capture/re-source exported env across calls. Default false (stateless env). */
  envCapture?: boolean;
}

/** Make an ownerTaskId safe to use as a directory name. */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'task';
}

/**
 * Per-task terminal session: holds the persistent cwd (Phase A) and, when
 * envCapture is on, a filtered exported-env snapshot (Phase B). State lives in
 * memory; the per-task scratch dir holds the files bash writes between calls.
 */
export class TerminalSession {
  readonly ownerTaskId: string;
  readonly workdir: string;
  readonly dir: string;
  readonly envCapture: boolean;
  protected _cwd: string;
  /** Persisted exported env (Phase B). Empty in Phase A. */
  protected _env: Record<string, string> = {};
  /**
   * Snapshot of process.env at construction — the delta baseline (Phase B). We
   * persist only vars whose value DIFFERS from this, i.e. what commands actually
   * added/changed, never the broad process.env slice. Snapshotted (not read live)
   * so a later mutation of process.env can't retroactively shift the baseline.
   */
  protected readonly _baseline: Record<string, string>;
  /** SHELL_CREDENTIAL_BROKER_V1: this task's placeholder and loopback routes. Undefined when off. */
  readonly broker: CredentialBroker | undefined;
  /** SHELL_EGRESS_V1=enforce: hosts the egress proxy refused for this task since the last note. */
  private readonly refusedHosts: string[] = [];

  constructor(ownerTaskId: string, seedCwd: string, opts: TerminalSessionOpts = {}) {
    this.ownerTaskId = ownerTaskId;
    this.workdir = seedCwd;
    this._cwd = seedCwd;
    this.envCapture = !!opts.envCapture;
    this._baseline = { ...process.env } as Record<string, string>;
    this.broker = credentialBrokerEnabled() ? new CredentialBroker() : undefined;
    this.dir = join(SCRATCH_ROOT, sanitize(ownerTaskId));
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* best-effort */ }
  }

  get cwd(): string { return this._cwd; }
  protected get cwdFile(): string { return join(this.dir, 'cwd'); }
  protected get envFile(): string { return join(this.dir, 'env'); }
  protected get envRawFile(): string { return join(this.dir, 'env.raw'); }

  /** Await before building a child env: starts the broker's loopback listener (flag on). */
  ready(): Promise<void> { return this.broker ? this.broker.start() : Promise.resolve(); }

  /** Flag on: `env` with this task's placeholder and routes in place of the real token. Off: `env` itself. */
  brokered<T extends Record<string, string | undefined>>(env: T): T {
    return this.broker ? this.broker.childEnv(env) : env;
  }

  /** Build the execFile invocation for a foreground command (Phase A; Phase B when envCapture). */
  buildExec(command: string): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
    const env: NodeJS.ProcessEnv = {
      // SHELL_CREDENTIAL_BROKER_V1 swaps the inherited env only, never the wrapper keys below
      // (the model's own command text is not rewritten). Off: the same keys in the same order.
      ...this.brokered({
        ...process.env,
        // Platform API v1 (L17): this task's company variables. After process.env, and BEFORE the
        // egress proxy and the wrapper's own keys below, so neither can be overridden by them.
        ...extraEnvByTask.get(this.ownerTaskId),
        // SHELL_EGRESS_V1=shadow|enforce: route this command's egress through the screening
        // proxy (undefined ⇒ nothing merged ⇒ byte-identical). Placed after process.env
        // so the proxy wins over any ambient HTTP(S)_PROXY. Enforce names the owning task.
        ...egressProxyVars(process.env, this.ownerTaskId),
      }),
      VESTRA_CMD: command,
      VESTRA_CWD: this._cwd,
      VESTRA_WORKDIR: this.workdir,
      VESTRA_CWDFILE: this.cwdFile,
    };
    let script = PHASE_A_SCRIPT;
    if (this.envCapture) {
      env.VESTRA_ENVFILE = this.envFile;
      env.VESTRA_ENVRAW = this.envRawFile;
      script = PHASE_B_SCRIPT;
    }
    // `cwd` is best-effort: the wrapper re-cd's authoritatively. Use a dir we know
    // exists so execFile does not throw ENOENT if the persisted cwd was deleted.
    const cwd = existsSync(this._cwd) ? this._cwd : this.workdir;
    return { file: 'bash', args: ['-lc', script], env, cwd };
  }

  /**
   * SHELL_SESSION_V1: a yielded command's wrapper. The same invocation as buildExec, except
   * that its pwd and env dump go to files of its own (named by `tag`), so a command that
   * outlives its call never races the next foreground command over the shared ones.
   */
  buildYieldExec(command: string, tag: string): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
    const x = this.buildExec(command);
    const f = this.yieldFiles(tag);
    x.env.VESTRA_CWDFILE = f.cwd;
    if (this.envCapture) x.env.VESTRA_ENVRAW = f.envRaw;
    return x;
  }

  /** SHELL_SESSION_V1: a yielded command finished inside its window: its cd and exports apply, as a foreground one's do. */
  captureYield(tag: string): void {
    const f = this.yieldFiles(tag);
    this.captureCwd(f.cwd);
    this.captureEnv(f.envRaw);
    this.discardYield(tag);
  }

  /** SHELL_SESSION_V1: a yielded command outlived its window: drop its files (the env dump holds cleartext); its cd and exports never apply. */
  discardYield(tag: string): void {
    const f = this.yieldFiles(tag);
    for (const p of [f.cwd, f.envRaw]) {
      try { rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
  }

  private yieldFiles(tag: string): { cwd: string; envRaw: string } {
    const t = sanitize(tag);
    return { cwd: join(this.dir, `cwd.${t}`), envRaw: join(this.dir, `env.raw.${t}`) };
  }

  /** After a foreground command, read the persisted pwd. Keep last-good on any error. */
  captureCwd(file: string = this.cwdFile): void {
    try {
      const v = readFileSync(file, 'utf8').trim();
      if (v) this._cwd = v;
    } catch { /* keep last-good */ }
  }

  /**
   * After a foreground command (envCapture on), read the raw env dump, filter it,
   * reduce to the DELTA vs the baseline process.env, re-emit as single-quote-escaped
   * exports (guaranteed re-sourceable), validate in a throwaway shell, then atomically
   * commit. ANY failure keeps the previous good env so the next command is never
   * broken (spec §4.1 Phase B mitigations).
   *
   * Delta capture: the wrapper re-sources the persisted env before each command, so
   * the post-command dump = process.env + previously-persisted-delta + this command's
   * changes. Keeping only vars whose value differs from `_baseline` therefore yields
   * the correct CUMULATIVE delta (prior persisted vars still differ from baseline and
   * are re-kept). An EMPTY delta (nothing exported, ever) is a fast no-op — no write,
   * no validate — which is the common case and removes per-command overhead.
   */
  captureEnv(rawFile: string = this.envRawFile): void {
    if (!this.envCapture) return;
    let raw: string;
    try { raw = readFileSync(rawFile, 'latin1'); } catch { return; } // keep last-good
    // Best-effort unlink: raw dump contains cleartext secrets; remove immediately after read.
    try { rmSync(rawFile, { force: true }); } catch { /* best-effort */ }
    if (!raw) return;
    const parsed = parseEnvDump(raw);
    // Keep only what this session actually added/changed vs the process.env baseline.
    // Profile-managed vars (PATH, ...) are excluded — `bash -l` re-derives them every
    // command, so they would spuriously fill the delta and defeat the no-op below.
    // NOTE: this is a NAME-based denylist — it cannot catch a credential embedded in a
    // non-secret-named var's VALUE (e.g. DATABASE_URL=postgres://user:pass@host); such a
    // value is persisted in cleartext to the per-task /tmp scratch for the session. The
    // boundary remains the per-user single-tenant sandbox (the user's own secret, in their
    // own sandbox); a value-scanning / typed-secret model is the proper follow-up.
    const next: Record<string, string> = {};
    // Broker on: the child started from the BROKERED baseline, so its loopback routes are not a delta.
    const baseline = this.brokered(this._baseline);
    for (const [k, v] of Object.entries(parsed)) {
      if (PROFILE_MANAGED.has(k)) continue;
      // A company variable, unchanged, is re-supplied every turn by setTaskExtraEnv: never
      // persisted to the scratch env file (it may be a secret, and a stale copy would win).
      if (extraEnvByTask.get(this.ownerTaskId)?.[k] === v) continue;
      if (String(baseline[k] ?? '') !== v) next[k] = v;
    }
    // Empty delta → nothing was exported: skip the write + the validate shell entirely.
    // Bare return (do NOT touch _env) so any already-persisted state survives a transient
    // empty dump (e.g. a one-off env-file sourcing hiccup), keeping last-good intact.
    if (Object.keys(next).length === 0) return;
    const body = Object.entries(next)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
      .join('\n') + '\n';
    const tmp = `${this.envFile}.tmp`;
    try {
      writeFileSync(tmp, body, 'latin1');
      // Validate the file is re-sourceable BEFORE committing (mitigation #2).
      execFileSync('bash', ['-c', `set -e; . "${tmp}"`], { stdio: 'ignore' });
      renameSync(tmp, this.envFile); // atomic commit (mitigation #1)
      this._env = next;
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      // keep previous good this._env
    }
  }

  /** Env to seed a background child with. Phase A: just process.env. */
  childEnv(): NodeJS.ProcessEnv {
    // ...egressProxyVars() (undefined ⇒ nothing) routes a background process's egress
    // through the screening proxy under SHELL_EGRESS_V1=shadow|enforce; byte-identical when off.
    const extra = extraEnvByTask.get(this.ownerTaskId);
    return this.brokered(this.envCapture
      ? { ...process.env, ...extra, ...this._env, ...egressProxyVars(process.env, this.ownerTaskId) }
      : { ...process.env, ...extra, ...egressProxyVars(process.env, this.ownerTaskId) });
  }

  noteEgressRefusal(host: string): void {
    if (this.refusedHosts.length < MAX_REFUSALS_NOTED) this.refusedHosts.push(host);
  }

  /** The refusals since the last call, as one plain line to append to a result ('' when none). */
  takeEgressRefusalNote(): string {
    const n = this.refusedHosts.length;
    if (n === 0) return '';
    const hosts = [...new Set(this.refusedHosts.splice(0))].join(', ');
    const what = n === 1 ? '1 connection to a private network address was'
      : `${n}${n >= MAX_REFUSALS_NOTED ? ' or more' : ''} connections to private network addresses were`;
    return `\nNote: ${what} blocked by policy (${hosts})`;
  }

  /** Remove the scratch dir. Best-effort, never throws. */
  cleanup(): void {
    this.broker?.close();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const sessions = new Map<string, TerminalSession>();

/**
 * The egress proxy's side of the refusal note: kept on the task's live terminal session only, so
 * an id with none (a child can forge the proxy credential) records nothing and holds no memory.
 */
export function recordEgressRefusal(ownerTaskId: string, host: string): void {
  sessions.get(ownerTaskId)?.noteEgressRefusal(host);
}

/** Get (or create on first call) the per-task terminal session. */
export function getSession(ownerTaskId: string, seedCwd: string, opts?: TerminalSessionOpts): TerminalSession {
  let s = sessions.get(ownerTaskId);
  if (!s) {
    s = new TerminalSession(ownerTaskId, seedCwd, opts);
    sessions.set(ownerTaskId, s);
  }
  return s;
}

/**
 * The LIVE persisted cwd of a task's terminal session, WITHOUT creating one.
 * null ⇒ no session exists yet (no Bash has run, so nothing has cd'd — the
 * caller's seed cwd is still authoritative). Non-creating on purpose: getSession
 * honors opts only on first-create, so a read-only consumer (the permission
 * gate resolving relative delete targets) must never be the one that creates
 * the session — it would pin envCapture off for the Bash tool.
 */
export function peekSessionCwd(ownerTaskId: string): string | null {
  return sessions.get(ownerTaskId)?.cwd ?? null;
}

/** Tear down a task's session: rm scratch dir + drop the registry entry. Never throws. */
export function cleanupSession(ownerTaskId: string): void {
  extraEnvByTask.delete(ownerTaskId);
  const s = sessions.get(ownerTaskId);
  if (!s) return;
  s.cleanup();
  sessions.delete(ownerTaskId);
}

/** Test-only: number of live sessions. */
export function _sessionCount(): number {
  return sessions.size;
}
