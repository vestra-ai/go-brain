import type { ToolCall } from '../contract/harness.js';
import type { InteractionKind } from '../contract/interaction.js';
import type { SubagentId, SubagentPathSegment } from '../contract/subagent-path.js';

/**
 * InteractionPort — fires a human-in-the-loop interaction and returns its id.
 * The host persists it, delivers it to the user, and resolves it out-of-band.
 */
export interface InteractionPort {
  requestInteraction(a: {
    taskId: string;
    call: ToolCall;
    kind: InteractionKind;
    signal?: AbortSignal;
    /**
     * P2.4 (subagent-deep-HITL) — OPTIONAL identity of the child that paused. When a
     * pause bubbled up from a nested subagent, `subagentId` is the leaf `Agent` tool_use
     * id and `subagentPath` the root→leaf path. The host threads them onto the durable
     * row + the INTERACTION_REQUIRED wire so a resolved continue routes back to THAT
     * child's lane. Both absent ⇒ a main-agent pause ⇒ byte-identical to today.
     */
    subagentId?: SubagentId;
    subagentPath?: SubagentPathSegment[];
  }): Promise<string>;
  requestComposioAuth(a: {
    toolName: string;
    toolCallId: string;
    toolkit: string;
    authUrl: string;
  }): Promise<string>;
}

/**
 * SDK default: explicit failure. A no-host SDK cannot resolve a human
 * interaction, so it must fail loudly rather than silently approve/deny.
 */
export class UnconfiguredInteractionPort implements InteractionPort {
  async requestInteraction(_a: {
    taskId: string;
    call: ToolCall;
    kind: InteractionKind;
    signal?: AbortSignal;
    subagentId?: SubagentId;
    subagentPath?: SubagentPathSegment[];
  }): Promise<string> {
    throw new Error(
      'InteractionPort not configured: human-in-the-loop requires a host implementation',
    );
  }
  async requestComposioAuth(_a: {
    toolName: string;
    toolCallId: string;
    toolkit: string;
    authUrl: string;
  }): Promise<string> {
    throw new Error(
      'InteractionPort not configured: composio auth requires a host implementation',
    );
  }
}
