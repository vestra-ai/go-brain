import { describe, it, expect } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { journalToAnthropicMessages, imageBlockToAnthropicParam } from '../../engine/native-messages.js';
import type { ToolDispatchResult } from '../../tools/tool-types.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ImageBlock } from '../../contract/blocks.js';

/**
 * Task 3 — `pushToolResult` (the in-memory push, used when `cfg.journal` is absent)
 * must emit image content in the Anthropic `tool_result` too, via the SAME shared
 * helper the journal converter uses (no drift). Text-only stays a bare STRING
 * (byte-identical) — the native parity oracle.
 */

function pushOne(r: ToolDispatchResult): any {
  const t = new AnthropicMessagesTransport({ client: {} as any });
  const history: unknown[] = [];
  t.pushToolResult(history, r);
  return (history[0] as any).content[0];
}

describe('AnthropicMessagesTransport.pushToolResult — tool_result image content', () => {
  it('blocks carrying an image → content is the array (text param + image param)', () => {
    const content = pushOne({
      toolUseId: 'call_1',
      text: 'Took a screenshot',
      isError: false,
      blocks: [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', mediaType: 'image/jpeg', data: 'B64' },
      ],
    });

    expect(content.type).toBe('tool_result');
    expect(content.tool_use_id).toBe('call_1');
    expect(content.is_error).toBe(false);
    expect(content.content).toEqual([
      { type: 'text', text: 'Took a screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B64' } },
    ]);
  });

  it('blocks undefined → content === r.text (bare string, byte-identical)', () => {
    const content = pushOne({
      toolUseId: 'call_2',
      text: 'plain text result',
      isError: true,
    });

    expect(content.type).toBe('tool_result');
    expect(content.tool_use_id).toBe('call_2');
    expect(content.is_error).toBe(true);
    expect(typeof content.content).toBe('string');
    expect(content.content).toBe('plain text result');
  });

  it('text-only blocks (no image) → content stays the bare string r.text', () => {
    const content = pushOne({
      toolUseId: 'call_3',
      text: 'r.text wins',
      isError: false,
      blocks: [{ type: 'text', text: 'r.text wins' }],
    });
    expect(typeof content.content).toBe('string');
    expect(content.content).toBe('r.text wins');
  });

  it('url ImageBlock → url source', () => {
    const content = pushOne({
      toolUseId: 'call_4',
      text: 'see',
      isError: false,
      blocks: [
        { type: 'text', text: 'see' },
        { type: 'image', mediaType: 'image/png', data: 'IGN', url: 'https://cdn/z.png' },
      ],
    });
    expect(content.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'url', url: 'https://cdn/z.png' } },
    ]);
  });
});

describe('shared-helper drift guard — journal converter and pushToolResult agree', () => {
  it('both paths produce the SAME image param for the same ImageBlock (one helper)', () => {
    const image: ImageBlock = { type: 'image', mediaType: 'image/jpeg', data: 'SHAREDB64' };
    const blocks = [{ type: 'text' as const, text: 'cap' }, image];

    // journal path
    const base = {
      taskId: 't1', rootTaskId: 't1', spawnDepth: 0, workspaceId: 'w1', agentId: 'native',
      principal: { kind: 'agent' as const, agentId: 'native' }, timestamp: '2026-01-01T00:00:00.000Z',
    };
    // PR8: pair the tool_result with its tool_use so the orphan-strip leaves it intact.
    const toolUseEntry: JournalEntry = { ...base, uuid: 'u0', parentUuid: null, seq: 0, payload: { type: 'tool_use', toolUseId: 'c', name: 'x', input: {} } };
    const entry: JournalEntry = { ...base, uuid: 'u1', parentUuid: 'u0', seq: 1, payload: { type: 'tool_result', toolUseId: 'c', isError: false, blocks } };
    const journalUser = journalToAnthropicMessages([toolUseEntry, entry]).find((m) => m.role === 'user')!;
    const journalContent = (journalUser.content as any[])[0].content;

    // push path
    const pushContent = pushOne({ toolUseId: 'c', text: 'cap', isError: false, blocks }).content;

    // the IMAGE param (second element) is identical across paths…
    expect(journalContent[1]).toEqual(pushContent[1]);
    // …and equals the standalone shared helper's output (no third source of truth).
    expect(journalContent[1]).toEqual(imageBlockToAnthropicParam(image));
    expect(pushContent[1]).toEqual(imageBlockToAnthropicParam(image));
  });
});
