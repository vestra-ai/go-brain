/**
 * history-heal.ts — the floor under a rejected history.
 *
 * A task's history is re-derived from its journal on every turn, so a shape the
 * provider rejects is rejected on EVERY retry. Live prod task 28edef30 (2026-09-28):
 * one misplaced tool_result, four failed turns over three hours ("The AI service had an
 * issue"), and we heard from Slack. The projection now pairs results correctly
 * (result-adjacency.ts, pinned for every dialect by history-pairing.property.test.ts);
 * this is the floor for whatever shape comes next, so the next one costs one extra
 * request instead of the task.
 *
 * The trigger, all of it structural (never the message, repo law):
 *  - the model call failed with HTTP 400 and the SDK's typed `invalid_request_error`
 *    (`.status`, then `.type` or the body envelope's `.error.error.type`);
 *  - before the round committed: the caller is startStreamWithRetry's catch, which only
 *    sees failures from before the first stream event, so nothing reached the person;
 *  - the lane's own classifier left it the catch-all `model_error` (subtype
 *    `model_error`), or named it `request_invalid`: OUR request was malformed, today the
 *    signed-thinking replay native-termination.ts calls `thinking_replay_invalid` (prod
 *    09-16, a task frozen for an hour; that kind had no repair at all). Credit, context
 *    and image are named there too and keep their own paths, as does the OpenAI
 *    encrypted-reasoning 400 (its own subtype and recovery).
 * Main loop with a journal only: the safe view is built from the journal, and a
 * subagent's history lives in its own seam.
 *
 * The safe view: past rounds' tool calls and results as plain text (what was called, a
 * clipped result), so no pairing, ordering, signature or replay-channel rule can apply
 * to them. The latest tool round stays structured when it is well-formed on its own
 * (the model is answering those results); otherwise the whole history is text. A
 * rejected thinking replay always takes the whole-text view: the offending signed block
 * can sit in the latest assistant message, which the kept tail would send verbatim.
 *
 * Bounded: one heal per model call, and a second failure is thrown exactly as before
 * (the turn ends as it always did). A stop during the retry is a stop, never a failed
 * heal. Loud: a `[history-heal]` console.error every time, and an `agent:history_healed`
 * raw event (once per turn when it healed, always when it did not) that the relay
 * persists to error_events.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '../contract/blocks.js';
import type { HarnessEvent } from '../contract/events.js';
import type { JournalEntry, JournalPayload } from '../contract/journal.js';
import type { ProviderHistory, StreamEvent, Transport } from './transport.js';
import type { RoundDeps, RoundState } from './round-engine.js';
import { wireMessages } from './context-elision.js';
import { toolBlockFingerprint } from './request-validity.js';

/**
 * The raw HarnessEvent name a heal rides so the server can persist an error_event.
 * Mirrors `EVENTS.AGENT_HISTORY_HEALED` in @bash/shared (the engine imports no
 * @bash/*), pinned to the literal by test, like RECONSTRUCTION_MISMATCH_EVENT.
 */
export const HISTORY_HEALED_EVENT = 'agent:history_healed';

/** A past tool call's input and result are clipped to these many characters in the text view. */
const INPUT_CHARS = 500;
const RESULT_HEAD_CHARS = 1500;
const RESULT_TAIL_CHARS = 500;

/** The status + typed error of a thrown provider error, read structurally. */
function rejection(err: unknown): { status?: unknown; type?: unknown; requestId?: unknown } {
  const e = err as
    | { status?: unknown; type?: unknown; error?: { type?: unknown; error?: { type?: unknown } }; requestID?: unknown; request_id?: unknown }
    | null
    | undefined;
  // Anthropic's `.error` is the body ENVELOPE ({type:'error', error:{type}}), so its own
  // `.type` is the literal 'error'; `.type` on the thrown error is the real one on both
  // SDKs, the envelope's inner type covers an SDK that left it null.
  return { status: e?.status, type: e?.type ?? e?.error?.error?.type, requestId: e?.requestID ?? e?.request_id };
}

/**
 * Which view a failed model call heals on, or null when it is not a history the provider
 * rejected (or another path owns it): `safe` keeps a well-formed latest tool round,
 * `text_only` renders everything as text.
 */
export function rejectedHistoryView(err: unknown, transport: Pick<Transport, 'classifyError'>): 'safe' | 'text_only' | null {
  const { status, type } = rejection(err);
  if (status !== 400 || type !== 'invalid_request_error') return null;
  const outcome = transport.classifyError(err);
  if (outcome.kind === 'model_error' && outcome.raw?.subtype === 'model_error') return 'safe';
  return outcome.kind === 'request_invalid' ? 'text_only' : null;
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text }) as ContentBlock;
const withPayload = (e: JournalEntry, payload: JournalPayload): JournalEntry => ({ ...e, payload }) as JournalEntry;

function clip(s: string, head: number, tail = 0): string {
  if (s.length <= head + tail) return s;
  // Head AND tail: a fenced untrusted result keeps both its opening and closing marker.
  return `${s.slice(0, head)}\n[... ${s.length - head - tail} characters left out ...]\n${tail ? s.slice(-tail) : ''}`;
}

function resultText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * The index of the latest assistant entry when the history ENDS in that round's tool
 * block and the block is well-formed on its own (every call answered once inside it,
 * no result without its call there); -1 otherwise.
 */
function wellFormedToolTail(entries: JournalEntry[]): number {
  let a = entries.length - 1;
  while (a >= 0 && entries[a].payload.type !== 'assistant') a--;
  if (a < 0) return -1;
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const e of entries.slice(a + 1)) {
    const p = e.payload;
    if (p.type === 'tool_use' && !calls.has(p.toolUseId)) calls.add(p.toolUseId);
    else if (p.type === 'tool_result' && calls.has(p.toolUseId) && !answered.has(p.toolUseId)) answered.add(p.toolUseId);
    else return -1;
  }
  return calls.size > 0 && answered.size === calls.size ? a : -1;
}

/** Past rounds as plain text: assistant text, then each call and its result as a line. */
function asText(entries: JournalEntry[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  const names = new Map<string, string>();
  for (const e of entries) {
    const p = e.payload;
    if (p.type === 'assistant') {
      out.push(withPayload(e, { type: 'assistant', blocks: p.blocks.filter((b) => b.type === 'text' && b.text !== '') }));
    } else if (p.type === 'tool_use') {
      names.set(p.toolUseId, p.name);
      const line = textBlock(`[Earlier call: ${p.name} ${clip(JSON.stringify(p.input ?? {}), INPUT_CHARS)}]`);
      const last = out[out.length - 1];
      if (last?.payload.type === 'assistant') last.payload.blocks.push(line);
      else out.push(withPayload(e, { type: 'assistant', blocks: [line] }));
    } else if (p.type === 'tool_result') {
      const name = names.get(p.toolUseId) ?? 'tool';
      const body = clip(resultText(p.blocks), RESULT_HEAD_CHARS, RESULT_TAIL_CHARS) || '(no output)';
      out.push(withPayload(e, { type: 'user', blocks: [textBlock(`[Earlier ${name} ${p.isError ? 'error' : 'result'}: ${body}]`)] }));
    } else {
      out.push(e);
    }
  }
  return out.filter((e) => e.payload.type !== 'assistant' || e.payload.blocks.length > 0);
}

/** The safe view of a projected history (see the module header). PURE. */
export function safeHistoryView(entries: JournalEntry[], textOnly = false): { entries: JournalEntry[]; tailKept: boolean } {
  const tail = textOnly ? -1 : wellFormedToolTail(entries);
  if (tail < 0) return { entries: asText(entries), tailKept: false };
  return { entries: [...asText(entries.slice(0, tail)), ...entries.slice(tail)], tailKept: true };
}

type Started = { stream: AsyncIterable<StreamEvent>; model: string; billedAs?: string };

/**
 * The round's catch for a failed model call (runOneRound): retry ONCE on the safe view
 * when the trigger holds, else rethrow `err` untouched. `call` re-issues the SAME request
 * with a different history (startStreamWithRetry, passed in to keep this module free of
 * a runtime import back into round-engine).
 */
export async function* healRejectedHistory(
  deps: RoundDeps,
  st: RoundState,
  err: unknown,
  rejected: { model: string; history: ProviderHistory; signal?: AbortSignal },
  call: (history: ProviderHistory) => Promise<Started>,
): AsyncGenerator<HarnessEvent, Started, void> {
  const { ctx, cfg, transport } = deps;
  // The request's own signal, and the live one (a steer swaps the scope before aborting the old).
  const stopped = (): boolean => rejected.signal?.aborted === true || cfg.signal?.aborted === true;
  const heal = deps.sub === undefined && cfg.journal && !stopped() ? rejectedHistoryView(err, transport) : null;
  if (!heal || !cfg.journal) throw err;
  const { type, requestId } = rejection(err);
  const fingerprint = Array.isArray(rejected.history)
    ? toolBlockFingerprint(rejected.history as Anthropic.MessageParam[])
    : '';
  const safe = safeHistoryView(wireMessages((await cfg.journal.project()).messages, deps.elision ?? null), heal === 'text_only');
  const view = safe.tailKept ? 'tail_kept' : 'text_only';
  console.error(
    `[history-heal] ${transport.api} rejected the history (${String(type)}, request_id=${String(requestId ?? '?')}); ` +
      `retrying once on the ${view} view; model=${rejected.model} fingerprint=${fingerprint}`,
  );
  const event = (healed: boolean): HarnessEvent => ({
    kind: 'raw',
    engine: 'native',
    event: HISTORY_HEALED_EVENT,
    data: {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      healed,
      view,
      errorType: String(type),
      requestId: typeof requestId === 'string' ? requestId : null,
      api: transport.api,
      model: rejected.model,
      fingerprint: fingerprint.slice(0, 1000),
    },
  });
  let started: Started;
  try {
    started = await call(transport.historyFromJournal(safe.entries));
  } catch (retryErr) {
    if (stopped()) throw retryErr; // a stop during the retry is a stop, not a failed heal
    console.error(`[history-heal] the ${view} view was rejected too; the turn ends as before (task=${ctx.taskId})`);
    yield event(false);
    throw retryErr;
  }
  // One row per turn: every later round of this turn re-derives the same history and heals again.
  if (!st.historyHealReported) {
    st.historyHealReported = true;
    yield event(true);
  }
  return started;
}
