/**
 * Regression: an OpenAI Responses turn that FAILS must surface as a thrown,
 * classifiable error — never as a silent empty `done`.
 *
 * The live bug: gpt-5.5 on the native harness produced NO response and NO error
 * ($0 billed, a clean "completed" turn). Root cause — OpenAI can end a turn with a
 * `response.failed` / top-level `error` SSE event (the credential proxy surfaces an
 * upstream `insufficient_quota` this way) OR drain with no terminal event at all.
 * The accumulator only knew `response.completed`, so `final()` was null and
 * readStream fabricated `done` with `usage:{0,0}`. The harness then treated it as a
 * normal empty completion and the terminal-reason UI (which only renders ERROR
 * outcomes) showed nothing.
 *
 * Fix: the accumulator captures failure events; readStream re-throws a classifiable
 * error when a failure was seen OR no terminal event arrived; classifyError maps the
 * thrown error (whose http status is ABSENT on the stream-event path) by `code`.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { classifyOpenAIResponsesError } from '../openai-responses-termination.js';
import type { StreamEvent } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Drain until the iterable throws; return what was yielded plus the thrown error. */
async function drainUntilThrow(
  it: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const e of it) events.push(e);
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

const t = () => new OpenAIResponsesTransport({ client: {} as unknown as OpenAI });

describe('OpenAIResponsesTransport.readStream — failure surfacing', () => {
  it('throws (carrying code) on a response.failed event with insufficient_quota', async () => {
    function* failed(): Generator<Ev> {
      yield { type: 'response.created', response: {} } as unknown as Ev;
      yield {
        type: 'response.failed',
        response: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } },
      } as unknown as Ev;
    }
    const { error } = await drainUntilThrow(t().readStream(failed()));
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe('insufficient_quota');
    // …and it classifies to a billing_error the UI can render.
    expect(classifyOpenAIResponsesError(error).kind).toBe('billing_error');
  });

  it('throws on a top-level error event (rate_limit_exceeded → rate_limited)', async () => {
    function* errored(): Generator<Ev> {
      yield {
        type: 'error',
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached',
        param: null,
        sequence_number: 1,
      } as unknown as Ev;
    }
    const { error } = await drainUntilThrow(t().readStream(errored()));
    expect(error).toBeInstanceOf(Error);
    expect(classifyOpenAIResponsesError(error).kind).toBe('rate_limited');
  });

  it('throws when the stream drains with NO terminal event (never a silent empty done)', async () => {
    function* truncated(): Generator<Ev> {
      yield { type: 'response.created', response: {} } as unknown as Ev;
      yield { type: 'response.output_text.delta', delta: 'partial' } as unknown as Ev;
      // …connection dies — no response.completed / .incomplete / .failed.
    }
    const { events, error } = await drainUntilThrow(t().readStream(truncated()));
    // The live text still streamed (so the user sees the partial)…
    expect(events).toContainEqual({ kind: 'text', text: 'partial' });
    // …but the abnormal end is a thrown model_error, NOT a fabricated done.
    expect(events.find((e) => e.kind === 'done')).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(classifyOpenAIResponsesError(error).kind).toBe('model_error');
  });

  it('does NOT throw on response.incomplete (a clean partial → done with stopReason)', async () => {
    function* incomplete(): Generator<Ev> {
      yield { type: 'response.output_text.delta', delta: 'half an answer' } as unknown as Ev;
      yield {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 12, output_tokens: 99 },
        },
      } as unknown as Ev;
    }
    const events = await drain(t().readStream(incomplete()));
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect((done as Extract<StreamEvent, { kind: 'done' }>).stopReason).toBe('max_output_tokens');
    expect((done as Extract<StreamEvent, { kind: 'done' }>).usage.outputTokens).toBe(99);
  });

  it('still emits a normal done on a clean response.completed turn (no regression)', async () => {
    function* ok(): Generator<Ev> {
      yield { type: 'response.output_text.delta', delta: 'hello' } as unknown as Ev;
      yield {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } },
      } as unknown as Ev;
    }
    const events = await drain(t().readStream(ok()));
    expect(events).toContainEqual({ kind: 'text', text: 'hello' });
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect((done as Extract<StreamEvent, { kind: 'done' }>).stopReason).toBe('completed');
  });
});

describe('classifyOpenAIResponsesError — code-based quota/rate (status may be absent)', () => {
  it('maps insufficient_quota → billing_error even when http status is undefined', () => {
    // The real thrown OpenAI quota APIError arrives with status=undefined (verified live).
    const out = classifyOpenAIResponsesError({ code: 'insufficient_quota', message: 'quota' });
    expect(out.kind).toBe('billing_error');
  });

  it('maps rate_limit_exceeded → rate_limited even when http status is undefined', () => {
    const out = classifyOpenAIResponsesError({ code: 'rate_limit_exceeded', message: 'slow down' });
    expect(out.kind).toBe('rate_limited');
  });

  it('still honors a thrown 401 → auth_error', () => {
    expect(classifyOpenAIResponsesError({ status: 401, message: 'bad key' }).kind).toBe('auth_error');
  });
});
