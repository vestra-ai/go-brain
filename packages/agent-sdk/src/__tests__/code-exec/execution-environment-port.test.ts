import { describe, it, expect } from 'vitest';
import type { ExecutionEnvironment, ExecRequest, ExecResult } from '../../ports/execution-environment-port.js';

describe('ExecutionEnvironment port', () => {
  it('a minimal impl satisfies the contract', async () => {
    const fake: ExecutionEnvironment = {
      async run(req: ExecRequest): Promise<ExecResult> {
        return { stdout: req.code, stderr: '', exitCode: 0, timedOut: false };
      },
    };
    const out = await fake.run({
      language: 'python', code: 'print(1)', timeoutMs: 1000,
      cwd: '/tmp', env: {}, bridge: { kind: 'uds', address: '/tmp/s.sock', token: 'n' },
    });
    expect(out).toEqual({ stdout: 'print(1)', stderr: '', exitCode: 0, timedOut: false });
  });
});
