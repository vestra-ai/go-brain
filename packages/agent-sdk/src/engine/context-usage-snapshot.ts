/**
 * K4F-1: the per-turn context-usage snapshot (native context-meter parity).
 *
 * Lifted out of the loop file, which only ratchets DOWN (R3) — the same seam that
 * put the compaction body in compaction-run.ts. Nothing here reads `this`: it was
 * already pure over its parameters, so the move is a rename of its home.
 */
import type { HarnessContext } from '../contract/harness.js';
import type { ContextUsageSnapshot } from '../contract/events.js';
import {
  projectTokenCount,
  estimateTokens,
  resolveMaxContextTokens,
  buildContextLedger,
} from '../kernel/index.js';
import { wireMessages, type FrozenElision } from './context-elision.js';
import type { NativeConfig } from './native-config.js';
import type { ProviderHistory, ProviderTool } from './transport.js';

/**
 * Guarded JSON.stringify for the in-memory provider history, used ONLY for the
 * journal-less context-usage estimate (the journal path uses projectTokenCount).
 * A circular ref degrades to '' (→ 0 tokens) rather than throwing — best-effort.
 */
function stringifyHistory(history: ProviderHistory): string {
  try {
    return JSON.stringify(history) ?? '';
  } catch {
    return '';
  }
}

/**
 * Build the per-turn context-fullness snapshot the core sink maps onto
 * AGENT_CONTEXT_USAGE (native parity with the Claude arm's getContextUsage path). PURE
 * per-category math (buildContextLedger) over the SAME bucket sources maybeCompact
 * reads (messages/system/tools; memory 0 because the Nami block is already folded into
 * `system`). `maxTokens` resolves from the @bash/shared capability registry (real wire
 * limit, no stale 200k). Best-effort / never-throw: any failure returns null.
 * History: docs/learnings/native-harness-history.md (Context-usage meter).
 */
export async function buildContextUsageSnapshot(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  system: string,
  providerTools: ProviderTool[],
  history: ProviderHistory,
  elision: FrozenElision | null,
): Promise<ContextUsageSnapshot | null> {
  try {
    // messages bucket: durable journal projection when present, else a heuristic
    // estimate over the in-memory provider history (ephemeral/test path). The
    // history stringify is guarded (a circular ref degrades to 0, never throws
    // out — the whole method is best-effort anyway).
    const messages = cfg.journal
      ? projectTokenCount(wireMessages((await cfg.journal.project()).messages, elision), { countImages: elision !== null }).messages
      : estimateTokens(stringifyHistory(history));
    const ledger = buildContextLedger({
      messages,
      system: estimateTokens(system),
      // JSON.stringify(providerTools) is the EXACT expression maybeCompact uses for
      // the tools bucket → the snapshot's tools count matches the trigger's value.
      tools: estimateTokens(JSON.stringify(providerTools)),
      // memory = 0: the Nami block is already inside `system` (see doc above).
    });
    const maxTokens = resolveMaxContextTokens(ctx.model);
    const percentage = maxTokens > 0 ? (ledger.total / maxTokens) * 100 : 0;
    return {
      totalTokens: ledger.total,
      maxTokens,
      percentage,
      model: ctx.model,
      system: ledger.system,
      tools: ledger.tools,
      messages: ledger.messages,
      memory: ledger.memory,
    };
  } catch {
    // never-throw: a snapshot hiccup must never abort the turn → no emission.
    return null;
  }
}
