/**
 * gemini-messages — wire translation for the Gemini native arm.
 *
 * Gemini's shape differs from the OpenAI/Anthropic dialects:
 *   - turns are `contents: [{ role: 'user' | 'model', parts: [...] }]`
 *   - a tool call is a `functionCall` part on a `model` turn
 *   - a tool result is a `functionResponse` part on a `user` turn, matched to its
 *     call by NAME (older models carry no tool-call id) — so the projection recovers
 *     the name from the preceding tool_use via a toolUseId→name map, and echoes the
 *     provider's call `id` when the sealed turn carries one (Gemini 3 does).
 *   - the model turn itself is SEALED: the assistant entry's `geminiContent` channel
 *     is sent back as the provider streamed it, never rebuilt from our blocks.
 *   - the system prompt is a separate `system_instruction` (built in the transport).
 *
 * Output runs through the shared validity floor (ensureValidGeminiRequest).
 */

import { randomUUID } from 'node:crypto';
import type { ContentBlock, ImageBlock } from '../contract/blocks.js';
import type { GeminiContentReplay, JournalEntry } from '../contract/journal.js';
import type { NormalizedUsage } from '../engine/transport.js';
import type { ReadyToolUse } from '../engine/tool-ready.js';
import {
  dropGeminiCallParts,
  ensureValidGeminiRequest,
  stripOrphanedGeminiToolParts,
  PLACEHOLDER_NO_OUTPUT,
  type GeminiContent,
  type GeminiPart,
} from '../engine/request-validity.js';

/** The dialect id this projection trusts a `geminiContent` channel from. */
export const GEMINI_API = 'gemini';

// ─────────────────────────────────────────────────────────────────────────────
// 1. journal → Gemini contents
// ─────────────────────────────────────────────────────────────────────────────

export function journalToGeminiContents(entries: JournalEntry[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  // Model turns replayed from the provider's own parts — the floor hands these back
  // untouched (see ensureValidGeminiRequest).
  const sealed = new Set<GeminiContent>();
  const nameByToolId = new Map<string, string>();
  // tool_use id → the provider's call id, from a sealed turn: echoed on the result.
  const wireIdByToolId = new Map<string, string>();
  // tool_use ids already emitted INSIDE a sealed turn — their separate tool_use
  // entries must NOT double-fold (kept in the journal for result matching / healing).
  const replayed = new Set<string>();
  // tool_use ids that SURVIVED the upstream projection (suspend/compaction drop
  // entries; the channel rides the assistant entry and cannot be pruned with them).
  const present = new Set<string>();
  for (const e of entries) if (e.payload.type === 'tool_use') present.add(e.payload.toolUseId);

  for (const entry of entries) {
    const p = entry.payload;
    switch (p.type) {
      case 'user':
        out.push({ role: 'user', parts: blocksToGeminiParts(p.blocks) });
        break;

      case 'assistant': {
        // CROSS-ISSUER GUARD: only a channel THIS dialect minted carries signatures
        // this API validates; any other issuer projects through the split path.
        const channel = p.api === GEMINI_API ? p.geminiContent : undefined;
        if (channel && channel.parts.length > 0) {
          const turn = sealedTurn(channel, present);
          out.push(turn.content);
          if (turn.sealed) sealed.add(turn.content);
          for (const [toolUseId, wireId] of turn.wireIds) wireIdByToolId.set(toolUseId, wireId);
          for (const id of channel.callIds) replayed.add(id);
        } else {
          out.push({ role: 'model', parts: textToGeminiParts(p.blocks) });
        }
        break;
      }

      case 'tool_use': {
        nameByToolId.set(p.toolUseId, p.name);
        if (replayed.has(p.toolUseId)) break;
        // PR6 — re-emit the Gemini-3 thoughtSignature on the functionCall part, or
        // Gemini-3 400s on the next request. Absent on non-Gemini-3 → byte-identical.
        const part: GeminiPart = {
          functionCall: { name: p.name, args: p.input ?? {} },
          ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
        };
        const last = out[out.length - 1];
        if (last && last.role === 'model') {
          last.parts.push(part);
          // No longer the provider's turn as sent → it takes the ordinary floor.
          sealed.delete(last);
        } else {
          out.push({ role: 'model', parts: [part] });
        }
        break;
      }

      case 'tool_result': {
        const name = nameByToolId.get(p.toolUseId) ?? p.toolUseId;
        const wireId = wireIdByToolId.get(p.toolUseId);
        const text = blocksToText(p.blocks);
        out.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name,
                response: { output: text === '' ? PLACEHOLDER_NO_OUTPUT : text },
                ...(wireId ? { id: wireId } : {}),
              },
            },
          ],
        });
        break;
      }

      default:
        break;
    }
  }

  // P2.0b: orphan-strip at the WHOLE-HISTORY seam only (the floor itself is also
  // the live path's per-slice normalizer, where pairs legitimately span slices).
  // The strip returns an untouched content by reference, so a sealed turn it had to
  // repair drops out of `sealed` on its own.
  return ensureValidGeminiRequest(stripOrphanedGeminiToolParts(out), sealed);
}

/**
 * A journaled sealed turn → its model content. The parts go back exactly as the
 * provider sent them; the one repair is a call whose tool_use entry an upstream
 * projection pruned — only THAT call leaves (signature-aware, see
 * dropGeminiCallParts), and the turn is then no longer sealed.
 */
function sealedTurn(
  channel: GeminiContentReplay,
  present: ReadonlySet<string>,
): { content: GeminiContent; sealed: boolean; wireIds: Array<[string, string]> } {
  const parts = channel.parts as GeminiPart[];
  const wireIds: Array<[string, string]> = [];
  let k = 0;
  for (const part of parts) {
    if (!part.functionCall) continue;
    const toolUseId = channel.callIds[k++];
    if (toolUseId !== undefined && part.functionCall.id) wireIds.push([toolUseId, part.functionCall.id]);
  }
  const pruned = (i: number): boolean => {
    const id = channel.callIds[i];
    return id !== undefined && !present.has(id);
  };
  if (!channel.callIds.some((_, i) => pruned(i))) {
    return { content: { role: 'model', parts: [...parts] }, sealed: true, wireIds };
  }
  return { content: { role: 'model', parts: dropGeminiCallParts(parts, (_, i) => pruned(i)) }, sealed: false, wireIds };
}

/** Text blocks → one Gemini text part each (model turns carry text only). */
function textToGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => ({ text: b.text }));
}

/** User turns can carry text + inline images. */
export function blocksToGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const b of blocks) {
    if (b.type === 'image') parts.push(imageToGeminiPart(b));
  }
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ text: b.text });
  }
  return parts;
}

function imageToGeminiPart(b: ImageBlock): GeminiPart {
  // Gemini inlineData needs base64 bytes; a CDN url isn't a valid inlineData
  // source, so use the base64 data when present. A url-bearing block ALSO
  // carries its url as the INTERNAL vestraImageUrl marker so the transport's
  // request-build pass (media-refs S1) can edge-fetch bytes for a url-only
  // block — the marker never reaches the wire (materializeGeminiBody strips it
  // in every flag state).
  return {
    inlineData: { mimeType: b.mediaType, data: b.data },
    ...(b.url ? { vestraImageUrl: b.url } : {}),
  };
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gemini streamed GenerateContentResponse → text/thinking + captured calls
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal view of one streamed Gemini chunk (the REST `:streamGenerateContent` shape). */
export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<GeminiPart & { thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export interface CapturedGeminiToolUse {
  id: string;
  name: string;
  input: unknown;
  /** PR6 — the Gemini-3 opaque signature on this functionCall (replayed next turn). */
  thoughtSignature?: string;
}

export interface GeminiAccumulator {
  onChunk(chunk: GeminiStreamChunk): void;
  /** The model turn exactly as streamed (every part of every chunk, in order), or
   *  undefined when the stream carried no part. */
  replay(): GeminiContentReplay | undefined;
  /** Live visible-text fragment of a chunk (excludes thought parts), or null. */
  textDelta(chunk: GeminiStreamChunk): string | null;
  /** Live thinking fragment (a `thought:true` text part), or null. */
  thinkingDelta(chunk: GeminiStreamChunk): string | null;
  toolUses(): CapturedGeminiToolUse[];
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — the calls the chunks fed since the last call carried, drained.
   * A Gemini functionCall part arrives whole, so its chunk IS its natural boundary; the
   * args are already an object (a non-object is reported with input undefined).
   */
  takeReady(): ReadyToolUse[];
  /** Finalized turn, or null if the stream produced no terminal chunk. */
  final(): { stopReason: string | null; usage: NormalizedUsage } | null;
}

export function createGeminiAccumulator(): GeminiAccumulator {
  const calls: CapturedGeminiToolUse[] = [];
  // SEALED: the candidate's parts verbatim — the provider's own output, never a
  // reconstruction. Streaming has no final aggregated response, so the turn IS the
  // chunks' parts in arrival order: Gemini 3 puts the thoughtSignature on the first
  // call of a parallel run and ends the turn with an empty text part, and both go
  // back exactly as they came.
  const parts: Array<Record<string, unknown>> = [];
  let stopReason: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sawTerminal = false;
  // L1 — calls that arrived with object args, not yet handed to the transport.
  let ready: ReadyToolUse[] = [];

  function onChunk(chunk: GeminiStreamChunk): void {
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      parts.push(part as Record<string, unknown>);
      if (part.functionCall) {
        // PR6 — capture the Gemini-3 thoughtSignature riding this functionCall part.
        const sig = (part as { thoughtSignature?: unknown }).thoughtSignature;
        calls.push({
          // Mint a globally-unique internal id. Gemini never sees this id on the wire
          // (functionResponse pairs by NAME), so it has zero provider impact — but it
          // IS the journal `toolUseId`, and a per-stream counter (`gemini-call-${N}`)
          // collided across turns (every stream restarts at 0). Colliding ids made the
          // kernel's keepLastToolResultPerId delete EARLIER turns' real tool_results at
          // every projection. A UUID makes each call's id unique for all time.
          id: `gemini-call-${randomUUID()}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(typeof sig === 'string' && sig ? { thoughtSignature: sig } : {}),
        });
        const call = calls[calls.length - 1];
        // L1: every call is reported; args that are not an object are unreadable (undefined).
        const readable = call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input);
        ready.push({ id: call.id, name: call.name, input: readable ? call.input as Record<string, unknown> : undefined });
      }
    }
    if (cand?.finishReason) {
      stopReason = cand.finishReason;
      sawTerminal = true;
    }
    if (chunk.usageMetadata) {
      usage = normalizeGeminiUsage(chunk.usageMetadata);
      sawTerminal = true;
    }
  }

  function textDelta(chunk: GeminiStreamChunk): string | null {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    return text !== '' ? text : null;
  }

  function thinkingDelta(chunk: GeminiStreamChunk): string | null {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => p.thought === true && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    return text !== '' ? text : null;
  }

  function toolUses(): CapturedGeminiToolUse[] {
    return calls.slice();
  }

  function final(): { stopReason: string | null; usage: NormalizedUsage } | null {
    if (!sawTerminal) return null;
    return { stopReason, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
  }

  function replay(): GeminiContentReplay | undefined {
    // callIds[i] ↔ the i-th functionCall part: `calls` is pushed at the same step.
    return parts.length > 0 ? { parts: parts.slice(), callIds: calls.map((c) => c.id) } : undefined;
  }

  function takeReady(): ReadyToolUse[] {
    const out = ready;
    ready = [];
    return out;
  }

  return { onChunk, replay, textDelta, thinkingDelta, toolUses, takeReady, final };
}

/**
 * C5 — the ONE convention every other arm already keeps: `inputTokens` is EXCLUSIVE of
 * the cached bucket. `promptTokenCount` INCLUDES `cachedContentTokenCount` on the wire,
 * and this lane alone passed it through inclusive, while the sandbox stamps every usage
 * event `input_tokens_exclusive: true`: the ledger row counted the cached tokens twice and
 * the server re-price billed them at the full input rate on top of the cached rate.
 */
function normalizeGeminiUsage(u: NonNullable<GeminiStreamChunk['usageMetadata']>): NormalizedUsage {
  const prompt = u.promptTokenCount ?? 0;
  const cached = Math.min(u.cachedContentTokenCount ?? 0, prompt);
  return {
    inputTokens: prompt - cached,
    // BILL-10: Gemini's candidatesTokenCount does NOT include thinking tokens, but
    // Google bills thoughtsTokenCount at the OUTPUT rate. Fold them into output so
    // reasoning tokens are billed exactly once (parity with the other arms, which
    // fold reasoning into output/completion_tokens). 2.5-pro/flash think by default.
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    ...(typeof u.thoughtsTokenCount === 'number' && { reasoningTokens: u.thoughtsTokenCount }),
  };
}
