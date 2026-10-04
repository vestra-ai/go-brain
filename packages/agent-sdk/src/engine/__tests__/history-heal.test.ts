/**
 * history-heal — the trigger and the safe view, in isolation. The turn-level behavior
 * (one retry, the log, the event, the bounds) is native-harness.history-heal.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import { classifyAnthropicError } from '../native-termination.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import { HISTORY_HEALED_EVENT, rejectedHistoryView, safeHistoryView } from '../history-heal.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { journalToChatCompletionsMessages } from '../../transports/chat-completions-messages.js';
import { journalToGeminiContents } from '../../transports/gemini-messages.js';

afterEach(() => vi.restoreAllMocks());

const anthropic = { classifyError: (e: unknown) => classifyAnthropicError(e) };
const openai = { classifyError: (e: unknown) => classifyOpenAIResponsesError(e) };
const anthropic400 = (message: string, type = 'invalid_request_error') =>
  AnthropicAPIError.generate(400, { type: 'error', error: { type, message } }, undefined, new Headers({ 'request-id': 'req_1' }));

describe('rejectedHistoryView — the trigger is structural', () => {
  it('heals a 400 invalid_request_error nothing else owns (the 28edef30 rejection) on the safe view', () => {
    expect(rejectedHistoryView(anthropic400('messages.5: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01'), anthropic)).toBe('safe');
    expect(rejectedHistoryView(anthropic400('messages.2.content.0: unexpected `tool_use_id` found in `tool_result` blocks'), anthropic)).toBe('safe');
  });

  it('heals a rejected signed-thinking replay (request_invalid, prod 09-16) on the text-only view', () => {
    const replay = anthropic400('messages.3.content.0: thinking blocks in the latest assistant message cannot be modified');
    expect(classifyAnthropicError(replay).kind).toBe('request_invalid');
    expect(rejectedHistoryView(replay, anthropic)).toBe('text_only');
  });

  it('never heals the 400s native-termination names for other paths (credit, context, image)', () => {
    for (const message of [
      'Your credit balance is too low to access the Anthropic API.',
      'prompt is too long: 250000 tokens > 200000 maximum',
      'messages.1.content.0.image.source.base64: image exceeds 5 MB maximum',
    ]) {
      expect(rejectedHistoryView(anthropic400(message), anthropic)).toBeNull();
    }
  });

  it('never heals without BOTH the status and the typed error', () => {
    expect(rejectedHistoryView(anthropic400('bad', 'not_found_error'), anthropic)).toBeNull();
    const overloaded = AnthropicAPIError.generate(529, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, undefined, new Headers());
    expect(rejectedHistoryView(overloaded, anthropic)).toBeNull();
    expect(rejectedHistoryView(new Error('400 invalid_request_error: tool_use ids were found'), anthropic)).toBeNull();
  });

  it('reads the OpenAI SDK the same way, and leaves its encrypted-reasoning 400 to its own recovery', () => {
    const invalid = OpenAIAPIError.generate(400, { error: { type: 'invalid_request_error', code: null, message: 'No tool output found for function call call_1.' } }, undefined, new Headers());
    expect(rejectedHistoryView(invalid, openai)).toBe('safe');
    const encrypted = OpenAIAPIError.generate(400, { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } }, undefined, new Headers());
    expect(rejectedHistoryView(encrypted, openai)).toBeNull();
  });
});

// ── the safe view ─────────────────────────────────────────────────────────────

let seq = 0;
const e = (payload: JournalPayload): JournalEntry =>
  ({
    uuid: `e${seq}`, parentUuid: null, seq: seq++, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
    agentId: 'g', principal: { kind: 'system' }, timestamp: '', payload,
  }) as unknown as JournalEntry;
const text = (t: string) => [{ type: 'text', text: t } as never];
const P = {
  user: (t: string) => e({ type: 'user', blocks: text(t) }),
  assistant: (t: string) => e({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'hm', signature: 'sig' } as never, ...text(t)] }),
  use: (id: string, name = 'Bash') => e({ type: 'tool_use', toolUseId: id, name, input: { command: `echo ${id}` } }),
  result: (id: string, t = `out ${id}`) => e({ type: 'tool_result', toolUseId: id, blocks: text(t), isError: false }),
};

const toolBlocks = (msgs: Anthropic.MessageParam[]) =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use' || b.type === 'tool_result');

describe('safeHistoryView', () => {
  it('renders past tool rounds as text and keeps the latest, well-formed tool round structured', () => {
    const history = [
      P.user('tidy the folder'), P.assistant('looking'), P.use('a'), P.result('a'),
      P.user('now the renders'), P.assistant('deleting'), P.use('b'), P.use('c'), P.result('c'), P.result('b'),
    ];
    const safe = safeHistoryView(history);
    expect(safe.tailKept).toBe(true);
    const msgs = journalToAnthropicMessages(safe.entries);
    const ids = toolBlocks(msgs).map((b) => (b.type === 'tool_use' ? `use:${b.id}` : `result:${(b as Anthropic.ToolResultBlockParam).tool_use_id}`));
    expect(ids).toEqual(['use:b', 'use:c', 'result:c', 'result:b']);
    const flat = JSON.stringify(msgs);
    expect(flat).toContain('[Earlier call: Bash {\\"command\\":\\"echo a\\"}]');
    expect(flat).toContain('[Earlier Bash result: out a]');
    // The past's thinking (and its signature) is gone: nothing signed can be rejected there.
    expect(msgs.slice(0, 3).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking'))).toBe(false);
  });

  it('text-only on request renders even a well-formed latest round as text', () => {
    const history = [P.user('tidy'), P.assistant('deleting'), P.use('b'), P.result('b')];
    expect(safeHistoryView(history).tailKept).toBe(true);
    const safe = safeHistoryView(history, true);
    expect(safe.tailKept).toBe(false);
    expect(toolBlocks(journalToAnthropicMessages(safe.entries))).toEqual([]);
  });

  it('goes fully text-only when the tail itself is the problem (the pre-#3930 28edef30 shape)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The shape the projection sent before #3930: the breadcrumb between tu3 and its result.
    const history = [
      P.user('make a showreel'), P.assistant('checking the music'), P.use('tu3'),
      P.user('[System] The connection for the earlier Bash request is now available.'), P.result('tu3', 'bands printed'),
    ];
    const safe = safeHistoryView(history);
    expect(safe.tailKept).toBe(false);
    const msgs = journalToAnthropicMessages(safe.entries);
    expect(toolBlocks(msgs)).toEqual([]);
    expect(JSON.stringify(msgs)).toContain('bands printed');
    // Nothing for the floor to repair, on any lane.
    expect(err).not.toHaveBeenCalled();
    expect(journalToChatCompletionsMessages(safe.entries).some((m) => m.role === 'tool')).toBe(false);
    expect(journalToGeminiContents(safe.entries).flatMap((c) => c.parts).some((p) => p.functionCall || p.functionResponse)).toBe(false);
  });

  it('a history that ends in a user turn is text-only past plus that turn, alternating cleanly', () => {
    const safe = safeHistoryView([P.user('go'), P.assistant('ok'), P.use('a'), P.result('a'), P.assistant('done'), P.user('next')]);
    expect(safe.tailKept).toBe(false);
    const msgs = journalToAnthropicMessages(safe.entries);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[msgs.length - 1].content).toBe('next');
  });

  it('clips a long result at both ends, so a fenced untrusted result keeps its closing marker', () => {
    const body = `<untrusted_content>\n${'x'.repeat(20_000)}\n</untrusted_content>`;
    const safe = safeHistoryView([P.user('read it'), P.assistant('reading'), P.use('a', 'web_fetch'), P.result('a', body), P.user('summarize')]);
    const rendered = JSON.stringify(journalToAnthropicMessages(safe.entries));
    expect(rendered).toContain('<untrusted_content>');
    expect(rendered).toContain('</untrusted_content>');
    expect(rendered.length).toBeLessThan(4_000);
  });

  it('is pure: the projected entries it was given are untouched', () => {
    const history = [P.user('go'), P.assistant('ok'), P.use('a'), P.result('a'), P.user('next')];
    const before = JSON.stringify(history);
    safeHistoryView(history);
    expect(JSON.stringify(history)).toBe(before);
  });
});

describe('HISTORY_HEALED_EVENT', () => {
  it('is the literal @bash/shared registers as EVENTS.AGENT_HISTORY_HEALED', () => {
    expect(HISTORY_HEALED_EVENT).toBe('agent:history_healed');
  });
});
