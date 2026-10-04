/**
 * openai-responses-messages — wire translation for the OpenAI Responses transport.
 *
 * The structural analog of `native-messages.ts` (the Anthropic arm), swapped to
 * the OpenAI Responses API shapes:
 *
 *   1. The journal (our append-only source of truth — `JournalEntry[]`).
 *   2. The OpenAI Responses API request `input` array (`ResponseInputItem[]`).
 *   3. Responses streaming events (`ResponseStreamEvent`) → accumulated assistant
 *      text + the captured function-call (tool_use) calls.
 *
 * Everything is typed against the installed `openai` SDK (v6.39.1). The raw
 * Responses streaming events are deliberately NOT the higher-level
 * `@openai/agents` events — those are a different layer.
 */

import type OpenAI from 'openai';
import type { ContentBlock, ImageBlock } from '../contract/blocks.js';
import type { JournalEntry, ResponsesOutputReplay } from '../contract/journal.js';
import { stripInvisibleControlTurns } from '../contract/journal.js';
import type { NormalizedUsage } from '../contract/events.js';
import { readResponsesUsage } from '../contract/responses-usage.js';
import { ensureValidOpenAIResponsesRequest, SEALED_ISSUER } from '../engine/request-validity.js';
import { readyToolArgs, type ReadyToolUse } from '../engine/tool-ready.js';

/** The dialect id this projection trusts a `responsesOutput` channel from. */
export const OPENAI_RESPONSES_API = 'openai_responses';

/**
 * A sealed round → its input items: the provider's own output items, in order, each a
 * shallow copy marked with its issuer under SEALED_ISSUER (a symbol — never on the
 * wire) so the preflight can apply the cross-issuer drop and otherwise pass it
 * through untouched. Output items are valid input items as they stand (probed
 * 2026-09-23: reasoning with summary + encrypted_content, message with id + phase +
 * output_text content, function_call with id + status), so nothing is reshaped.
 */
export function sealedResponsesItems(output: ResponsesOutputReplay): OpenAI.Responses.ResponseInputItem[] {
  return output.items.map(
    (item) => ({ ...item, [SEALED_ISSUER]: output.issuer ?? '' }) as unknown as OpenAI.Responses.ResponseInputItem,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. journal → OpenAI Responses API `input`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert journal context entries (the output of `Journal.project()`) into the
 * OpenAI Responses API `input` array.
 *
 *  - `user`        → `{ role: 'user', content }`           (text concatenated).
 *  - `assistant`   → `{ role: 'assistant', content }`      (text blocks only;
 *                    thinking is already dropped in the journal per K1).
 *  - `tool_use`    → `{ type: 'function_call', call_id, name, arguments }`
 *                    (arguments JSON-stringified; `{}` for empty input).
 *  - `tool_result` → `{ type: 'function_call_output', call_id, output }`
 *                    (paired with its function_call by `call_id`).
 *
 * `project()` already filters to context entries, so non-context payload types
 * never arrive — but we skip them (and the not-yet-replayed `system` /
 * `custom_message`) defensively.
 */
/**
 * Build one Responses `reasoning` input item from a journaled reasoning record.
 * PR4 — when the record carries an `issuer` (the provider/endpoint that minted the
 * `encrypted_content`), ride it on an INTERNAL `_issuer` marker so the callModel
 * preflight can drop a foreign-issuer blob before the wire (it can't be decrypted by
 * a different endpoint → 400 invalid_encrypted_content). `_issuer` is NOT a valid
 * Responses field; `preflightOpenAIResponsesInput` strips it (along with `id`). Absent
 * issuer → no `_issuer` key → byte-identical to the pre-PR4 item.
 */
function reasoningInputItem(r: {
  id: string;
  encryptedContent: string;
  issuer?: string;
}): OpenAI.Responses.ResponseReasoningItem {
  return {
    type: 'reasoning',
    id: r.id,
    summary: [],
    encrypted_content: r.encryptedContent,
    ...(r.issuer ? { _issuer: r.issuer } : {}),
  } as OpenAI.Responses.ResponseReasoningItem;
}

export function journalToOpenAIResponsesInput(
  entries: JournalEntry[],
): OpenAI.Responses.ResponseInputItem[] {
  // Nami P1.1 — invisible control turns (the hot memory pass) are journaled for
  // billing/audit but must never re-enter the model's context.
  entries = stripInvisibleControlTurns(entries);
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  // call_ids already sent INSIDE a sealed round — their tool_use entries (kept in the
  // journal for result pairing / healing / suspend) must not fold a second copy.
  const replayed = new Set<string>();

  for (const entry of entries) {
    const p = entry.payload;
    switch (p.type) {
      case 'user':
        // Image-aware: an ImageBlock on a user entry projects an `input_image`
        // content part (image-before-text), matching the Anthropic arm
        // (`blocksToAnthropic`). A text-only entry stays a bare string —
        // byte-identical to the prior text-only projection.
        out.push({ role: 'user', content: blocksToOpenAIResponsesContent(p.blocks) });
        break;

      case 'assistant': {
        // SEALED: the round's `response.output` exactly as the provider returned it —
        // its order (reasoning where the model put it, commentary messages between
        // calls), each message's id and `phase`, every reasoning summary, the raw
        // `arguments` strings, and item types this SDK does not model. The rebuild
        // below reordered [r1, message, call] to [r1?, message, r1, call], merged
        // messages, lost `phase`, and re-stringified parsed arguments. A call whose
        // tool_use entry was pruned upstream has no output either, so the floor's
        // orphan strip removes it (and only it) exactly as it does for a folded call.
        // CROSS-ISSUER GUARD: only a channel this dialect minted is read.
        const channel = p.api === OPENAI_RESPONSES_API ? p.responsesOutput : undefined;
        if (channel && channel.items.length > 0) {
          out.push(...sealedResponsesItems(channel));
          for (const item of channel.items) {
            if (item.type === 'function_call' && typeof item.call_id === 'string') replayed.add(item.call_id);
          }
          break;
        }
        // PR4 P2 — echo any HEAD/orphan encrypted reasoning items captured before
        // this assistant turn (they preceded no tool call) immediately BEFORE the
        // assistant message, so a leading/orphan reasoning survives reload (stateless
        // reasoning models REQUIRE the item or they 400). The field is OpenAI/Sakana-
        // scoped + absent on Anthropic / non-reasoning entries → byte-identical there.
        for (const r of p.reasoning ?? []) out.push(reasoningInputItem(r));
        // PR11 — RETIRES THE ORIGINALLY-REPORTED BUG. A tool-only turn journals a
        // text-empty assistant entry; pushing it as an empty assistant message made
        // the validity floor rewrite it to "(no content)" BEFORE the function_call, and
        // gpt-5.x read itself saying "(no content)" and PARROTED it. So: push the
        // assistant message ONLY when it carries real text, else emit NOTHING. The old
        // content='' follower after HEAD reasoning took the same "(no content)" rewrite
        // (the parrot again, 09-23); a reasoning item needs no follower (probed
        // 2026-09-23: reasoning then a user message or a call is accepted).
        const assistantText = blocksToText(p.blocks);
        if (assistantText !== '') out.push({ role: 'assistant', content: assistantText });
        break;
      }

      case 'tool_use': {
        if (replayed.has(p.toolUseId)) break;
        // §4.3a — echo any encrypted reasoning items captured before this call,
        // each immediately BEFORE the function_call (stateless reasoning models
        // REQUIRE this on tool turns or the Responses API 400s). The field is
        // OpenAI/Sakana-scoped and absent on Anthropic / non-reasoning tool_uses,
        // so this loop is a no-op (byte-identical) for them.
        for (const r of p.reasoning ?? []) out.push(reasoningInputItem(r));
        const item: OpenAI.Responses.ResponseFunctionToolCall = {
          type: 'function_call',
          call_id: p.toolUseId,
          name: p.name,
          arguments: stringifyArgs(p.input),
        };
        out.push(item);
        break;
      }

      case 'tool_result': {
        // Image-aware: a tool_result whose blocks carry ≥1 image (browser-control
        // screenshots) emits the content-ARRAY `output` so the image reaches the
        // model; a text-only result keeps the bare-string `output` (byte-identical).
        // `toolResultOutput` is the SAME helper the in-memory pushToolResult uses,
        // so the two paths cannot drift.
        const item: OpenAI.Responses.ResponseInputItem.FunctionCallOutput = {
          type: 'function_call_output',
          call_id: p.toolUseId,
          output: toolResultOutput(p.blocks, blocksToText(p.blocks)),
        };
        out.push(item);
        break;
      }

      // `system` / `custom_message` are context entries but not yet replayed as
      // Responses input in K2 v0; non-context types never reach here.
      default:
        break;
    }
  }

  // Validity floor (shared with the Anthropic arm): a journal-re-derived history
  // must always be a structurally valid Responses request. Guards an empty
  // assistant message (a tool-only turn) and an empty function_call_output (a tool
  // that returned nothing) — both shapes the Responses API can 400 on.
  return ensureValidOpenAIResponsesRequest(out);
}

/** Concatenate the text blocks of a payload into one string for the API. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Map one ImageBlock → an OpenAI Responses `input_image` content part. Prefers
 * the CDN `url` (dodges the request size cap); falls back to a `data:` base64 URL
 * only when no url is present. Mirrors the Anthropic arm's url-over-base64 choice
 * (`blocksToAnthropic`). `detail:'auto'` matches the API default. */
function imageBlockToInputImage(b: ImageBlock): OpenAI.Responses.ResponseInputImage {
  return {
    type: 'input_image',
    detail: 'auto',
    image_url: b.url ?? `data:${b.mediaType};base64,${b.data}`,
  };
}

/**
 * Map one `ImageBlock` → a function-call-OUTPUT image content part.
 *
 * CRITICAL: this returns `ResponseInputImageContent` — the variant valid inside a
 * `function_call_output.output` array (`ResponseFunctionCallOutputItemList`) — NOT
 * the user-message `ResponseInputImage` that `imageBlockToInputImage` returns.
 * They look alike but are DISTINCT types: `ResponseInputImage.detail` is REQUIRED,
 * `ResponseInputImageContent.detail` is OPTIONAL, and only the latter is assignable
 * to a tool-result output array. We omit `detail` (the API default is `auto`).
 *
 * The image url mirrors the user-message helper: prefer the CDN `url` (dodges the
 * request size cap); fall back to an inline `data:` base64 url. The SINGLE source of
 * truth for the tool-result image-content shape — both the journal converter
 * (`journalToOpenAIResponsesInput`) and the in-memory `pushToolResult` route through
 * `toolResultOutput`, which calls this, so the two paths can't drift. Exported so
 * `openai-responses-transport.ts`'s `pushToolResult` can reuse the SAME helper.
 */
export function imageBlockToOutputImageContent(
  b: ImageBlock,
): OpenAI.Responses.ResponseInputImageContent {
  return {
    type: 'input_image',
    image_url: b.url ?? `data:${b.mediaType};base64,${b.data}`,
  };
}

/**
 * Build the OpenAI Responses `function_call_output.output` from the journal/dispatch
 * blocks.
 *
 * - When `blocks` carries ≥1 image, return the content-ARRAY form
 *   (`ResponseFunctionCallOutputItemList`): each text block → an
 *   `ResponseInputTextContent` (`input_text`) part and each image block → an
 *   `ResponseInputImageContent` (`input_image`) part via
 *   `imageBlockToOutputImageContent`, preserving the tool-emitted order so a
 *   screenshot actually reaches the model.
 * - Otherwise (text-only), return `textFallback` as a BARE STRING — the cheap shape,
 *   byte-identical to before this change. This is the native parity oracle.
 *
 * Shared by the journal converter (`journalToOpenAIResponsesInput`) and the in-memory
 * `pushToolResult`. The bare-string fallback is supplied by the caller so each path
 * keeps its existing text source (`blocksToText(blocks)` for the journal; `r.text` for
 * the dispatch result) byte-for-byte.
 */
export function toolResultOutput(
  blocks: ContentBlock[],
  textFallback: string,
): OpenAI.Responses.ResponseInputItem.FunctionCallOutput['output'] {
  if (!blocks.some((b) => b.type === 'image')) {
    return textFallback;
  }
  const out: OpenAI.Responses.ResponseFunctionCallOutputItemList = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'input_text', text: b.text });
    } else if (b.type === 'image') {
      out.push(imageBlockToOutputImageContent(b));
    }
    // Other block types are not valid inside a function_call_output content array.
  }
  return out;
}

/**
 * Project a user payload's blocks into the OpenAI Responses user `content`.
 *
 * THE SINGLE SOURCE OF TRUTH shared by the journal projection
 * (`journalToOpenAIResponsesInput`) and the in-memory `pushUser`, so the two
 * paths cannot drift on image handling.
 *
 *  - When ≥1 `image` block is present, returns a structured
 *    `ResponseInputMessageContentList`: each image → an `input_image` part, each
 *    text → an `input_text` part, IMAGE-BEFORE-TEXT (parity with the Anthropic
 *    arm's `blocksToAnthropic`, which leads with image params).
 *  - When the blocks are text-only (the overwhelmingly common case), returns a
 *    BARE STRING — exactly what the prior text-only projection produced, so every
 *    existing text-only request stays byte-identical. We only switch to the
 *    structured content-list form once an image is actually attached.
 *
 * Non-text / non-image blocks never reach a user payload, so they're ignored.
 */
export function blocksToOpenAIResponsesContent(
  blocks: ContentBlock[],
): string | OpenAI.Responses.ResponseInputMessageContentList {
  const hasImage = blocks.some((b) => b.type === 'image');
  if (!hasImage) {
    // Byte-identical text-only path: a bare string (the prior projection).
    return blocksToText(blocks);
  }
  // Structured content list — images lead, then text parts, matching the
  // Anthropic projection's image-before-text ordering.
  const images: OpenAI.Responses.ResponseInputContent[] = [];
  const texts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const b of blocks) {
    if (b.type === 'image') {
      images.push(imageBlockToInputImage(b));
    } else if (b.type === 'text') {
      texts.push({ type: 'input_text', text: b.text });
    }
  }
  return [...images, ...texts];
}

/** Stringify a tool_use input; empty/undefined → `"{}"`. */
function stringifyArgs(input: unknown): string {
  if (input === undefined || input === null) return '{}';
  return JSON.stringify(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Responses streaming events → accumulated text + captured tool calls
// ─────────────────────────────────────────────────────────────────────────────

/** A tool call captured off the stream, with its arguments JSON reassembled + parsed. */
export interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Consumes raw OpenAI Responses streaming events and accumulates:
 *  - assistant text (concatenated across `response.output_text.delta` events),
 *  - function-call (tool_use) calls (call_id / name / parsed arguments), and
 *  - a `textDelta(ev)` helper that returns the live text fragment of a single
 *    event (or `null`) for `AGENT_TEXT_DELTA` socket emission.
 *  - `final()` — set on `response.completed`; carries the mapped stopReason +
 *    NormalizedUsage.
 *
 * The transport's `readStream` drives this: it calls `onEvent` for every stream
 * event, emits `textDelta(ev)` for live streaming, then reads `text()` /
 * `toolUses()` / `final()` once the stream ends.
 *
 * NOTE on ids: a function call has TWO ids — the model-generated `call_id`
 * (used to pair with its `function_call_output`, and what the journal stores as
 * `toolUseId`) and the streaming item `id`. The argument-delta events key by the
 * item `id` (`item_id`), so we map item_id → the in-flight call and surface
 * `call_id` as `CapturedToolUse.id`.
 */
export interface ResponsesAccumulator {
  /** Feed one streaming event. Updates internal text + tool-call + final state. */
  onEvent(ev: OpenAI.Responses.ResponseStreamEvent): void;
  /** The accumulated assistant text. */
  text(): string;
  /** The function-call (tool_use) calls seen so far, JSON-parsed. */
  toolUses(): CapturedToolUse[];
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — the calls FINALIZED since the last call (their
   * `function_call_arguments.done` or `output_item.done` arrived), drained, keyed by
   * `call_id` like toolUses(); an unreadable one (tool-ready.ts) carries input undefined.
   */
  takeReady(): ReadyToolUse[];
  /**
   * The round's output items as the PROVIDER returned them: `response.output` off the
   * terminal event (see ResponsesOutputReplay), else — a client or double that sent a
   * terminal without it — the `output_item.done` items in output order. Undefined when
   * neither carried an item.
   */
  output(): Array<Record<string, unknown>> | undefined;
  /** The live text fragment of a single event, or null when it isn't a text delta. */
  textDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null;
  /**
   * The accumulated REFUSAL text (a soft refusal arrives as a separate
   * `ResponseOutputRefusal` content part, NOT assistant text). Empty when the
   * turn was not a refusal. Exposed so the termination classifier can carry it
   * and the transport can render it as a live text block — the user must SEE the
   * refusal, not a blank success bubble.
   */
  refusal(): string;
  /**
   * The live refusal fragment of a single event, or null when it isn't a
   * `response.refusal.delta`. The transport surfaces this as a text delta so the
   * refusal streams live through the SAME AGENT_TEXT_DELTA wiring as ordinary
   * assistant text.
   */
  refusalDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null;
  /**
   * The live reasoning-summary fragment of a single event, or null when it isn't a
   * `response.reasoning_summary_text.delta`. Surfaced as `thinking` from the
   * transport so the SAME downstream wiring (AGENT_THINKING_DELTA) renders it.
   * OpenAI reasoning summaries carry no replayable signature.
   */
  thinkingDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null;
  /**
   * PR4 P3 — the CONCATENATED reasoning-summary text accumulated across all
   * `response.reasoning_summary_text.delta` events this turn (empty when there was
   * no summary). The transport emits this as a DISPLAY-ONLY `thinking_block`
   * (signature OMITTED) after the live deltas so the reasoning summary persists in
   * the journal + renders on reload (symmetric with the Anthropic thinking_block).
   * It is NEVER echoed as a wire reasoning item — the sealed `output()` carries the
   * reasoning items themselves.
   */
  reasoningSummary(): string;
  /**
   * Final outcome — set on `response.completed` AND `response.incomplete` (a
   * partial-but-clean terminal, e.g. max_output_tokens), else null. A null final
   * after the stream drains means NO terminal event arrived → the transport throws
   * so the abnormal end surfaces instead of masquerading as an empty completion.
   */
  final(): { stopReason: string | null; usage: NormalizedUsage } | null;
  /**
   * A captured failure — set on a `response.failed` or top-level `error` stream
   * event (OpenAI delivers some upstream failures, e.g. an `insufficient_quota`
   * mid-request, as an SSE event rather than a thrown HTTP error). Carries the JSON
   * error `code` (may be null) + `message` so the transport can re-throw a
   * classifiable error. Null when no failure event was seen.
   */
  failure(): { code: string | null; message: string } | null;
}

/** An in-flight function call tracked by its streaming item id. */
interface PendingCall {
  callId: string;
  name: string;
  partialArgs: string;
  finalized: boolean;
}

export function createOpenAIResponsesAccumulator(): ResponsesAccumulator {
  let textBuf = '';
  // A soft refusal streams as a separate `ResponseOutputRefusal` content part
  // (response.refusal.delta/.done), distinct from assistant text. We accumulate
  // it apart from `textBuf` and flip the terminal stopReason to 'refusal' so the
  // turn surfaces as a visible refusal, not a blank success.
  let refusalBuf = '';
  let sawRefusal = false;
  // PR4 P3 — the concatenated reasoning-summary text (live deltas), persisted as a
  // display-only thinking_block. NEVER echoed as a wire reasoning item.
  let summaryBuf = '';
  // function calls indexed by streaming item id (arg deltas reference item_id).
  const calls = new Map<string, PendingCall>();
  // preserve emission order: item ids in the order their calls were opened.
  const order: string[] = [];
  // SEALED: the terminal response's own `output` (authoritative), and the
  // `output_item.done` items by output_index (the fallback only).
  let finalOutput: Array<Record<string, unknown>> | undefined;
  const doneItems = new Map<number, Record<string, unknown>>();
  let finalState: { stopReason: string | null; usage: NormalizedUsage } | null = null;
  let failureState: { code: string | null; message: string } | null = null;
  // L1 — finalized calls with readable arguments, not yet handed to the transport.
  let ready: ReadyToolUse[] = [];

  function startCall(item: OpenAI.Responses.ResponseFunctionToolCall): void {
    // `id` is the streaming item id arg-deltas reference; fall back to call_id.
    const itemId = item.id ?? item.call_id;
    if (calls.has(itemId)) return;
    calls.set(itemId, {
      callId: item.call_id,
      name: item.name,
      partialArgs: item.arguments ?? '',
      finalized: false,
    });
    order.push(itemId);
  }

  function finalizeCall(itemId: string, finalArgs?: string): void {
    const cur = calls.get(itemId);
    if (!cur || cur.finalized) return;
    if (finalArgs !== undefined && finalArgs !== '') cur.partialArgs = finalArgs;
    cur.finalized = true;
    // L1: every finalized call is reported, an unreadable one with input undefined.
    ready.push({ id: cur.callId, name: cur.name, input: readyToolArgs(cur.partialArgs) });
  }

  function onEvent(ev: OpenAI.Responses.ResponseStreamEvent): void {
    switch (ev.type) {
      case 'response.output_text.delta':
        textBuf += ev.delta;
        break;

      // A soft refusal streams as its own content part. Capture the text into
      // `refusalBuf` (NOT `textBuf`) and remember we saw one so `response.completed`
      // can flip the stopReason to 'refusal'.
      case 'response.refusal.delta':
        refusalBuf += ev.delta;
        sawRefusal = true;
        break;

      case 'response.refusal.done':
        // The `.done` event carries the full refusal text. Prefer it when present
        // (it is authoritative); otherwise the accumulated deltas already hold it.
        if (typeof ev.refusal === 'string' && ev.refusal !== '') refusalBuf = ev.refusal;
        sawRefusal = true;
        break;

      // PR4 P3 — accumulate the reasoning summary so the transport can persist it as
      // a display-only thinking_block (the live deltas still stream via thinkingDelta).
      case 'response.reasoning_summary_text.delta':
        summaryBuf += ev.delta;
        break;

      case 'response.output_item.added': {
        if (ev.item.type === 'function_call') startCall(ev.item);
        break;
      }

      case 'response.function_call_arguments.delta': {
        const cur = calls.get(ev.item_id);
        if (cur && !cur.finalized) cur.partialArgs += ev.delta;
        break;
      }

      case 'response.function_call_arguments.done':
        finalizeCall(ev.item_id, ev.arguments);
        break;

      case 'response.output_item.done': {
        doneItems.set(ev.output_index, ev.item as unknown as Record<string, unknown>);
        if (ev.item.type === 'function_call') {
          const itemId = ev.item.id ?? ev.item.call_id;
          // start defensively in case `added` was missed, then finalize.
          if (!calls.has(itemId)) startCall(ev.item);
          finalizeCall(itemId, ev.item.arguments);
        } else if (ev.item.type === 'message') {
          // Belt-and-suspenders: a refusal may arrive ONLY as a `{type:'refusal'}`
          // content part on the finalized message item (no separate delta events).
          // Fold its text into `refusalBuf` so it is never silently dropped.
          for (const part of ev.item.content ?? []) {
            if ((part as { type?: string }).type === 'refusal') {
              const text = (part as { refusal?: string }).refusal ?? '';
              if (text !== '') refusalBuf = text;
              sawRefusal = true;
            }
          }
        }
        break;
      }

      case 'response.completed': {
        const resp = ev.response;
        // A soft refusal arrives ON a status='completed' response — the refusal
        // signal lives in the content part, not the status. When one was seen,
        // override the stopReason so classification routes to `kind:'refused'`
        // (mirroring the Anthropic arm's stop_reason='refusal'), not a blank
        // success bubble.
        const refused = sawRefusal || refusalBuf !== '';
        finalOutput = sealedOutput(resp);
        finalState = {
          stopReason: refused
            ? 'refusal'
            : (resp.incomplete_details?.reason ?? resp.status ?? null),
          usage: normalizeResponsesUsage(resp.usage),
        };
        break;
      }

      // A partial-but-CLEAN terminal (e.g. max_output_tokens). The Responses
      // streaming API ends a truncated turn with `response.incomplete`, NOT
      // `response.completed` — so without this case `final()` would stay null and a
      // legitimately-truncated answer (already streamed live) would be thrown away
      // as an abnormal end. classifyOpenAIResponsesTermination maps the
      // 'incomplete'/'max_output_tokens' stopReason → completed (partial), parity
      // with the Anthropic max_tokens path.
      case 'response.incomplete': {
        const resp = ev.response;
        finalOutput = sealedOutput(resp);
        finalState = {
          stopReason: resp.incomplete_details?.reason ?? resp.status ?? 'incomplete',
          usage: normalizeResponsesUsage(resp.usage),
        };
        break;
      }

      // FAILURE terminals — OpenAI delivers some upstream failures as an SSE event
      // instead of a thrown HTTP error (notably an `insufficient_quota` surfacing
      // mid-request through the credential proxy). Capture the error so readStream
      // re-throws a classifiable error rather than emitting a silent empty `done`.
      case 'response.failed': {
        const err = ev.response.error;
        failureState = {
          code: err?.code ?? null,
          message: err?.message ?? 'OpenAI Responses request failed',
        };
        break;
      }

      case 'error': {
        failureState = {
          code: ev.code ?? null,
          message: ev.message ?? 'OpenAI Responses stream error',
        };
        break;
      }

      // reasoning_summary deltas (thinking) + all other events carry nothing we
      // accumulate here (the transport may surface thinking separately).
      default:
        break;
    }
  }

  function textDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null {
    if (ev.type === 'response.output_text.delta') return ev.delta;
    return null;
  }

  function refusalDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null {
    if (ev.type === 'response.refusal.delta') return ev.delta;
    return null;
  }

  function thinkingDelta(ev: OpenAI.Responses.ResponseStreamEvent): string | null {
    if (ev.type === 'response.reasoning_summary_text.delta') return ev.delta;
    return null;
  }

  return {
    onEvent,
    textDelta,
    refusalDelta,
    thinkingDelta,
    text: () => textBuf,
    refusal: () => refusalBuf,
    reasoningSummary: () => summaryBuf,
    toolUses: () =>
      order.map((itemId) => {
        const c = calls.get(itemId)!;
        return { id: c.callId, name: c.name, input: parseArgs(c.partialArgs) };
      }),
    takeReady: () => {
      const out = ready;
      ready = [];
      return out;
    },
    output: () => {
      if (finalOutput) return finalOutput;
      const done = [...doneItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
      return done.length > 0 ? done : undefined;
    },
    final: () => finalState,
    failure: () => failureState,
  };
}

/** A terminal response's `output`, verbatim; undefined when it carried none. */
function sealedOutput(resp: OpenAI.Responses.Response): Array<Record<string, unknown>> | undefined {
  const items = (resp as { output?: unknown }).output;
  return Array.isArray(items) && items.length > 0 ? (items as Array<Record<string, unknown>>) : undefined;
}

/** Map a Responses `usage` payload → the provider-neutral NormalizedUsage. */
export function normalizeResponsesUsage(u: OpenAI.Responses.ResponseUsage | undefined): NormalizedUsage {
  // `cache_write_tokens` (GPT-5.6+, billed at 1.25× input) is a BREAKDOWN of
  // input_tokens like cached_tokens; readResponsesUsage reads and clamps both.
  //
  // ONE-CONVENTION NORMALIZATION (2026-08-04, billing_partial_underbill): OpenAI's
  // input_tokens INCLUDES the cached/write breakdowns; NormalizedUsage carries the
  // EXCLUSIVE (Anthropic-shape, disjoint-buckets) convention on every arm, so wire
  // consumers (the server's billable-token floor, totalContext, repricing) never
  // have to know which provider produced the event. Subtract the breakdowns HERE,
  // at the single producer; the cost fn prices the buckets directly. The wire is
  // read by the contract's one reader (readResponsesUsage), the same one the
  // server's composer reads, so the two lanes cannot read it differently again.
  const r = readResponsesUsage(u);
  return {
    inputTokens: r.inputTokens - r.cachedTokens - r.cacheWriteTokens,
    outputTokens: r.outputTokens,
    cacheReadInputTokens: r.cachedTokens,
    cacheCreationInputTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens,
  };
}

/**
 * Reassemble + parse function-call arguments from streamed fragments. An empty
 * stream means no arguments → `{}`. Malformed JSON (a torn stream) degrades to
 * `{}` rather than throwing, so a single bad call can't crash the whole turn.
 */
function parseArgs(partialArgs: string): unknown {
  const trimmed = partialArgs.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}
