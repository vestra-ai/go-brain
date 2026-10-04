import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { DockerEnvironment, type SpawnLike, type SpawnedProc } from '../../tools/code-exec/docker-environment.js';
import type { ExecRequest } from '../../ports/execution-environment-port.js';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
}

function makeFakeSpawn(opts: { closeOnKill?: boolean } = {}) {
  const closeOnKill = opts.closeOnKill !== false;
  const calls: { command: string; args: string[]; proc: FakeProc }[] = [];
  let runProc: FakeProc | undefined;
  const spawn: SpawnLike = (command, args) => {
    const proc = new FakeProc();
    calls.push({ command, args, proc });
    if (args[0] === 'run') runProc = proc;
    // A `docker kill <name>` makes the container (and thus the run client) exit —
    // unless closeOnKill is false (simulating a daemon hiccup → exercises the backstop).
    if (args[0] === 'kill' && closeOnKill) queueMicrotask(() => runProc?.emit('close', 137));
    return proc as unknown as SpawnedProc;
  };
  return {
    spawn,
    calls,
    runCall: () => calls.find((c) => c.args[0] === 'run'),
    killCall: () => calls.find((c) => c.args[0] === 'kill'),
  };
}

function req(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    language: 'python',
    code: 'print("hi")',
    timeoutMs: 5000,
    cwd: '/app/workspace',
    env: { PATH: '/usr/bin', VESTRA_RPC_SOCKET: '/tmp/vb-abc/b.sock' },
    bridge: { kind: 'uds', address: '/tmp/vb-abc/b.sock', token: 'tok' },
    ...overrides,
  };
}

describe('DockerEnvironment.buildRunArgs (pure argv assembly)', () => {
  const env = new DockerEnvironment({ image: 'vestra/ce:latest' });

  it('assembles a hardened, network-isolated run with the right mounts + interpreter', () => {
    const args = env.buildRunArgs(req(), '/tmp/snip-1', 'vestra-ce-x');
    const s = args.join(' ');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--name', 'vestra-ce-x']);
    expect(s).toContain('--network none');
    expect(s).toContain('--pids-limit 256');
    expect(s).toContain('--memory 1024m');
    expect(s).toContain('--cpus 2');
    expect(s).toContain('--cap-drop ALL');
    expect(s).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
    // --memory-swap pinned == --memory so the effective ceiling isn't ~2×.
    expect(s).toContain('--memory-swap 1024m');
    // snippet ro, bridge socket dir at the SAME path, workspace rw + workdir
    expect(s).toContain('-v /tmp/snip-1:/vestra:ro');
    expect(s).toContain('-v /tmp/vb-abc:/tmp/vb-abc');
    expect(s).toContain('-v /app/workspace:/app/workspace -w /app/workspace');
    // already-scrubbed env passed verbatim as -e
    expect(s).toContain('-e PATH=/usr/bin');
    expect(s).toContain('-e VESTRA_RPC_SOCKET=/tmp/vb-abc/b.sock');
    // image then interpreter + snippet path, in that order, at the very end
    expect(args.slice(-3)).toEqual(['vestra/ce:latest', 'python3', '/vestra/snippet.py']);
  });

  it('node language → node /vestra/snippet.mjs', () => {
    const args = env.buildRunArgs(req({ language: 'node' }), '/tmp/snip-2', 'n');
    expect(args.slice(-3)).toEqual(['vestra/ce:latest', 'node', '/vestra/snippet.mjs']);
  });

  it('network:true omits --network none', () => {
    const e = new DockerEnvironment({ image: 'img', network: true });
    expect(e.buildRunArgs(req(), '/tmp/s', 'x').join(' ')).not.toContain('--network');
  });

  it('mountWorkspace:false omits the workspace bind + workdir', () => {
    const e = new DockerEnvironment({ image: 'img', mountWorkspace: false });
    const s = e.buildRunArgs(req(), '/tmp/s', 'x').join(' ');
    expect(s).not.toContain('/app/workspace:/app/workspace');
    expect(s).not.toContain('-w ');
  });

  it('zeroed caps omit their flags; user + extraRunArgs are honored', () => {
    const e = new DockerEnvironment({
      image: 'img',
      memoryMb: 0,
      cpus: 0,
      pidsLimit: 0,
      user: '1000:1000',
      extraRunArgs: ['--read-only'],
    });
    const args = e.buildRunArgs(req(), '/tmp/s', 'x');
    const s = args.join(' ');
    expect(s).not.toContain('--memory');
    expect(s).not.toContain('--cpus');
    expect(s).not.toContain('--pids-limit');
    expect(s).toContain('--user 1000:1000');
    // extraRunArgs land immediately before the image (which is 3rd-from-last:
    // [..., '--read-only', image, interpreter, snippet]).
    expect(args[args.length - 4]).toBe('--read-only');
    expect(args[args.length - 3]).toBe('img');
  });

  it('refuses to bind-mount the host root or a sensitive root (cd / guard)', () => {
    for (const root of ['/', '/etc', '/root', '/var']) {
      const s = env.buildRunArgs(req({ cwd: root }), '/tmp/s', 'x').join(' ');
      expect(s).not.toContain(`-v ${root}:${root}`);
    }
    // a workspace SUBDIR of a sensitive root is still fine
    const ok = env.buildRunArgs(req({ cwd: '/root/workspace' }), '/tmp/s', 'x').join(' ');
    expect(ok).toContain('-v /root/workspace:/root/workspace');
  });
});

describe('DockerEnvironment.run (driven via a fake docker)', () => {
  it('captures stdout + exit code on a clean run', async () => {
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req());
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    const proc = f.runCall()!.proc;
    proc.stdout.emit('data', 'hello\n');
    proc.emit('close', 0);
    const res = await p;
    expect(res).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false });
  });

  it('propagates a non-zero container exit code', async () => {
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req());
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    const proc = f.runCall()!.proc;
    proc.stderr.emit('data', 'boom');
    proc.emit('close', 3);
    expect(await p).toEqual({ stdout: '', stderr: 'boom', exitCode: 3, timedOut: false });
  });

  it('on timeout: kills the container (docker kill <name>) and returns exitCode 124/timedOut', async () => {
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req({ timeoutMs: 15 }));
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    const res = await p; // never emits close on its own; timer → kill → fake close
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    const kill = f.killCall();
    expect(kill).toBeTruthy();
    expect(kill!.args).toEqual(['kill', f.runCall()!.args[3]]); // the --name value
  });

  it('on abort: kills the container promptly', async () => {
    const ac = new AbortController();
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req({ timeoutMs: 10_000, signal: ac.signal }));
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    ac.abort();
    await p;
    expect(f.killCall()).toBeTruthy();
  });

  it('decodes a multibyte UTF-8 char split across two chunks without corruption', async () => {
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req());
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    const proc = f.runCall()!.proc;
    // '€' is E2 82 AC in UTF-8 — split it across two data events.
    const euro = Buffer.from('€', 'utf8');
    proc.stdout.emit('data', euro.subarray(0, 1));
    proc.stdout.emit('data', euro.subarray(1));
    proc.emit('close', 0);
    const res = await p;
    expect(res.stdout).toBe('€'); // not '��…'
  });

  it('does NOT hang if docker kill yields no client close — the backstop force-settles', async () => {
    const f = makeFakeSpawn({ closeOnKill: false });
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn, killGraceMs: 20 });
    const res = await env.run(req({ timeoutMs: 10 })); // timer → kill (no close) → backstop
    expect(res.timedOut).toBe(true); // st.timedOut set before the backstop fired
    expect(f.killCall()).toBeTruthy();
  });

  it('on >8MB output: stops the container and marks the overflow (exitCode 0)', async () => {
    const f = makeFakeSpawn();
    const env = new DockerEnvironment({ image: 'img', spawn: f.spawn });
    const p = env.run(req());
    await vi.waitFor(() => expect(f.runCall()).toBeTruthy());
    const proc = f.runCall()!.proc;
    proc.stdout.emit('data', 'x'.repeat(9 * 1024 * 1024));
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain('[output exceeded 8 MB - process stopped]');
    expect(f.killCall()).toBeTruthy();
  });
});

// Opt-in real-container e2e — runs ONLY when a dev points it at a local image that
// has python3 (never in normal CI, so no daemon/pull flakiness). Set
// VESTRA_DOCKER_E2E_IMAGE=<image> with docker running.
function dockerReady(): boolean {
  if (!process.env.VESTRA_DOCKER_E2E_IMAGE) return false;
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('DockerEnvironment real container (opt-in)', () => {
  it.skipIf(!dockerReady())('runs a python snippet to completion', async () => {
    const env = new DockerEnvironment({ image: process.env.VESTRA_DOCKER_E2E_IMAGE! });
    const res = await env.run(
      req({ code: 'print("docker-ok")', cwd: '/tmp', mountWorkspace: false } as Partial<ExecRequest>),
    );
    expect(res.stdout).toContain('docker-ok');
    expect(res.exitCode).toBe(0);
  });
});
