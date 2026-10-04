import { z } from 'zod';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confinePath, WorkspaceEscapeError } from './fs-util.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import type { RawToolOptions, ToolExecuteContext } from './tool-types.js';
import { softFail } from './result-shape.js';

const execFile = promisify(nodeExecFile);

/**
 * Glob tool for the OpenAI arm. Spawns `rg --files -g <pattern>` (ripgrep)
 * which respects .gitignore by default — closest fidelity to Claude's Glob.
 * No shell injection: args are passed as an array to execFile. 120s timeout +
 * 8 MB output cap mirrors the Bash tool limits.
 */
export function makeGlobTool(getWorkingDir: () => string): RawToolOptions {
  return {
    name: 'Glob',
    description: TOOL_DESCRIPTIONS.Glob,
    strict: true,
    // W3-2: pure filename search (no writes) — concurrency-safe.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    parameters: z.object({
      pattern: z.string().describe('Glob pattern to match (e.g. "**/*.ts", "*.json").'),
      path: z
        .string()
        .nullable()
        .optional()
        .describe('The directory to search in. If not specified, the workspace root is used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" — simply omit it. Must be a valid directory path if provided.'),
    }),
    execute: async (args: unknown, context: ToolExecuteContext = {}) => {
      const { pattern, path } = args as { pattern: string; path?: string | null };

      // Path confinement for the search directory (lexical + realpath, so a
      // symlinked dir inside the workspace cannot point rg outside it).
      const searchPath = path && path !== '.' ? path : '.';
      let dir: string;
      try {
        ({ abs: dir } = confinePath(searchPath, getWorkingDir()));
      } catch (e) {
        // T5: a workspace escape / bad path is invalid input, as on Read and Edit.
        return softFail('invalid_input', e instanceof WorkspaceEscapeError
          ? e.message
          : `Bad path: ${searchPath}`);
      }

      try {
        const { stdout } = await execFile(
          'rg',
          ['--files', '-g', pattern, '--', dir],
          {
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            // P3: forward the run's abort signal so a user interrupt kills rg
            // promptly (rejects with AbortError) instead of waiting out the timeout.
            ...(context.signal !== undefined && { signal: context.signal }),
          },
        );
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .sort();
        return lines.length ? lines.join('\n') : 'No files found';
      } catch (err) {
        // rg exits with code 1 when there are no matches — that is not an error.
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
        if (e.code === 1) return 'No files found';
        // T5: the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1), the failure kind as Bash splits it.
        return softFail(searchFailureCode(context, e), `Glob failed: ${e.stderr || e.message || String(err)}`);
      }
    },
  };
}

/** Node's error code when a child's output overflows `maxBuffer` (it also kills the child). */
const MAXBUFFER_EXCEEDED = 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED';

/**
 * T5 — which taxonomy code a failed `rg` run carries. An output overflow first: Node kills the
 * child on it too (`killed: true`), and read as a `timeout` (transient) it would invite the
 * Agent and Weave retry consumers to re-run the same oversized search. Then the run's own
 * interrupt (the signal is the version-independent truth), then the exec timeout's kill, else
 * a plain failure. Shared with Grep.
 */
export function searchFailureCode(
  context: ToolExecuteContext,
  e: { killed?: boolean; code?: number | string },
): 'too_large' | 'aborted' | 'timeout' | 'exec_failed' {
  if (e.code === MAXBUFFER_EXCEEDED) return 'too_large';
  return context.signal?.aborted === true ? 'aborted' : e.killed === true ? 'timeout' : 'exec_failed';
}
