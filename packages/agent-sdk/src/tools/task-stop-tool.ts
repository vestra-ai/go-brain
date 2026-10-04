import { z } from 'zod';
import { stopProcess } from './process-registry.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import type { RawToolOptions } from './tool-types.js';

/**
 * TaskStop — kill a background task by id (SDK TaskStopInput; task_id optional in the SDK,
 * required for us). `ownerTaskId` scopes it to the owning task's processes; undefined is unscoped.
 */
function buildTaskStopTool(ownerTaskId: string | undefined): RawToolOptions {
  return {
    name: 'TaskStop',
    description: TOOL_DESCRIPTIONS.TaskStop,
    strict: true,
    parameters: z.object({
      task_id: z.string().describe('The ID of the background task to stop'),
    }),
    execute: async (args: unknown): Promise<string> => {
      const a = args as { task_id: string };
      return stopProcess(a.task_id, ownerTaskId);
    },
  };
}

/** TaskStop as the catalog registers it: scoped to its task. */
export function makeTaskStopTool(ownerTaskId: string): RawToolOptions {
  return buildTaskStopTool(ownerTaskId);
}

/** UNSCOPED: reaches every task's processes. Tests only; the catalog registers `makeTaskStopTool(taskId)`. */
export const taskStopToolOptions: RawToolOptions = buildTaskStopTool(undefined);
