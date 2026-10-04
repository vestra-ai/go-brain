/**
 * request-validity — the per-provider "validity floor".
 *
 * Inspired by Hermes (NousResearch/hermes-agent), whose provider adapters each
 * bake in a set of defensive invariants so that a conversation re-derived from
 * stored state is ALWAYS a structurally valid API request — no matter what
 * (legal but quirky) sequence the model produced or how our journal stored it.
 *
 * The native arm builds its request two ways: live (in-memory, from the stream
 * accumulator) and on resume (re-derived from the append-only journal via
 * `journalToAnthropicMessages`). The live path naturally produces well-formed
 * messages; the re-derived path can emit shapes the Messages API rejects with a
 * 400 invalid_request — which our termination classifier buckets as the
 * catch-all `model_error` ("The AI service had an issue"). This floor closes
 * that whole class:
 *
 *   1. No empty assistant content        → `(no content)` placeholder.
 *   2. No empty text blocks              → dropped (Anthropic rejects empty text).
 *   3. No empty tool_result content      → `(no output)` placeholder.
 *   4. Thinking blocks ordered first     → required before text/tool_use.
 *   5. Consecutive tool_result user msgs → merged into one user turn
 *                                          (parallel-tool results must share a turn).
 *
 * Pure and idempotent: an already-valid request passes through unchanged.
 *
 * SEALED messages: an assistant message replayed from the provider's own verbatim
 * content is signed as a whole — every thinking block over everything before it —
 * and Anthropic rejects ANY change to the latest one ("thinking blocks in the
 * latest assistant message cannot be modified"). Rules 1, 2 and 4 are repairs for
 * messages WE rebuilt; applied to the provider's message they are the corruption.
 * So a sealed message skips normalization entirely. The one repair still allowed
 * is the orphan strip (a tool_use with no result 400s no matter what), and it
 * produces a NEW message, which is therefore no longer sealed and takes the
 * dead-thinking demotion as before.
 *
 * This is the Anthropic-Messages implementation. The OpenAI Responses, OpenAI
 * Chat Completions, and Gemini transports apply the same invariant SET against
 * their own wire shapes (see the matching `ensureValid*Request` helpers).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

/** Substituted for an assistant/user message that would otherwise be empty. */
export const PLACEHOLDER_EMPTY_CONTENT = '(no content)';
/** Substituted for a tool_result whose content would otherwise be empty. */
export const PLACEHOLDER_NO_OUTPUT = '(no output)';

type Block = Anthropic.ContentBlockParam;

/** Apply the Anthropic-Messages validity floor to a request's message list. */
export function ensureValidAnthropicRequest(
  messages: Anthropic.MessageParam[],
  sealed: ReadonlySet<Anthropic.MessageParam> = new Set(),
): Anthropic.MessageParam[] {
  // PR8: strip orphaned tool blocks FIRST (before the empty/merge passes) — an
  // unanswered tool_use or an unmatched tool_result both 400. This is the request-build
  // guard for the cold-resume case a hard kill (before heal+fsync) leaves behind.
  // Then (adjacency floor) ensure every surviving tool_use is answered in the turn
  // right after it — a present-but-non-adjacent result equally 400s.
  return ensureToolResultsAdjacent(
    mergeConsecutiveUserTurns(
      stripOrphanedToolBlocks(messages).map((m) => (isReplayableAsIs(m, sealed) ? m : normalizeMessage(m))),
    ),
  );
}

/**
 * The assistant `tool_use` ids NOT answered in the IMMEDIATELY-following user turn.
 * Answered means the way the Messages API reads it: a tool_result in the LEADING run of
 * that turn's blocks. A result behind a text block is rejected like a missing one (live
 * 28edef30: the merge folded a breadcrumb and a late result into `[text, tool_result]`,
 * this scan counted it answered, and the floor passed a request that 400s).
 */
export function unansweredToolUseIds(messages: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id);
    if (ids.length === 0) continue;
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b.type !== 'tool_result') break;
        answered.add(b.tool_use_id);
      }
    }
    for (const id of ids) if (!answered.has(id)) out.push(id);
  }
  return out;
}

/** Compact per-message tool-block fingerprint for the HITL resume-400 tripwire logs. */
export function toolBlockFingerprint(messages: Anthropic.MessageParam[]): string {
  return messages
    .map((m, i) => {
      if (!Array.isArray(m.content)) return `${i}:${m.role}`;
      const tu = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id);
      const tr = m.content.filter((b) => b.type === 'tool_result').map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id);
      return `${i}:${m.role}${tu.length ? ` tu=[${tu.join(',')}]` : ''}${tr.length ? ` tr=[${tr.join(',')}]` : ''}`;
    })
    .join(' | ');
}

/**
 * Adjacency floor (the unanswered-tool_use resume 400, live tasks 1067a95b / 8db91619) —
 * every assistant `tool_use` MUST be answered in the IMMEDIATELY-following user turn (the
 * Messages API requires all of an assistant turn's tool_results in the very next message).
 * A journal-re-derived history can interleave a later turn between a tool_use and its
 * PRESENT-but-non-adjacent tool_result; `stripOrphanedToolBlocks` (run before this) only
 * drops a result that is MISSING entirely, so a displaced-but-present result slips through.
 *
 * Runs LAST: relocate each assistant's tool_results INTO the turn right after it (deduped
 * last-wins, matching `keepLastToolResultPerId` upstream), dropping a user turn the
 * relocation empties. Identity (same reference) when every tool_use is already answered
 * adjacently — the well-formed live path, so it is byte-identical there.
 *
 * LOUD tripwire (repo law: fix the disease, not the symptom — the floor is defense-in-depth
 * ONLY with full visibility): a relocation is NEVER silent. `project()` always emits an
 * adjacent history, so any firing here means the request was assembled from a shape
 * `project()` would not produce (a scope leak / stale projection) — we log it at ERROR with
 * the ids + fingerprint so every occurrence lands in the trace store for a targeted fix.
 */
function ensureToolResultsAdjacent(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Fast path: already adjacent everywhere → identity (no allocation), byte-identical.
  const unanswered = unansweredToolUseIds(messages);
  if (unanswered.length === 0) return messages;

  // LOUD: never self-heal silently (the relay ships this to the trace store).
  console.error(
    `[hitl-adjacency-floor-repair] relocating tool_result(s) for unanswered tool_use id(s) ` +
      `[${unanswered.join(',')}] into the adjacent user turn; messages=${messages.length}; ` +
      `fingerprint=${toolBlockFingerprint(messages)}`,
  );

  const toolUseIds = (m: Anthropic.MessageParam): string[] =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id)
      : [];

  // Collect every tool_result by id (LAST wins — parallels keepLastToolResultPerId).
  const resultById = new Map<string, Anthropic.ToolResultBlockParam>();
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') resultById.set(b.tool_use_id, b);
    }
  }

  // Rebuild: emit each assistant, then a user turn carrying ALL its tool_results; strip
  // those relocated results from their original user turns (dropping a turn emptied by it).
  const relocated = new Set<string>();
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const ids = toolUseIds(m);
    if (ids.length > 0) {
      out.push(m);
      const results = ids
        .map((id) => resultById.get(id))
        .filter((b): b is Anthropic.ToolResultBlockParam => b !== undefined);
      for (const id of ids) relocated.add(id);
      if (results.length > 0) out.push({ role: 'user', content: results });
      continue;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const kept = m.content.filter((b) => b.type !== 'tool_result' || !relocated.has(b.tool_use_id));
      if (kept.length > 0) out.push({ ...m, content: kept });
      continue; // a user turn emptied by the relocation is dropped
    }
    out.push(m);
  }
  return mergeConsecutiveUserTurns(out); // fold the relocated-results turn into an adjacent user turn
}

/**
 * PR8 (gaps 8 + 12) — strip orphaned tool blocks in BOTH directions, demoting any
 * signed thinking left invalid by a strip.
 *
 *  - Drop an assistant `tool_use` whose id has NO matching `tool_result` (a hard kill
 *    before the result was journaled → cold resume 400s "tool_use ids were found
 *    without tool_result blocks").
 *  - Drop a user `tool_result` whose `tool_use_id` matches NO `tool_use` (the reverse
 *    orphan, equally rejected).
 *  - GAP 12: when stripping a tool_use mutates a turn that ALSO carries a signed
 *    thinking block, that block's signature was computed against the ORIGINAL turn and
 *    is now dead — Anthropic rejects the replayed turn ("thinking blocks ... cannot be
 *    modified"). Demote every thinking block on that turn to text so it replays cleanly.
 *
 * Pure; a list with no orphans returns each message unchanged (same reference) →
 * byte-identical. The id sets are computed from the ORIGINAL messages (orphans of each
 * kind are disjoint, so the two strips are independent).
 */
function stripOrphanedToolBlocks(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResultIds = new Set<string>();
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (m.role === 'user' && b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
      else if (m.role === 'assistant' && b.type === 'tool_use') toolUseIds.add(b.id);
    }
  }
  if (toolUseIds.size === 0 && toolResultIds.size === 0) return messages;

  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    if (m.role === 'assistant') {
      const kept = m.content.filter((b) => b.type !== 'tool_use' || toolResultIds.has(b.id));
      if (kept.length === m.content.length) return m; // nothing stripped → unchanged
      const hadThinking = m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
      const content = hadThinking ? demoteDeadThinking(kept) : kept;
      return { ...m, content: content.length > 0 ? content : [{ type: 'text', text: '(tool call removed)' }] };
    }
    const kept = m.content.filter((b) => b.type !== 'tool_result' || toolUseIds.has(b.tool_use_id));
    if (kept.length === m.content.length) return m;
    // Self-describing placeholder (matches Hermes + the assistant-side '(tool call removed)').
    return { ...m, content: kept.length > 0 ? kept : [{ type: 'text', text: '(tool result removed)' }] };
  });
}

/**
 * PR8 — demote dead thinking after an orphan-strip invalidated its signature. A signed
 * `thinking` block becomes a plain text block (its reasoning is preserved, its dead
 * signature dropped); a `redacted_thinking` block is opaque and cannot be re-expressed
 * as text, so it is dropped (matches Hermes).
 */
function demoteDeadThinking(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === 'thinking') {
      if (b.thinking) out.push({ type: 'text', text: b.thinking });
    } else if (b.type === 'redacted_thinking') {
      // opaque — drop
    } else {
      out.push(b);
    }
  }
  return out;
}

/**
 * A sealed message goes back byte-for-byte — unless it carries an empty text block,
 * which Anthropic rejects as input. That one shape is unreplayable as-is, so it
 * takes the ordinary floor (whose tombstone rule then drops the thinking the empty
 * block was signed into).
 */
function isReplayableAsIs(m: Anthropic.MessageParam, sealed: ReadonlySet<Anthropic.MessageParam>): boolean {
  return sealed.has(m) && Array.isArray(m.content) && !m.content.some(isEmptyText);
}

function normalizeMessage(m: Anthropic.MessageParam): Anthropic.MessageParam {
  const content = m.content;
  if (typeof content === 'string') {
    // Bare string content is only invalid when it's empty.
    return content.length === 0 ? { ...m, content: PLACEHOLDER_EMPTY_CONTENT } : m;
  }
  const blocks = m.role === 'assistant' ? normalizeAssistantBlocks(content) : normalizeUserBlocks(content);
  return { ...m, content: blocks };
}

/** Drop empty text blocks, order thinking first, never return an empty array. */
function normalizeAssistantBlocks(blocks: Block[]): Block[] {
  const kept = blocks.filter((b) => !isEmptyText(b));
  const isThinking = (b: Block) => b.type === 'thinking' || b.type === 'redacted_thinking';
  // PR2: when a turn INTERLEAVES thinking with content (think→tool→think, Claude
  // 4.6+ interleaved thinking), the emission order is LOAD-BEARING: each thinking
  // block is signed against its predecessors, so hoisting all thinking to the front
  // invalidates the LATER signatures → 400 "Invalid signature in thinking block".
  // Detect the genuine case precisely: the turn LEADS with a thinking block (the
  // model always reasons first, so a real signed turn does) AND carries a further
  // thinking block AFTER some non-thinking content. That excludes the degenerate
  // "text-then-thinking" shape (which still hoists, below) — there the lead block is
  // not thinking, so we never mistake a malformed turn for an interleaved one.
  // Preserve verbatim (the journal's verbatim-replay channel already produced the
  // valid shape; the floor must not undo it). Drop empties only.
  /*
   * Two thinking blocks sitting directly against each other is a shape a FAITHFUL
   * capture cannot produce: the model always emits content between them. So it is
   * a tombstone — something that was there when the later block was signed is no
   * longer here, and that signature can never be made to match again. Anthropic
   * answers the whole request with
   *   `messages.N.content.M: thinking blocks in the latest assistant message
   *    cannot be modified`
   * and, because the damage lives in the journal, EVERY retry rebuilds the same
   * rejected request — the task is wedged permanently, not slowly (prod 09-16,
   * a server_tool_use pair the accumulator discarded).
   *
   * The only legal move is to stop sending the thinking. Dropping it costs one
   * turn's reasoning continuity; sending it costs the whole task. Note this also
   * catches the subtler case the empty-text filter above CREATES: an empty text
   * block between two thinking blocks is illegal to send (Anthropic rejects empty
   * text) and illegal to drop (it was signed over), so the turn is unreplayable
   * either way and the thinking has to go.
   */
  const adjacentThinking = kept.some((b, i) => i > 0 && isThinking(b) && isThinking(kept[i - 1]));
  if (adjacentThinking) {
    const withoutThinking = kept.filter((b) => !isThinking(b));
    return withoutThinking.length > 0
      ? withoutThinking
      : [{ type: 'text', text: PLACEHOLDER_EMPTY_CONTENT }];
  }

  const firstNonThinking = kept.findIndex((b) => !isThinking(b));
  const interleaved =
    kept.length > 0 &&
    isThinking(kept[0]) &&
    firstNonThinking !== -1 &&
    kept.slice(firstNonThinking + 1).some(isThinking);
  if (interleaved) return kept;
  // Non-interleaved (the common case): stable partition — thinking blocks first
  // (the API requires a thinking block before any text/tool_use when thinking is in
  // play), rest in original order. Byte-identical to the pre-PR2 behavior.
  const ordered = [...kept.filter(isThinking), ...kept.filter((b) => !isThinking(b))];
  return ordered.length > 0 ? ordered : [{ type: 'text', text: PLACEHOLDER_EMPTY_CONTENT }];
}

/** Fix empty tool_result content, drop empty text blocks, never return empty. */
function normalizeUserBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_result') {
      out.push({ ...b, content: normalizeToolResultContent(b.content) });
    } else if (!isEmptyText(b)) {
      out.push(b);
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: PLACEHOLDER_EMPTY_CONTENT }];
}

function isEmptyText(b: Block): boolean {
  return b.type === 'text' && (b.text ?? '') === '';
}

/** A tool_result `content` is invalid when empty; substitute a placeholder. */
function normalizeToolResultContent(
  content: Anthropic.ToolResultBlockParam['content'],
): NonNullable<Anthropic.ToolResultBlockParam['content']> {
  if (content == null) return PLACEHOLDER_NO_OUTPUT;
  if (typeof content === 'string') return content === '' ? PLACEHOLDER_NO_OUTPUT : content;
  if (Array.isArray(content)) {
    const nonEmpty = content.filter((b) => !(b.type === 'text' && (b.text ?? '') === ''));
    return nonEmpty.length > 0 ? nonEmpty : PLACEHOLDER_NO_OUTPUT;
  }
  return content;
}

/**
 * Merge ANY run of consecutive user-role messages into a single user turn.
 * Anthropic 400s on consecutive same-role messages ("roles must alternate"). The
 * journal projection can emit consecutive user turns several ways: parallel
 * tool_results (one user message each — the original case), and — since PR1
 * empty-output recovery — a turn that ends in an exhausted empty recovery leaves a
 * trailing user-role entry (the prompt, or a tool_result) directly before the NEXT
 * user turn. Content is concatenated as blocks (a bare-string user content becomes
 * one text block; an empty string contributes nothing).
 *
 * Only the USER side needs merging: the journal never emits consecutive ASSISTANT
 * turns from recovery — a truly-empty recovery round journals nothing, and a
 * thinking-only round is finalized (not re-called), so a recovered assistant entry
 * always follows a user/tool_result turn. (Merging signed-thinking assistant turns
 * would be signature-unsafe; deliberately not done here.)
 */
export function mergeConsecutiveUserTurns(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toBlocks = (content: Anthropic.MessageParam['content']): Block[] =>
    typeof content === 'string' ? (content === '' ? [] : [{ type: 'text', text: content }]) : [...content];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      prev.content = [...toBlocks(prev.content), ...toBlocks(m.content)];
    } else {
      out.push({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Responses wire shape — the same invariant SET.
// ─────────────────────────────────────────────────────────────────────────────

type ResponsesItem = OpenAI.Responses.ResponseInputItem;

/**
 * Apply the validity floor to an OpenAI Responses input list. The Responses
 * projection emits an assistant `message` per assistant turn (empty *string*
 * content when the turn was only a tool call) and a `function_call_output` per
 * tool result (empty *string* output when a tool returned nothing) — both shapes
 * the API can 400 on. A content/output that already carries an image array is
 * non-empty by construction, so guarding the empty-string case is sufficient.
 * Reasoning-item ordering is already guaranteed upstream by the projection.
 */
export function ensureValidOpenAIResponsesRequest(items: ResponsesItem[]): ResponsesItem[] {
  // P2.0b: strip orphaned tool items FIRST (the Anthropic floor's PR8 order) — a
  // function_call_output whose function_call line was quarantined (P2.0 validated
  // hydration), or the reverse from a hard kill, 400s every subsequent turn.
  // NOTE: the strip is a WHOLE-HISTORY invariant (an orphan's partner can live in a
  // different turn). It rides inside this floor ONLY because the sole caller is the
  // whole-history projection (journalToOpenAIResponsesInput). Before any per-slice
  // reuse of this floor, hoist the strip to that seam — the way the Gemini arm already
  // separates `stripOrphanedGeminiToolParts` from `ensureValidGeminiRequest`.
  return stripOrphanedResponsesToolItems(items).map(normalizeResponsesItem);
}

/**
 * P2.0b — the Anthropic `stripOrphanedToolBlocks` ported to the Responses wire
 * shape: drop a `function_call` with no matching `function_call_output` (paired
 * by call_id) and a `function_call_output` with no matching `function_call`.
 * The GAP-12 analog here is REASONING PAIRING, not thinking signatures: a
 * `reasoning` item is bound to the call it immediately precedes, so stripping
 * the call alone would leave "reasoning without its required following item" —
 * equally a 400 — so the reasoning item is dropped with its call. A single call
 * can carry a RUN of consecutive reasoning items (the projection flushes N
 * captured reasoning records immediately before the call, see
 * openai-responses-messages.ts §4.3a), so the whole run is swept, not just one.
 * Pure; a list with no tool items returns the same array, and untouched items
 * keep their references.
 */
function stripOrphanedResponsesToolItems(items: ResponsesItem[]): ResponsesItem[] {
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const item of items) {
    if (!('type' in item)) continue;
    if (item.type === 'function_call' && typeof item.call_id === 'string') callIds.add(item.call_id);
    else if (item.type === 'function_call_output' && typeof item.call_id === 'string') outputIds.add(item.call_id);
  }
  if (callIds.size === 0 && outputIds.size === 0) return items;

  const out: ResponsesItem[] = [];
  for (const item of items) {
    if ('type' in item && item.type === 'function_call' && !outputIds.has(item.call_id)) {
      // Drop the orphan call — and the ENTIRE run of reasoning items bound to it
      // (immediately preceding), none of which can stand without their following
      // item. The sweep stops at the first non-reasoning item: in a parallel batch
      // a KEPT sibling call sits between its own reasoning and this orphan, so that
      // reasoning is never swept (it rides behind the kept call, not this one).
      while (out.length > 0) {
        const top = out[out.length - 1];
        if ('type' in top && top.type === 'reasoning') out.pop();
        else break;
      }
      continue;
    }
    if ('type' in item && item.type === 'function_call_output' && !callIds.has(item.call_id)) {
      continue; // the quarantined-tool_use case: the result survived, its call is gone
    }
    out.push(item);
  }
  return out;
}

function normalizeResponsesItem(item: ResponsesItem): ResponsesItem {
  if ('type' in item && item.type === 'function_call_output') {
    return item.output === '' ? ({ ...item, output: PLACEHOLDER_NO_OUTPUT } as ResponsesItem) : item;
  }
  // Message items carry `role` + `content` (function_call / function_call_output /
  // reasoning carry neither). EasyInputMessage may omit `type`, so key off shape.
  if ('role' in item && 'content' in item && item.content === '') {
    return { ...item, content: PLACEHOLDER_EMPTY_CONTENT } as ResponsesItem;
  }
  return item;
}

/**
 * The mark a SEALED Responses item carries in the in-flight input: the provider
 * that minted it (see ResponsesOutputReplay), under a symbol key so it can never
 * serialize (the API 400s an unknown field — `_issuer` probed 2026-09-23). The
 * preflight passes a marked item through verbatim: only the cross-issuer drop and
 * the kill switch apply, both of which remove a whole reasoning item that cannot be
 * decrypted. Its `id` stays — probed 2026-09-23 on gpt-6-sol and gpt-6-luna with
 * store:false: reasoning / message / function_call ids are all accepted (with or
 * without `encrypted_content`), and so is a message whose reasoning was dropped.
 */
export const SEALED_ISSUER: unique symbol = Symbol('vestra.sealedIssuer');

/**
 * A sealed NON-reasoning item another provider minted (a mid-task model switch, e.g.
 * Muse → GPT-6) goes out without its `id`: that `msg_*` / `fc_*` names an item on the
 * other provider's side, not this one's. OpenAI accepts it either way (probed
 * 2026-09-23), so this is only about never handing an endpoint ids it did not issue.
 * Its reasoning is dropped outright below (undecryptable). Same-issuer and unmarked
 * items pass by reference.
 */
function foreignIdStripped(item: ResponsesItem, currentIssuer: string | undefined): ResponsesItem {
  const issuer = (item as { [SEALED_ISSUER]?: string })[SEALED_ISSUER];
  if (issuer === undefined || issuer === '' || currentIssuer === undefined || issuer === currentIssuer) return item;
  if ((item as { type?: unknown }).type === 'reasoning' || !('id' in item)) return item;
  const { id: _foreign, ...rest } = item as ResponsesItem & { id?: unknown };
  return rest as ResponsesItem;
}

/**
 * PR3 (Hermes parity) — the RAISING stateless preflight for the OpenAI Responses
 * input list. Applied in `callModel` (the single choke point for BOTH the journal-
 * projected and in-memory paths), it enforces the `store:false` wire contract:
 *
 *  1. **Strip the reasoning `id`.** With `store:false` the Responses API cannot
 *     resolve a reasoning item by its server-minted `id` → 404. We replay the
 *     self-contained `encrypted_content` blob instead, so the `id` MUST be dropped
 *     from the outgoing item. (We still read it first, for dedup.) Rebuilt legacy
 *     records only: a SEALED item keeps its id (see SEALED_ISSUER — the 404 no
 *     longer reproduces, probed 2026-09-23).
 *  2. **Dedup reasoning by `id`.** A repeated reasoning id (e.g. a re-drive that
 *     re-appended, or a mis-paired linkage) would send the same encrypted blob twice;
 *     drop the duplicate. Items with no id can't be deduped → always kept.
 *  3. **Assert structural integrity.** A `function_call` with no `call_id`/`name`, or
 *     a `function_call_output` with no `call_id`, is journal corruption the API would
 *     reject with an opaque `model_error`. RAISE here so the failure is legible and
 *     attributable instead of a silent 400. (run() classifies the throw.)
 *
 * PR4 — the SAME preflight also enforces the cross-issuer reasoning contract:
 *  4. **Drop foreign-issuer reasoning.** `encrypted_content` is sealed to the
 *     endpoint (provider) that minted it; replaying a blob minted by one endpoint
 *     against a different endpoint → 400 `invalid_encrypted_content`, which poisons every
 *     later turn. The journal stamps the minting issuer on each reasoning item (rides
 *     an internal `_issuer` marker from the projection); given the CURRENT issuer
 *     (`opts.currentIssuer`, from the model in callModel), drop items whose `_issuer`
 *     differs. Unstamped (legacy / in-memory current-turn) items pass through.
 *  5. **Kill switch.** `opts.replayReasoning === false` drops ALL reasoning items —
 *     the one-time recovery after an `invalid_encrypted_content` 400 slipped through
 *     (e.g. an unstamped legacy blob): disable replay, retry, succeed.
 * The internal `_issuer` marker is ALWAYS stripped (never a valid wire field).
 *
 * Mirrors Hermes' `_preflight_codex_input_items` + `_classify_responses_issuer` filter.
 * Pure except for the throw; an already-clean list passes through structurally
 * unchanged. The Anthropic / Chat / Gemini arms never call this.
 */
export function preflightOpenAIResponsesInput(
  items: ResponsesItem[],
  opts: { currentIssuer?: string; replayReasoning?: boolean } = {},
): ResponsesItem[] {
  const { currentIssuer, replayReasoning = true } = opts;
  const out: ResponsesItem[] = [];
  const seenReasoningIds = new Set<string>();
  items.forEach((sent, idx) => {
    const item = foreignIdStripped(sent, currentIssuer);
    if (!('type' in item)) {
      // A message item (role + content) — no stateless concern; pass through.
      out.push(item);
      return;
    }
    if (item.type === 'reasoning') {
      const r = item as ResponsesItem & { id?: string; encrypted_content?: unknown; _issuer?: unknown };
      // PR4 kill switch: replay disabled → drop every reasoning item.
      if (!replayReasoning) return;
      const sealed = (r as { [SEALED_ISSUER]?: string })[SEALED_ISSUER];
      if (sealed !== undefined) {
        if (currentIssuer !== undefined && sealed !== '' && sealed !== currentIssuer) return;
        out.push(item); // the provider's own item: sent as it came (see SEALED_ISSUER)
        return;
      }
      // Hermes parity: with the `id` stripped (below) a reasoning item is replayed
      // SOLELY by its self-contained `encrypted_content` blob — so a content-less item
      // is an empty shell the API rejects. Drop it. (Unreachable from our capture site,
      // which only stores reasoning when encrypted_content is non-empty — defensive.)
      if (typeof r.encrypted_content !== 'string' || r.encrypted_content === '') return;
      // PR4 cross-issuer guard: drop a blob minted by a DIFFERENT issuer than the
      // current endpoint (it can't decrypt it → 400). Unstamped items pass through.
      const itemIssuer = typeof r._issuer === 'string' ? r._issuer : undefined;
      if (currentIssuer !== undefined && itemIssuer !== undefined && itemIssuer !== currentIssuer) return;
      const id = typeof r.id === 'string' && r.id ? r.id : undefined;
      if (id) {
        if (seenReasoningIds.has(id)) return; // dedup: drop the repeat
        seenReasoningIds.add(id);
      }
      // Strip `id` (store:false → id 404s) AND the internal `_issuer` marker (never a
      // valid wire field); keep the rest of the item verbatim.
      const { id: _dropped, _issuer: _droppedIssuer, ...rest } = r;
      out.push(rest as ResponsesItem);
      return;
    }
    if (item.type === 'function_call') {
      const c = item as ResponsesItem & { call_id?: unknown; name?: unknown };
      if (typeof c.call_id !== 'string' || c.call_id.trim() === '') {
        throw new Error(`OpenAI Responses input[${idx}] function_call is missing call_id.`);
      }
      if (typeof c.name !== 'string' || c.name.trim() === '') {
        throw new Error(`OpenAI Responses input[${idx}] function_call is missing name.`);
      }
      out.push(item);
      return;
    }
    if (item.type === 'function_call_output') {
      const c = item as ResponsesItem & { call_id?: unknown };
      if (typeof c.call_id !== 'string' || c.call_id.trim() === '') {
        throw new Error(`OpenAI Responses input[${idx}] function_call_output is missing call_id.`);
      }
      out.push(item);
      return;
    }
    out.push(item);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions wire shape — the same invariant SET.
// ─────────────────────────────────────────────────────────────────────────────

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Apply the validity floor to an OpenAI Chat Completions message list. The
 * projection emits an assistant message per turn (content `null` + `tool_calls`
 * when the turn was a tool call) and a `tool` message per result. The shapes a
 * journal-re-derived history can 400 on: an assistant message with NEITHER content
 * NOR tool_calls, and a `tool` message with empty content. A null-content
 * assistant message that carries tool_calls is VALID and left untouched.
 */
export function ensureValidChatCompletionsRequest(messages: ChatMessage[]): ChatMessage[] {
  // P2.0b: strip orphaned tool messages/calls FIRST (the Anthropic floor's PR8
  // order) — then the empty floor below turns an assistant message whose whole
  // tool_calls batch was stripped into a placeholder-content message.
  // NOTE: like the Responses arm, the strip is a WHOLE-HISTORY invariant riding
  // inside this floor only because the sole caller is the whole-history projection.
  // Hoist it to that seam (as the Gemini arm does) before any per-slice reuse.
  return stripOrphanedChatToolMessages(messages).map(normalizeChatMessage);
}

/**
 * P2.0b — the Anthropic `stripOrphanedToolBlocks` ported to the Chat Completions
 * wire shape: drop an assistant `tool_calls` entry with no matching `tool`
 * message (paired by id ↔ tool_call_id) and a `tool` message with no matching
 * assistant `tool_calls` entry. An emptied `tool_calls` array is REMOVED (the API
 * rejects an empty array); a content-less assistant left behind gets the
 * self-describing `(tool call removed)` placeholder — matching the Anthropic
 * floor — rather than the generic `(no content)` that `normalizeChatMessage` would
 * otherwise apply and that gpt-5.x has been observed to PARROT (see the PR11 note in
 * openai-responses-messages.ts). No thinking/reasoning analog exists on this wire
 * shape. Pure; a list with no tool traffic returns the same array, and untouched
 * messages keep their references.
 */
function stripOrphanedChatToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) callIds.add(c.id);
    } else if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      resultIds.add(m.tool_call_id);
    }
  }
  if (callIds.size === 0 && resultIds.size === 0) return messages;

  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const kept = m.tool_calls.filter((c) => resultIds.has(c.id));
      if (kept.length === m.tool_calls.length) {
        out.push(m); // nothing stripped → unchanged reference
      } else if (kept.length > 0) {
        out.push({ ...m, tool_calls: kept });
      } else {
        // Whole batch orphaned → the assistant becomes content-only. Give an
        // otherwise-empty message the self-describing `(tool call removed)`
        // placeholder (Anthropic-floor parity) instead of letting the empty floor
        // fall through to `(no content)` (which gpt-5.x parrots). Real content is
        // preserved untouched.
        const { tool_calls: _dropped, ...rest } = m;
        const hasContent = typeof rest.content === 'string' ? rest.content !== '' : rest.content != null;
        out.push(hasContent ? (rest as ChatMessage) : ({ ...rest, content: '(tool call removed)' } as ChatMessage));
      }
      continue;
    }
    if (m.role === 'tool' && !callIds.has(m.tool_call_id)) {
      continue; // the quarantined-tool_use case: the result survived, its call is gone
    }
    out.push(m);
  }
  return out;
}

/**
 * Tool-call arguments that are not valid JSON become "{}" — the value dispatch ran the
 * call with. A round cut off by max_tokens mid-call leaves `'{"path": "a'` in the
 * sealed message, and Fireworks GLM 5.2 400s every later request carrying it ("must
 * be a JSON object string", probed 2026-09-23; DeepSeek V4 Flash and Grok accept it).
 * A repair of what cannot be sent: the message is then no longer the provider's as
 * streamed. Well-formed messages pass by reference.
 */
export function withSendableToolArguments<M extends ChatMessage>(m: M): M {
  if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
  let repaired = false;
  const toolCalls = m.tool_calls.map((c) => {
    const args = (c as { function?: { arguments?: unknown } }).function?.arguments;
    if (typeof args !== 'string' || isJson(args)) return c;
    repaired = true;
    return { ...c, function: { ...(c as { function: object }).function, arguments: '{}' } };
  });
  return repaired ? ({ ...m, tool_calls: toolCalls } as M) : m;
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  const m = withSendableToolArguments(message);
  if (m.role === 'assistant') {
    const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const emptyContent = m.content == null || m.content === '';
    // A reasoning-only round (e.g. cut off by max_tokens while thinking) is a real
    // turn: Fireworks (DeepSeek V4 / V4.1 / V4 Pro, GLM 5.2) and xAI all accept it
    // with content null, '' or absent (probed 2026-09-23). Rewriting it to
    // "(no content)" put words in the model's mouth that it then parroted (PR11).
    const reasoning = (m as { reasoning_content?: unknown }).reasoning_content;
    if (emptyContent && !hasToolCalls && !(typeof reasoning === 'string' && reasoning !== '')) {
      return { ...m, content: PLACEHOLDER_EMPTY_CONTENT };
    }
    return m;
  }
  if (m.role === 'tool') {
    const empty = m.content === '' || (Array.isArray(m.content) && m.content.length === 0);
    return empty ? { ...m, content: PLACEHOLDER_NO_OUTPUT } : m;
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini native wire shape — the same invariant SET.
//
// Gemini has no official SDK dependency here, so its wire types are declared
// explicitly (the transport speaks the REST `generateContent` shape). Roles are
// `user` | `model`; a turn is a list of `parts` (text / functionCall /
// functionResponse / inlineData). functionResponse is matched to its call by
// NAME (Gemini carries no tool-call id).
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiPart {
  text?: string;
  /** A thought-summary text part (only when thoughts are requested). */
  thought?: boolean;
  /** `id` is the provider's own call id (Gemini 3 mints one per call). */
  functionCall?: { name: string; args: unknown; id?: string };
  /** `id` echoes the call's provider id, pairing the result to its call by id. */
  functionResponse?: { name: string; response: unknown; id?: string };
  inlineData?: { mimeType: string; data: string };
  /** PR6 — Gemini-3 opaque signature attached to a functionCall; must be replayed
   *  verbatim on the next request or the turn 400s. Absent on non-Gemini-3 models. */
  thoughtSignature?: string;
  /** Media-refs S1 — INTERNAL projection-only marker: the image block's CDN url,
   *  carried so the transport's request-build pass can edge-fetch bytes for a
   *  url-only image. NEVER wire-legal: materializeGeminiBody strips it in every
   *  flag state before the request is sent. */
  vestraImageUrl?: string;
}
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Google's documented escape for a function call that carries no real signature:
 * the validator skips a call (generateContent: a functionCall part; Interactions:
 * a thought step) carrying this value. Sent only where no real signature exists —
 * a captured signature is never replaced by it.
 */
export const GEMINI_SENTINEL_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Apply the validity floor to a Gemini `contents` list: drop empty text parts,
 * give an empty functionResponse a placeholder, and never emit a content with no
 * parts. Mirrors the other dialects' guarantee that a journal-re-derived history
 * is always a structurally valid request.
 *
 * SEALED contents (a model turn replayed from the provider's own parts) skip the
 * part normalization: the trailing `{text:""}` part Gemini streams is the
 * provider's, and dropping it is a rewrite of the model's turn. Only a sealed turn
 * with nothing sendable in it (see isSendableGeminiTurn) takes the floor.
 */
export function ensureValidGeminiRequest(
  contents: GeminiContent[],
  sealed: ReadonlySet<GeminiContent> = new Set(),
): GeminiContent[] {
  return mergeConsecutiveGeminiUser(
    contents.map((c) =>
      sealed.has(c) && isSendableGeminiTurn(c.parts) ? c : { ...c, parts: normalizeGeminiParts(c.parts, c.role) },
    ),
  );
}

/** A turn is sendable as-is when some part is more than a bare `{text:""}`. */
export function isSendableGeminiTurn(parts: GeminiPart[]): boolean {
  return parts.some((p) => !(p.text === '' && Object.keys(p).length === 1));
}

/**
 * Remove functionCall parts from ONE model turn without leaving the survivors
 * unsendable. Gemini 3 signs only the FIRST call of a parallel run (probed
 * 2026-09-23: [call A + signature, call B] — B carries none), and a turn whose
 * signed call is removed while an unsigned sibling stays 400s ("Function call is
 * missing a thought_signature … position 2"). So when a removed call carried the
 * turn's signature and the first surviving call has none, that call takes the
 * documented skip-validator sentinel (probed: 200). The real signature cannot move
 * with it — it was issued for the removed call — and nothing else is touched.
 */
export function dropGeminiCallParts(parts: GeminiPart[], drop: (p: GeminiPart, callIndex: number) => boolean): GeminiPart[] {
  let callIndex = 0;
  let droppedSignature = false;
  const kept = parts.filter((p) => {
    if (!p.functionCall) return true;
    if (!drop(p, callIndex++)) return true;
    if (p.thoughtSignature) droppedSignature = true;
    return false;
  });
  if (!droppedSignature) return kept;
  const first = kept.findIndex((p) => p.functionCall);
  if (first < 0 || kept[first].thoughtSignature) return kept;
  return kept.map((p, i) => (i === first ? { ...p, thoughtSignature: GEMINI_SENTINEL_THOUGHT_SIGNATURE } : p));
}

/**
 * P2.0b — drop orphaned Gemini tool parts, pairing calls to results the way Gemini
 * ACTUALLY does: POSITIONALLY, not by a global name set. Gemini carries no tool-call
 * id, so a `functionResponse` answers the `functionCall` of the same name in the
 * IMMEDIATELY-PRECEDING model turn — a name answered in an earlier turn does NOT
 * license an unanswered call of that name in a later turn (the bug the global name-set
 * matcher had: a trailing unanswered `search` survived because `search` was answered
 * once, upstream).
 *
 * The invariant enforced here:
 *  - For each model turn bearing `functionCall` parts, pair them by name+order
 *    (greedy, count-matched) against the `functionResponse` parts of the contiguous
 *    run of user turns immediately following (the projection emits one user turn per
 *    parallel result; the floor's `mergeConsecutiveGeminiUser` folds them later).
 *  - Drop unpaired `functionCall` parts from the model turn.
 *  - Drop the unpaired `functionResponse` parts from that user run.
 *  - Drop EVERY `functionResponse` in a user turn NOT part of a run following a
 *    functionCall-bearing model turn (the reverse orphan — e.g. a result whose call
 *    line was quarantined at hydration).
 * Pairing is by NAME only (never id): old journals minted colliding internal ids, so
 * an id-based matcher would mis-pair across turns. A stripped `functionCall` takes its
 * per-part `thoughtSignature` with it — and because Gemini 3 signs only the FIRST call
 * of a parallel run, stripping that one would leave its unsigned siblings unsendable;
 * `dropGeminiCallParts` gives the first survivor the documented sentinel in that case.
 *
 * DELIBERATELY NOT inside `ensureValidGeminiRequest`: that floor is also the per-slice
 * normalizer on the LIVE path (gemini-transport pushAssistant / pushToolResult call it
 * on single-content slices, where the matching partner legitimately lives outside the
 * slice). The strip is a WHOLE-HISTORY invariant — apply it only at the whole-history
 * seam (journalToGeminiContents), before the floor. Pure; a history with no orphans
 * returns every content unchanged (same reference). An emptied content is left for
 * `normalizeGeminiParts` (the floor, which runs after this strip) to placeholder —
 * never zero parts.
 */
export function stripOrphanedGeminiToolParts(contents: GeminiContent[]): GeminiContent[] {
  const n = contents.length;
  // Filtered parts per changed content index; a content absent here is unchanged.
  const rewritten = new Map<number, GeminiPart[]>();
  // User turns that belong to a response-run answering a functionCall model turn.
  const pairedUserTurns = new Set<number>();

  let i = 0;
  while (i < n) {
    const c = contents[i];
    if (c.role === 'model' && c.parts.some((p) => p.functionCall)) {
      // Gather the contiguous run of user turns immediately following this model turn.
      let j = i + 1;
      const runIdx: number[] = [];
      while (j < n && contents[j].role === 'user') runIdx.push(j++);
      // Response pool for the run: a multiset of functionResponse names.
      const available = new Map<string, number>();
      for (const ri of runIdx) {
        for (const p of contents[ri].parts) {
          if (p.functionResponse) {
            const name = p.functionResponse.name;
            available.set(name, (available.get(name) ?? 0) + 1);
          }
        }
      }
      // Greedy pair calls (in order) against the pool; unpaired calls dropped.
      const remaining = new Map(available);
      const keptModelParts = dropGeminiCallParts(c.parts, (p) => {
        const cnt = remaining.get(p.functionCall!.name) ?? 0;
        if (cnt > 0) {
          remaining.set(p.functionCall!.name, cnt - 1);
          return false;
        }
        return true;
      });
      if (keptModelParts.length !== c.parts.length) rewritten.set(i, keptModelParts);
      // consumed[name] = available - remaining. Keep that many responses per name
      // across the run (in order); drop the rest.
      const keepBudget = new Map<string, number>();
      for (const [name, cnt] of available) keepBudget.set(name, cnt - (remaining.get(name) ?? 0));
      for (const ri of runIdx) {
        pairedUserTurns.add(ri);
        const uc = contents[ri];
        const keptUserParts = uc.parts.filter((p) => {
          if (!p.functionResponse) return true;
          const budget = keepBudget.get(p.functionResponse.name) ?? 0;
          if (budget > 0) {
            keepBudget.set(p.functionResponse.name, budget - 1);
            return true;
          }
          return false;
        });
        if (keptUserParts.length !== uc.parts.length) rewritten.set(ri, keptUserParts);
      }
      i = j;
      continue;
    }
    i++;
  }

  // Reverse orphans: functionResponse parts in a user turn that never paired with a
  // preceding functionCall model turn.
  for (let k = 0; k < n; k++) {
    if (pairedUserTurns.has(k)) continue;
    const c = contents[k];
    if (c.role !== 'user' || !c.parts.some((p) => p.functionResponse)) continue;
    rewritten.set(k, c.parts.filter((p) => !p.functionResponse));
  }

  if (rewritten.size === 0) return contents;
  return contents.map((c, idx) => (rewritten.has(idx) ? { ...c, parts: rewritten.get(idx)! } : c));
}

/**
 * PR5 — merge consecutive `user`-role contents into one (parts concatenated). The
 * projection emits one user content per PARALLEL tool result (`functionResponse`), and
 * — like the Anthropic floor — a recovery give-up can leave a trailing user content
 * before the next user turn; Gemini wants those in a SINGLE content. Mirrors the
 * Anthropic `mergeConsecutiveUserTurns` (user side only — merging `model` turns is not
 * needed and the journal never emits consecutive model contents). Pure.
 */
function mergeConsecutiveGeminiUser(contents: GeminiContent[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const c of contents) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && c.role === 'user') {
      prev.parts = [...prev.parts, ...c.parts];
    } else {
      out.push({ ...c, parts: [...c.parts] });
    }
  }
  return out;
}

function normalizeGeminiParts(parts: GeminiPart[], role: GeminiContent['role']): GeminiPart[] {
  const out: GeminiPart[] = [];
  for (const p of parts) {
    if (p.text !== undefined) {
      // An empty text part that carries a thoughtSignature is the provider's, not
      // noise: the signature can sit there, and dropping the part drops it.
      if (p.text !== '' || p.thoughtSignature) out.push(p);
      continue;
    }
    if (p.functionResponse) {
      const r = p.functionResponse.response;
      const empty = r == null || r === '';
      out.push(empty ? { functionResponse: { ...p.functionResponse, response: { output: PLACEHOLDER_NO_OUTPUT } } } : p);
      continue;
    }
    out.push(p);
  }
  if (role === 'model') signFirstCall(out);
  return out.length > 0 ? out : [{ text: PLACEHOLDER_EMPTY_CONTENT }];
}

/**
 * A REBUILT model turn (not the provider's sealed parts: an old journal's split
 * projection, a round with no captured turn, the blocks fallback) whose first
 * functionCall carries no signature gets the documented skip-validator sentinel on
 * it. Every Gemini model we can reach is Gemini 3 (2.5 answers 404 "no longer
 * available", probed 2026-09-23), and Gemini 3 400s that turn on every retry
 * ("Function call is missing a thought_signature"); with the sentinel it is a 200.
 * A real signature is never replaced. Mutates `parts` (the floor's own copy).
 */
function signFirstCall(parts: GeminiPart[]): void {
  const first = parts.findIndex((p) => p.functionCall);
  if (first >= 0 && !parts[first].thoughtSignature) {
    parts[first] = { ...parts[first], thoughtSignature: GEMINI_SENTINEL_THOUGHT_SIGNATURE };
  }
}
