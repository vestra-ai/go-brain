import type { RawToolOptions, OnAuthHalt } from '../tools/tool-types.js';
import type { ActiveAbility } from '../contract/active-ability.js';
import type { ContextPort } from '../kernel/context/context-port.js';
import type { TodoStatus } from '../contract/blocks.js';
import type { GateResult, ToolCall } from '../contract/harness.js';

/**
 * A todos snapshot the Todos tools hand back on each mutation. Structurally
 * equal to the product's `TodoSnapshot` (apps/sandbox tools/task-tools.ts) — typed
 * here against the SDK's own `TodoStatus` so the port stays free of product types.
 */
export type TodoSnapshot = Array<{ content: string; status: TodoStatus; activeForm?: string; owner?: string }>;

/**
 * Everything the product's domain-tool factories need to build their tools.
 * Provider-neutral + fully SDK-typeable: the model transport stays a product-side
 * closure detail of the ToolHost impl (it is not part of this contract).
 */
export interface ToolHostContext {
  taskId: string;
  abilities: ActiveAbility[];
  contextPort: ContextPort;
  model: string;
  /** The per-run gate product tools route through (harness.gateTool). */
  gateTool(call: ToolCall): Promise<GateResult>;
  /** Fires a pause-for-human interaction; resolves to the PAUSED_HALT sentinel string. */
  onPause(call: ToolCall, kind: string): Promise<string>;
  /** Run-scoped: the Todos tools call this with a snapshot on each mutation. */
  onTodos(todos: TodoSnapshot): void;
  /** Run-scoped: mints a correlation id (used by MCP/tool factories). */
  mintId(): string;
}

/**
 * ToolHost — the product assembles the FULL ordered tool list (built-ins +
 * ability / skill / agent / search-abilities / context-query + Composio MCP) AND
 * the single Composio auth-halt callback. The SDK ships an empty default; the
 * engine consumes `buildTools(ctx)` in its prologue (wired at ring 4c.7).
 */
export interface ToolHost {
  buildTools(ctx: ToolHostContext): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }>;
}

/** SDK default: the host registers no product tools (generic tools only). */
export class EmptyToolHost implements ToolHost {
  async buildTools(_ctx: ToolHostContext): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    return { tools: [], onAuthHalt: async () => {} };
  }
}
