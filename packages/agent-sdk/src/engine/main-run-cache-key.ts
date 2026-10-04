import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../ports/runtime-config.js';

/**
 * The MAIN run's OpenAI-compatible prompt-cache anchor (`prompt_cache_key`),
 * shared by the per-round model call (round-engine) and the structured-output
 * epilogue's terminal constrained call (native-harness) — the two billed
 * main-turn sites, which MUST agree so the epilogue rides the same warm shard
 * as the loop rounds.
 *
 * USER+MODEL-scoped, not task-scoped. The cacheable prefix (system prompt +
 * tool schemas — ~29k tokens) is byte-identical across ALL of a user's tasks,
 * but the old per-task key deliberately gave every new task FRESH shard
 * affinity, so its first call only landed on a warm prefix cache by luck —
 * the observed bimodal TTFT on the Fireworks lanes (sub-second warm vs 15-21s
 * cold multi-tenant queue). A stable user+model key makes the first message of
 * a NEW task deliberately land on the SAME shard the user's previous tasks
 * warmed. At our scale, hot-shard risk from one user's traffic is negligible.
 *
 * This is a provider-side cache-AFFINITY HINT only: nothing else consumes
 * `cacheKey` (no journal/billing/dedup) — the transports forward it as
 * `prompt_cache_key` for providers that model the field, and the Anthropic arm
 * never reads it (its caching is explicit `cache_control`) → byte-identical.
 * Hashed so no raw user id rides the wire; sliced to 16 hex chars (affinity
 * needs stability, not collision-proofness).
 *
 * `userId` absent (legacy callers / tests that set no env) → the per-task anchor,
 * `taskId`. (It read a RuntimeConfig session id first; that field was the
 * process-wide env SESSION_ID — the task that started the runner — so it gave
 * every parallel task the first task's key. Where SESSION_ID was that task, the
 * key is unchanged.)
 *
 * SUBAGENT runs never route here — the Agent tool overrides the anchor with
 * its own per-agent-type shard key (PR5 item 2), which stays task-scoped so a
 * nested run never pollutes the parent's shard.
 */
export function mainRunCacheKey(
  runtime: RuntimeConfig | undefined,
  taskId: string,
  model: string,
): string {
  const userId = runtime?.userId;
  if (userId) {
    return `u-${createHash('sha256').update(`${userId}:${model}`).digest('hex').slice(0, 16)}`;
  }
  return taskId;
}

/**
 * The Agent tool's SUBAGENT shard anchor — task+agent-type+model-scoped (PR5
 * item 2: a nested run's distinct prefix must never pollute the parent task's
 * shard, and two same-slug children on different models must not share one).
 *
 * Hashed for the same two reasons as mainRunCacheKey, plus one hard constraint
 * the raw `${taskId}:sub:${slug}:${model}` concatenation violated: OpenAI caps
 * `prompt_cache_key` at 64 chars, and a uuid task id + a long slug + a long
 * model id (uuid + 'deep-researcher' + 'gpt-5.6-terra' = 70) 400s every spawn
 * before the subagent starts. `sub-` + 16 hex chars is bounded at 20.
 */
export function subRunCacheKey(ownerTaskId: string, agentSlug: string, model: string): string {
  return `sub-${createHash('sha256').update(`${ownerTaskId}:${agentSlug}:${model}`).digest('hex').slice(0, 16)}`;
}
