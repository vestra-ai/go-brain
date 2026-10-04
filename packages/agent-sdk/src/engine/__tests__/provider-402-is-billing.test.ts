/**
 * A provider 402 is billing on EVERY lane, end to end (staging 2026-10-01).
 *
 * The Gemini key ran dry at 10:10Z: Google answered HTTP 402 with the body status
 * RESOURCE_EXHAUSTED, the error authority read the code before the status, and the
 * turn classified rate_limited, was retried six times (RETRY_BY_CAUSE_V1's rate-limit
 * budget), and told the person "Service is busy, try again shortly" (tasks 59284c91,
 * 65ec2807). A dead key is not busy: no retry fixes it.
 *
 * Each lane is driven through its REAL request path: the real SDK client (Anthropic,
 * OpenAI Responses, Chat Completions for Fireworks) or the real hand-rolled fetch
 * (both Gemini transports), with only the network replaced by a canned Response. Then
 * the real retry boundary (startStreamWithRetry, the flag ON as on staging and OFF),
 * the lane's own classifier (the one the terminal catch calls), and the contract's
 * words for the person (terminalReasonFor). The control on every lane: a 429 is still
 * a rate limit, retried, and still says "busy".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { startStreamWithRetry } from '../round-engine.js';
import { retryCause } from '../error-authority.js';
import { terminalReasonFor } from '../../contract/terminal-reason.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';
import type { Transport } from '../transport.js';

const FLAG = 'RETRY_BY_CAUSE_V1';

afterEach(() => {
  delete process.env[FLAG];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = { 'content-type': 'application/json' };

/** The bodies each provider sends. Google's 402 is the one that arrived on 10-01. */
const BODY = {
  anthropic: {
    402: { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    429: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } },
  },
  openai: {
    // A 402 carrying a code the table maps elsewhere: the status must still win.
    402: { error: { message: 'Payment required', type: 'requests', param: null, code: 'rate_limit_exceeded' } },
    429: { error: { message: 'Rate limit reached for requests', type: 'requests', param: null, code: 'rate_limit_exceeded' } },
  },
  fireworks: {
    402: { error: { object: 'error', type: 'invalid_request_error', message: 'Account is suspended, possibly due to reaching the monthly spending limit.' } },
    429: { error: { object: 'error', type: 'invalid_request_error', message: 'You have exceeded your requests per minute rate limit' } },
  },
  google: {
    402: { error: { code: 402, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your billing.', status: 'RESOURCE_EXHAUSTED' } },
    429: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } },
  },
} as const;

type Status = 402 | 429;

/** A fetch that answers every request with `status` and the lane's body, counting calls. */
function cannedFetch(body: unknown, status: Status) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: json }));
}

interface Lane {
  name: string;
  model: string;
  /** Build the lane's transport over a fetch that answers with `status`. */
  make: (status: Status) => { transport: Transport; calls: () => number };
}

const LANES: Lane[] = [
  {
    name: 'anthropic (Messages, real SDK client)',
    model: 'claude-sonnet-5-5',
    make: (status) => {
      const fetch = cannedFetch(BODY.anthropic[status], status);
      const client = new Anthropic({ apiKey: 'k', maxRetries: 0, fetch: fetch as never });
      return { transport: new AnthropicMessagesTransport({ client }), calls: () => fetch.mock.calls.length };
    },
  },
  {
    name: 'openai (Responses, real SDK client)',
    model: 'gpt-6.1-sol',
    make: (status) => {
      const fetch = cannedFetch(BODY.openai[status], status);
      const client = new OpenAI({ apiKey: 'k', maxRetries: 0, fetch: fetch as never });
      return { transport: new OpenAIResponsesTransport({ client }), calls: () => fetch.mock.calls.length };
    },
  },
  {
    name: 'fireworks (Chat Completions, real SDK client)',
    model: 'deepseek-v4-pro',
    make: (status) => {
      const fetch = cannedFetch(BODY.fireworks[status], status);
      const client = new OpenAI({ apiKey: 'k', maxRetries: 0, fetch: fetch as never });
      return { transport: new ChatCompletionsTransport({ client }), calls: () => fetch.mock.calls.length };
    },
  },
  {
    name: 'gemini (generateContent, real fetch path)',
    model: 'gemini-3.8-flash',
    make: (status) => {
      vi.stubEnv('GEMINI_API_KEY', 'k');
      const fetch = cannedFetch(BODY.google[status], status);
      vi.stubGlobal('fetch', fetch);
      return { transport: new GeminiTransport(), calls: () => fetch.mock.calls.length };
    },
  },
  {
    name: 'gemini (Interactions, real fetch path)',
    model: 'gemini-3.8-flash',
    make: (status) => {
      vi.stubEnv('GEMINI_API_KEY', 'k');
      const fetch = cannedFetch(BODY.google[status], status);
      vi.stubGlobal('fetch', fetch);
      return { transport: new GeminiInteractionsTransport(), calls: () => fetch.mock.calls.length };
    },
  },
];

function paramsFor(t: Transport, model: string) {
  const history = t.emptyHistory();
  t.pushUser(history, 'hi');
  return { model, maxTokens: 64, system: 'sys', tools: [], history };
}

/** Run the real retry boundary to its end; return the error it rethrew (what the terminal catch classifies). */
async function failedRound(lane: Lane, status: Status, fallbackModel?: string) {
  // Every backoff the loop asks for (capped at 30 s) fires at once, asserted by count rather
  // than slept through. Longer timers (an SDK's request timeout) keep their real delay.
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
    real(fn, (ms ?? 0) <= 30_000 ? 0 : ms)) as typeof setTimeout);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { transport, calls } = lane.make(status);
  let err: unknown;
  try {
    await startStreamWithRetry(paramsFor(transport, lane.model), transport, fallbackModel ? { retry: { fallbackModel } } : {});
  } catch (e) {
    err = e;
  }
  expect(err, `${lane.name}: the round should fail`).toBeDefined();
  return { transport, err, calls: calls() };
}

describe.each(LANES.map((l) => [l.name, l] as const))('%s', (_name, lane) => {
  it.each([true, false])('a 402 is billing: one call, no retry, no fallback, and the person is told it is out of credit (RETRY_BY_CAUSE_V1=%s)', async (on) => {
    if (on) process.env[FLAG] = 'true';
    const { transport, err, calls } = await failedRound(lane, 402, 'some-other-model');
    // ONE request reached the provider: no retry, and the fallback model never ran.
    expect(calls).toBe(1);
    const outcome = transport.classifyError(err);
    expect(outcome.kind).toBe('billing_error');
    expect(outcome.raw.api_error_status).toBe(402);
    expect(retryCause(outcome, err)).toBe('usage_limit');
    const { status, label } = terminalReasonFor(outcome);
    expect(status).toBe('failed');
    expect(label).toMatch(/out of credit on our side/i);
    expect(label).toMatch(/team has been alerted/i);
    expect(label).toMatch(/another model/i);
    expect(label).not.toMatch(/busy/i);
  });

  it('the control: a 429 is still a rate limit, retried, and still says busy', async () => {
    process.env[FLAG] = 'true';
    const { transport, err, calls } = await failedRound(lane, 429);
    expect(calls).toBeGreaterThan(1);
    const outcome = transport.classifyError(err);
    expect(outcome.kind).toBe('rate_limited');
    expect(retryCause(outcome, err)).toBe('rate_limit');
    expect(terminalReasonFor(outcome).label).toBe('Service is busy, try again shortly');
  });
});

describe("the person's words for a billing failure", () => {
  const ours = terminalReasonFor({ kind: 'billing_error', raw: { subtype: 'billing', errors: [], api_error_status: 402 } }).label;

  it('ours: honest and plain (no dash, never the vendor name, never "busy")', () => {
    expect(ours).not.toMatch(/[–—]/);
    expect(ours).not.toMatch(/claude/i);
    expect(ours).not.toMatch(/busy/i);
  });

  it("the person's own plan (typed owner 'person'): the engine's sentence wins", () => {
    const theirs = 'Your Claude account needs attention. Open claude.ai to fix it, then try again.';
    const view = terminalReasonFor({ kind: 'billing_error', owner: 'person', message: theirs, raw: { subtype: 'billing', errors: [] } });
    expect(view.label).toBe(theirs);
    expect(view.status).toBe('failed');
  });

  // Review #4128: whose account it is is TYPED, never read off whether prose is present.
  // A provider sentence riding our own failure must not flip the copy to "your plan".
  it('a message with no owner is still OURS: our copy, never the provider prose', () => {
    const view = terminalReasonFor({ kind: 'billing_error', message: 'Your prepayment credits are depleted.', raw: { subtype: 'billing', errors: [] } });
    expect(view.label).toBe(ours);
  });
});
