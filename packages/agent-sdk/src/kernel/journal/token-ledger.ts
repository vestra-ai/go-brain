/**
 * K4-T0 — pure token ledger primitives.
 *
 * PURITY CONTRACT (mirrors journal-stats.ts):
 *   - No I/O, no clock reads, no provider SDK.
 *   - Single linear pass for projectTokenCount.
 *   - Never throws — degenerate input is tolerated silently.
 *   - Imports only @bash/shared + built-in types.
 *
 * BUCKET DIVISION (critical for callers):
 *   projectTokenCount counts ONLY the `messages` bucket from journal entries.
 *   The journal has no system/tool entries that survive into context — system and
 *   tool-schema tokens are non-journal strings the caller holds. Callers (Compactor,
 *   trigger) compute `system`/`tools`/`memory` via:
 *       estimateTokens(systemPromptString)
 *       estimateTokens(JSON.stringify(providerTools))
 *       estimateTokens(namiBlock)
 *   and assemble the full TokenLedger at the call site.
 *
 * HEURISTIC RATIONALE (not a real tokenizer):
 *   The ledger drives a threshold trigger, not billing. Billing-grade counts
 *   flow through real provider usage on every turn_end. A ±10% heuristic error
 *   moves the trigger by a few % — harmless, because the provider's real
 *   context-window error (context_exceeded) is the backstop. The char/word
 *   blend matches the length/4 convention already in executor.ts:666.
 */

import { resolveCapabilities } from '../../contract/model-capabilities.js';
import type { JournalEntry } from '../../contract/journal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-category token attribution. Categories map to the cache-boundary segments
 *  and the compact_boundary.preTokens/postTokens observability fields. */
export interface TokenLedger {
  total: number;
  system: number;   // instruction stack (system string), heuristic-estimated
  tools: number;    // provider tool-schema JSON, heuristic-estimated
  messages: number; // user/assistant/tool_use/tool_result CONTEXT entries
  memory: number;   // the layer-7 Nami push block (session-frozen)
}

// ─── estimateTokens ───────────────────────────────────────────────────────────

/**
 * Heuristic token estimate for an arbitrary string (system/tools/memory).
 * Char/word hybrid — NOT a tokenizer. Fail-closed: overestimates rather than
 * under-estimates so the trigger fires earlier, never later.
 *
 * Formula:
 *   byChar = round(text.length / 4)          — standard "4 chars per token" rule
 *   byWord = round(wordCount * 1.3)           — 1.3 tokens per word average
 *   result = max(byChar, byWord)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChar = Math.round(text.length / 4);
  const byWord = Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);
  return Math.max(byChar, byWord);
}

// ─── Image weight ─────────────────────────────────────────────────────────────

/**
 * Flat per-image token estimate.
 *
 * A real count is `(width x height) / 750` for Anthropic, but a journal
 * `ImageBlock` carries no dimensions — only base64 `data` — so a true count
 * would mean decoding every image on every projection. 1,200 tokens is roughly
 * a 1000x900 screenshot, the dominant image in this system.
 *
 * The bar this has to clear is not accuracy, it is BLINDNESS: the ledger counts
 * only text blocks, so today a turn that returns four screenshots measures as
 * ~0 tokens while ~5k ride the wire. A crude flat rate moves the compaction
 * trigger to roughly the right place; zero never can.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_200;

/** Options for projectTokenCount. Absent ⇒ pre-elision behavior, byte-identical. */
export interface ProjectTokenCountOptions {
  /**
   * Charge `IMAGE_TOKEN_ESTIMATE` for every image block. Default FALSE so every
   * pre-existing caller measures exactly what it measured before; the native
   * harness passes true only under CONTEXT_ELISION_V1, where the elided wire
   * view and this measurement must agree (see the ledger-coherence note in
   * native-harness.ts maybeCompact).
   */
  countImages?: boolean;
}

// ─── resolveMaxContextTokens ──────────────────────────────────────────────────

/**
 * Resolve the authoritative context-window size for a given model id.
 *
 * Delegates to the @bash/shared model-capability registry — THE single source
 * of truth for per-model wire limits — so this never drifts behind newly added
 * models (the previous local regex omitted opus-4-8 and fable-5, treating those
 * 1M-context models as 200k and firing the compaction trigger ~5x too early).
 * Unknown ids resolve to the registry's conservative 200_000 fallback
 * (fail-safe-small — the trigger fires earlier, never later).
 *
 * `resolveCapabilities` is pure (no I/O, no provider SDK), so kernel purity is
 * preserved.
 *
 * NOTE: NATIVE_CAPABILITIES.maxContextTokens is a coarse advertisement stub
 * (K1 v0, frozen). This function is the runtime authoritative source —
 * NativeHarness.iterateTurn calls resolveMaxContextTokens(ctx.model) (K4-T2).
 */
export function resolveMaxContextTokens(model: string): number {
  return resolveCapabilities(model).contextWindow;
}

/**
 * Resolve the input-token count past which THIS model prefers to compact, or
 * undefined when it declares none.
 *
 * Same registry, same purity, same reason as resolveMaxContextTokens: the
 * preferred ceiling is per-model metadata (`preferredMaxInputTokens` — 200k on the
 * Anthropic 1M models, 272k on the GPT-5.5/5.6 family, absent on
 * Haiku/Sonnet-4.5/GLM/DeepSeek), and a local copy would drift behind every
 * newly-seeded model. It is a context-hygiene / latency / headroom bound, NOT a
 * pricing boundary: the registry's separate `premiumInputThreshold` carries the
 * provider re-pricing fact where one exists, and nothing in the kernel reads it.
 *
 * ABSENT means "no ceiling", NOT "a ceiling at zero" — a caller that treats
 * undefined as a threshold would compact a Haiku session on every round. The
 * undefined is the load-bearing half of this signature.
 */
export function resolvePreferredMaxInputTokens(model: string): number | undefined {
  return resolveCapabilities(model).preferredMaxInputTokens;
}

// ─── projectTokenCount ────────────────────────────────────────────────────────

/**
 * Pure projection over journal CONTEXT entries → the messages bucket ONLY.
 *
 * `entries` is the output of Journal.project() (already isContextEntry-filtered,
 * but this function is also tolerant of non-context entries — they contribute 0).
 *
 * Single linear pass. Never throws. Returns total === messages (system/tools/memory
 * are always 0 here — callers supply those via estimateTokens over non-journal strings).
 */
export function projectTokenCount(
  entries: JournalEntry[],
  opts?: ProjectTokenCountOptions,
): TokenLedger {
  let messages = 0;
  const imageWeight = opts?.countImages === true ? IMAGE_TOKEN_ESTIMATE : 0;

  /** Images in one block list, charged at the (opt-in) flat rate. */
  const imageTokens = (blocks: ReadonlyArray<{ type: string }>): number => {
    if (imageWeight === 0) return 0;
    let n = 0;
    for (const b of blocks) if (b.type === 'image') n++;
    return n * imageWeight;
  };

  for (const e of entries) {
    const p = e.payload;

    if (p.type === 'user' || p.type === 'assistant' || p.type === 'custom_message') {
      // Join all text blocks into a single string for estimation
      const text = p.blocks
        .map((b: { type: string; text?: string }) => (b.type === 'text' && b.text ? b.text : ''))
        .join(' ');
      messages += estimateTokens(text) + imageTokens(p.blocks);
    } else if (p.type === 'tool_use') {
      messages += estimateTokens(JSON.stringify(p.input));
    } else if (p.type === 'tool_result') {
      const text = p.blocks
        .map((b: { type: string; text?: string }) => (b.type === 'text' && b.text ? b.text : ''))
        .join(' ');
      messages += estimateTokens(text) + imageTokens(p.blocks);
    } else if (p.type === 'system') {
      // system entries in the journal are context entries but this function counts
      // only the "messages" bucket. The spec says system/tools are non-journal strings.
      // However, journal `system` payloads ARE context entries that contribute to the
      // model's window — count them in messages (the only bucket projectTokenCount populates).
      messages += estimateTokens(p.event + JSON.stringify(p.data ?? ''));
    }
    // All other types (usage, compact_boundary, label, mode, custom, interaction) → 0 contribution
  }

  return {
    total: messages,
    system: 0,
    tools: 0,
    messages,
    memory: 0,
  };
}

// ─── buildContextLedger ───────────────────────────────────────────────────────

/**
 * K4F-1 — assemble a FULLY-POPULATED TokenLedger from the four per-category
 * token counts a caller holds.
 *
 * The bucket division (see the BUCKET DIVISION note above) means callers compute
 * `system`/`tools`/`memory` from non-journal strings (via estimateTokens) and the
 * `messages` bucket from projectTokenCount. Before K4F-1 the native compaction
 * call site summed these inline and DISCARDED the per-category split, keeping only
 * the scalar total. This helper makes the split first-class so it can ALSO ride on
 * the native AGENT_CONTEXT_USAGE emission for a future per-category drill-down.
 *
 * `total = system + tools + messages + memory` — the SAME scalar the inline sum
 * produced, so the compaction threshold check is behavior-identical.
 *
 * `memory` defaults to 0: a caller without a separable layer-7 Nami block (e.g.
 * the native call site, where the block is already folded into `system`) omits it
 * so it is never double-counted.
 *
 * PURE + never-throws: degenerate buckets (NaN/negative) are floored to a finite
 * non-negative value so the trigger math never sees NaN or a negative total.
 */
export function buildContextLedger(parts: {
  messages: number;
  system: number;
  tools: number;
  memory?: number;
}): TokenLedger {
  const clamp = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
  const messages = clamp(parts.messages);
  const system = clamp(parts.system);
  const tools = clamp(parts.tools);
  const memory = clamp(parts.memory ?? 0);
  return {
    total: messages + system + tools + memory,
    system,
    tools,
    messages,
    memory,
  };
}
