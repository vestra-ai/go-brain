import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { JournalEntry } from '../../contract/journal.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { journalToOpenAIResponsesInput } from '../../transports/openai-responses-messages.js';
import { journalToGeminiContents } from '../../transports/gemini-messages.js';

/**
 * P2.0b N=3 CONFORMANCE — native-anthropic ≡ openai_responses ≡ gemini on the
 * orphan-strip invariant: the SAME journal, holding a tool_result whose tool_use line
 * was quarantined at hydration (P2.0 validated hydration drops the bad line), must
 * project to a wire body with NO orphaned tool traffic on ALL THREE arms. Before
 * P2.0b only the Anthropic floor stripped — the Responses and Gemini arms 400-bricked
 * every subsequent turn ("No tool call found for function call output …").
 *
 * The invariant is structural (same GUARANTEE, arm-specific wire shapes), the
 * conformance style of native-parity.test.ts:16-22.
 */

const base = {
  parentUuid: null, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'system' } as const, timestamp: 'T',
};

/** The quarantine fixture: user → assistant → [tool_use QUARANTINED] → tool_result → user. */
function journalWithQuarantinedToolUse(): JournalEntry[] {
  return [
    { ...base, uuid: 'u0', seq: 0, payload: { type: 'user', blocks: [{ type: 'text', text: 'go' }] } },
    { ...base, uuid: 'u1', seq: 1, payload: { type: 'assistant', blocks: [{ type: 'text', text: 'reading the file' }] } },
    // seq 2 — the tool_use entry — was shape-corrupt and quarantined at read().
    { ...base, uuid: 'u3', seq: 3, payload: { type: 'tool_result', toolUseId: 'tu_lost', blocks: [{ type: 'text', text: 'file contents' }] } },
    { ...base, uuid: 'u4', seq: 4, payload: { type: 'user', blocks: [{ type: 'text', text: 'thanks' }] } },
  ] as JournalEntry[];
}

describe('P2.0b orphan-strip conformance (N=3: anthropic ≡ openai_responses ≡ gemini)', () => {
  it('anthropic arm: the orphaned tool_result never reaches the wire', () => {
    const messages = journalToAnthropicMessages(journalWithQuarantinedToolUse());
    const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    // The conversation itself survives (degraded, not bricked). User content may
    // project as a bare string OR as text blocks — collect both shapes.
    const texts = [
      ...messages.filter((m) => typeof m.content === 'string').map((m) => m.content as string),
      ...blocks.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map((b) => b.text),
    ].join('\n');
    expect(texts).toContain('go');
    expect(texts).toContain('thanks');
  });

  it('openai_responses arm: the SAME journal projects with no orphaned function_call_output', () => {
    const items = journalToOpenAIResponsesInput(journalWithQuarantinedToolUse());
    expect(items.some((i) => 'type' in i && i.type === 'function_call_output')).toBe(false);
    expect(items.some((i) => 'type' in i && i.type === 'function_call')).toBe(false);
    // The conversation itself survives on this arm too — SAME survival strength as
    // the other two legs (verify pass: role-only was materially weaker).
    const text = items
      .map((i) => {
        const c = (i as { content?: unknown }).content;
        return typeof c === 'string' ? c : JSON.stringify(c ?? '');
      })
      .join('\n');
    expect(text).toContain('go');
    expect(text).toContain('thanks');
  });

  it('gemini arm: the SAME journal projects with no orphaned functionResponse', () => {
    const contents = journalToGeminiContents(journalWithQuarantinedToolUse());
    const parts = contents.flatMap((c) => c.parts);
    expect(parts.some((p) => p.functionResponse)).toBe(false);
    expect(parts.some((p) => p.functionCall)).toBe(false);
    // The conversation itself survives (degraded, not bricked).
    const text = parts.map((p) => p.text ?? '').join('\n');
    expect(text).toContain('go');
    expect(text).toContain('thanks');
  });

  /** Verify-pass addition: the FORWARD fixture only covers a quarantined tool_use;
   *  this one covers the REVERSE direction (a trailing unanswered call — hard-kill
   *  before heal), protecting the positional-pairing invariant cross-arm. */
  it('N=3: a trailing UNANSWERED tool_use (hard-kill shape) is stripped on all three arms', () => {
    const reverse: JournalEntry[] = [
      { ...base, uuid: 'u0', seq: 0, payload: { type: 'user', blocks: [{ type: 'text', text: 'go' }] } },
      { ...base, uuid: 'u1', seq: 1, payload: { type: 'assistant', blocks: [{ type: 'text', text: 'on it' }] } },
      { ...base, uuid: 'u2', seq: 2, payload: { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { p: 'x' } } },
      { ...base, uuid: 'u3', seq: 3, payload: { type: 'tool_result', toolUseId: 'tu_1', blocks: [{ type: 'text', text: 'ok' }] } },
      { ...base, uuid: 'u4', seq: 4, payload: { type: 'user', blocks: [{ type: 'text', text: 'more' }] } },
      { ...base, uuid: 'u5', seq: 5, payload: { type: 'assistant', blocks: [{ type: 'text', text: 'running' }] } },
      // Hard-kill: this second Read call never got a result (no heal ran).
      { ...base, uuid: 'u6', seq: 6, payload: { type: 'tool_use', toolUseId: 'tu_2', name: 'Read', input: { p: 'y' } } },
    ] as JournalEntry[];

    const aBlocks = journalToAnthropicMessages(reverse).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(aBlocks.filter((b) => b.type === 'tool_use')).toHaveLength(1); // tu_1 kept, tu_2 stripped

    const rItems = journalToOpenAIResponsesInput(reverse);
    expect(rItems.filter((i) => 'type' in i && i.type === 'function_call')).toHaveLength(1);

    const gParts = journalToGeminiContents(reverse).flatMap((c) => c.parts);
    // The SAME tool name ('Read') is answered earlier — the old global-name-set
    // matcher kept the dangler; positional pairing must strip exactly it.
    expect(gParts.filter((p) => p.functionCall)).toHaveLength(1);
    expect(gParts.filter((p) => p.functionResponse)).toHaveLength(1);
  });

  it('both arms preserve a healthy paired journal untouched (no false strips)', () => {
    const healthy: JournalEntry[] = [
      { ...base, uuid: 'u0', seq: 0, payload: { type: 'user', blocks: [{ type: 'text', text: 'go' }] } },
      { ...base, uuid: 'u1', seq: 1, payload: { type: 'assistant', blocks: [{ type: 'text', text: 'on it' }] } },
      { ...base, uuid: 'u2', seq: 2, payload: { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { p: 'x' } } },
      { ...base, uuid: 'u3', seq: 3, payload: { type: 'tool_result', toolUseId: 'tu_1', blocks: [{ type: 'text', text: 'ok' }] } },
    ] as JournalEntry[];

    const anthropic = journalToAnthropicMessages(healthy);
    const aBlocks = anthropic.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(aBlocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(aBlocks.some((b) => b.type === 'tool_result')).toBe(true);

    const responses = journalToOpenAIResponsesInput(healthy);
    expect(responses.some((i) => 'type' in i && i.type === 'function_call')).toBe(true);
    expect(responses.some((i) => 'type' in i && i.type === 'function_call_output')).toBe(true);

    const gemini = journalToGeminiContents(healthy).flatMap((c) => c.parts);
    expect(gemini.some((p) => p.functionCall)).toBe(true);
    expect(gemini.some((p) => p.functionResponse)).toBe(true);
  });
});
