// packages/agent-sdk/src/engine/prompt-span.ts
//
// Per-fresh-request prompt-payload breakdown (observability only). Built ONCE per
// task birth — the first 'fresh' round — from the SERVED bytes at the model-call
// site, so the server's [prompt-span] line can attribute the ~40k unattributed
// fresh-prefill by instruction layer and tool schema. Pure; NEVER throws (every
// field is independently guarded and degrades to 0 / []). Zero extra model calls.

import type { PromptBreakdown, PromptLayerSize } from '../contract/events.js';
import type { ProviderHistory, ProviderTool } from './transport.js';

export type { PromptBreakdown, PromptLayerSize };

/** JSON byte-length of a value; a circular/unserializable value degrades to 0. */
function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Best-effort tool name across the Anthropic ({name}) and OpenAI ({function.name}) shapes. */
function toolName(t: unknown): string {
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    const fn = o.function;
    if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
      return (fn as Record<string, unknown>).name as string;
    }
  }
  return 'unknown';
}

export interface BuildPromptBreakdownInput {
  /** The assembled system prompt string as it goes on the wire. */
  system: string;
  /** The provider tool schemas as they go on the wire. */
  providerTools: ProviderTool[];
  /** The provider message history (array of message envelopes for the native arm). */
  history: ProviderHistory;
  /** Per-instruction-layer raw sizes, from the assembly site (buildNativeSystemPrompt). */
  layerSizes?: PromptLayerSize[];
}

/**
 * Assemble the breakdown. All-guarded so an odd payload never aborts the round.
 */
export function buildPromptBreakdown(input: BuildPromptBreakdownInput): PromptBreakdown {
  const systemChars = typeof input.system === 'string' ? input.system.length : 0;
  const layers = Array.isArray(input.layerSizes)
    ? input.layerSizes.map((l) => ({ id: String(l?.id ?? 'unknown'), chars: Number(l?.chars) || 0 }))
    : [];

  const tools = Array.isArray(input.providerTools) ? input.providerTools : [];
  const perTool = tools.map((t) => ({ name: toolName(t), chars: jsonLen(t) }));
  const toolsCount = tools.length;
  // Whole-array chars measured directly (matches the maybeCompact tools bucket).
  const toolsChars = jsonLen(tools);
  const topTools = [...perTool].sort((a, b) => b.chars - a.chars).slice(0, 5);

  // First user-message envelope, including any context blocks riding it.
  const msg0Chars = Array.isArray(input.history) && input.history.length > 0
    ? jsonLen(input.history[0])
    : 0;

  return { systemChars, layers, toolsCount, toolsChars, topTools, msg0Chars };
}
