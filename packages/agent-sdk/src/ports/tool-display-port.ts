import type { ToolDisplay } from '../contract/blocks.js';
import type { ActiveAbility } from '../contract/active-ability.js';

/**
 * ToolDisplayPort — the product enriches a raw tool invocation into the display
 * shape the UI renders (Composio classification, skill→ability attribution). The
 * SDK ships a no-op default that returns undefined (the raw tool name passes
 * through). Signature mirrors the product's enrichToolUse exactly.
 */
export interface ToolDisplayPort {
  enrich(
    data: { toolName: string; toolUseId: string; toolInput: unknown },
    abilities?: ActiveAbility[],
  ): ToolDisplay | undefined;
}

/** SDK default: no enrichment. */
export class NoopToolDisplayPort implements ToolDisplayPort {
  enrich(): ToolDisplay | undefined {
    return undefined;
  }
}
