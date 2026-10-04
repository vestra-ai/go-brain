/**
 * gemini-interactions-messages — wire translation for the Gemini Interactions arm.
 *
 *   - a turn is a flat list of `steps` (user_input / model_output / thought /
 *     function_call / function_result), NOT role-bucketed messages
 *   - a tool result pairs to its call by `call_id` (the Interactions API carries
 *     ids — no by-name or positional matching, unlike generateContent)
 *   - stateless (`store:false`) replay MUST resend every prior `thought` step with
 *     its signature: the assistant entry's `geminiSteps` channel carries them
 *   - the system prompt is the separate `system_instruction` (built in the transport)
 *
 * Output runs through the orphan strip + validity floor (whole-history seam only).
 */
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { GeminiReplayStep, JournalEntry } from '../contract/journal.js';
import { stripInvisibleControlTurns } from '../contract/journal.js';
import type { NormalizedUsage } from '../engine/transport.js';
import {
  ensureValidGeminiInteractionsSteps,
  stripOrphanedGeminiInteractionsCalls,
} from './gemini-interactions-validity.js';
import type {
  GeminiInteractionsContent,
  GeminiMediaContent,
  GeminiInteractionsStep,
  GeminiInteractionsUsage,
} from './gemini-interactions-wire.js';

/** The dialect id this projection trusts a `geminiSteps` channel from. */
export const GEMINI_INTERACTIONS_API = 'gemini_interactions';

function imageToContent(b: ImageBlock): GeminiInteractionsContent {
  // Interactions wants base64 bytes. A url-bearing block ALSO carries its url as
  // the INTERNAL vestraImageUrl marker so the transport's request-build pass can
  // edge-fetch bytes for a url-only block — the marker never reaches the wire.
  return { type: 'image', data: b.data, mime_type: b.mediaType, ...(b.url ? { vestraImageUrl: b.url } : {}) };
}

/**
 * Per-call options the `watch` tool sets on a media block it hands to pushUser.
 * They shape ONE request (a clip range, a cheaper resolution) and are never
 * journaled — the block on the journal is the file, not the way it was watched.
 */
export interface MediaWatchOptions {
  resolution?: 'low' | 'medium' | 'high';
  startSec?: number;
  endSec?: number;
  /**
   * STRICT resolution (VIDEO_UNDERSTANDING_V1, §8). The main lane degrades an
   * unresolvable file to a placeholder note so one bad clip never costs a turn
   * its text. A `watch` call is the opposite: the request is NOTHING but the
   * media, so a placeholder makes the describe model answer "I have no video"
   * — a confident, metered, WRONG answer. Set here, carried onto the marker,
   * and read by the materialize pass, which RETHROWS instead of placeholdering
   * so the tool can report the real reason. Never set on the main lane.
   */
  strict?: true;
}

/** A media block on its way to the wire; the journal's own block has no options. */
export type MediaBlockForWire = MediaBlock & { watchOptions?: MediaWatchOptions };

function mediaToContent(b: MediaBlockForWire): GeminiMediaContent {
  const w = b.watchOptions;
  // `uri` is EMPTY here on purpose: the journal must never hold a Files API
  // reference (they expire in 48h). The marker carries what the request-build
  // pass needs to mint one, and is stripped there in every state.
  return {
    type: b.kind,
    mime_type: b.mediaType,
    uri: '',
    ...(w?.resolution ? { resolution: w.resolution } : {}),
    ...(w && (w.startSec !== undefined || w.endSec !== undefined)
      ? {
          processing: {
            ...(w.startSec !== undefined ? { start_offset: `${w.startSec}s` } : {}),
            ...(w.endSec !== undefined ? { end_offset: `${w.endSec}s` } : {}),
          },
        }
      : {}),
    vestraMediaRef: {
      ...(w?.strict ? { strict: true as const } : {}),
      path: b.path,
      ...(b.url ? { url: b.url } : {}),
      ...(b.contentSha ? { sha: b.contentSha } : {}),
      mimeType: b.mediaType,
      sizeBytes: b.sizeBytes,
      displayName: b.filename,
    },
  };
}

/** User turns: media leads, then images, then text (mirrors blocksToGeminiParts). */
export function blocksToGeminiInteractionsContent(blocks: ContentBlock[]): GeminiInteractionsContent[] {
  const out: GeminiInteractionsContent[] = [];
  for (const b of blocks) if (b.type === 'media') out.push(mediaToContent(b as MediaBlockForWire));
  for (const b of blocks) if (b.type === 'image') out.push(imageToContent(b));
  for (const b of blocks) if (b.type === 'text') out.push({ type: 'text', text: b.text });
  return out;
}

/** A tool result: text-only → ONE text item from the fallback (byte-identical to the
 *  dispatcher's flattening); with images → every text/image block, in order. */
export function toolResultToGeminiContent(blocks: ContentBlock[], textFallback: string): GeminiInteractionsContent[] {
  if (!blocks.some((b) => b.type === 'image')) return [{ type: 'text', text: textFallback }];
  const out: GeminiInteractionsContent[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') out.push(imageToContent(b));
  }
  return out;
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * The verbatim channel → wire steps, one for one, in order. A step captured since
 * the seal IS a wire step and goes back as it came; the two older normalized
 * shapes (a `text` step, a thought whose `summary` is a string) are mapped back to
 * the wire form they were read from — each `text` step was one model_output. Never
 * merges, reorders or drops a step: the model's turn is not ours to edit.
 */
export function replayStepsToWire(steps: GeminiReplayStep[]): GeminiInteractionsStep[] {
  return steps.map((s): GeminiInteractionsStep => {
    if (s.type === 'text' && typeof s.text === 'string' && !('content' in s)) {
      return { type: 'model_output', content: [{ type: 'text', text: s.text }] };
    }
    if (s.type === 'thought' && typeof s.summary === 'string') {
      const { summary, ...rest } = s;
      return { ...(rest as GeminiInteractionsStep), ...(summary ? { summary: [{ type: 'text', text: summary }] } : {}) } as GeminiInteractionsStep;
    }
    return s as GeminiInteractionsStep;
  });
}

/** The function_call ids a channel carries, in order. */
function channelCallIds(channel: GeminiReplayStep[]): string[] {
  return channel.filter((s) => s.type === 'function_call').map((s) => String((s as { id?: unknown }).id));
}

export function journalToGeminiInteractionsSteps(entries: JournalEntry[]): GeminiInteractionsStep[] {
  // Nami P1.1 — invisible control turns are journaled for billing/audit but must
  // never re-enter the model's context.
  entries = stripInvisibleControlTurns(entries);
  const out: GeminiInteractionsStep[] = [];
  const nameByToolId = new Map<string, string>();
  // function_call ids already emitted INSIDE a replayed channel — their separate
  // tool_use entries must NOT double-fold (kept in the journal for result matching).
  const replayed = new Set<string>();
  // tool_use ids that SURVIVED the upstream projection (suspend/compaction drop
  // entries; the channel rides the assistant entry and can't be pruned with them).
  const present = new Set<string>();
  for (const e of entries) if (e.payload.type === 'tool_use') present.add(e.payload.toolUseId);

  for (const entry of entries) {
    const p = entry.payload;
    switch (p.type) {
      case 'user':
        out.push({ type: 'user_input', content: blocksToGeminiInteractionsContent(p.blocks) });
        break;

      case 'assistant': {
        // CROSS-ISSUER GUARD: only a channel THIS dialect minted can carry
        // signatures this API validates. A handoff from another model (or the
        // generateContent lane) projects through the split path below, and its
        // foreign thinking never reaches the wire (text only).
        const channel = p.api === GEMINI_INTERACTIONS_API ? p.geminiSteps : undefined;
        if (channel != null && channel.length > 0) {
          // A call whose tool_use entry an upstream projection pruned must go — and
          // ONLY that call (its result went with it). Dropping the whole channel for
          // it, as this once did, swapped the model's real signed thought for the
          // sentinel; the thought stays valid without the call (probed 2026-09-23:
          // thought + text + one of two calls + its result → 200).
          const kept = channel.filter((s) => s.type !== 'function_call' || present.has(String(s.id)));
          out.push(...replayStepsToWire(kept));
          for (const id of channelCallIds(kept)) replayed.add(id);
        } else {
          const text = blocksToText(p.blocks);
          out.push({ type: 'model_output', content: text ? [{ type: 'text', text }] : [] });
        }
        break;
      }

      case 'tool_use': {
        nameByToolId.set(p.toolUseId, p.name);
        if (replayed.has(p.toolUseId)) break;
        out.push({
          type: 'function_call',
          id: p.toolUseId,
          name: p.name,
          arguments: (p.input ?? {}) as Record<string, unknown>,
        });
        break;
      }

      case 'tool_result': {
        const name = nameByToolId.get(p.toolUseId);
        out.push({
          type: 'function_result',
          call_id: p.toolUseId,
          ...(name ? { name } : {}),
          result: toolResultToGeminiContent(p.blocks, blocksToText(p.blocks)),
          ...(p.isError ? { is_error: true } : {}),
        });
        break;
      }

      default:
        break;
    }
  }

  // Whole-history seam: pair by call_id, then the floor.
  return ensureValidGeminiInteractionsSteps(stripOrphanedGeminiInteractionsCalls(out));
}

/**
 * Interactions usage → the single NormalizedUsage convention: `inputTokens` is
 * EXCLUSIVE of the cached bucket (total_input_tokens INCLUDES it on the wire), and
 * thought tokens fold into output (Google bills them at the output rate).
 */
export function normalizeGeminiInteractionsUsage(u: GeminiInteractionsUsage): NormalizedUsage {
  const input = u.total_input_tokens ?? 0;
  const cached = Math.min(u.total_cached_tokens ?? 0, input);
  return {
    inputTokens: input - cached,
    outputTokens: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    // C5: the thought tokens (already folded into output) reach the ledger as reasoning.
    ...(typeof u.total_thought_tokens === 'number' && { reasoningTokens: u.total_thought_tokens }),
  };
}
