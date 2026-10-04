import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import { journalToAnthropicMessages } from '../native-messages.js';

/**
 * Regression for the staging model_error (task 39aff7f0): a native Opus 4.8 task
 * was suspended at a Composio auth gate, then resumed. On resume the history is
 * re-derived from the journal via journalToAnthropicMessages. The real journal
 * contained quirky-but-legal model output — an empty assistant turn (a tool call
 * with no thinking/text), a tool-only turn with no assistant entry — which the
 * OLD projection turned into shapes the Messages API 400s on. This pins the floor.
 */

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`,
    parentUuid: seq === 1 ? null : `u${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-06-25T21:42:00.000Z',
    payload,
  };
}

/** The exact journal shapes that bit the real task. */
function buildProblemJournal(): JournalEntry[] {
  seq = 0;
  return [
    entry({ type: 'user', blocks: [{ type: 'text', text: 'analyze my posthog' }] }),
    // Normal turn: signed thinking (empty text, as adaptive thinking stores it) + text + tool call.
    entry({ type: 'assistant', blocks: [
      { type: 'thinking', thinking: '', signature: 'sig1' },
      { type: 'text', text: 'let me look' },
    ] }),
    entry({ type: 'tool_use', toolUseId: 'a', name: 'Skill', input: {} }),
    entry({ type: 'tool_result', toolUseId: 'a', blocks: [{ type: 'text', text: 'skill loaded' }] }),
    // Turn with NO thinking (model went straight to a tool call with a line of text).
    entry({ type: 'assistant', blocks: [{ type: 'text', text: 'creating tasks' }] }),
    entry({ type: 'tool_use', toolUseId: 'b', name: 'TaskCreate', input: {} }),
    entry({ type: 'tool_result', toolUseId: 'b', blocks: [{ type: 'text', text: 'ok' }] }),
    // BARE tool_use: no assistant entry precedes it (a tool-only turn) — old code
    // spawned a fresh assistant:[tool_use]; valid for adaptive thinking, but the
    // following empty assistant + empty tool_result are the real 400 sources.
    entry({ type: 'tool_use', toolUseId: 'c', name: 'TaskCreate', input: {} }),
    entry({ type: 'tool_result', toolUseId: 'c', blocks: [{ type: 'text', text: 'ok' }] }),
    // EMPTY assistant entry (blocks:[]) — a tool-only turn the harness journaled
    // with no blocks. Folding a tool_use in keeps it non-empty; but on its own it
    // must never project to empty content.
    entry({ type: 'assistant', blocks: [] }),
    entry({ type: 'tool_use', toolUseId: 'd', name: 'TaskUpdate', input: {} }),
    // EMPTY tool_result (no text blocks) — must not become empty content.
    entry({ type: 'tool_result', toolUseId: 'd', blocks: [] }),
  ];
}

describe('journalToAnthropicMessages applies the validity floor', () => {
  const messages = journalToAnthropicMessages(buildProblemJournal());

  it('never emits an assistant message with empty content', () => {
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      const content = m.content as Anthropic.ContentBlockParam[];
      expect(Array.isArray(content) ? content.length : (content as string).length).toBeGreaterThan(0);
    }
  });

  it('never emits an empty text block', () => {
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Anthropic.ContentBlockParam[]) {
        if (b.type === 'text') expect(b.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('never emits an empty tool_result content', () => {
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Anthropic.ContentBlockParam[]) {
        if (b.type !== 'tool_result') continue;
        const c = (b as Anthropic.ToolResultBlockParam).content;
        const len = typeof c === 'string' ? c.length : Array.isArray(c) ? c.length : 0;
        expect(len).toBeGreaterThan(0);
      }
    }
  });

  it('orders any thinking block first within its assistant message', () => {
    for (const m of messages) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const blocks = m.content as Anthropic.ContentBlockParam[];
      const hasThinking = blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
      if (hasThinking) {
        expect(['thinking', 'redacted_thinking']).toContain(blocks[0].type);
      }
    }
  });
});
