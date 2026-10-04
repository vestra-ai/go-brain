/**
 * chat-completions-messages — wire translation for the OpenAI Chat Completions arm.
 *
 * Chat Completions is the BREADTH dialect: one wire shape fronts every
 * OpenAI-compatible provider (OpenAI, DeepSeek, Kimi/Moonshot, MiniMax, Groq,
 * Together, OpenRouter, local servers). Structural twin of the Responses
 * projection (openai-responses-messages), swapped to the Chat Completions shapes:
 *
 *   - `user`        → { role: 'user', content }              (text, or text+image parts)
 *   - `assistant`   → { role: 'assistant', content }          (text; tool calls fold in)
 *   - `tool_use`    → folded into the preceding assistant message's `tool_calls[]`
 *   - `tool_result` → { role: 'tool', tool_call_id, content }
 *
 * Output runs through the shared validity floor (ensureValidChatCompletionsRequest)
 * so a journal-re-derived history is always a structurally valid request.
 */

import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { ContentBlock, ImageBlock } from '../contract/blocks.js';
import type { ChatMessageReplay, JournalEntry } from '../contract/journal.js';
import type { NormalizedUsage } from '../engine/transport.js';
import { ensureValidChatCompletionsRequest, PLACEHOLDER_EMPTY_CONTENT } from '../engine/request-validity.js';
import { readyToolArgs, type ReadyToolUse } from '../engine/tool-ready.js';
import { filenameFromUrl } from './media-bytes.js';

/**
 * Media-refs S1: optional note enrichment — when `named` is set, omission
 * notes NAME the omitted image (restorable per the Manus doctrine: the handle
 * survives even when the content can't ride this wire). Default/absent opts
 * keep every output byte-identical to today (the OFF axis).
 */
export interface ImageNoteOpts {
  named?: boolean;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantMsg = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/** The dialect id this projection trusts a `chatMessage` channel from. */
export const CHAT_COMPLETIONS_API = 'openai_chat_completions';

// ─────────────────────────────────────────────────────────────────────────────
// 1. journal → Chat Completions messages
// ─────────────────────────────────────────────────────────────────────────────

export function journalToChatCompletionsMessages(
  entries: JournalEntry[],
  opts?: ImageNoteOpts,
): Msg[] {
  const out: Msg[] = [];
  // The current ROUND's assistant message — the fold target for tool_use
  // entries. A round is one model call: its assistant entry, then its tool_use
  // entries, with tool_result entries landing in COMPLETION order (a parallel-
  // tool round interleaves use/result pairs). Folding only into the LAST
  // message synthesized a reasoning-less `content:null` assistant for every call
  // that followed a result; the deepseek lane then replayed a tool loop whose
  // assistant messages carried no reasoning_content and their API 400'd the
  // turn ("The reasoning_content in the thinking mode must be passed back") —
  // the 2026-08-13 strikes (task fd760456), on code that had the in-memory fix.
  // Folding into the round's assistant reproduces the in-memory pushAssistant
  // shape (ONE assistant message, all of the round's tool_calls) so the two
  // request builders can no longer diverge. A user or assistant entry starts a
  // new round.
  let roundAssistant: AssistantMsg | null = null;
  // tool_call ids already sent INSIDE a sealed message — their tool_use entries must
  // not fold a second copy (they stay in the journal for result pairing / healing).
  const replayed = new Set<string>();

  for (const entry of entries) {
    const p = entry.payload;
    switch (p.type) {
      case 'user':
        out.push({ role: 'user', content: blocksToChatContent(p.blocks) });
        roundAssistant = null;
        break;

      case 'assistant': {
        // SEALED: the message as the provider streamed it — content, reasoning_content,
        // tool_calls with their ids and RAW argument strings. The rebuild below
        // re-stringifies parsed arguments (a torn one became "{}"). CROSS-ISSUER
        // GUARD: only a channel this dialect minted is read.
        const sealed = p.api === CHAT_COMPLETIONS_API ? p.chatMessage : undefined;
        if (sealed) {
          const a = { ...sealed } as AssistantMsg;
          out.push(a);
          for (const c of a.tool_calls ?? []) replayed.add(c.id);
          roundAssistant = a;
          break;
        }
        // Legacy rounds: the thinking blocks are the round's reasoning_content (sent
        // only to a model that reads it back — see callModel), and only when this
        // dialect wrote them: another model's thinking is not this model's reasoning.
        const plain: Msg = { role: 'assistant', content: blocksToText(p.blocks) };
        const own = p.api === undefined || p.api === CHAT_COMPLETIONS_API;
        const a = (own ? withReasoning(plain, p.blocks) : plain) as AssistantMsg;
        out.push(a);
        roundAssistant = a;
        break;
      }

      case 'tool_use': {
        if (replayed.has(p.toolUseId)) break;
        // Fold into the ROUND's assistant message (even when that round's
        // tool_result entries already follow it); synthesize a tool-only
        // assistant (content:null) only when the round has none — a
        // recovery-shaped journal — and make the synth the round's fold
        // target so even that round stays ONE message.
        const call: ToolCall = {
          id: p.toolUseId,
          type: 'function',
          function: { name: p.name, arguments: stringifyArgs(p.input) },
        };
        if (roundAssistant) {
          roundAssistant.tool_calls = [...(roundAssistant.tool_calls ?? []), call];
        } else {
          const synth: AssistantMsg = { role: 'assistant', content: null, tool_calls: [call] };
          out.push(synth);
          roundAssistant = synth;
        }
        break;
      }

      case 'tool_result':
        out.push({
          role: 'tool',
          tool_call_id: p.toolUseId,
          // toolResultText is the SAME helper the in-memory pushToolResult uses:
          // an image-bearing result gains IMAGE_OMITTED_NOTE (once) instead of
          // its images silently projecting to an empty string.
          content: toolResultText(p.blocks, blocksToText(p.blocks), opts),
        });
        break;

      // system / custom_message are not yet replayed as Chat Completions input;
      // non-context types never reach here (project() filters them).
      default:
        break;
    }
  }

  return ensureValidChatCompletionsRequest(out);
}

/** Concatenate the text blocks of a payload into one string. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** JSON-stringify a tool input; an empty/undefined input is the empty object. */
function stringifyArgs(input: unknown): string {
  return input === undefined ? '{}' : JSON.stringify(input);
}

/** Map one ImageBlock → a Chat Completions `image_url` content part. */
function imageBlockToChatPart(b: ImageBlock): OpenAI.Chat.Completions.ChatCompletionContentPartImage {
  return {
    type: 'image_url',
    image_url: { url: b.url ?? `data:${b.mediaType};base64,${b.data}` },
  };
}

/**
 * User content: a bare string when text-only (the cheap shape), else an array of
 * content parts with images BEFORE text (parity with the other arms).
 */
export function blocksToChatContent(
  blocks: ContentBlock[],
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (!blocks.some((b) => b.type === 'image')) {
    return blocksToText(blocks);
  }
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const b of blocks) {
    if (b.type === 'image') parts.push(imageBlockToChatPart(b));
  }
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
  }
  return parts;
}

/** Note left in place of a dropped image so a text-only model knows one existed. */
export const IMAGE_OMITTED_NOTE = '[Image omitted: the selected model cannot view images.]';

/**
 * The omission note, optionally NAMING the omitted image (media-refs S1). The
 * unnamed form IS the exported constant — same string, single source of truth.
 */
export function imageOmittedNote(name?: string | null): string {
  return name ? `[Image omitted: ${name} — the selected model cannot view images.]` : IMAGE_OMITTED_NOTE;
}

/** First image block's filename (derived from its CDN url), or null. */
function firstImageName(blocks: ContentBlock[]): string | null {
  const img = blocks.find((b): b is ImageBlock => b.type === 'image');
  return img?.url ? filenameFromUrl(img.url) : null;
}

/**
 * Tool-result `content` for the Chat Completions wire. The `tool` role is
 * STRING-ONLY on this dialect, so an image block can never ride along — when the
 * blocks carry ≥1 image, append IMAGE_OMITTED_NOTE (ONCE, regardless of image
 * count) after the caller's text so the model KNOWS a screenshot existed instead
 * of it silently vanishing. Text-only blocks return `text` byte-identical.
 * Shared by the journal converter (journalToChatCompletionsMessages) and the
 * in-memory `pushToolResult`, so the two paths can't drift; each caller keeps
 * its existing text source (`blocksToText(blocks)` for the journal, `r.text`
 * for the dispatch result).
 */
export function toolResultText(
  blocks: ContentBlock[],
  text: string,
  opts?: ImageNoteOpts,
): string {
  if (!blocks.some((b) => b.type === 'image')) return text;
  const note = imageOmittedNote(opts?.named ? firstImageName(blocks) : null);
  return text ? `${text}\n${note}` : note;
}

/**
 * Per-request projection for TEXT-ONLY models (the Fireworks OSS lane: GLM /
 * DeepSeek), which hard-400 on an `image_url` content part. Because a persisted
 * image is replayed into the request on EVERY turn (journalToChatCompletionsMessages),
 * a single image would otherwise brick the whole session. This drops `image_url`
 * parts from every message and collapses the surviving text (plus a one-line note
 * so the model knows an image was dropped) to the cheap string shape. The journal's
 * ImageBlock is left intact — still valid if the task later switches to a vision
 * model. Messages without images (or with plain-string content) pass through
 * byte-identical. Pure; only invoked when caps.supportsImageInput === false.
 */
export function stripImagesFromChatMessages(messages: Msg[], opts?: ImageNoteOpts): Msg[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content as OpenAI.Chat.Completions.ChatCompletionContentPart[];
    const images = parts.filter(
      (p): p is OpenAI.Chat.Completions.ChatCompletionContentPartImage => p.type === 'image_url',
    );
    if (images.length === 0) return m;
    const texts = parts
      .filter((p): p is OpenAI.Chat.Completions.ChatCompletionContentPartText => p.type === 'text')
      .map((p) => p.text);
    // Named form (media-refs S1): derive the name from the first stripped
    // part's url — null (⇒ generic note) for data: URLs, which carry no name.
    const name = opts?.named ? filenameFromUrl(images[0]!.image_url.url) : null;
    const content = [...texts, imageOmittedNote(name)].join('\n\n');
    return { ...m, content } as Msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Chat Completions streaming chunks → text/thinking + captured tool calls
// ─────────────────────────────────────────────────────────────────────────────

/** A tool call captured off the stream, input JSON reassembled + parsed. */
export interface CapturedChatToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatCompletionsAccumulator {
  onChunk(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): void;
  /** Live text fragment of a chunk, or null. */
  textDelta(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): string | null;
  /** Live reasoning fragment (DeepSeek-style `reasoning_content`), or null. */
  thinkingDelta(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): string | null;
  toolUses(): CapturedChatToolUse[];
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — the calls this dialect has CLOSED since the last call, in
   * index order, at its natural boundary: a call is done when the next index opens AND it
   * carries readable arguments and its provider id, and every open call is done when the
   * choice finishes. Each carries the same id toolUses() will (minted here once, at the
   * finish, for an id-less call); an unreadable one carries input undefined. Drained.
   */
  takeReady(): ReadyToolUse[];
  /** The finalized turn, or null if the stream produced no terminal chunk. */
  final(): { stopReason: string | null; usage: NormalizedUsage } | null;
  /**
   * PR7 — the accumulated `delta.refusal` text, or '' if the turn carried no refusal.
   * OpenAI-compat proxies fronting Claude/Bedrock stream a safety refusal here with
   * empty content; readStream promotes it to text when it's the SOLE payload.
   */
  refusal(): string;
  /**
   * True iff a usage chunk actually arrived (stream_options.include_usage honored).
   * False on a non-empty turn signals the silent-$0 billing risk — the transport
   * warns once rather than committing a $0 turn.
   */
  sawUsage(): boolean;
  /**
   * The round's FULL accumulated reasoning ('' when the model emitted none).
   * The transport persists it as a terminal `thinking_block` so the engine
   * journals it and the deepseek tool-loop replay has reasoning to pass back
   * (their API 400s a follow-up without it — live incident 2026-08-13).
   */
  reasoningText(): string;
  /**
   * The assistant message as the provider streamed it (see ChatMessageReplay): every
   * string field of the deltas joined in arrival order, any other field as last
   * sent, tool_calls by index with their ids and RAW argument strings.
   */
  message(): ChatMessageReplay;
}

/** In-progress tool call accumulated by streamed `index`. */
interface PendingCall {
  id: string;
  type?: string;
  name: string;
  args: string;
}

export function createChatCompletionsAccumulator(): ChatCompletionsAccumulator {
  const callsByIndex = new Map<number, PendingCall>();
  let stopReason: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sawTerminal = false;
  let refusalText = '';
  let reasoningText = '';
  // SEALED: the message's own fields in arrival order (see message()).
  const fields: Record<string, unknown> = {};
  // L1 — the indexes already judged closed, and the closed calls not yet handed over.
  const closed = new Set<number>();
  let ready: ReadyToolUse[] = [];

  /**
   * Close calls in index order, so they are reported in the order the batch runs them.
   * At a next-index boundary (`bound`) a call closes only once it carries readable, non-empty
   * arguments AND the provider's own id: a names-first or interleaving provider sends both
   * later, and a call judged closed early would start on defaults, or under an id minted here
   * that its real id then replaces (a silent second run). The first call not done stops the
   * walk; the choice finishing (no `bound`) closes every call left, minting a missing id and
   * reporting an unreadable call with input undefined.
   */
  function closeInOrder(bound?: number): void {
    for (const [index, c] of [...callsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (closed.has(index)) continue;
      if (bound !== undefined) {
        if (index >= bound) return;
        if (c.id === '' || c.args.trim() === '' || readyToolArgs(c.args) === undefined) return;
      }
      closed.add(index);
      ready.push({ id: mintId(c), name: c.name, input: readyToolArgs(c.args) });
    }
  }

  function onChunk(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): void {
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string | null;
        refusal?: string | null;
      };
      // PR7 — accumulate the streamed refusal (a safety decline from an OpenAI-compat
      // proxy fronting Claude/Bedrock). Promoted to content by readStream when sole.
      if (typeof delta.refusal === 'string') refusalText += delta.refusal;
      // Accumulate the round's reasoning for the terminal thinking_block.
      if (typeof delta.reasoning_content === 'string') reasoningText += delta.reasoning_content;
      for (const [k, v] of Object.entries(delta)) {
        if (k === 'role' || k === 'tool_calls' || v == null) continue;
        fields[k] = typeof v === 'string' ? (typeof fields[k] === 'string' ? fields[k] : '') + v : v;
      }
      for (const tc of delta.tool_calls ?? []) {
        // A new index opens: every call before it is complete (calls stream in index order).
        if (!callsByIndex.has(tc.index)) closeInOrder(tc.index);
        const cur = callsByIndex.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        callsByIndex.set(tc.index, cur);
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        sawTerminal = true;
        closeInOrder();
      }
    }
    // usage rides the final chunk (requires stream_options:{include_usage:true}).
    if (chunk.usage) {
      // NOTE (T0-billing drill, leg 3a): the raw wire object is normalized on the
      // next line and then DISCARDED, so `logRawWireUsage` below is the only place
      // a real pass's raw `prompt_tokens` / `cached_tokens` can be read back at
      // all — switch `VESTRA_LOG_RAW_USAGE` on for one pass to get them. Do NOT
      // reconstruct them from the normalized values instead: recovering
      // `prompt_tokens` as `inputTokens + cacheReadTokens` merely inverts
      // normalizeChatUsage's own subtraction below, which passes straight back
      // through the assumption an independent leg exists to check. The pinned
      // fixture in __tests__/usage-convention.test.ts states the wire shape as its
      // own literals, but it is AUTHORED, not captured — only this log closes the
      // gap with a live body.
      logRawWireUsage(chunk);
      usage = normalizeChatUsage(chunk.usage);
      sawTerminal = true;
    }
  }

  function textDelta(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): string | null {
    const c = chunk.choices?.[0]?.delta?.content;
    return typeof c === 'string' && c !== '' ? c : null;
  }

  function thinkingDelta(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): string | null {
    const d = chunk.choices?.[0]?.delta as { reasoning_content?: string | null } | undefined;
    const r = d?.reasoning_content;
    return typeof r === 'string' && r !== '' ? r : null;
  }

  /**
   * The calls in index order. A call the provider sent with no id gets one minted
   * here, ONCE, so its tool_use, its result and the sealed message all carry the
   * same id — an empty id pairs with nothing and the request 400s.
   */
  function calls(): PendingCall[] {
    const ordered = [...callsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    for (const c of ordered) mintId(c);
    return ordered;
  }

  function mintId(c: PendingCall): string {
    if (c.id === '') c.id = `call_${randomUUID().replace(/-/g, '')}`;
    return c.id;
  }

  function toolUses(): CapturedChatToolUse[] {
    return calls().map((c) => ({ id: c.id, name: c.name, input: parseArgs(c.args) }));
  }

  function message(): ChatMessageReplay {
    const toolCalls = calls().map((c) => ({
      id: c.id,
      type: c.type ?? 'function',
      function: { name: c.name, arguments: c.args },
    }));
    return { role: 'assistant', ...fields, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
  }

  function final(): { stopReason: string | null; usage: NormalizedUsage } | null {
    if (!sawTerminal) return null;
    return { stopReason, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
  }

  return {
    onChunk,
    textDelta,
    thinkingDelta,
    toolUses,
    takeReady: () => {
      const out = ready;
      ready = [];
      return out;
    },
    message,
    final,
    refusal: () => refusalText,
    reasoningText: () => reasoningText,
    // True iff a usage chunk actually arrived (stream_options.include_usage honored).
    // When false on a non-empty turn the cost would silently meter at $0 — the
    // transport warns so the undercharge surfaces instead of failing silently.
    sawUsage: () => usage != null,
  };
}

/** The env gate for {@link logRawWireUsage}. Read per call, so a drill can flip it without a rebuild. */
const RAW_USAGE_LOG_FLAG = 'VESTRA_LOG_RAW_USAGE';

/**
 * BILLING-DRILL LEG — default OFF, costs one string compare when off.
 *
 * `normalizeChatUsage` (below) is a LOSSY, SUBTRACTIVE read of the wire: it folds
 * `prompt_tokens` — which INCLUDES cached tokens on this API — down to an exclusive
 * `inputTokens`, and the raw counts are then discarded. So a cost "checked" by
 * recomputing from `NormalizedUsage` re-runs the normalizer's own subtraction and can
 * only ever agree with itself. That check is circular, and a circular check is exactly
 * what let a 100x units flip stand in this repo for six days.
 *
 * With `VESTRA_LOG_RAW_USAGE=true` the RAW counts are logged verbatim, once per round,
 * keyed by request id + model so one pass's rounds can be picked out of a shared log.
 * A cost can then be recomputed BY HAND from the wire numbers and the published rate
 * card — an independent leg with no pricer code anywhere in its path.
 *
 * TOKEN COUNTS ONLY. No content, no prompts, no tool arguments, no reasoning text ever
 * crosses this line. The fields are enumerated one by one rather than spread, so a
 * provider that adds a content-bearing key to its `usage` object cannot silently widen
 * this log; absent fields are omitted rather than logged as `undefined`, so the payload
 * shows exactly what the wire actually carried.
 */
function logRawWireUsage(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): void {
  if (process.env[RAW_USAGE_LOG_FLAG] !== 'true') return;
  const u = chunk.usage;
  if (!u) return;
  // DeepSeek's first-party cache spellings ride alongside OpenAI's; the normalizer reads
  // them, so the drill needs them to see which convention priced the round.
  const ds = u as OpenAI.Completions.CompletionUsage & {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  const counts: Record<string, number> = {};
  const put = (key: string, value: unknown): void => {
    if (typeof value === 'number') counts[key] = value;
  };
  put('prompt_tokens', u.prompt_tokens);
  put('completion_tokens', u.completion_tokens);
  put('total_tokens', u.total_tokens);
  put('cached_tokens', u.prompt_tokens_details?.cached_tokens);
  put('reasoning_tokens', u.completion_tokens_details?.reasoning_tokens);
  put('prompt_cache_hit_tokens', ds.prompt_cache_hit_tokens);
  put('prompt_cache_miss_tokens', ds.prompt_cache_miss_tokens);
  console.debug('[chat-completions] raw wire usage', {
    requestId: chunk.id,
    model: chunk.model,
    ...counts,
  });
}

export function normalizeChatUsage(u: OpenAI.Completions.CompletionUsage): NormalizedUsage {
  // ONE-CONVENTION NORMALIZATION (2026-08-04): prompt_tokens INCLUDES
  // cached_tokens on this API; NormalizedUsage is EXCLUSIVE on every arm —
  // see normalizeResponsesUsage for the incident rationale.
  //
  // DeepSeek FIRST-PARTY spelling (docs-verified 2026-08-13): api.deepseek.com
  // reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` instead of
  // OpenAI's `prompt_tokens_details.cached_tokens`. Presence-gated: providers
  // that never send the field (OpenAI, Fireworks — which serves DeepSeek models
  // with the OPENAI spelling, live-verified 2026-08-12) are byte-identical.
  const ds = u as OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number };
  const raw = u.prompt_tokens ?? 0;
  const hit = typeof ds.prompt_cache_hit_tokens === 'number' ? ds.prompt_cache_hit_tokens : undefined;
  const cached = Math.min(hit ?? u.prompt_tokens_details?.cached_tokens ?? 0, raw);
  // REASONING-TOKEN CONVENTION (live-verified 2026-08-13): xAI EXCLUDES
  // completion_tokens_details.reasoning_tokens from completion_tokens
  // (total = prompt + completion + reasoning on their wire, and their
  // cost_in_usd_ticks bills reasoning at the output rate), while OpenAI and
  // DeepSeek INCLUDE reasoning in completion_tokens (total = prompt +
  // completion). The wire is self-describing, so detect the convention from
  // the total-tokens arithmetic instead of a per-provider list — a provider
  // that reports neither shape keeps today's behavior (no fold).
  const completion = u.completion_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const reasoningExcluded =
    reasoning > 0 && typeof u.total_tokens === 'number' && u.total_tokens === raw + completion + reasoning;
  return {
    inputTokens: Math.max(0, raw - cached),
    outputTokens: completion + (reasoningExcluded ? reasoning : 0),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    // C5: the provider's own reasoning count rides to the ledger (task_turn_usage
    // reasoning_tokens), already inside outputTokens either way. Present only when the
    // wire reported one, so a provider that never does keeps its row's NULL.
    ...(typeof u.completion_tokens_details?.reasoning_tokens === 'number' && { reasoningTokens: reasoning }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reasoning replay + the DeepSeek effort vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A legacy round's reasoning (its thinking blocks) as the message's real
 * `reasoning_content` — no-op when there is none. Rounds written since 09-23 carry
 * the sealed message instead, which already has the field as the provider sent it.
 */
export function withReasoning(msg: Msg, blocks: ContentBlock[]): Msg {
  const thinking = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n');
  return thinking !== '' ? ({ ...msg, reasoning_content: thinking } as unknown as Msg) : msg;
}

/**
 * Strip `reasoning_content` from assistant messages for a model that does not read
 * it back (capability `thinking.replaysReasoning` absent). The old gate sent it only
 * on the `deepseek` provider — a lane that no longer exists — so every Fireworks
 * model lost its reasoning on every tool loop, on the unverified belief that
 * Fireworks' schema rejects the field (it does not: probed 2026-09-23, see the
 * capability). Messages without it pass through by reference.
 */
export function withoutReasoningContent(messages: Msg[]): Msg[] {
  const out: Msg[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !('reasoning_content' in m)) return void out.push(m);
    const { reasoning_content: _dropped, ...rest } = m as Msg & { reasoning_content?: unknown };
    const a = rest as AssistantMsg;
    if ((a.content != null && a.content !== '') || (a.tool_calls?.length ?? 0) > 0) return void out.push(a);
    // A reasoning-only round with its reasoning stripped says nothing to this model:
    // leave it out, unless that would put two user turns side by side — then the
    // floor's placeholder keeps the alternation (a bare assistant is accepted by
    // Fireworks and xAI too, probed 2026-09-23, but its acceptance is not a contract).
    const prev = out[out.length - 1]?.role;
    const next = messages[i + 1]?.role;
    if (prev === 'user' && next === 'user') out.push({ ...a, content: PLACEHOLDER_EMPTY_CONTENT });
  });
  return out;
}

/**
 * DeepSeek's accepted reasoning_effort vocabulary is low|high|max — no
 * 'medium' (docs-verified 2026-08-13; thinking defaults ON at 'high').
 * 'medium' maps UP to 'high' so a mid-tier seed row can never 400 the lane.
 */
export function deepseekReasoningEffort(
  effort: 'low' | 'medium' | 'high' | undefined,
): 'low' | 'high' | undefined {
  return effort === 'medium' ? 'high' : effort;
}

/** Parse reassembled tool-call args; a torn/empty stream degrades to `{}`. */
function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}
