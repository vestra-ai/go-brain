/**
 * The common JournalEntry envelope every native append starts from.
 *
 * Its own module because BOTH native-journal.ts (the conversation appends) and
 * telemetry-entries.ts (the CONTEXT_POLICY:false observability appends) build on
 * it, and having either import it from the other would make a cycle out of two
 * modules that genuinely share one small thing. Depends on contract types only.
 */
import type { NewEntry } from '../contract/journal.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import type { HarnessContext } from '../contract/harness.js';
import type { NativeConfigLike } from './native-config-like.js';

/**
 * Build the common JournalEntry fields from a taskId + the tenant boundary.
 * `workspaceId` is the injected `userId` (the tenant boundary); `userId || 'sandbox'`
 * reproduces the prior `process.env.USER_ID ?? 'sandbox'` for every real input
 * (unset env → `''` → `'sandbox'`; a real id → the real id). `timestamp` is left
 * empty — `Journal.doAppend` fills it from the clock.
 */
export function baseFromTaskId(
  taskId: string,
  userId: string,
  agentPath?: SubagentPathSegment[],
): Omit<NewEntry, 'payload'> {
  return {
    taskId,
    rootTaskId: taskId,
    spawnDepth: 0,
    workspaceId: userId || 'sandbox',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '', // Journal.doAppend fills this from the clock
    // T10 — scope the entry to a subagent's inner conversation. CONDITIONAL spread:
    // an absent/empty path leaves NO `agentPath` key, so a main-agent entry is
    // byte-identical to today (golden-asserted). Only present under the recursion flag.
    ...(agentPath && agentPath.length ? { agentPath } : {}),
  };
}

export function base(
  ctx: HarnessContext<NativeConfigLike>,
  agentPath?: SubagentPathSegment[],
): Omit<NewEntry, 'payload'> {
  const userId = ctx.config.runtimeConfig?.userId ?? '';
  return baseFromTaskId(ctx.taskId, userId, agentPath);
}
