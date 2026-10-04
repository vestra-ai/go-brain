/**
 * native-messages — wire translation for the native Anthropic arm.
 *
 * Three pure, SDK-grounded converters that move data between the THREE
 * representations the native arm touches:
 *
 *   1. The journal (our append-only source of truth — `JournalEntry[]`).
 *   2. The Anthropic Messages API request shape (`Anthropic.MessageParam[]`).
 *   3. Anthropic streaming events (`Anthropic.MessageStreamEvent`) → our
 *      `ContentBlock[]` + the captured tool_use calls.
 *
 * Correctness here is load-bearing: a bug corrupts every native-arm turn.
 * Everything is typed against the installed `@anthropic-ai/sdk` (v0.93.0).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, ImageBlock } from '../contract/blocks.js';
import type { AnthropicReplayBlock, JournalEntry } from '../contract/journal.js';
import { stripInvisibleControlTurns } from '../contract/journal.js';
import { ensureValidAnthropicRequest, mergeConsecutiveUserTurns, unansweredToolUseIds, toolBlockFingerprint } from './request-validity.js';
import { readyToolArgs, type ReadyToolUse } from './tool-ready.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. journal → Anthropic Messages API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert journal context entries (the output of `Journal.project()`) into
 * Anthropic Messages API messages.
 *
 *  - `user`        → `{ role: 'user', content }` — a bare string when the entry
 *                    is a single text block, else a block array.
 *  - `assistant`   → `{ role: 'assistant', content: blocks }`.
 *  - `tool_use`    → a `tool_use` content block FOLDED INTO the preceding
 *                    assistant message (a fresh assistant message is created
 *                    when the previous message isn't an assistant — e.g. on a
 *                    compaction boundary that drops the assistant text).
 *  - `tool_result` → `{ role: 'user', content: [{ type: 'tool_result', ... }] }`.
 *
 * `project()` already filters to context entries (`isContextEntry`), so the
 * non-context payload types (`usage`, `compact_boundary`, `mode`, `custom`,
 * `label`, `interaction`) never arrive — but we skip them defensively. The
 * remaining context types we don't yet replay as input (`system`,
 * `custom_message`) are skipped too; extend as the arm grows.
 */
export function journalToAnthropicMessages(entries: JournalEntry[]): Anthropic.MessageParam[] {
  // Nami P1.1 — invisible control turns (the hot memory pass) are journaled for
  // billing/audit but must never re-enter the model's context.
  entries = stripInvisibleControlTurns(entries);
  const out: Anthropic.MessageParam[] = [];
  // Assistant messages replayed from the provider's verbatim content. The validity
  // floor must hand these back untouched (see `ensureValidAnthropicRequest`).
  const sealed = new Set<Anthropic.MessageParam>();
  // PR2 — tool_use ids already emitted INSIDE a verbatim `anthropicBlocks` assistant
  // message. Their separate `tool_use` entries must NOT double-fold (they're kept in
  // the journal for tool-result matching / healing / suspend, but the wire shape is
  // owned by the verbatim channel). Empty for every non-interleaved journal.
  const replayedToolUseIds = new Set<string>();
  // PR2 — the tool_use ids that SURVIVED the upstream projection (suspendPending /
  // compaction run BEFORE this and drop a paused/compacted-away tool_use ENTRY). The
  // verbatim channel rides the assistant entry, so those passes can't prune it — we
  // only use the channel when EVERY tool_use it carries is still present here; if one
  // was dropped, we fall back to the default split projection (which the suspend/heal
  // machinery already shaped) rather than re-orphan the dropped call on the wire.
  const presentToolUseIds = new Set<string>();
  for (const e of entries) if (e.payload.type === 'tool_use') presentToolUseIds.add(e.payload.toolUseId);

  for (const entry of entries) {
    const p = entry.payload;
    switch (p.type) {
      case 'user':
        out.push({ role: 'user', content: textOrBlocks(p.blocks) });
        break;

      case 'assistant': {
        // Use the verbatim channel ONLY when it's safe: every tool_use it carries
        // must still be a present (un-suspended, un-compacted) entry. Otherwise an
        // upstream pass pruned one, and replaying the channel verbatim would re-emit
        // the dropped tool_use as an orphan → 400. Fall back to the default split
        // projection there (the suspend/heal machinery already shaped it).
        const channel = p.anthropicBlocks;
        const channelUsable =
          channel != null &&
          channel.length > 0 &&
          channel.every((b) => b.type !== 'tool_use' || presentToolUseIds.has(b.id));
        if (channelUsable) {
          // Interleaved-thinking fast path: replay the verbatim, order-preserving
          // block sequence so each thinking signature keeps its original context.
          // Record its tool_use ids so the matching tool_use entries below skip
          // their fold (the channel already carries them in the right positions).
          const replayed: Anthropic.MessageParam = { role: 'assistant', content: replayBlocksToAnthropic(channel) };
          out.push(replayed);
          sealed.add(replayed);
          for (const b of channel) if (b.type === 'tool_use') replayedToolUseIds.add(b.id);
        } else {
          out.push({ role: 'assistant', content: blocksToAnthropic(p.blocks) });
        }
        break;
      }

      case 'tool_use': {
        // Already represented in a preceding verbatim assistant message → skip
        // (folding it again would duplicate the tool_use block on the wire).
        if (replayedToolUseIds.has(p.toolUseId)) break;
        // Fold into the last assistant message; create one if the previous
        // message isn't an assistant with array content.
        const block: Anthropic.ToolUseBlockParam = {
          type: 'tool_use',
          id: p.toolUseId,
          name: p.name,
          input: p.input ?? {},
        };
        const last = out[out.length - 1];
        if (last?.role === 'assistant' && Array.isArray(last.content)) {
          last.content.push(block);
          // No longer the provider's message as sent → it takes the ordinary floor.
          sealed.delete(last);
        } else {
          out.push({ role: 'assistant', content: [block] });
        }
        break;
      }

      case 'tool_result':
        out.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: p.toolUseId,
              content: toolResultContent(p.blocks, blocksToText(p.blocks)),
              is_error: p.isError ?? false,
            } satisfies Anthropic.ToolResultBlockParam,
          ],
        });
        break;

      // `system` / `custom_message` are context entries but not yet replayed
      // as Messages-API input in K1 v0; non-context types never reach here.
      default:
        break;
    }
  }

  // HITL resume-400 TRIPWIRE (live tasks 1067a95b / 8db91619) — fire BEFORE the validity
  // floor repairs the request, so a re-drill hands us the exact RAW failing shape even when
  // the floor self-heals. `project()` always emits an adjacent history, so a firing here
  // means this request was assembled from a shape `project()` would not produce (a scope
  // leak / stale projection reaching the wire) — the disease, not the symptom. Log at ERROR
  // with the ids + message count + the journal seq watermark + a compact fingerprint (the
  // relay ships sandbox logs to the trace store). Silent for a well-formed history.
  // Read over the MERGED turns, the shape the wire gets: each result is its own user
  // turn here, so the raw list made every parallel batch's second call look unanswered.
  const unanswered = unansweredToolUseIds(mergeConsecutiveUserTurns(out));
  if (unanswered.length > 0) {
    const seqWatermark = entries.reduce((mx, e) => Math.max(mx, (e as { seq?: number }).seq ?? -1), -1);
    console.error(
      `[hitl-resume-400-tripwire] raw projected request has unanswered tool_use id(s) ` +
        `[${unanswered.join(',')}] (would 400 without the adjacency floor); messages=${out.length}; ` +
        `journalSeqWatermark=${seqWatermark}; fingerprint=${toolBlockFingerprint(out)}`,
    );
  }

  // Apply the validity floor so a journal-re-derived history is always a
  // structurally valid Messages request (the live in-memory path is well-formed
  // by construction; this brings the resume path to parity). Without it, quirky
  // but legal model output — interleaved tool calls, a tool-only turn, an empty
  // tool result — projects into shapes the API 400s on (the model_error class).
  return ensureValidAnthropicRequest(out, sealed);
}

/**
 * A single text block → bare string (Anthropic's cheap shape); else a block array.
 *
 * The decision is made on what SURVIVES the projection, not on the raw block list.
 * Judging the raw list meant any block this lane does not carry still changed the
 * shape of the message: a `media` block (the Gemini lane's, journalled on the user
 * turn and dropped here) turned `content: "watch this"` into
 * `content: [{type:'text',text:'watch this'}]` — the same words, different request
 * bytes, so every historical turn carrying one moved the prompt-cache prefix for a
 * block Anthropic never sees. Byte-identical for every list that already reached
 * the string form, because a lone text block projects to exactly one text param.
 */
function textOrBlocks(blocks: ContentBlock[]): string | Anthropic.ContentBlockParam[] {
  const projected = blocksToAnthropic(blocks);
  if (projected.length === 1 && projected[0].type === 'text') {
    return projected[0].text;
  }
  return projected;
}

/** Concatenate the text blocks of a tool_result into one string for the API. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Map ONE `ImageBlock` → an Anthropic image content param. Prefer the CDN `url`
 * source (no media_type, dodges the 20MB base64 request cap, matches what the
 * Claude arm sends); fall back to inline base64 `data`.
 *
 * The SINGLE source of truth for the image-param shape on the native Anthropic arm:
 * `blocksToAnthropic` (user-message images), the tool_result journal converter, and
 * the in-memory `pushToolResult` all route image blocks through here so they can't
 * drift. (Exported so `anthropic-transport.ts`'s `pushToolResult` imports the SAME
 * helper instead of re-deriving the shape.)
 */
export function imageBlockToAnthropicParam(block: ImageBlock): Anthropic.ImageBlockParam {
  return {
    type: 'image',
    source: block.url
      ? { type: 'url', url: block.url }
      : { type: 'base64', media_type: block.mediaType, data: block.data },
  };
}

/**
 * Build the Anthropic `tool_result` `content` from the journal/dispatch blocks.
 *
 * - When `blocks` carries ≥1 image, return the ARRAY form: each text block becomes a
 *   text param and each image block an image param (via `imageBlockToAnthropicParam`),
 *   preserving the tool-emitted order so a screenshot reaches the model.
 * - Otherwise (text-only), return `textFallback` as a BARE STRING — Anthropic's cheap
 *   shape, byte-identical to before this change. This is the native parity oracle.
 *
 * Shared by the journal converter (`journalToAnthropicMessages`) and the in-memory
 * `pushToolResult`. The bare-string fallback is supplied by the caller so each path
 * keeps its existing text source (`blocksToText(blocks)` for the journal; `r.text` for
 * the dispatch result) byte-for-byte.
 */
export function toolResultContent(
  blocks: ContentBlock[],
  textFallback: string,
): NonNullable<Anthropic.ToolResultBlockParam['content']> {
  if (!blocks.some((b) => b.type === 'image')) {
    return textFallback;
  }
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      out.push(imageBlockToAnthropicParam(b));
    }
    // Other block types are not valid inside an Anthropic tool_result content array.
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. our ContentBlock[] → Anthropic content blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert our `ContentBlock[]` into Anthropic content blocks.
 *
 * Maps `text` blocks and SIGNED `thinking` blocks (extended thinking). A signed
 * thinking block MUST be replayed verbatim — including its cryptographic
 * `signature` — on the request that sends a tool_result back, or the Messages API
 * rejects the turn (this is the multi-turn correctness contract for interleaved
 * thinking). Thinking blocks are emitted BEFORE text/tool_use, the order the model
 * produced them. An UNSIGNED thinking block is dropped (the API rejects replaying
 * thinking without a signature, and an unsigned block is one we never captured a
 * signature for — e.g. a foreign-arm journal entry or a pre-thinking turn).
 *
 * `image` blocks (uploaded by the user) map to Anthropic image params, preferring a
 * CDN `url` source over inline base64 `data` (the url avoids the 20MB base64 request
 * cap and matches what the Claude arm sends). Before this, image blocks were
 * silently dropped here — so an uploaded image never reached the model and the
 * native arm hallucinated. Other block types (tool_use/tool_result) flow through
 * dedicated paths.
 */
export function blocksToAnthropic(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' && b.signature) {
      // Replay the signed thinking block verbatim (thinking + signature). Unsigned
      // thinking is skipped — Anthropic rejects unsigned thinking replay.
      out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    } else if (b.type === 'image') {
      // Single source of truth for the image-param shape (shared with tool_result).
      out.push(imageBlockToAnthropicParam(b));
    }
    // remaining types (tool_use/tool_result) skipped here (handled on their own paths).
  }
  return out;
}

/**
 * Convert the PR2 verbatim-replay channel (`AnthropicReplayBlock[]`) into Anthropic
 * content blocks, PRESERVING ORDER EXACTLY. Unlike `blocksToAnthropic`, this never
 * re-partitions — the whole point of the channel is that the emission order is
 * load-bearing (each thinking block is signed against its predecessors). A signed
 * thinking block and a redacted_thinking block both replay verbatim; tool_use maps
 * to the Anthropic `tool_use` param. There is no unsigned/empty case: the
 * accumulator only ever records signed thinking and data-bearing redacted blocks.
 */
export function replayBlocksToAnthropic(blocks: AnthropicReplayBlock[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    } else if (b.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: b.data });
    } else if (b.type === 'provider_raw') {
      // Straight back out as it came in. We cannot validate a block we do not
      // model, and we must not: re-serializing it is exactly the "modification"
      // the signature check catches.
      out.push(b.raw as Anthropic.ContentBlockParam);
    } else {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Anthropic streaming events → ContentBlock[] + captured tool calls
// ─────────────────────────────────────────────────────────────────────────────

/** A tool call captured off the stream, with its input JSON reassembled + parsed. */
export interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Consumes Anthropic streaming events and accumulates:
 *  - assistant text (→ our `ContentBlock[]`, one block per text content index),
 *  - tool_use calls (id / name / parsed input), and
 *  - a `textDelta(ev)` helper that returns the live text fragment of a single
 *    event (or `null`) for `AGENT_TEXT_DELTA` socket emission.
 *
 * The `run()` loop drives this: it calls `onEvent` for every stream event,
 * emits `textDelta(ev)` for live streaming, then reads `blocks()` / `toolUses()`
 * once the stream ends.
 */
export interface StreamAccumulator {
  /** Feed one streaming event. Updates internal text + thinking + tool-call state. */
  onEvent(ev: Anthropic.MessageStreamEvent): void;
  /**
   * The accumulated assistant content blocks (text + signed thinking), in the
   * order the model produced them. NO tool_use blocks (those live on toolUses()).
   * A completed thinking block carries its verbatim `signature` so the next
   * request can replay it (multi-turn extended-thinking correctness).
   */
  blocks(): ContentBlock[];
  /** The tool_use calls seen so far, JSON-parsed. */
  toolUses(): CapturedToolUse[];
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — the tool_use calls CLOSED since the last call (their
   * `content_block_stop` arrived), drained, an unreadable one (tool-ready.ts) with input
   * undefined. The transport turns each into a live `tool_ready` event.
   */
  takeReady(): ReadyToolUse[];
  /**
   * PR2 — the FULL assistant turn in EXACT emission order: signed thinking /
   * redacted_thinking / text / tool_use, interleaved as the model produced them.
   * This is the only channel that preserves the cross-type ordering `blocks()` +
   * `toolUses()` lose; the transport hands it to the loop (gated to interleaved
   * turns) so a journal-re-derived request replays each thinking block in its
   * original signature context. UNSIGNED thinking is omitted (unreplayable —
   * Anthropic rejects unsigned thinking on input), matching `blocksToAnthropic`.
   */
  orderedBlocks(): AnthropicReplayBlock[];
  /** The live text fragment of a single event, or null when it isn't a text delta. */
  textDelta(ev: Anthropic.MessageStreamEvent): string | null;
  /**
   * The live thinking fragment of a single event, or null when it isn't a
   * thinking_delta. (signature_delta carries no human-visible text → null.) Drives
   * the AGENT_THINKING_DELTA live emission, the thinking parity of textDelta.
   */
  thinkingDelta(ev: Anthropic.MessageStreamEvent): string | null;
}

/** In-progress block tracked by content-block index while streaming. */
type Pending =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature: string }
  // Safety-flagged reasoning Anthropic returns as an opaque `data` blob (no human
  // text, no separate signature). It MUST be replayed verbatim before a tool_use
  // on the next request or the turn 400s — captured here so orderedBlocks() can.
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; id: string; name: string; partialJson: string }
  // unknown/unhandled block types (server tools, …) — tracked so we don't
  // mis-route their deltas, but emitted into neither blocks() nor toolUses().
  | { kind: 'other' };

export function createStreamAccumulator(): StreamAccumulator {
  // Blocks indexed by their content-block index (Anthropic guarantees index per block).
  const pending = new Map<number, Pending>();
  // Completed assistant content blocks (text + signed thinking) in emission order.
  const contentBlocks: ContentBlock[] = [];
  const captured: CapturedToolUse[] = [];
  // PR2 — the FULL turn (thinking / redacted_thinking / text / tool_use) in exact
  // emission order, accumulated at each content_block_stop (stops fire in block
  // order). The cross-type record `blocks()` + `toolUses()` cannot reconstruct.
  const ordered: AnthropicReplayBlock[] = [];
  // L1 — closed calls with readable arguments, not yet handed to the transport.
  let ready: ReadyToolUse[] = [];

  function onEvent(ev: Anthropic.MessageStreamEvent): void {
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block;
        if (cb.type === 'text') {
          // Anthropic may seed the start event with initial text; preserve it.
          pending.set(ev.index, { kind: 'text', text: cb.text ?? '' });
        } else if (cb.type === 'thinking') {
          // Extended thinking. Seed with any initial thinking/signature the start
          // event carries (usually empty; deltas fill them in).
          pending.set(ev.index, {
            kind: 'thinking',
            text: cb.thinking ?? '',
            signature: cb.signature ?? '',
          });
        } else if (cb.type === 'tool_use') {
          pending.set(ev.index, { kind: 'tool_use', id: cb.id, name: cb.name, partialJson: '' });
        } else if (cb.type === 'redacted_thinking') {
          // Opaque safety-flagged reasoning. The `data` blob arrives complete on
          // the start event (no deltas); capture it for verbatim replay.
          pending.set(ev.index, { kind: 'redacted_thinking', data: cb.data ?? '' });
        } else {
          // Unhandled block types (server_tool_use, web_search_tool_result, …)
          // carry no payload we accumulate here — tracked as 'other' so their
          // deltas don't mis-route.
          pending.set(ev.index, { kind: 'other' });
        }
        break;
      }

      case 'content_block_delta': {
        const cur = pending.get(ev.index);
        if (!cur) break;
        const d = ev.delta;
        if (d.type === 'text_delta' && cur.kind === 'text') {
          cur.text += d.text;
        } else if (d.type === 'thinking_delta' && cur.kind === 'thinking') {
          cur.text += d.thinking;
        } else if (d.type === 'signature_delta' && cur.kind === 'thinking') {
          // Anthropic streams the signature in one (or more) signature_delta events
          // after the thinking text; accumulate verbatim.
          cur.signature += d.signature;
        } else if (d.type === 'input_json_delta' && cur.kind === 'tool_use') {
          cur.partialJson += d.partial_json;
        }
        // citations_delta is not accumulated.
        break;
      }

      case 'content_block_stop': {
        const cur = pending.get(ev.index);
        if (!cur) break;
        if (cur.kind === 'text') {
          contentBlocks.push({ type: 'text', text: cur.text });
          // Skip empty text in the ordered channel: it carries no wire content and
          // the validity floor strips it before its interleave check — keeping the
          // gate's interleave detection symmetric with the floor's (`normalizeAssistantBlocks`).
          if (cur.text) ordered.push({ type: 'text', text: cur.text });
        } else if (cur.kind === 'thinking') {
          // A SIGNED-BUT-EMPTY thinking block is the API's `display:'omitted'`
          // shape (signature_delta only, no thinking_delta text) — replay-only,
          // exactly like redacted_thinking below: never push it to contentBlocks
          // or a blank "Thought" bubble persists to the journal + web (the
          // 07-08/09 empty-thinking incident — the provider default flipped).
          if (cur.text || !cur.signature) {
            // Carry the signature so blocksToAnthropic can replay it next turn. A
            // signature-less thinking block (shouldn't happen with thinking enabled)
            // still records the text, but the converter will drop it (unsigned).
            contentBlocks.push(
              cur.signature
                ? { type: 'thinking', thinking: cur.text, signature: cur.signature }
                : { type: 'thinking', thinking: cur.text },
            );
          }
          // The ordered channel is replay-only, so it carries ONLY signed thinking
          // (unsigned thinking is unreplayable — Anthropic 400s on it as input).
          if (cur.signature) ordered.push({ type: 'thinking', thinking: cur.text, signature: cur.signature });
        } else if (cur.kind === 'redacted_thinking') {
          // Replay-only; not pushed to contentBlocks (it has no renderable form and
          // is never re-emitted to the UI). Drop a data-less block (unreplayable).
          if (cur.data) ordered.push({ type: 'redacted_thinking', data: cur.data });
        } else if (cur.kind === 'tool_use') {
          const input = parseToolInput(cur.partialJson);
          captured.push({ id: cur.id, name: cur.name, input });
          ordered.push({ type: 'tool_use', id: cur.id, name: cur.name, input });
          // L1: every closed call is reported, an unreadable one with input undefined.
          ready.push({ id: cur.id, name: cur.name, input: readyToolArgs(cur.partialJson) });
        }
        pending.delete(ev.index);
        break;
      }

      // message_start / message_delta / message_stop carry no per-block content
      // we accumulate here (usage + stop_reason are read off finalMessage() in run()).
      default:
        break;
    }
  }

  function textDelta(ev: Anthropic.MessageStreamEvent): string | null {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      return ev.delta.text;
    }
    return null;
  }

  function thinkingDelta(ev: Anthropic.MessageStreamEvent): string | null {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
      return ev.delta.thinking;
    }
    return null;
  }

  return {
    onEvent,
    textDelta,
    thinkingDelta,
    blocks: () => contentBlocks,
    toolUses: () => captured,
    takeReady: () => {
      const out = ready;
      ready = [];
      return out;
    },
    orderedBlocks: () => ordered,
  };
}

/**
 * Reassemble + parse a tool_use input from its streamed `partial_json` fragments.
 * An empty stream means no arguments → `{}`. Malformed JSON (a torn stream)
 * degrades to `{}` rather than throwing, so a single bad tool call can't crash
 * the whole turn (the dispatch layer surfaces the real error downstream).
 */
function parseToolInput(partialJson: string): unknown {
  const trimmed = partialJson.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}
