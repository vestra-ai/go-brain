import { z } from 'zod';
import {
  getOutput, getOutputBlocking, stopProcess, MAX_BLOCKING_WAIT_MS,
  sendInput, closeStdin, listProcesses, readNewOutput, waitForProcess, type NewOutput,
} from './process-registry.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import { shellSessionEnabled, toolResultShapeEnabled } from '../policy/feature-flags.js';
import type { RawToolOptions, ToolExecuteContext } from './tool-types.js';
import { truncationMarker, softFail } from './result-shape.js';

/**
 * SHELL_SESSION_V1: the process tool as one half of a shell session (Bash `yield_ms` is the
 * other). A read returns what is new since the last read; write and submit return the reply.
 */
const SESSION_DESCRIPTION =
  'Continue a command still running from Bash (yield_ms or run_in_background:true). action: ' +
  '"read" (what it printed since your last read, a waiting prompt included; block+timeout waits ' +
  'for it to finish first; offset/limit page the whole output instead), "submit" (stdin + Enter: ' +
  'answer a prompt) and "write" (raw stdin), both returning its reply, "close" (EOF), "kill", ' +
  '"list" (your running jobs). Requires id for every action except list.';

const PARAM_TEXT = {
  offset: 'read: first line (default 0)',
  limit: 'read: max lines (default last 200)',
  timeout: 'read: max wait ms when block=true',
};

const SESSION_PARAM_TEXT: typeof PARAM_TEXT = {
  offset: 'read: page the whole output from this line, instead of what is new',
  limit: 'read: max lines (default the newest 200)',
  timeout: 'Max wait ms: read with block=true (default 30000), or for the reply to write/submit (default 2000)',
};

/** SHELL_SESSION_V1: how long the reply to an input may take, and the quiet that ends it. */
const REPLY_WAIT_MS = 2000;
const REPLY_SETTLE_MS = 300;

/**
 * SHELL_SESSION_V1: what a read of new output left out, in the one truncation marker (T5): the
 * new lines the byte budget dropped before they were read, and the oldest new lines a `limit`
 * left out (still kept, so the marker names the exact read that pages them back). Empty when
 * nothing is missing. Bash's yielded result uses it too (bash-tool.ts runYielded).
 */
export function newOutputMarker(id: string, r: Pick<NewOutput, 'lost' | 'skipped' | 'skippedAt'>): string {
  if (r.lost <= 0 && r.skipped <= 0) return '';
  const parts = [
    ...(r.lost > 0 ? [`${r.lost} earlier lines (no longer kept)`] : []),
    ...(r.skipped > 0 ? [`${r.skipped} lines`] : []),
  ];
  const recovery = r.skipped > 0
    ? `Read the skipped lines with process(action="read", id="${id}", offset=${r.skippedAt}, limit=${r.skipped}).`
    : 'Only the latest output is kept.';
  return truncationMarker({ omitted: parts.join(' and '), from: 'start', recovery });
}

/** SHELL_SESSION_V1: a read of what is new, as the model reads it. */
function formatNew(id: string, r: NewOutput): string {
  const ptyNote = r.pty ? ' (pty: exit code may not reflect the child)' : '';
  const lines = [`[${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ''}${ptyNote}]`];
  const marker = newOutputMarker(id, r);
  if (marker) lines.push(marker);
  lines.push(r.text || '(no new output)');
  return lines.join('\n');
}

/**
 * Unified background-process management tool (replaces TaskOutput/TaskStop).
 *
 * `ownerTaskId` scopes every action to the owning task's processes: another task's process
 * reads as unknown and `list` shows only this task's (per-session isolation invariant). The
 * catalog always registers the scoped build (`makeProcessTool`). Undefined is unscoped.
 */
function buildProcessTool(ownerTaskId: string | undefined, sessionOn: boolean): RawToolOptions {
  const p = sessionOn ? SESSION_PARAM_TEXT : PARAM_TEXT;
  return {
    name: 'process',
    description: sessionOn ? SESSION_DESCRIPTION : TOOL_DESCRIPTIONS.process,
    strict: true,
    parameters: z.object({
      action: z.enum(['read', 'list', 'write', 'submit', 'close', 'kill'])
        .describe('What to do with the background job'),
      id: z.string().nullable().optional().describe('The bg_ task id (required for all actions except list)'),
      data: z.string().nullable().optional().describe('Input for write/submit'),
      offset: z.number().int().nullable().optional().describe(p.offset),
      limit: z.number().int().nullable().optional().describe(p.limit),
      block: z.boolean().nullable().optional().describe('read: wait for the process to exit'),
      timeout: z.number().int().nullable().optional().describe(p.timeout),
    }),
    // T5: every failure in the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1); the words are unchanged.
    execute: async (args: unknown, context: ToolExecuteContext = {}): Promise<ReturnType<typeof softFail>> => {
      const a = args as {
        action: string; id?: string | null; data?: string | null;
        offset?: number | null; limit?: number | null; block?: boolean | null; timeout?: number | null;
      };
      if (a.action === 'list') {
        const rows = listProcesses(ownerTaskId);
        if (rows.length === 0) return 'No background tasks.';
        return rows.map((r) => `${r.id}  [${r.status}]  ${r.command}`).join('\n');
      }
      const id = a.id ?? '';
      if (!id) return softFail('invalid_input', `process: action '${a.action}' requires an id`);
      switch (a.action) {
        case 'read': {
          // SHELL_SESSION_V1: without an offset, a read is what is new since the last one;
          // a blocking one first waits for the process to finish (exit and both pipes
          // closed, so its last lines are in), clamped like every wait (L5).
          if (sessionOn && a.offset == null) {
            if (a.block) {
              try {
                await waitForProcess(id, Math.min(Math.max(0, a.timeout ?? 30_000), MAX_BLOCKING_WAIT_MS), {
                  ...(ownerTaskId !== undefined && { ownerTaskId }),
                  ...(context.signal !== undefined && { signal: context.signal }),
                });
              } catch {
                return softFail('aborted', `process: read aborted for ${id}`); // the wait rejects only on the signal
              }
            }
            return formatNew(id, readNewOutput(id, ownerTaskId, a.limit ?? 200));
          }
          // P3: a blocking read observes ctx.signal — a user interrupt rejects the
          // wait, which we map to a model-visible string (never-throw boundary).
          let res;
          try {
            res = a.block
              // L5: the wait is clamped (MAX_BLOCKING_WAIT_MS), so a long poll of a working
              // build returns [running] with its output, never a stalled call.
              ? await getOutputBlocking(id, Math.min(Math.max(0, a.timeout ?? 30_000), MAX_BLOCKING_WAIT_MS), context.signal, ownerTaskId)
              : getOutput(id, ownerTaskId);
          } catch {
            return context.signal?.aborted
              ? softFail('aborted', `process: read aborted for ${id}`)
              : softFail('exec_failed', `process: read failed for ${id}`);
          }
          const lines = res.output.split('\n');
          const start = a.offset ?? Math.max(0, lines.length - (a.limit ?? 200));
          const page = lines.slice(start, a.limit != null ? start + a.limit : undefined).join('\n');
          const ptyNote = res.pty ? ' (pty: exit code may not reflect the child)' : '';
          // Byte-budget ring buffer dropped older output — tell the model so it knows
          // the head is truncated (Hardening-H).
          const droppedNote = toolResultShapeEnabled()
            ? readWindowMarker(id, res.droppedBytes, a.offset == null ? start : 0)
            : res.droppedBytes > 0 ? `[dropped ${res.droppedBytes} bytes of earlier output]\n` : '';
          return `[${res.status}${res.exitCode != null ? ` exit=${res.exitCode}` : ''}${ptyNote}]\n${droppedNote}${page}`;
        }
        case 'write':
        case 'submit': {
          const sent = sendInput(id, a.data ?? '', {
            enter: a.action === 'submit',
            ...(ownerTaskId !== undefined && { ownerTaskId }),
          });
          if (!sessionOn || !sent.written) return sent.message;
          // SHELL_SESSION_V1: wait for the reply (output that then goes quiet, or the exit).
          try {
            await waitForProcess(id, Math.min(Math.max(0, a.timeout ?? REPLY_WAIT_MS), MAX_BLOCKING_WAIT_MS), {
              settleMs: REPLY_SETTLE_MS,
              ...(ownerTaskId !== undefined && { ownerTaskId }),
              ...(context.signal !== undefined && { signal: context.signal }),
            });
          } catch {
            // The input went in; a Stop cut the wait for its reply (the wait rejects only on the signal).
            return softFail('aborted', `${sent.message}\nprocess: wait aborted for ${id}`);
          }
          return `${sent.message}\n${formatNew(id, readNewOutput(id, ownerTaskId, a.limit ?? 200))}`;
        }
        case 'close': return closeStdin(id, ownerTaskId);
        case 'kill': return stopProcess(id, ownerTaskId);
        default: return softFail('invalid_input', `process: unknown action '${a.action}'`);
      }
    },
  };
}

/** The process tool as the catalog registers it: scoped to its task, SHELL_SESSION_V1 read when built. */
export function makeProcessTool(ownerTaskId: string): RawToolOptions {
  return buildProcessTool(ownerTaskId, shellSessionEnabled());
}

/**
 * UNSCOPED: reaches every task's processes. For the tests and the deferred-tool index only
 * (names and text); the catalog registers `makeProcessTool(taskId)`. Flag-off behaviour.
 */
export const processToolOptions: RawToolOptions = buildProcessTool(undefined, false);

/**
 * T5 (TOOL_RESULT_SHAPE_V1) — what a default read leaves out of its window, in the one
 * truncation marker: the bytes the ring buffer already dropped, and the earlier lines the
 * default last-200-line window skipped (silent before). Empty when nothing is missing.
 */
function readWindowMarker(id: string, droppedBytes: number, skippedLines: number): string {
  if (droppedBytes <= 0 && skippedLines <= 0) return '';
  const parts = [
    ...(droppedBytes > 0 ? [`${droppedBytes} bytes of the earliest output (no longer kept)`] : []),
    ...(skippedLines > 0 ? [`${skippedLines} lines`] : []),
  ];
  const recovery = skippedLines > 0
    ? `Read the skipped lines with process(action="read", id="${id}", offset=0, limit=${skippedLines}).`
    : 'Only the latest output is kept.';
  return `${truncationMarker({ omitted: parts.join(' and '), from: 'start', recovery })}\n`;
}
