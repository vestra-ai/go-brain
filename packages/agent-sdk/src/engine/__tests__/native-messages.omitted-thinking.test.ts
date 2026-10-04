/**
 * `display:'omitted'` thinking shape — signed-but-EMPTY blocks are replay-only.
 *
 * 07-08 incident: the provider-side default for adaptive thinking flipped to the
 * omitted form (signature_delta only, NO thinking_delta text). The accumulator
 * pushed the blank-but-signed block to the renderable channel, so every Anthropic
 * turn persisted `{"type":"thinking","thinking":"","signature":...}` to the
 * journal + web — thinking bubbles vanished on both surfaces. Pins:
 *   1. signed-but-empty → orderedBlocks() ONLY (multi-turn signature continuity),
 *      never blocks() (no blank renderable bubble);
 *   2. signed WITH text → both channels (the normal summarized shape, unchanged).
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createStreamAccumulator } from '../native-messages.js';

function feed(acc: ReturnType<typeof createStreamAccumulator>, ...evs: Anthropic.MessageStreamEvent[]) {
  for (const ev of evs) acc.onEvent(ev);
}

/** The omitted shape: start → signature_delta → stop, NO thinking_delta. */
function* omittedThinkingBlock(index: number, signature: string): Generator<Anthropic.MessageStreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_stop', index } as Anthropic.MessageStreamEvent;
}

function* textBlock(index: number, text: string): Generator<Anthropic.MessageStreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } as Anthropic.MessageStreamEvent;
  yield { type: 'content_block_stop', index } as Anthropic.MessageStreamEvent;
}

describe('createStreamAccumulator — omitted (signed-but-empty) thinking', () => {
  it('routes signed-but-empty thinking to orderedBlocks() ONLY — no blank renderable bubble', () => {
    const acc = createStreamAccumulator();
    feed(acc, ...omittedThinkingBlock(0, 'EpoDCokB'), ...textBlock(1, 'the answer'));

    // Replay continuity preserved (the signature must ride the next request)…
    expect(acc.orderedBlocks()).toEqual([
      { type: 'thinking', thinking: '', signature: 'EpoDCokB' },
      { type: 'text', text: 'the answer' },
    ]);
    // …but the renderable channel carries NO blank thinking block.
    expect(acc.blocks()).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('signed thinking WITH text still lands in both channels (summarized shape unchanged)', () => {
    const acc = createStreamAccumulator();
    feed(
      acc,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible reasoning' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigZ' } } as Anthropic.MessageStreamEvent,
      { type: 'content_block_stop', index: 0 } as Anthropic.MessageStreamEvent,
    );
    expect(acc.blocks()).toEqual([{ type: 'thinking', thinking: 'visible reasoning', signature: 'sigZ' }]);
    expect(acc.orderedBlocks()).toEqual([{ type: 'thinking', thinking: 'visible reasoning', signature: 'sigZ' }]);
  });
});
