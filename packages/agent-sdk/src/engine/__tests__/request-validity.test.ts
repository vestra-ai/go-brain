import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  ensureValidAnthropicRequest,
  ensureValidOpenAIResponsesRequest,
  preflightOpenAIResponsesInput,
  ensureValidChatCompletionsRequest,
  ensureValidGeminiRequest,
  stripOrphanedGeminiToolParts,
  type GeminiContent,
} from '../request-validity.js';

/**
 * The validity floor (Hermes-inspired): whatever we send to the Anthropic
 * Messages API must be a structurally valid request, no matter what (legal but
 * quirky) sequence the model produced or how the journal stored it. These are
 * the invariants that a re-derived-from-journal history can otherwise violate
 * and 400 on (the model_error class).
 */
describe('ensureValidAnthropicRequest — PR8 orphan-strip + signature demotion', () => {
  it('strips an orphan assistant tool_use with no matching tool_result (cold-resume crash guard)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'tu_orphan', name: 'Read', input: {} }] },
      // No tool_result for tu_orphan (a hard kill before the result was journaled).
    ];
    const out = ensureValidAnthropicRequest(msgs);
    const blocks = out[1].content as Anthropic.ContentBlockParam[];
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    expect(blocks.some((b) => b.type === 'text')).toBe(true); // surviving text kept
  });

  it('strips an orphan user tool_result with no matching tool_use', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ghost', content: 'x' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    // The orphan tool_result is gone; the user turn never becomes empty.
    const userTurn = out.find((m) => m.role === 'user')!;
    const blocks = userTurn.content as Anthropic.ContentBlockParam[];
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false);
    expect((userTurn.content as Anthropic.ContentBlockParam[]).length).toBeGreaterThan(0);
  });

  it('keeps a PAIRED tool_use + tool_result (no strip; byte-identical)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect((out[0].content as Anthropic.ContentBlockParam[]).some((b) => b.type === 'tool_use')).toBe(true);
    expect((out[1].content as Anthropic.ContentBlockParam[]).some((b) => b.type === 'tool_result')).toBe(true);
  });

  it('demotes signed thinking to text when an orphan tool_use is stripped from the turn (gap 12)', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I will read it', signature: 'SIG' },
          { type: 'tool_use', id: 'tu_orphan', name: 'Read', input: {} },
        ],
      },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    const blocks = out[0].content as Anthropic.ContentBlockParam[];
    // The now-dead signed thinking is demoted to text (its signature is invalid after
    // the strip → replaying it 400s "thinking blocks ... cannot be modified").
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && b.text === 'I will read it')).toBe(true);
  });

  it('replaces an assistant turn emptied by the strip with a placeholder', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_orphan', name: 'Read', input: {} }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    const blocks = out[0].content as Anthropic.ContentBlockParam[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].type).toBe('text');
  });
});

describe('ensureValidAnthropicRequest — adjacency floor (the unanswered-tool_use resume 400)', () => {
  /** Provider invariant: every assistant tool_use is answered in the IMMEDIATELY-following user turn. */
  function assertAdjacent(out: Anthropic.MessageParam[]): void {
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
      if (ids.length === 0) continue;
      const next = out[i + 1];
      const answered = new Set(
        next && next.role === 'user' && Array.isArray(next.content)
          ? next.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id)
          : [],
      );
      for (const id of ids) expect(answered.has(id), `tool_use ${id} unanswered in the next turn`).toBe(true);
    }
  }

  it('gathers a present-but-NON-adjacent tool_result into the immediately-following user turn (live task 1067a95b shape)', () => {
    // An assistant turn with two tool_uses; the FIRST (weave) is answered two turns later,
    // an intervening assistant turn separating it from its result. Anthropic 400s
    // "tool_use ... without tool_result immediately after". Content must be preserved.
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 'weave', name: 'Weave', input: {} },
        { type: 'tool_use', id: 'inner', name: 'Bash', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inner', content: 'inner ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'node summary' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'weave', content: 'weave out' },
        { type: 'text', text: '[System] resume' },
      ] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    assertAdjacent(out);
    const flat = JSON.stringify(out);
    expect(flat).toContain('weave out'); // gathered, not stripped — the result content survives
    expect(flat).toContain('inner ok');
  });

  it('multi-pause main-agent shape: a later user breadcrumb before the result still lands adjacently', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'rm', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: '[System] the connection resumed' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rm', content: 'removed' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    assertAdjacent(out);
    expect(JSON.stringify(out)).toContain('removed');
  });

  it('is identity for an already-adjacent (well-formed) transcript', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    assertAdjacent(out);
    expect(out).toEqual(msgs); // no relocation on a well-formed history
  });
});

describe('ensureValidAnthropicRequest', () => {
  it('merges consecutive tool_result user messages into one user message', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tools' },
          { type: 'tool_use', id: 'a', name: 'x', input: {} },
          { type: 'tool_use', id: 'b', name: 'y', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ra' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'rb' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect(out).toHaveLength(2);
    const results = out[1].content as Anthropic.ContentBlockParam[];
    expect(results.map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id)).toEqual(['a', 'b']);
  });

  // PR1 (empty-output recovery): a turn that ends in an exhausted empty recovery
  // leaves a trailing user-role entry (the prompt, or a tool_result) and the NEXT
  // user turn then lands adjacent → two consecutive user messages, which the
  // Messages API 400s on ("roles must alternate"). The floor must merge ANY
  // consecutive user turns, not only tool_result-only ones.
  it('merges two consecutive PLAIN user turns into one (recovery give-up + next turn)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'first prompt' },
      { role: 'user', content: 'second prompt' },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    const blocks = out[0].content as Anthropic.ContentBlockParam[];
    expect(blocks.map((b) => (b as Anthropic.TextBlockParam).text)).toEqual(['first prompt', 'second prompt']);
  });

  it('merges a trailing tool_result user turn with a following plain user turn (post-tool give-up)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ra' }] },
      { role: 'user', content: 'next user message' },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('user');
    const blocks = out[1].content as Anthropic.ContentBlockParam[];
    expect(blocks[0].type).toBe('tool_result');
    expect((blocks[1] as Anthropic.TextBlockParam).text).toBe('next user message');
    // No two consecutive same-role messages remain.
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
  });

  it('replaces empty assistant content with a non-empty placeholder', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'assistant', content: [] }];
    const out = ensureValidAnthropicRequest(msgs);
    expect(out[0].content).toEqual([{ type: 'text', text: '(no content)' }]);
  });

  it('replaces empty tool_result content with a non-empty placeholder', () => {
    // PR8: paired with its tool_use so the orphan-strip leaves it; the empty content
    // still gets the placeholder.
    const msgs: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    const userTurn = out.find((m) => m.role === 'user')!;
    const block = (userTurn.content as Anthropic.ContentBlockParam[])[0] as Anthropic.ToolResultBlockParam;
    expect(block.content).toBe('(no output)');
  });

  it('drops empty text blocks but keeps the rest of the message', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'a', name: 'x', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    const blocks = out[0].content as Anthropic.ContentBlockParam[];
    expect(blocks.some((b) => b.type === 'text')).toBe(false);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('orders thinking blocks before text and tool_use within an assistant message', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'tool_use', id: 'a', name: 'x', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect((out[0].content as Anthropic.ContentBlockParam[])[0].type).toBe('thinking');
  });

  it('leaves an already-valid request unchanged (bare-string user content too)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const out = ensureValidAnthropicRequest(msgs);
    expect(out).toEqual(msgs);
  });
});

/**
 * Same invariant SET, OpenAI Responses wire shape. The Responses projection emits
 * an assistant `message` for every assistant turn (empty content when the turn was
 * just a tool call) and a `function_call_output` per tool result (empty output when
 * the tool returned nothing) — both shapes the Responses API can 400 on.
 */
describe('ensureValidOpenAIResponsesRequest', () => {
  it('replaces empty assistant message content with a placeholder', () => {
    const items = [{ role: 'assistant', content: '' }] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect((out[0] as { content: unknown }).content).toBe('(no content)');
  });

  it('replaces empty function_call_output output with a placeholder', () => {
    // P2.0b: paired with its function_call so the orphan-strip leaves it; the
    // empty-output floor is what's under test here.
    const items = [
      { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: '' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect((out[1] as { output: unknown }).output).toBe('(no output)');
  });

  it('leaves function_call, reasoning, and non-empty items unchanged', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc' },
      { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' },
      { role: 'assistant', content: 'real answer' },
      { type: 'function_call_output', call_id: 'a', output: 'result' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out).toEqual(items);
  });
});

/**
 * PR3 (Hermes parity) — the RAISING stateless preflight. With store:false the
 * Responses API cannot resolve a reasoning item by `id` (it 404s), so every replayed
 * reasoning item must drop its `id` and carry only the self-contained
 * `encrypted_content`. The `id` is still used (BEFORE stripping) to DEDUP repeated
 * items. The preflight also RAISES on a structurally-invalid function_call /
 * function_call_output (missing call_id / name) — a journal-corruption signal that
 * the API would otherwise reject with an opaque model_error. Mirrors Hermes'
 * `_preflight_codex_input_items`.
 */
describe('preflightOpenAIResponsesInput (PR3 stateless preflight)', () => {
  it('strips the id from a reasoning item, keeping encrypted_content (store:false → id 404s)', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc1' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('id');
    expect((out[0] as { encrypted_content: unknown }).encrypted_content).toBe('enc1');
    expect((out[0] as { type: unknown }).type).toBe('reasoning');
  });

  it('dedups reasoning items by id (a repeated id is dropped)', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc1' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc1' },
      { type: 'function_call', call_id: 'c2', name: 'Read', arguments: '{}' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    const reasoning = out.filter((i) => (i as { type?: string }).type === 'reasoning');
    expect(reasoning).toHaveLength(1);
  });

  it('keeps distinct reasoning items (different ids), each id-stripped', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'e1' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'e2' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    expect(out).toHaveLength(2);
    expect(out.every((i) => !('id' in (i as object)))).toBe(true);
    expect(out.map((i) => (i as { encrypted_content: string }).encrypted_content)).toEqual(['e1', 'e2']);
  });

  it('drops a content-less reasoning item (empty encrypted_content) — id-stripped + store:false would 400)', () => {
    // Hermes parity (_preflight_codex_input_items): a reasoning item with no
    // encrypted_content is an empty shell once its id is stripped; the API rejects it.
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: '' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'real' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    expect(out).toHaveLength(1);
    expect((out[0] as { encrypted_content: string }).encrypted_content).toBe('real');
  });

  it('raises on a function_call missing call_id', () => {
    const items = [
      { type: 'function_call', name: 'Read', arguments: '{}' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    expect(() => preflightOpenAIResponsesInput(items)).toThrow(/call_id/i);
  });

  it('raises on a function_call missing name', () => {
    const items = [
      { type: 'function_call', call_id: 'c1', arguments: '{}' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    expect(() => preflightOpenAIResponsesInput(items)).toThrow(/name/i);
  });

  it('raises on a function_call_output missing call_id', () => {
    const items = [
      { type: 'function_call_output', output: 'x' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    expect(() => preflightOpenAIResponsesInput(items)).toThrow(/call_id/i);
  });

  it('drops a FOREIGN-issuer reasoning item, keeps current-issuer + unstamped (PR4)', () => {
    // `encrypted_content` is sealed to the endpoint that minted it; replaying a
    // foreign-issuer blob against openai → 400 invalid_encrypted_content. Given the
    // current issuer, drop items stamped with a different issuer; keep current-issuer
    // items and unstamped (legacy/in-memory) items. The `_issuer` marker is internal
    // (NOT a wire field) and is stripped from every kept item.
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'mine', _issuer: 'openai' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'theirs', _issuer: 'google' },
      { type: 'reasoning', id: 'r3', summary: [], encrypted_content: 'legacy' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items, { currentIssuer: 'openai' });
    const enc = out
      .filter((i) => (i as { type?: string }).type === 'reasoning')
      .map((i) => (i as { encrypted_content: string }).encrypted_content);
    expect(enc).toEqual(['mine', 'legacy']);
    // `_issuer` is internal — never sent to the API.
    expect(out.every((i) => !('_issuer' in (i as object)))).toBe(true);
  });

  it('without a currentIssuer, keeps all reasoning (back-compat: no foreign-drop)', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'a', _issuer: 'openai' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'b', _issuer: 'google' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    expect(out.filter((i) => (i as { type?: string }).type === 'reasoning')).toHaveLength(2);
  });

  it('with replayReasoning:false (the invalid_encrypted_content kill switch), drops ALL reasoning', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'a', _issuer: 'openai' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
      { type: 'reasoning', id: 'r2', summary: [], encrypted_content: 'b' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items, { currentIssuer: 'openai', replayReasoning: false });
    expect(out.some((i) => (i as { type?: string }).type === 'reasoning')).toBe(false);
    // Non-reasoning items survive (the function_call still goes through).
    expect(out.some((i) => (i as { type?: string }).type === 'function_call')).toBe(true);
  });

  it('leaves valid function_call / output / message items unchanged and preserves order', () => {
    const items = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'e1' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"p":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      { role: 'assistant', content: 'done' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = preflightOpenAIResponsesInput(items);
    expect(out.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role?: string }).role)).toEqual([
      'reasoning',
      'function_call',
      'function_call_output',
      'assistant',
    ]);
    expect(out[1]).toEqual({ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"p":1}' });
    expect(out[2]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'ok' });
  });
});

/**
 * Same invariant SET, OpenAI Chat Completions wire shape (the breadth multiplier —
 * fronts every OpenAI-compatible provider). The projection emits an assistant
 * message per turn (content null + tool_calls when it was a tool call) and a tool
 * message per result; an assistant with neither content nor tool_calls, or a tool
 * message with empty content, are shapes the API can 400 on.
 */
describe('ensureValidChatCompletionsRequest', () => {
  it('fills an assistant message that has neither content nor tool_calls', () => {
    const msgs = [{ role: 'assistant', content: '' }] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(msgs);
    expect((out[0] as { content: unknown }).content).toBe('(no content)');
  });

  it('leaves a null-content assistant message that carries tool_calls', () => {
    // P2.0b: paired with its tool message so the orphan-strip leaves it.
    const msgs = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(msgs);
    expect((out[0] as { content: unknown }).content).toBeNull();
    expect((out[0] as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
  });

  it('replaces empty tool message content with a placeholder', () => {
    // P2.0b: paired with its tool_call so the orphan-strip leaves it.
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(msgs);
    expect((out[1] as { content: unknown }).content).toBe('(no output)');
  });

  it('leaves already-valid messages unchanged', () => {
    // P2.0b: the tool message must be PAIRED to count as valid (an unpaired one
    // is an orphan the strip now removes).
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'result' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(msgs);
    expect(out).toEqual(msgs);
  });
});

/**
 * Same invariant SET, Gemini native wire shape (contents / parts; roles
 * user|model; functionResponse matched by name).
 */
describe('ensureValidGeminiRequest', () => {
  it('replaces a content that has no parts with a placeholder text part', () => {
    const contents: GeminiContent[] = [{ role: 'model', parts: [] }];
    const out = ensureValidGeminiRequest(contents);
    expect(out[0].parts).toEqual([{ text: '(no content)' }]);
  });

  it('drops empty text parts but keeps a functionCall part', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: '' }, { functionCall: { name: 'fn', args: {} } }] },
    ];
    const out = ensureValidGeminiRequest(contents);
    // The rebuilt, unsigned first call takes the sentinel (Gemini 3 400s it bare).
    expect(out[0].parts).toEqual([{ functionCall: { name: 'fn', args: {} }, thoughtSignature: 'skip_thought_signature_validator' }]);
  });

  it('keeps an empty text part that carries a thoughtSignature, and never replaces a real signature', () => {
    const out = ensureValidGeminiRequest([
      { role: 'model', parts: [{ text: '', thoughtSignature: 'T' }, { functionCall: { name: 'fn', args: {} }, thoughtSignature: 'REAL' }] },
    ]);
    expect(out[0].parts).toEqual([{ text: '', thoughtSignature: 'T' }, { functionCall: { name: 'fn', args: {} }, thoughtSignature: 'REAL' }]);
  });

  it('fills an empty functionResponse with a placeholder', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ functionResponse: { name: 'fn', response: '' } }] },
    ];
    const out = ensureValidGeminiRequest(contents);
    expect(out[0].parts[0].functionResponse?.response).toEqual({ output: '(no output)' });
  });

  it('leaves already-valid contents unchanged', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ];
    const out = ensureValidGeminiRequest(contents);
    expect(out).toEqual(contents);
  });

  it('PR5 — merges consecutive same-role user contents (parallel functionResponses) into one', () => {
    // The projection emits one user content per parallel tool result; Gemini wants them
    // in a single content. Mirrors the Anthropic floor's consecutive-user merge.
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: { ok: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'b', response: { ok: 2 } } }] },
    ];
    const out = ensureValidGeminiRequest(contents);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('user');
    expect(out[1].parts).toHaveLength(2);
    expect(out[1].parts.map((p) => p.functionResponse?.name)).toEqual(['a', 'b']);
  });

  it('PR5 — does NOT merge across a role boundary (user / model / user stays 3)', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'one' }] },
      { role: 'model', parts: [{ text: 'two' }] },
      { role: 'user', parts: [{ text: 'three' }] },
    ];
    const out = ensureValidGeminiRequest(contents);
    expect(out).toHaveLength(3);
  });
});

/**
 * P2.0b — the orphan-strip ported from the Anthropic floor to the other three
 * dialects. A tool_result whose tool_use line was quarantined (P2.0 validated
 * hydration) — or the reverse — must be stripped before the wire on EVERY arm;
 * previously only Anthropic stripped, and the other three 400-bricked every
 * subsequent turn.
 */
describe('ensureValidOpenAIResponsesRequest — P2.0b orphan strip', () => {
  it('strips a function_call with no matching function_call_output', () => {
    const items = [
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'c_orphan', name: 'Read', arguments: '{}' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out.some((i) => 'type' in i && i.type === 'function_call')).toBe(false);
    expect(out.some((i) => 'role' in i && i.role === 'user')).toBe(true);
  });

  it('strips a function_call_output with no matching function_call (the quarantined-tool_use case)', () => {
    const items = [
      { role: 'user', content: 'go' },
      { type: 'function_call_output', call_id: 'c_ghost', output: 'result of a call whose line was quarantined' },
    ] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out.some((i) => 'type' in i && i.type === 'function_call_output')).toBe(false);
  });

  it('keeps a PAIRED call + output untouched (same references)', () => {
    const call = { type: 'function_call', call_id: 'c_1', name: 'Read', arguments: '{}' };
    const output = { type: 'function_call_output', call_id: 'c_1', output: 'ok' };
    const items = [call, output] as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
  });

  it('drops the reasoning item immediately preceding a stripped function_call (the GAP-12 analog)', () => {
    // A reasoning item is bound to the call it precedes; with the call stripped it
    // becomes "reasoning without its required following item" — equally a 400.
    const items = [
      { role: 'user', content: 'go' },
      { type: 'reasoning', encrypted_content: 'blob', summary: [] },
      { type: 'function_call', call_id: 'c_orphan', name: 'Read', arguments: '{}' },
      { role: 'assistant', content: 'done' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out.some((i) => 'type' in i && i.type === 'reasoning')).toBe(false);
    expect(out.some((i) => 'type' in i && i.type === 'function_call')).toBe(false);
    expect(out.some((i) => 'role' in i && i.role === 'assistant')).toBe(true);
  });

  it('drops ALL contiguous reasoning items preceding a stripped orphan call (multi-reasoning flush)', () => {
    // A single tool_use can carry a RUN of reasoning records, flushed together
    // immediately before the function_call (openai-responses-messages.ts §4.3a). A
    // single-pop would leave the earlier ones dangling → the same 400 class.
    const items = [
      { role: 'user', content: 'go' },
      { type: 'reasoning', encrypted_content: 'blob1', summary: [] },
      { type: 'reasoning', encrypted_content: 'blob2', summary: [] },
      { type: 'function_call', call_id: 'c_orphan', name: 'Read', arguments: '{}' },
      { role: 'assistant', content: 'done' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    expect(out.some((i) => 'type' in i && i.type === 'reasoning')).toBe(false);
    expect(out.some((i) => 'type' in i && i.type === 'function_call')).toBe(false);
    expect(out.some((i) => 'role' in i && i.role === 'assistant')).toBe(true);
    expect(out.some((i) => 'role' in i && i.role === 'user')).toBe(true);
  });

  it('sweeps ONLY the orphan call reasoning — a kept sibling call keeps its own (parallel batch)', () => {
    // Parallel batch projected as reasoning→call(kept), reasoning→call(orphan). The
    // sweep must stop at the kept call, preserving the reasoning that rides behind it.
    const items = [
      { type: 'reasoning', encrypted_content: 'r_kept', summary: [] },
      { type: 'function_call', call_id: 'c_kept', name: 'Read', arguments: '{}' },
      { type: 'reasoning', encrypted_content: 'r_orphan', summary: [] },
      { type: 'function_call', call_id: 'c_orphan', name: 'Bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c_kept', output: 'ok' },
    ] as unknown as OpenAI.Responses.ResponseInputItem[];
    const out = ensureValidOpenAIResponsesRequest(items);
    // Kept call + ITS reasoning survive; the orphan call + its reasoning are gone.
    expect(out.some((i) => 'type' in i && i.type === 'function_call' && i.call_id === 'c_kept')).toBe(true);
    expect(out.some((i) => 'type' in i && i.type === 'function_call' && i.call_id === 'c_orphan')).toBe(false);
    const reasonings = out.filter((i) => 'type' in i && i.type === 'reasoning') as unknown as { encrypted_content: string }[];
    expect(reasonings).toHaveLength(1);
    expect(reasonings[0].encrypted_content).toBe('r_kept');
  });
});

describe('ensureValidChatCompletionsRequest — P2.0b orphan strip', () => {
  it('strips an assistant tool_calls entry with no matching tool message', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c_orphan', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(messages);
    const assistant = out.find((m) => m.role === 'assistant')!;
    expect('tool_calls' in assistant ? assistant.tool_calls : undefined).toBeUndefined();
    // Whole batch orphaned → self-describing placeholder (Anthropic-floor parity),
    // NOT the generic '(no content)' that gpt-5.x has been observed to parrot.
    expect(assistant.content).toBe('(tool call removed)');
  });

  it('keeps REAL assistant content when its whole tool_calls batch is orphaned', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'let me look', tool_calls: [{ id: 'c_orphan', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(messages);
    const assistant = out.find((m) => m.role === 'assistant')!;
    expect('tool_calls' in assistant ? assistant.tool_calls : undefined).toBeUndefined();
    expect(assistant.content).toBe('let me look'); // real content is not clobbered
  });

  it('strips only the orphaned entry from a MIXED tool_calls batch', () => {
    const messages = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c_ok', type: 'function', function: { name: 'Read', arguments: '{}' } },
        { id: 'c_orphan', type: 'function', function: { name: 'Bash', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'c_ok', content: 'ok' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(messages);
    const assistant = out.find((m) => m.role === 'assistant')! as { tool_calls?: { id: string }[] };
    expect(assistant.tool_calls?.map((c) => c.id)).toEqual(['c_ok']);
    expect(out.some((m) => m.role === 'tool')).toBe(true);
  });

  it('drops a tool message whose tool_call_id matches no assistant tool_call (the quarantined-tool_use case)', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'c_ghost', content: 'result of a quarantined call' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(messages);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps a PAIRED tool_call + tool message untouched (same references)', () => {
    const messages = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c_1', content: 'ok' },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    const out = ensureValidChatCompletionsRequest(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
  });
});

describe('stripOrphanedGeminiToolParts — P2.0b orphan strip (positional)', () => {
  it('strips a functionCall whose name has no functionResponse', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ text: 'reading' }, { functionCall: { name: 'Read', args: {} } }] },
    ];
    const out = ensureValidGeminiRequest(stripOrphanedGeminiToolParts(contents));
    expect(out.flatMap((c) => c.parts).some((p) => p.functionCall)).toBe(false);
    expect(out.flatMap((c) => c.parts).some((p) => p.text === 'reading')).toBe(true);
  });

  it('strips a functionResponse whose name has no functionCall (the quarantined-tool_use case)', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'hm' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'GhostTool', response: { output: 'x' } } }] },
    ];
    const out = ensureValidGeminiRequest(stripOrphanedGeminiToolParts(contents));
    expect(out.flatMap((c) => c.parts).some((p) => p.functionResponse)).toBe(false);
    // The emptied user content gets the floor's placeholder, never zero parts.
    expect(out.every((c) => c.parts.length > 0)).toBe(true);
  });

  it('keeps PAIRED call + response untouched (same references when nothing strips)', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'Read', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { output: 'ok' } } }] },
    ];
    const out = stripOrphanedGeminiToolParts(contents);
    expect(out[0]).toBe(contents[0]);
    expect(out[1]).toBe(contents[1]);
  });

  it('REVERSE: strips a trailing UNANSWERED call whose name was answered in an EARLIER turn', () => {
    // The global name-set matcher's bug: a later unanswered `search` survived because
    // `search` was answered once upstream. Positional pairing strips it.
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }, { functionCall: { name: 'grep', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'r1' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'grep', response: { output: 'r2' } } }] },
      { role: 'model', parts: [{ text: 'again' }, { functionCall: { name: 'search', args: {} } }] },
    ];
    const out = stripOrphanedGeminiToolParts(contents);
    // The first (answered) batch is intact; the trailing unanswered `search` is gone.
    expect(out[0].parts.filter((p) => p.functionCall).map((p) => p.functionCall!.name)).toEqual(['search', 'grep']);
    expect(out[3].parts.some((p) => p.functionCall)).toBe(false);
    expect(out[3].parts.some((p) => p.text === 'again')).toBe(true);
    // No response was falsely stripped.
    expect(out.flatMap((c) => c.parts).filter((p) => p.functionResponse)).toHaveLength(2);
  });

  it('MIXED-COUNT: one answered + one unanswered call of the SAME name in one turn → only the unpaired drops', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 1 } } }, { functionCall: { name: 'search', args: { q: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'r' } } }] },
    ];
    const out = stripOrphanedGeminiToolParts(contents);
    const calls = out[0].parts.filter((p) => p.functionCall);
    expect(calls).toHaveLength(1);
    expect(calls[0].functionCall!.args).toEqual({ q: 1 }); // greedy: the FIRST is paired
    expect(out[1].parts.some((p) => p.functionResponse)).toBe(true);
  });

  it('FORWARD: strips an orphan response (its call quarantined) while the real pair stays intact', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'ok' } } }] },
      { role: 'model', parts: [{ text: 'thinking' }] }, // turn-2 assistant; its tool_use was quarantined
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'orphan' } } }] },
    ];
    const out = stripOrphanedGeminiToolParts(contents);
    // turn-1 pair intact (untouched references); the orphan response is stripped.
    expect(out[0]).toBe(contents[0]);
    expect(out[1]).toBe(contents[1]);
    expect(out[3].parts.some((p) => p.functionResponse)).toBe(false);
    const responses = out.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(responses).toHaveLength(1);
    expect(responses[0].functionResponse!.response).toEqual({ output: 'ok' });
  });

  it('COLLIDING-ID COMPAT: two separate same-name pairs across turns both survive (pairing ignores ids)', () => {
    // Old journals minted colliding internal ids; positional pairing by name+turn is
    // immune — two `search` pairs in distinct turns are each locally paired and kept.
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: { n: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'first' } } }] },
      { role: 'model', parts: [{ text: 'again' }, { functionCall: { name: 'search', args: { n: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'second' } } }] },
    ];
    const out = stripOrphanedGeminiToolParts(contents);
    expect(out).toBe(contents); // no false strip — same reference
  });

  it('BYTE-IDENTICAL: a valid multi-turn history returns the same array reference', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: { output: '1' } } }] },
      { role: 'model', parts: [{ text: 'done' }] },
    ];
    expect(stripOrphanedGeminiToolParts(contents)).toBe(contents);
  });
});

/**
 * Prod 09-16 — the wedge. Anthropic ran a server-side tool mid-reply, so the turn
 * was `thinking > server_tool_use > tool_search_result > thinking > tool_use`. The
 * accumulator discarded the two block types it did not model, and the journal kept
 * `thinking > thinking > tool_use`. The SECOND thinking block's signature is
 * computed over the blocks that preceded it, including the two we dropped, so
 * replaying it 400'd — `messages.19.content.1: thinking blocks in the latest
 * assistant message cannot be modified` — on EVERY retry, permanently. The task
 * could never make another model call.
 *
 * Fidelity is fixed upstream (the channel now captures the provider's own blocks).
 * This is the seatbelt for the NEXT unmodelled block type: two thinking blocks
 * sitting directly against each other is a shape a faithful capture cannot produce
 * — the model always emits content between them — so it is a reliable tombstone
 * for "something was removed here". When we see it we drop the thinking rather
 * than send a signature we know is stale: losing one turn's reasoning costs a
 * little quality, sending it costs the whole task.
 */
describe('Anthropic validity floor — unreplayable thinking never ships', () => {
  const sig = (n: string) => ({ type: 'thinking' as const, thinking: `t-${n}`, signature: `sig-${n}` });
  const tool = { type: 'tool_use' as const, id: 'tu1', name: 'Bash', input: {} };

  function assistantOf(msgs: Anthropic.MessageParam[]): Anthropic.ContentBlockParam[] {
    const m = msgs.find((x) => x.role === 'assistant');
    return (m?.content ?? []) as Anthropic.ContentBlockParam[];
  }

  it('drops BOTH thinking blocks when two sit adjacent — the tombstone shape', () => {
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [sig('a'), sig('b'), tool] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ] as Anthropic.MessageParam[]);
    const blocks = assistantOf(out);
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    // The work itself survives — only the unreplayable reasoning goes.
    expect(blocks.map((b) => b.type)).toEqual(['tool_use']);
  });

  it('keeps a single thinking block — the ordinary turn is untouched', () => {
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [sig('a'), tool] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ] as Anthropic.MessageParam[]);
    expect(assistantOf(out).map((b) => b.type)).toEqual(['thinking', 'tool_use']);
  });

  it('keeps genuinely interleaved thinking — separated by content, so it is faithful', () => {
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [sig('a'), tool, sig('b')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ] as Anthropic.MessageParam[]);
    // Order preserved AND both blocks kept: a tool_use between them means nothing
    // was dropped, so each signature still matches its position.
    expect(assistantOf(out).map((b) => b.type)).toEqual(['thinking', 'tool_use', 'thinking']);
  });

  it('a provider block between two thinkings is content — nothing is dropped', () => {
    // The shape the fixed capture now produces. The server block is what the
    // second signature was computed over, so keeping it keeps the turn valid.
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [sig('a'), { type: 'server_tool_use', id: 'srv', name: 'search', input: {} }, sig('b'), tool],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ] as unknown as Anthropic.MessageParam[]);
    expect(assistantOf(out).map((b) => b.type)).toEqual([
      'thinking', 'server_tool_use', 'thinking', 'tool_use',
    ]);
  });

  it('drops adjacent redacted thinking too — same tombstone, same reasoning', () => {
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'zz' }, sig('b'), tool],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    ] as Anthropic.MessageParam[]);
    expect(assistantOf(out).map((b) => b.type)).toEqual(['tool_use']);
  });

  it('never empties a message to nothing — a thinking-only turn keeps a placeholder', () => {
    const out = ensureValidAnthropicRequest([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [sig('a'), sig('b')] },
    ] as Anthropic.MessageParam[]);
    const blocks = assistantOf(out);
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text' });
  });
});
