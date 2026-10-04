// tools/code-exec/local-subprocess-environment.ts
import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionEnvironment, ExecRequest, ExecResult } from '../../ports/execution-environment-port.js';

const MAX_BUFFER = 8 * 1024 * 1024;

interface ExecErr extends Error { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string; }

/** Default code-exec runtime: a plain child_process on the host the agent runs on.
 *  No remote-sandbox vendor, no host-env reads, no app-package imports. */
export class LocalSubprocessEnvironment implements ExecutionEnvironment {
  async run(req: ExecRequest): Promise<ExecResult> {
    const dir = await mkdtemp(join(tmpdir(), 'vestra-codeexec-'));
    const ext = req.language === 'python' ? 'py' : 'mjs';
    const file = join(dir, `snippet.${ext}`);
    const cmd = req.language === 'python' ? 'python3' : 'node';
    try {
      await writeFile(file, req.code, 'utf8');
      return await new Promise<ExecResult>((resolve) => {
        execFile(
          cmd, [file],
          {
            cwd: req.cwd,
            env: req.env as NodeJS.ProcessEnv,
            timeout: req.timeoutMs,
            maxBuffer: MAX_BUFFER,
            // Forward the caller's abort signal so a user abort KILLS the child
            // promptly (execFile sends SIGTERM) instead of waiting out the timeout.
            ...(req.signal !== undefined && { signal: req.signal }),
          },
          (err, stdout, stderr) => {
            if (!err) { resolve({ stdout, stderr, exitCode: 0, timedOut: false }); return; }
            const e = err as ExecErr;
            // maxBuffer overflow: the process RAN and produced too much output — it
            // is NOT a timeout. On some Node versions the overflow kill is
            // killed+SIGTERM (identical to a timeout), so this MUST be checked
            // BEFORE the timeout classification below, else partial output is
            // dropped and the result is mislabelled "timed out". (Mirrors bash-tool.)
            const overflow =
              e.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED' ||
              e.code === 'ERR_CHILD_PROCESS_STDERR_MAXBUFFER_EXCEEDED' ||
              e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
              /maxBuffer/i.test(e.message ?? '');
            if (overflow) {
              const partial = e.stdout ?? stdout ?? '';
              const mb = MAX_BUFFER / 1024 / 1024;
              resolve({
                stdout: `${partial}\n[output exceeded ${mb} MB - process stopped]`,
                stderr: e.stderr ?? stderr ?? '',
                exitCode: 0,
                timedOut: false,
              });
              return;
            }
            const timedOut = e.killed === true && e.signal === 'SIGTERM';
            const exitCode = typeof e.code === 'number' ? e.code : 1;
            resolve({
              stdout: e.stdout ?? stdout ?? '',
              stderr: e.stderr ?? stderr ?? String(e.message ?? ''),
              exitCode: timedOut ? 124 : exitCode,
              timedOut,
            });
          },
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
