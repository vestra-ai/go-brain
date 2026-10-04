// tools/code-exec/docker-environment.ts
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type {
  ExecutionEnvironment,
  ExecRequest,
  ExecResult,
} from '../../ports/execution-environment-port.js';

const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The minimal child-process shape this environment drives. `node:child_process`'s
 * real `ChildProcess` satisfies it; unit tests inject a scripted fake so the exact
 * `docker run` argv is asserted WITHOUT a docker daemon.
 */
export interface SpawnedProc {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(): void;
}
export type SpawnLike = (command: string, args: string[]) => SpawnedProc;

export interface DockerEnvironmentOptions {
  /** Container image with BOTH python3 and node on PATH. Required — no default is
   *  baked into the pure SDK (the deployer owns the image; matches Hermes). */
  image: string;
  /** docker (or podman) binary. Default 'docker'. */
  dockerPath?: string;
  /** Give the container a network. Default false → `--network none`: the script gets
   *  NO network, yet in-code tool calls still reach the host over the bind-mounted
   *  AF_UNIX bridge socket (unix sockets are filesystem-, not network-namespaced). */
  network?: boolean;
  /** Memory cap (MB). Default 1024. `0` omits the flag. */
  memoryMb?: number;
  /** CPU cap. Default 2. `0` omits the flag. */
  cpus?: number;
  /** PID cap. Default 256. `0` omits the flag. */
  pidsLimit?: number;
  /** Bind-mount `req.cwd` (rw) at the same path + set it as workdir. Default true —
   *  so the script's direct file I/O lands in the same workspace the file tools use. */
  mountWorkspace?: boolean;
  /** `--user uid:gid` so writes to bind-mounts are host-owned. Default: image default. */
  user?: string;
  /** Extra raw `docker run` args, inserted just before the image. Default []. */
  extraRunArgs?: string[];
  /** Grace (ms) after a kill before force-settling if `docker kill` yields no client
   *  'close' — the anti-hang backstop. Default 3000. */
  killGraceMs?: number;
  /** Injectable spawn (tests). Default `node:child_process.spawn`. */
  spawn?: SpawnLike;
}

interface ExecState {
  out: string;
  err: string;
  timedOut: boolean;
  overflow: boolean;
  settled: boolean;
}

/**
 * A second `ExecutionEnvironment` backend: runs the snippet in a one-shot
 * `docker run --rm` container. The snippet dir and the bridge socket dir are
 * bind-mounted (the socket at its identical host path, so the generated stub's
 * AF_UNIX `connect(bridge.address)` Just Works with ZERO stub/bridge changes).
 *
 * Isolation upgrade over LocalSubprocessEnvironment: the script's OWN raw interpreter
 * syscalls (os.system, open, network) run in the container's namespaces, not on the
 * host — and with the default `--network none` the script has no network at all.
 * CAVEAT: in-code TOOL calls (run/read_file/write_file/patch/…) re-enter the host
 * dispatcher over the bridge, so they execute with the host agent's reach — the
 * container confines the script's direct syscalls, NOT the tools it invokes.
 *
 * PURE: only node builtins + the port type. No app-package imports, no host-env
 * reads, no remote-sandbox vendor — the deployer passes `image`/limits in via the
 * constructor; the product reads any host env on its own side and injects it here.
 */
export class DockerEnvironment implements ExecutionEnvironment {
  private readonly spawn: SpawnLike;
  constructor(private readonly opts: DockerEnvironmentOptions) {
    this.spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnLike);
  }

  /** Build the `docker run` argv (after the `docker` binary). Pure — tested directly. */
  buildRunArgs(req: ExecRequest, snippetDir: string, name: string): string[] {
    const o = this.opts;
    const sockDir = dirname(req.bridge.address);
    const interpreter = req.language === 'python' ? 'python3' : 'node';
    const ext = req.language === 'python' ? 'py' : 'mjs';
    const args: string[] = ['run', '--rm', '--name', name];

    // Network: default fully isolated. The bridge is a mounted unix socket, so the
    // script can still call tools even with no network.
    if (!o.network) args.push('--network', 'none');

    // Resource + privilege baseline (each cap omittable via 0).
    const pids = o.pidsLimit ?? 256;
    if (pids > 0) args.push('--pids-limit', String(pids));
    const mem = o.memoryMb ?? 1024;
    // Pin --memory-swap == --memory so the effective ceiling isn't silently ~2×
    // (swap defaults to memory when unset).
    if (mem > 0) args.push('--memory', `${mem}m`, '--memory-swap', `${mem}m`);
    const cpus = o.cpus ?? 2;
    if (cpus > 0) args.push('--cpus', String(cpus));
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init');
    if (o.user) args.push('--user', o.user);

    // Mounts: snippet (ro), the bridge socket dir (same path in+out), workspace (rw).
    args.push('-v', `${snippetDir}:/vestra:ro`);
    args.push('-v', `${sockDir}:${sockDir}`);
    // Workspace bind is guarded: never expose the host root or a sensitive system
    // root just because a prior `cd /` moved the session cwd there.
    if (o.mountWorkspace !== false && isMountableCwd(req.cwd)) {
      args.push('-v', `${req.cwd}:${req.cwd}`, '-w', req.cwd);
    }

    // Env: already secret-scrubbed by the caller. Passed as argv (no shell) → safe.
    for (const [k, v] of Object.entries(req.env)) {
      if (v === undefined) continue;
      args.push('-e', `${k}=${v}`);
    }

    if (o.extraRunArgs) args.push(...o.extraRunArgs);
    args.push(o.image, interpreter, `/vestra/snippet.${ext}`);
    return args;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const docker = this.opts.dockerPath ?? 'docker';
    const dir = await mkdtemp(join(tmpdir(), 'vestra-codeexec-docker-'));
    const ext = req.language === 'python' ? 'py' : 'mjs';
    const name = `vestra-ce-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(join(dir, `snippet.${ext}`), req.code, 'utf8');
      // The bridge socket dir is mkdtemp'd 0700 and the socket is owner-only; with
      // --cap-drop ALL the container can't DAC-override, so a container uid != host
      // uid (notably via --user) could NOT connect. Loosen dir+socket so any
      // container uid reaches the bridge — the 192-bit per-run nonce is the real
      // auth (and the host is single-tenant). Best-effort.
      try {
        await chmod(dirname(req.bridge.address), 0o711);
        await chmod(req.bridge.address, 0o666);
      } catch {
        /* if chmod fails the connect may still work when uids align */
      }
      const args = this.buildRunArgs(req, dir, name);
      return await this.spawnAndWait(docker, args, name, req);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private spawnAndWait(
    docker: string,
    args: string[],
    name: string,
    req: ExecRequest,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      const st: ExecState = { out: '', err: '', timedOut: false, overflow: false, settled: false };
      // Per-stream UTF-8 decoders: a multibyte char split across two 'data' chunks
      // would be corrupted by per-chunk toString(). (Same hazard the bridge fixed.)
      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      let bytes = 0; // raw byte count for the cap (NOT UTF-16 .length)
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const proc = this.spawn(docker, args);

      const settle = (code: number | null) => {
        if (st.settled) return;
        st.settled = true;
        clearTimeout(timer);
        if (backstop) clearTimeout(backstop);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        st.out += outDec.end();
        st.err += errDec.end();
        if (st.overflow) {
          const mb = MAX_BUFFER / 1024 / 1024;
          resolve({
            stdout: `${st.out}\n[output exceeded ${mb} MB - process stopped]`,
            stderr: st.err,
            exitCode: 0,
            timedOut: false,
          });
          return;
        }
        if (st.timedOut) {
          resolve({ stdout: st.out, stderr: st.err, exitCode: 124, timedOut: true });
          return;
        }
        resolve({ stdout: st.out, stderr: st.err, exitCode: code ?? 1, timedOut: false });
      };

      // Kill the CONTAINER (not just the run client) — `docker kill <name>`, with
      // `--rm` reaping it. spawn reports ENOENT ASYNCHRONOUSLY via 'error'; an
      // unhandled 'error' would crash the process, so attach a no-op handler.
      const killContainer = () => {
        const k = this.spawn(docker, ['kill', name]);
        k.on('error', () => {
          /* docker gone — the client kill below still stops streaming */
        });
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
      };

      // Kill AND guarantee settlement: if `docker kill` never yields a client
      // 'close' (daemon hiccup), a backstop force-settles so the turn cannot hang
      // forever (the contract LocalSubprocessEnvironment gives for free).
      const killAndBackstop = () => {
        killContainer();
        if (!backstop) backstop = setTimeout(() => settle(137), this.opts.killGraceMs ?? 3000);
      };

      const onChunk = (key: 'out' | 'err', dec: StringDecoder) => (chunk: Buffer | string) => {
        if (st.settled) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += buf.length;
        st[key] += dec.write(buf);
        if (bytes > MAX_BUFFER && !st.overflow) {
          st.overflow = true;
          killAndBackstop();
        }
      };
      proc.stdout?.on('data', onChunk('out', outDec));
      proc.stderr?.on('data', onChunk('err', errDec));
      proc.on('error', (e) => {
        if (st.settled) return;
        st.err += String(e?.message ?? e);
        settle(1);
      });
      proc.on('close', (code) => settle(code));

      // Host-side timeout (no docker --stop-timeout): kill the container, mark timedOut.
      const timer = setTimeout(() => {
        if (st.settled) return;
        st.timedOut = true;
        killAndBackstop();
      }, req.timeoutMs);

      // Cooperative abort: a user interrupt kills the container promptly.
      const onAbort = () => {
        if (st.settled) return;
        killAndBackstop();
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

/**
 * Whether `cwd` is safe to bind-mount rw into the container. Must be an absolute
 * path AND not the host root or a sensitive system root (a prior `cd /` would
 * otherwise mount the entire host filesystem rw). Workspace subdirs of these
 * (e.g. `/root/workspace`, `/app/workspace`) are fine — only the EXACT roots are
 * refused.
 */
const FORBIDDEN_MOUNT_ROOTS: ReadonlySet<string> = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/var', '/root', '/home', '/sys', '/proc', '/dev',
]);
export function isMountableCwd(cwd: string): boolean {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return false;
  const norm = cwd.replace(/\/+$/, '') || '/';
  return !FORBIDDEN_MOUNT_ROOTS.has(norm);
}
