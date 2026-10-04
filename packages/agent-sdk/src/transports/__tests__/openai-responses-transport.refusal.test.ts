/**
 * Regression: a SOFT REFUSAL from gpt (the OpenAI Responses arm) must surface as
 * a visible `kind:'refused'` carrying the refusal text — never as a BLANK,
 * success-shaped, billed bubble.
 *
 * The live bug: a soft refusal arrives as a `ResponseOutputRefusal` content part
 * streamed via `response.refusal.delta` / `response.refusal.done`, on a
 * `response.completed` (status='completed'). The accumulator had NO case for
 * those events → `textBuf` stayed '' and `stopReason='completed'`. Downstream the
 * turn rendered as an empty success and the structured-output epilogue looped
 * `JSON.parse('')` 3× (triple-billed).
 *
 * Fix: the accumulator captures the refusal text into a `refusalBuf`, flips
 * `stopReason='refusal'` on completion, exposes the refusal text; the termination
 * classifier maps `stopReason='refusal' → kind:'refused'` carrying that text
 * (mirroring the Anthropic arm's native-termination.ts); and readStream yields a
 * synthetic TEXT block carrying the refusal text so the user SEES it live.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import {
  createOpenAIResponsesAccumulator,
  type ResponsesAccumulator,
} from '../openai-responses-messages.js';
import { classifyOpenAIResponsesTermination } from '../openai-responses-termination.js';
import type { StreamEvent } from '../../engine/transport.js';
import type { ModelUsageSummary } from '../../contract/turn-outcome.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function feed(acc: ResponsesAccumulator, events: Ev[]): void {
  for (const ev of events) acc.onEvent(ev);
}

const t = () => new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });

const EMPTY_USAGE: ModelUsageSummary = {} as ModelUsageSummary;

describe('OpenAIResponsesAccumulator — refusal capture', () => {
  it('captures refusal.delta×N + refusal.done → stopReason=refusal with concatenated text (NOT empty-completed)', () => {
    const acc = createOpenAIResponsesAccumulator();
    feed(acc, [
      { type: 'response.refusal.delta', delta: "I'm sorry, " } as unknown as Ev,
      { type: 'response.refusal.delta', delta: 'I cannot help with that.' } as unknown as Ev,
      { type: 'response.refusal.done', refusal: "I'm sorry, I cannot help with that." } as unknown as Ev,
      {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 5, output_tokens: 4 } },
      } as unknown as Ev,
    ]);
    const final = acc.final();
    expect(final).not.toBeNull();
    expect(final!.stopReason).toBe('refusal');
    // The accumulator exposes the refusal text on its public surface.
    expect(acc.refusal()).toBe("I'm sorry, I cannot help with that.");
    // Plain assistant text stays empty (the refusal is NOT assistant text).
    expect(acc.text()).toBe('');
  });

  it('belt-and-suspenders: an output_item.done message carrying a {type:"refusal"} part (no delta events) is still captured', () => {
    const acc = createOpenAIResponsesAccumulator();
    feed(acc, [
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'Refused via the item part.' }],
        },
      } as unknown as Ev,
      {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 2, output_tokens: 1 } },
      } as unknown as Ev,
    ]);
    const final = acc.final();
    expect(final!.stopReason).toBe('refusal');
    expect(acc.refusal()).toBe('Refused via the item part.');
  });

  it('a normal completion (no refusal) keeps stopReason=completed and empty refusal (no regression)', () => {
    const acc = createOpenAIResponsesAccumulator();
    feed(acc, [
      { type: 'response.output_text.delta', delta: 'hello' } as unknown as Ev,
      {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 3, output_tokens: 2 } },
      } as unknown as Ev,
    ]);
    expect(acc.final()!.stopReason).toBe('completed');
    expect(acc.refusal()).toBe('');
    expect(acc.text()).toBe('hello');
  });
});

describe('classifyOpenAIResponsesTermination — refusal', () => {
  it('stopReason=refusal → kind:refused carrying the refusal text (not completed)', () => {
    const out = classifyOpenAIResponsesTermination({
      stopReason: 'refusal',
      costUsd: 0.01,
      numTurns: 1,
      durationMs: 10,
      modelUsage: EMPTY_USAGE,
      summaryText: "I'm sorry, I cannot help with that.",
    });
    expect(out.kind).toBe('refused');
    expect((out as Extract<typeof out, { kind: 'refused' }>).text).toBe(
      "I'm sorry, I cannot help with that.",
    );
  });

  it('still maps content_filter → refused (pre-existing behavior unchanged)', () => {
    const out = classifyOpenAIResponsesTermination({
      stopReason: 'content_filter',
      costUsd: 0,
      numTurns: 1,
      durationMs: 1,
      modelUsage: EMPTY_USAGE,
      summaryText: 'blocked',
    });
    expect(out.kind).toBe('refused');
  });
});

describe('OpenAIResponsesTransport.readStream — refusal renders as a live text block', () => {
  it('yields a synthetic text block carrying the refusal text + a done(stopReason=refusal)', async () => {
    function* refused(): Generator<Ev> {
      yield { type: 'response.refusal.delta', delta: 'I will not ' } as unknown as Ev;
      yield { type: 'response.refusal.delta', delta: 'do that.' } as unknown as Ev;
      yield { type: 'response.refusal.done', refusal: 'I will not do that.' } as unknown as Ev;
      yield {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 6, output_tokens: 3 } },
      } as unknown as Ev;
    }
    const events = await drain(t().readStream(refused()));
    // The user SEES the refusal: it streams live as text deltas (same wiring as
    // ordinary assistant text) whose concatenation is the full refusal text.
    const streamedText = events
      .filter((e): e is Extract<StreamEvent, { kind: 'text' }> => e.kind === 'text')
      .map((e) => e.text)
      .join('');
    expect(streamedText).toBe('I will not do that.');
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect((done as Extract<StreamEvent, { kind: 'done' }>).stopReason).toBe('refusal');
  });

  it('belt-and-suspenders: a refusal arriving ONLY on output_item.done is emitted as one synthetic text block', async () => {
    function* refusedNoDeltas(): Generator<Ev> {
      yield {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'Refused, no deltas streamed.' }],
        },
      } as unknown as Ev;
      yield {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 2, output_tokens: 1 } },
      } as unknown as Ev;
    }
    const events = await drain(t().readStream(refusedNoDeltas()));
    expect(events).toContainEqual({ kind: 'text', text: 'Refused, no deltas streamed.' });
    const done = events.find((e) => e.kind === 'done');
    expect((done as Extract<StreamEvent, { kind: 'done' }>).stopReason).toBe('refusal');
  });

  it('does NOT emit a refusal text block on a normal completion', async () => {
    function* ok(): Generator<Ev> {
      yield { type: 'response.output_text.delta', delta: 'hi' } as unknown as Ev;
      yield {
        type: 'response.completed',
        response: { status: 'completed', incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
      } as unknown as Ev;
    }
    const events = await drain(t().readStream(ok()));
    expect(events).toContainEqual({ kind: 'text', text: 'hi' });
    const done = events.find((e) => e.kind === 'done');
    expect((done as Extract<StreamEvent, { kind: 'done' }>).stopReason).toBe('completed');
  });
});
