import { z } from 'zod';
import { getOutput, getOutputBlocking, MAX_BLOCKING_WAIT_MS } from './process-registry.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import type { RawToolOptions, ToolExecuteContext } from './tool-types.js';

/**
 * TaskOutput — poll a background task's accumulated output (SDK TaskOutputInput).
 * `ownerTaskId` scopes it to the owning task's processes (another task's reads as unknown);
 * undefined is unscoped.
 */
function buildTaskOutputTool(ownerTaskId: string | undefined): RawToolOptions {
  return {
    name: 'TaskOutput',
    description: TOOL_DESCRIPTIONS.TaskOutput,
    strict: true,
    parameters: z.object({
      task_id: z.string().describe('The task ID to get output from'),
      block: z.boolean().describe('Whether to wait for completion'),
      timeout: z.number().int().describe('Max wait time in ms'),
    }),
    execute: async (args: unknown, ctx?: ToolExecuteContext): Promise<string> => {
      const a = args as { task_id: string; block: boolean; timeout: number };
      // L5: clamp the wait (process-registry.ts MAX_BLOCKING_WAIT_MS) and honour the
      // dispatcher's signal, so Stop ends the wait instead of the wait outliving the round.
      const waitMs = Math.min(Math.max(0, a.timeout), MAX_BLOCKING_WAIT_MS);
      const res = a.block
        ? await getOutputBlocking(a.task_id, waitMs, ctx?.signal, ownerTaskId)
        : getOutput(a.task_id, ownerTaskId);
      return `[${res.status}${res.exitCode != null ? ` exit=${res.exitCode}` : ''}]\n${res.output}`;
    },
  };
}

/** TaskOutput as the catalog registers it: scoped to its task. */
export function makeTaskOutputTool(ownerTaskId: string): RawToolOptions {
  return buildTaskOutputTool(ownerTaskId);
}

/** UNSCOPED: reaches every task's processes. Tests only; the catalog registers `makeTaskOutputTool(taskId)`. */
export const taskOutputToolOptions: RawToolOptions = buildTaskOutputTool(undefined);
