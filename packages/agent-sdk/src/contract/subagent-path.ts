/**
 * Subagent identity / path — one segment per `Agent` tool_use level, root → leaf.
 *
 * Threaded through journal → interaction row → wire → UI so a HITL request raised by a
 * subagent at ANY depth can be attributed to the user as one prompt and resumed to that
 * exact child. The path is derivable from the journal (each `Agent` tool_use entry already
 * records its toolUseId/slug), so it is reconstructable on cold resume — it is routing /
 * attribution metadata, NOT a second source of truth.
 *
 * Part of the durable depth-agnostic subagent-HITL work
 * (docs/superpowers/plans/2026-06-29-subagent-deep-hitl.md). Absent path ⇒ main
 * agent ⇒ byte-identical to today.
 */
export interface SubagentPathSegment {
  /** 1 = the first subagent under the main turn; increments per nesting level. */
  depth: number;
  /** The `Agent` tool_use id at this level — the durable join key. */
  agentToolUseId: string;
  /** The subagent slug, for attribution UI (e.g. "research-agent"). */
  agentSlug: string;
  /** Friendly display name (e.g. "Research Agent"). */
  agentName: string;
}

/** The leaf subagent's stable id == the deepest path segment's `agentToolUseId`. */
export type SubagentId = string;

/**
 * Derive the leaf `SubagentId` from a root→leaf path. Returns `undefined` for an empty
 * path (the main agent — no subagent in the chain).
 */
export function subagentIdFromPath(path: readonly SubagentPathSegment[]): SubagentId | undefined {
  return path.length > 0 ? path[path.length - 1].agentToolUseId : undefined;
}
