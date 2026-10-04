/**
 * The Gemini Interactions SSE accumulator. Steps arrive by `index`: step.start
 * opens one, step.delta appends to it, step.stop closes it; interaction.completed
 * carries the status + usage. Function-call arguments stream as JSON STRING
 * fragments (`arguments_delta`) — concatenated and parsed once at close.
 *
 * Two outputs: LIVE signals (thinking_start / thinking / text, yielded as they
 * arrive) and the CAPTURED turn (the steps verbatim for the replay channel, the
 * calls for `tool_use`, the terminal stop/usage).
 *
 * SEALED capture: the stream's `interaction.completed` carries no steps (probed
 * 2026-09-23 — status + usage only), so the provider's turn IS its step events:
 * each step is the `step.start` object exactly as sent with its deltas folded in
 * (a signature set, text/summary fragments appended, argument fragments parsed),
 * kept in INDEX order, on every round, whatever its type. Nothing is gated on a
 * shape we expect: an unsigned thought, a non-text output item, a step type this
 * SDK has never seen all go back as they came.
 */
import type { GeminiWireStep } from '../contract/journal.js';
import type { NormalizedUsage, StreamEvent } from '../engine/transport.js';
import { readyToolArgs, type ReadyToolUse } from '../engine/tool-ready.js';
import { normalizeGeminiInteractionsUsage } from './gemini-interactions-messages.js';
import type { GeminiInteractionsEvent, GeminiInteractionsUsage } from './gemini-interactions-wire.js';

export interface CapturedGeminiCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface GeminiInteractionsAccumulator {
  /** Fold one event; returns the live signals to yield. THROWS on an `error` event. */
  onEvent(ev: GeminiInteractionsEvent): StreamEvent[];
  /** Every function_call of the turn, in order, args parsed. */
  calls(): CapturedGeminiCall[];
  /**
   * L1 (TOOLS_MIDSTREAM_V1) — the function_call steps CLOSED since the last call (their
   * `step.stop` arrived, or the terminal event closed them), drained in call order even
   * when stops land out of order; an unreadable one (tool-ready.ts; no argument fragments
   * reads the start step's own arguments) carries input undefined.
   */
  takeReady(): ReadyToolUse[];
  /** The turn's steps verbatim, in index order; undefined when no step arrived. */
  steps(): GeminiWireStep[] | undefined;
  /** The terminal stop + usage, null if no terminal event arrived. THROWS on `failed`
   *  and on a non-refusal step error. */
  final(): { stopReason: string | null; usage: NormalizedUsage } | null;
}

/** A step being assembled: the wire step itself, plus a function call's argument buffer. */
interface OpenStep {
  step: GeminiWireStep;
  buf: string;
}

type StepError = { code?: number | string; message?: string };

function codedError(message: string, code?: string | number): Error {
  return Object.assign(new Error(message), code !== undefined ? { code: String(code).toUpperCase() } : {});
}

function parseArgs(buf: string, fallback: Record<string, unknown>, name: string): Record<string, unknown> {
  if (buf.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(buf);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    console.warn(`[GeminiInteractions] malformed arguments for ${name}: ${buf.slice(0, 200)}`);
    return {};
  }
}

const REFUSAL_WORDING = /safety|blocked|prohibited|recitation/i;

/**
 * The four fields `normalizeGeminiInteractionsUsage` actually reads. A usage object
 * carrying none of them normalizes to all-zeros, so it is TOKEN-LESS for billing no
 * matter what else it holds (a bare `total_tokens` included) — which is why the
 * terminal event's usage may only WIN over the delta fallback when it carries one.
 */
function hasTokenCounts(u: GeminiInteractionsUsage | undefined): u is GeminiInteractionsUsage {
  if (!u) return false;
  return (
    typeof u.total_input_tokens === 'number' ||
    typeof u.total_output_tokens === 'number' ||
    typeof u.total_cached_tokens === 'number' ||
    typeof u.total_thought_tokens === 'number'
  );
}

export function createGeminiInteractionsAccumulator(): GeminiInteractionsAccumulator {
  const open = new Map<number, OpenStep>();
  // Every step by its index — the provider's order, whatever order the stops land in.
  const byIndex = new Map<number, GeminiWireStep>();
  let stepError: StepError | undefined;
  let usage: GeminiInteractionsUsage | undefined;
  let lastTotalUsage: GeminiInteractionsUsage | undefined;
  let status: string | undefined;
  let errors: Array<{ code?: string; message?: string }> | undefined;
  let sawTerminal = false;
  // L1 — closed calls not yet handed to the transport, in call order. Stops may land out of
  // index order, so a closed call waits (in `closedCalls`) until every earlier call has
  // closed: the early starts must see the calls in the order the batch will run them.
  let ready: ReadyToolUse[] = [];
  const callIndexes: number[] = [];
  const closedCalls = new Map<number, ReadyToolUse>();
  let reportedCalls = 0;

  function close(index: number): void {
    const s = open.get(index);
    if (!s) return;
    open.delete(index);
    if (s.step.type === 'function_call') {
      const fallback = (s.step.arguments as Record<string, unknown> | undefined) ?? {};
      const readyInput = s.buf.trim() === '' ? fallback : readyToolArgs(s.buf);
      s.step.arguments = parseArgs(s.buf, fallback, String(s.step.name));
      // Every closed call is reported, an unreadable one with input undefined.
      closedCalls.set(index, { id: String(s.step.id), name: String(s.step.name), input: readyInput });
      while (reportedCalls < callIndexes.length && closedCalls.has(callIndexes[reportedCalls])) {
        ready.push(closedCalls.get(callIndexes[reportedCalls])!);
        reportedCalls++;
      }
    }
  }

  /** Append a text fragment to the last text item of `list` (or open one). */
  function appendText(list: unknown[], text: string): void {
    const last = list[list.length - 1] as { type?: unknown; text?: unknown } | undefined;
    if (last && last.type === 'text' && typeof last.text === 'string') last.text += text;
    else list.push({ type: 'text', text });
  }

  function onEvent(ev: GeminiInteractionsEvent): StreamEvent[] {
    switch (ev.event_type) {
      case 'step.start': {
        const e = ev as Extract<GeminiInteractionsEvent, { event_type: 'step.start' }>;
        // The step as sent (a copy: the fold below writes into it).
        const step = structuredClone(e.step) as GeminiWireStep;
        open.set(e.index, { step, buf: '' });
        byIndex.set(e.index, step);
        if (step.type === 'function_call') {
          callIndexes.push(e.index);
          callIndexes.sort((a, b) => a - b);
        }
        if (step.type === 'model_output' && step.error) stepError = step.error as StepError;
        return step.type === 'thought' ? [{ kind: 'thinking_start' }] : [];
      }
      case 'step.delta': {
        const e = ev as Extract<GeminiInteractionsEvent, { event_type: 'step.delta' }>;
        if (e.metadata?.total_usage) lastTotalUsage = e.metadata.total_usage;
        const s = open.get(e.index);
        const d = e.delta as { type: string; [k: string]: unknown };
        if (!s) return [];
        const step = s.step;
        if (d.type === 'thought_signature') {
          if (typeof d.signature === 'string') step.signature = d.signature;
          return [];
        }
        if (d.type === 'thought_summary') {
          const item = d.content as { type?: unknown; text?: unknown } | undefined;
          const summary = Array.isArray(step.summary) ? (step.summary as unknown[]) : (step.summary = [] as unknown[]);
          if (item && item.type === 'text' && typeof item.text === 'string') {
            appendText(summary, item.text);
            return step.type === 'thought' && item.text ? [{ kind: 'thinking', text: item.text }] : [];
          }
          if (item) summary.push(structuredClone(item));
          return [];
        }
        if (d.type === 'arguments_delta') {
          if (typeof d.arguments === 'string') s.buf += d.arguments;
          return [];
        }
        if (step.type === 'model_output' && !Array.isArray(step.content)) step.content = [];
        if (Array.isArray(step.content)) {
          // An output item: text fragments extend the open text item; any other
          // kind (an image, audio …) is an item of its own, kept whole.
          const content = step.content as unknown[];
          if (d.type === 'text' && typeof d.text === 'string') {
            appendText(content, d.text);
            return step.type === 'model_output' && d.text ? [{ kind: 'text', text: d.text }] : [];
          }
          content.push(structuredClone(d));
          return [];
        }
        // A delta kind this SDK does not model on a step it may not model either:
        // its fields land on the step as sent, never dropped.
        const { type: _t, ...fields } = d;
        Object.assign(step, structuredClone(fields));
        return [];
      }
      case 'step.stop': {
        close((ev as Extract<GeminiInteractionsEvent, { event_type: 'step.stop' }>).index);
        return [];
      }
      case 'interaction.completed': {
        const e = ev as Extract<GeminiInteractionsEvent, { event_type: 'interaction.completed' }>;
        for (const index of [...open.keys()].sort((a, b) => a - b)) close(index);
        status = e.interaction.status;
        // `?? lastTotalUsage` was nullish-only: a terminal `usage: {}` (a real shape)
        // and a DUPLICATE interaction.completed with no usage both used to shadow the
        // real numbers and bill a streamed turn at $0. Prefer the terminal usage only
        // when it carries token counts, and never overwrite ones already held.
        if (hasTokenCounts(e.interaction.usage)) usage = e.interaction.usage;
        else if (!hasTokenCounts(usage)) usage = lastTotalUsage;
        errors = e.interaction.errors;
        sawTerminal = true;
        return [];
      }
      case 'error': {
        const e = ev as Extract<GeminiInteractionsEvent, { event_type: 'error' }>;
        throw codedError(e.error?.message ?? 'Gemini Interactions stream error', e.error?.code);
      }
      default:
        return []; // interaction.created / status_update / unknown
    }
  }

  function ordered(): GeminiWireStep[] {
    return [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!);
  }

  function calls(): CapturedGeminiCall[] {
    return ordered()
      .filter((s) => s.type === 'function_call')
      .map((s) => ({
        id: String(s.id),
        name: String(s.name),
        input: (s.arguments as Record<string, unknown> | undefined) ?? {},
      }));
  }

  function steps(): GeminiWireStep[] | undefined {
    return byIndex.size > 0 ? ordered() : undefined;
  }

  function final(): { stopReason: string | null; usage: NormalizedUsage } | null {
    if (!sawTerminal) return null;
    if (status === 'failed') {
      const first = errors?.[0];
      throw codedError(first?.message ?? 'Gemini interaction failed', first?.code);
    }
    let stopReason: string | null = null;
    if (status === 'incomplete' || status === 'budget_exceeded') stopReason = 'max_tokens';
    else if (status === 'cancelled') stopReason = 'aborted';
    if (stepError) {
      if (REFUSAL_WORDING.test(stepError.message ?? '')) stopReason = 'refusal';
      else throw codedError(stepError.message ?? 'Gemini model_output error', stepError.code);
    }
    return { stopReason, usage: normalizeGeminiInteractionsUsage(usage ?? {}) };
  }

  function takeReady(): ReadyToolUse[] {
    const out = ready;
    ready = [];
    return out;
  }

  return { onEvent, calls, takeReady, steps, final };
}
