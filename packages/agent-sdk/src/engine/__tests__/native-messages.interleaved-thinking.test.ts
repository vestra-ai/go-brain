import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createStreamAccumulator } from '../native-messages.js';

/**
 * PR2 (Hermes transport-parity) — Anthropic interleaved thinking + tool_use order.
 *
 * With the interleaved-thinking beta a single assistant response can emit
 *   think(A) → tool_use(1) → think(B) → tool_use(2)
 * Each thinking block is signed against the blocks that PRECEDE it at its
 * position. The legacy accumulator split content into two channels (`blocks()`
 * = text+thinking, `toolUses()` = tool_use), losing the cross-type ordering, so
 * a re-derived turn replayed as think(A) → think(B) → tool(1) → tool(2) →
 * the 2nd block's signature no longer matches → 400 "Invalid signature in
 * thinking block" → non-retryable crash loop.
 *
 * `orderedBlocks()` is the verbatim, order-preserving channel that fixes it:
 * thinking (signed) / redacted_thinking / text / tool_use, in EXACT emission
 * order — the Anthropic analogue of Hermes' `anthropic_content_blocks`.
 */

/** Stream a complete thinking block (start → thinking_delta → signature_delta → stop). */
function* thinkingBlock(index: number, thinking: string, signature: string): Generator<Anthropic.MessageStreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_stop', index } as Anthropic.MessageStreamEvent;
}

/** Stream a complete tool_use block (start → input_json_delta → stop). */
function* toolUseBlock(index: number, id: string, name: string, input: object): Generator<Anthropic.MessageStreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_stop', index } as Anthropic.MessageStreamEvent;
}

function feed(acc: ReturnType<typeof createStreamAccumulator>, ...evs: Anthropic.MessageStreamEvent[]) {
  for (const ev of evs) acc.onEvent(ev);
}

describe('createStreamAccumulator — orderedBlocks() preserves interleaved emission order', () => {
  it('captures think→tool→think→tool in EXACT emission order (not thinking-first buckets)', () => {
    const acc = createStreamAccumulator();
    feed(
      acc,
      ...thinkingBlock(0, 'first reasoning', 'sigA'),
      ...toolUseBlock(1, 'tu_1', 'Read', { path: '/a' }),
      ...thinkingBlock(2, 'second reasoning', 'sigB'),
      ...toolUseBlock(3, 'tu_2', 'Read', { path: '/b' }),
    );

    expect(acc.orderedBlocks()).toEqual([
      { type: 'thinking', thinking: 'first reasoning', signature: 'sigA' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
      { type: 'thinking', thinking: 'second reasoning', signature: 'sigB' },
      { type: 'tool_use', id: 'tu_2', name: 'Read', input: { path: '/b' } },
    ]);
  });

  it('captures a redacted_thinking block (with its opaque data) ahead of a tool_use', () => {
    const acc = createStreamAccumulator();
    feed(
      acc,
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_stop', index: 0 } as Anthropic.MessageStreamEvent,
      ...toolUseBlock(1, 'tu_x', 'Bash', { command: 'ls' }),
    );

    expect(acc.orderedBlocks()).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB' },
      { type: 'tool_use', id: 'tu_x', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('includes interleaved text blocks in their emitted position', () => {
    const acc = createStreamAccumulator();
    feed(
      acc,
      ...thinkingBlock(0, 'think', 'sigA'),
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'on it' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_stop', index: 1 } as Anthropic.MessageStreamEvent,
      ...toolUseBlock(2, 'tu_1', 'Read', { path: '/a' }),
    );

    expect(acc.orderedBlocks()).toEqual([
      { type: 'thinking', thinking: 'think', signature: 'sigA' },
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
    ]);
  });

  it('omits empty text blocks from orderedBlocks (keeps the gate symmetric with the floor)', () => {
    // The floor strips empty text before its interleave check; if the accumulator
    // kept an empty text block in `ordered`, the gate would fire on it as a
    // "separator" the floor never sees → asymmetry. An empty-text block carries no
    // wire content, so it is dropped from the ordered channel just like a real text
    // block of length 0 is dropped by the floor.
    const acc = createStreamAccumulator();
    feed(
      acc,
      ...thinkingBlock(0, 'A', 'sigA'),
      // An empty text block between the two thinking blocks (no text deltas).
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_stop', index: 1 } as Anthropic.MessageStreamEvent,
      ...thinkingBlock(2, 'B', 'sigB'),
      ...toolUseBlock(3, 'tu_1', 'Read', { path: '/a' }),
    );
    expect(acc.orderedBlocks()).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sigA' },
      { type: 'thinking', thinking: 'B', signature: 'sigB' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
    ]);
  });

  it('does not regress the existing channels: blocks() = text+thinking, toolUses() = calls', () => {
    const acc = createStreamAccumulator();
    feed(
      acc,
      ...thinkingBlock(0, 'reasoning', 'sigA'),
      ...toolUseBlock(1, 'tu_1', 'Read', { path: '/a' }),
    );
    // blocks() still yields ONLY text+thinking (drives the live thinking_block emit).
    expect(acc.blocks()).toEqual([{ type: 'thinking', thinking: 'reasoning', signature: 'sigA' }]);
    // toolUses() still yields the parsed calls.
    expect(acc.toolUses()).toEqual([{ id: 'tu_1', name: 'Read', input: { path: '/a' } }]);
  });
});
