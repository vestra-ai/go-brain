// local-subprocess-environment.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { LocalSubprocessEnvironment } from '../../tools/code-exec/local-subprocess-environment.js';
import type { ExecRequest } from '../../ports/execution-environment-port.js';

function has(cmd: string): boolean { try { execFileSync(cmd, ['--version']); return true; } catch { return false; } }
const base = (over: Partial<ExecRequest>): ExecRequest => ({
  language: 'python', code: '', timeoutMs: 5000, cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? '' }, bridge: { kind: 'uds', address: '/tmp/x.sock', token: 'n' }, ...over,
});

describe('LocalSubprocessEnvironment', () => {
  const env = new LocalSubprocessEnvironment();

  it.skipIf(!has('python3'))('runs python and captures stdout', async () => {
    const r = await env.run(base({ language: 'python', code: 'print("hi")' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
    expect(r.timedOut).toBe(false);
  });

  it.skipIf(!has('node'))('runs node and captures stdout', async () => {
    const r = await env.run(base({ language: 'node', code: 'console.log("hi")' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
  });

  it.skipIf(!has('python3'))('non-zero exit is reported, not thrown', async () => {
    const r = await env.run(base({ code: 'import sys; sys.stderr.write("boom"); sys.exit(3)' }));
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it.skipIf(!has('python3'))('timeout is reported as timedOut', async () => {
    const r = await env.run(base({ code: 'import time; time.sleep(5)', timeoutMs: 300 }));
    expect(r.timedOut).toBe(true);
  });

  it.skipIf(!has('node'))('maxBuffer overflow surfaces partial output + a marker, NOT a timeout', async () => {
    // >8MB stdout forces a maxBuffer kill. On some Node versions that kill shape is
    // killed+SIGTERM — identical to a timeout — so it must be detected FIRST and
    // reported as partial output (not timedOut), with the partial bytes preserved.
    const r = await env.run(base({
      language: 'node',
      code: "process.stdout.write('x'.repeat(9*1024*1024))",
      timeoutMs: 60_000,
    }));
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toMatch(/output exceeded 8 MB - process stopped/);
    expect(r.stdout).toContain('x');
  });
});
