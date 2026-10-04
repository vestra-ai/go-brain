import { z } from 'zod';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confinePath, WorkspaceEscapeError } from './fs-util.js';
import { toolDescription } from './descriptions/trimmed.js';
import { toolDescLeanEnabled, toolDescTrimEnabled } from '../policy/feature-flags.js';
import type { RawToolOptions, ToolExecuteContext } from './tool-types.js';
import { softFail } from './result-shape.js';
import { searchFailureCode } from './glob-tool.js';

const execFile = promisify(nodeExecFile);
const DEFAULT_HEAD_LIMIT = 250;

/**
 * Canonical Grep tool — ripgrep with the full SDK GrepInput surface (14 params).
 *
 * strict:true is load-bearing — do NOT drop it on the theory that it only served a
 * deleted arm. It was originally mandatory for the retired `@openai/agents` arm,
 * which threw `UserError('Strict mode is required for Zod parameters')` for any
 * Zod-object tool declared `strict:false`, killing the whole tool list at
 * `new Agent()` construction so every `runtime=openai` task PREWARM_STARTUP_FAILed
 * before the turn began (observed live: staging tasks 4452414c, 7a7157fd). That
 * arm is gone, but the flag is still READ: `openai-responses-transport` forwards
 * it to OpenAI Structured-Outputs to enable constrained decoding, downgrading
 * itself to strict:false whenever the converted schema is not strict-compatible.
 * The hyphen keys (-A/-B/-C/-n/-i/-o) survive strict generation as ordinary JSON
 * property names (verified) — strict mode constrains additionalProperties+required,
 * not key spelling. No shell injection: args are an array to execFile. 120s / 8 MB caps.
 * head_limit/offset are applied in-process (rg has no offset flag) so paging works
 * across all output modes.
 */
/**
 * Apply `offset`/`head_limit` paging to ripgrep's output lines and, when the cap
 * actually hides matches, state the window and the EXACT next call.
 *
 * TRUNCATION HONESTY: a silent head_limit cutoff is indistinguishable from "that
 * was all of them" — the model either misses matches it needed or burns a
 * round-trip re-running the same search to find out. Naming `offset=N` outright
 * also means it never has to compute the offset itself (the same contract Read's
 * `continue with offset=N` marker already keeps).
 *
 * Pure + exported so the contract is testable without an `rg` binary on PATH.
 * `limit === 0` means unlimited, in which case nothing is ever hidden.
 */
export function pageGrepLines(lines: string[], offset: number, limit: number): string {
  const sliced = limit === 0 ? lines.slice(offset) : lines.slice(offset, offset + limit);
  if (!sliced.length) return 'No matches found';
  const shown = offset + sliced.length;
  if (shown >= lines.length) return sliced.join('\n');
  return (
    `${sliced.join('\n')}\n` +
    `[showing ${offset + 1}-${shown} of ${lines.length} matches; continue with offset=${shown}]`
  );
}

/** Grep's parameter text, as the SDK's GrepInput words it. Flag-off builds advertise exactly this. */
const GREP_PARAM_TEXT = {
  pattern: 'The regular expression pattern to search for in file contents',
  path: 'File or directory to search in (rg PATH). Defaults to the workspace root.',
  glob: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") — maps to rg --glob',
  output_mode: 'Output mode: "content" shows matching lines, "files_with_matches" (default) shows file paths, "count" shows match counts.',
  '-B': 'Lines to show before each match (rg -B). Requires output_mode: "content".',
  '-A': 'Lines to show after each match (rg -A). Requires output_mode: "content".',
  '-C': 'Alias for context.',
  context: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
  '-n': 'Show line numbers (rg -n). Requires output_mode: "content". Defaults to true.',
  '-i': 'Case insensitive search (rg -i).',
  '-o': 'Print only the matched parts of each line (rg -o). Requires output_mode: "content".',
  type: 'File type to search (rg --type). E.g. js, py, rust, go, ts.',
  head_limit: 'Limit output to first N lines/entries. Defaults to 250. Pass 0 for unlimited.',
  offset: 'Skip first N lines/entries before applying head_limit. Defaults to 0.',
  multiline: 'Enable multiline mode where . matches newlines (rg -U --multiline-dotall).',
};

/**
 * TOOL_DESC_TRIM_V1 — the same meanings without the ripgrep restatement: every option a
 * model knows from rg keeps its default and its one constraint (the line options shape
 * "content" output only, said once on output_mode). Read when the tool is built.
 */
const GREP_PARAM_TEXT_TRIMMED: typeof GREP_PARAM_TEXT = {
  pattern: 'The regular expression to find.',
  path: 'File or folder to search; defaults to the workspace root.',
  glob: 'Only files matching this glob, e.g. "*.{ts,tsx}".',
  output_mode: '"files_with_matches" (default): paths. "content": matching lines, shaped by -A/-B/-C/context/-n/-o. "count": counts.',
  '-B': 'Lines before each match.',
  '-A': 'Lines after each match.',
  '-C': 'Same as context.',
  context: 'Lines before and after each match.',
  '-n': 'Line numbers, default true.',
  '-i': 'Ignore case.',
  '-o': 'Only the matched part of each line.',
  type: 'File type, e.g. py or ts.',
  head_limit: 'Max lines or entries, default 250; 0 for all.',
  offset: 'Skip this many lines or entries first.',
  multiline: 'Let . match newlines.',
};

/**
 * TOOL_DESC_LEAN_V1 — GREP_PARAM_TEXT with only the ripgrep restatements removed ("(rg -B)",
 * "maps to rg --glob"...): each option keeps its words, its default and its "Requires
 * output_mode" rule, exactly. `multiline` says in words what "-U" said (patterns can span lines),
 * since the description's "`multiline` spans lines" goes. TOOL_DESC_TRIM_V1, when on, wins.
 */
const GREP_PARAM_TEXT_LEAN: typeof GREP_PARAM_TEXT = {
  ...GREP_PARAM_TEXT,
  path: 'File or directory to search in. Defaults to the workspace root.',
  glob: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")',
  '-B': 'Lines to show before each match. Requires output_mode: "content".',
  '-A': 'Lines to show after each match. Requires output_mode: "content".',
  context: 'Number of lines to show before and after each match. Requires output_mode: "content", ignored otherwise.',
  '-n': 'Show line numbers. Requires output_mode: "content". Defaults to true.',
  '-i': 'Case insensitive search.',
  '-o': 'Print only the matched parts of each line. Requires output_mode: "content".',
  type: 'File type to search. E.g. js, py, rust, go, ts.',
  multiline: 'Enable multiline mode where . matches newlines and patterns can span lines.',
};

export function makeGrepTool(getWorkingDir: () => string): RawToolOptions {
  const p = toolDescTrimEnabled() ? GREP_PARAM_TEXT_TRIMMED : toolDescLeanEnabled() ? GREP_PARAM_TEXT_LEAN : GREP_PARAM_TEXT;
  return {
    name: 'Grep',
    description: toolDescription('Grep'),
    strict: true,
    // W3-2: pure search (rg over the workspace, no writes) — concurrency-safe.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    parameters: z.object({
      pattern: z.string().describe(p.pattern),
      path: z.string().nullable().optional().describe(p.path),
      glob: z.string().nullable().optional().describe(p.glob),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).nullable().optional().describe(p.output_mode),
      '-B': z.number().int().nullable().optional().describe(p['-B']),
      '-A': z.number().int().nullable().optional().describe(p['-A']),
      '-C': z.number().int().nullable().optional().describe(p['-C']),
      context: z.number().int().nullable().optional().describe(p.context),
      '-n': z.boolean().nullable().optional().describe(p['-n']),
      '-i': z.boolean().nullable().optional().describe(p['-i']),
      '-o': z.boolean().nullable().optional().describe(p['-o']),
      type: z.string().nullable().optional().describe(p.type),
      head_limit: z.number().int().nullable().optional().describe(p.head_limit),
      offset: z.number().int().nullable().optional().describe(p.offset),
      multiline: z.boolean().nullable().optional().describe(p.multiline),
    }),
    execute: async (args: unknown, context: ToolExecuteContext = {}) => {
      const a = args as {
        pattern: string;
        path?: string | null;
        glob?: string | null;
        output_mode?: 'content' | 'files_with_matches' | 'count' | null;
        '-B'?: number | null;
        '-A'?: number | null;
        '-C'?: number | null;
        context?: number | null;
        '-n'?: boolean | null;
        '-i'?: boolean | null;
        '-o'?: boolean | null;
        type?: string | null;
        head_limit?: number | null;
        offset?: number | null;
        multiline?: boolean | null;
      };

      const outputMode = a.output_mode ?? 'files_with_matches';
      const searchPath = a.path && a.path !== '.' ? a.path : '.';

      let dir: string;
      try {
        ({ abs: dir } = confinePath(searchPath, getWorkingDir()));
      } catch (e) {
        // T5: a workspace escape / bad path is invalid input, as on Read and Edit.
        return softFail('invalid_input', e instanceof WorkspaceEscapeError ? e.message : `Bad path: ${searchPath}`);
      }

      const flags: string[] = [];
      if (a['-i']) flags.push('-i');
      if (a.multiline) flags.push('-U', '--multiline-dotall');
      if (a.glob) flags.push('--glob', a.glob);
      if (a.type) flags.push('--type', a.type);

      if (outputMode === 'files_with_matches') {
        flags.push('-l');
      } else if (outputMode === 'count') {
        flags.push('-c');
      } else {
        // content mode
        if (a['-n'] !== false) flags.push('-n');
        if (a['-o']) flags.push('-o');
        const ctxC = a['-C'] ?? a.context;
        if (ctxC != null && ctxC > 0) {
          flags.push('-C', String(ctxC));
        } else {
          if (a['-A'] != null && a['-A'] > 0) flags.push('-A', String(a['-A']));
          if (a['-B'] != null && a['-B'] > 0) flags.push('-B', String(a['-B']));
        }
      }

      let stdout: string;
      try {
        ({ stdout } = await execFile(
          'rg',
          [...flags, '--', a.pattern, dir],
          {
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            // P3: forward the run's abort signal so a user interrupt kills rg
            // promptly (rejects with AbortError) instead of waiting out the timeout.
            ...(context.signal !== undefined && { signal: context.signal }),
          },
        ));
      } catch (err) {
        const e = err as { code?: number | string; stderr?: string; message?: string; killed?: boolean };
        if (e.code === 1) return 'No matches found';
        // T5: the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1), the failure kind as Bash splits it.
        return softFail(searchFailureCode(context, e), `Grep failed: ${e.stderr || e.message || String(err)}`);
      }

      // Paging: rg has no offset flag, so slice in-process. head_limit defaults to
      // 250; 0 means unlimited.
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      const off = a.offset != null && a.offset > 0 ? a.offset : 0;
      const limit = a.head_limit != null ? a.head_limit : DEFAULT_HEAD_LIMIT;
      return pageGrepLines(lines, off, limit);
    },
  };
}
