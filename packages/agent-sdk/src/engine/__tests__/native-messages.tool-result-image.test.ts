import { describe, it, expect } from 'vitest';
import {
  journalToAnthropicMessages,
  imageBlockToAnthropicParam,
} from '../native-messages.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ImageBlock } from '../../contract/blocks.js';

/**
 * Task 3 — native ANTHROPIC arm tool_result image content.
 *
 * After T1 (blocks on the dispatch result) + T2 (blocks persisted in the journal),
 * `journalToAnthropicMessages` must reconstruct screenshots on resume: a tool_result
 * journal entry whose `blocks` carry an ImageBlock emits the Anthropic `tool_result`
 * with `content` as the ARRAY form (text param(s) + image param(s), order preserved).
 *
 * HARD INVARIANT (the native parity oracle — no prior conformance test pins this):
 * a TEXT-ONLY tool_result keeps `content` as a bare STRING, byte-identical to today.
 */

function baseEntry(seq: number, payload: JournalEntry['payload']): JournalEntry {
  return {
    uuid: `u_${seq}`,
    parentUuid: seq === 0 ? null : `u_${seq - 1}`,
    seq,
    taskId: 't1',
    rootTaskId: 't1',
    spawnDepth: 0,
    workspaceId: 'w1',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

describe('journalToAnthropicMessages — tool_result image content (resume reconstructs screenshots)', () => {
  it('emits content as an array (text param + base64 image param) and preserves is_error', () => {
    const entries: JournalEntry[] = [
      // PR8: pair with its tool_use so the orphan-strip leaves the tool_result intact.
      baseEntry(0, { type: 'tool_use', toolUseId: 'call_screenshot', name: 'screenshot', input: {} }),
      baseEntry(1, {
        type: 'tool_result',
        toolUseId: 'call_screenshot',
        isError: false,
        blocks: [
          { type: 'text', text: 'Took a screenshot' },
          { type: 'image', mediaType: 'image/jpeg', data: 'BASE64DATA' },
        ],
      }),
    ];

    const out = journalToAnthropicMessages(entries);
    const userMsg = out.find((m) => m.role === 'user')!;
    expect(userMsg).toBeTruthy();

    const content = (userMsg.content as any[])[0];
    expect(content.type).toBe('tool_result');
    expect(content.tool_use_id).toBe('call_screenshot');
    expect(content.is_error).toBe(false);

    // ARRAY form: text part PLUS the base64 image param, order preserved.
    expect(Array.isArray(content.content)).toBe(true);
    expect(content.content).toEqual([
      { type: 'text', text: 'Took a screenshot' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64DATA' },
      },
    ]);
  });

  it('BYTE-IDENTICAL: a text-only tool_result keeps content as a bare STRING (not an array)', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'tool_use', toolUseId: 'call_text', name: 'x', input: {} }),
      baseEntry(1, {
        type: 'tool_result',
        toolUseId: 'call_text',
        isError: true,
        blocks: [{ type: 'text', text: 'plain result' }],
      }),
    ];

    const content = (journalToAnthropicMessages(entries).find((m) => m.role === 'user')!.content as any[])[0];
    expect(content.type).toBe('tool_result');
    expect(content.tool_use_id).toBe('call_text');
    expect(content.is_error).toBe(true);
    // Bare string — the cheap Anthropic shape, byte-identical to before this change.
    expect(typeof content.content).toBe('string');
    expect(content.content).toBe('plain result');
  });

  it('url ImageBlock → {type:image, source:{type:url, url}} (mirrors the user-message mapping)', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'tool_use', toolUseId: 'call_url', name: 'x', input: {} }),
      baseEntry(1, {
        type: 'tool_result',
        toolUseId: 'call_url',
        blocks: [
          { type: 'text', text: 'see' },
          { type: 'image', mediaType: 'image/png', data: 'IGNORED', url: 'https://cdn/x.png' },
        ],
      }),
    ];

    const content = (journalToAnthropicMessages(entries).find((m) => m.role === 'user')!.content as any[])[0];
    expect(content.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'url', url: 'https://cdn/x.png' } },
    ]);
  });
});

describe('imageBlockToAnthropicParam — single source of truth for the image param shape', () => {
  it('base64 ImageBlock → base64 source', () => {
    const block: ImageBlock = { type: 'image', mediaType: 'image/gif', data: 'DAT' };
    expect(imageBlockToAnthropicParam(block)).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/gif', data: 'DAT' },
    });
  });

  it('url ImageBlock → url source (preferred over base64)', () => {
    const block: ImageBlock = {
      type: 'image',
      mediaType: 'image/webp',
      data: 'DAT',
      url: 'https://cdn/y.webp',
    };
    expect(imageBlockToAnthropicParam(block)).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://cdn/y.webp' },
    });
  });
});
