import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import {
  journalToChatCompletionsMessages,
  stripImagesFromChatMessages,
  IMAGE_OMITTED_NOTE,
} from '../chat-completions-messages.js';
import type { ToolDispatchResult } from '../../tools/tool-types.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { ProviderHistory } from '../../engine/transport.js';

type ToolMsg = OpenAI.Chat.Completions.ChatCompletionToolMessageParam;

/**
 * The `tool` role is STRING-ONLY on the Chat Completions dialect — an image block
 * can never ride along. Before this fix both projections silently DISCARDED image
 * blocks from tool results: a successful os_screenshot reached the model as bare
 * text on the live turn and as an EMPTY STRING on journal replay, so blind models
 * (the Fireworks OSS lane: GLM / DeepSeek) flailed instead of knowing an image
 * existed. Image-bearing tool results must carry IMAGE_OMITTED_NOTE — the SAME
 * note stripImagesFromChatMessages already leaves on user messages — appended
 * ONCE after any text, on BOTH the live push and the replay projection.
 */

function noteCount(content: string): number {
  return content.split(IMAGE_OMITTED_NOTE).length - 1;
}

function pushOne(r: ToolDispatchResult): ToolMsg {
  // No client needed: pushToolResult is pure history mutation.
  const t = new ChatCompletionsTransport({ client: {} as never });
  const h = t.emptyHistory() as ProviderHistory;
  t.pushToolResult(h, r);
  const msgs = h as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  expect(msgs).toHaveLength(1);
  return msgs[0] as ToolMsg;
}

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
    timestamp: '2026-07-18T00:00:00.000Z',
    payload,
  };
}

/** Project a paired tool_use + tool_result and return the tool message. */
function replayOne(blocks: ContentBlock[]): ToolMsg {
  seq = 0;
  const msgs = journalToChatCompletionsMessages([
    entry({ type: 'assistant', blocks: [{ type: 'text', text: 'looking' }] }),
    entry({ type: 'tool_use', toolUseId: 'shot', name: 'os_screenshot', input: {} }),
    entry({ type: 'tool_result', toolUseId: 'shot', blocks }),
  ]);
  const tool = msgs.find((m) => m.role === 'tool');
  expect(tool).toBeDefined();
  return tool as ToolMsg;
}

const IMG: ContentBlock = { type: 'image', mediaType: 'image/png', data: 'B64' };

describe('ChatCompletionsTransport.pushToolResult — image-bearing tool results (live path)', () => {
  it('image-only blocks with text → content is text + the note (not bare text)', () => {
    const msg = pushOne({
      toolUseId: 'call_1',
      text: '[screenshot]',
      isError: false,
      blocks: [IMG],
    });
    expect(msg.content).toBe(`[screenshot]\n${IMAGE_OMITTED_NOTE}`);
  });

  it('image-only blocks with EMPTY text → content is the note alone, never "(no output)"', () => {
    const msg = pushOne({ toolUseId: 'call_2', text: '', isError: false, blocks: [IMG] });
    expect(msg.content).toBe(IMAGE_OMITTED_NOTE);
  });

  it('multiple image blocks → ONE note, regardless of image count', () => {
    const msg = pushOne({
      toolUseId: 'call_3',
      text: 'two shots',
      isError: false,
      blocks: [IMG, { type: 'image', mediaType: 'image/jpeg', data: 'C64' }],
    });
    expect(noteCount(msg.content as string)).toBe(1);
  });

  it('blocks undefined → content === r.text (byte-identical to before)', () => {
    const msg = pushOne({ toolUseId: 'call_4', text: 'plain text result', isError: true });
    expect(msg.content).toBe('plain text result');
  });

  it('blocks undefined + empty text → "(no output)" placeholder (byte-identical)', () => {
    const msg = pushOne({ toolUseId: 'call_5', text: '', isError: false });
    expect(msg.content).toBe('(no output)');
  });

  it('text-only blocks (no image) → content stays r.text, no note', () => {
    const msg = pushOne({
      toolUseId: 'call_6',
      text: 'r.text wins',
      isError: false,
      blocks: [{ type: 'text', text: 'r.text wins' }],
    });
    expect(msg.content).toBe('r.text wins');
  });
});

describe('journalToChatCompletionsMessages — image-bearing tool_result (replay path)', () => {
  it('image-only blocks → content is the note, not an EMPTY STRING', () => {
    const msg = replayOne([IMG]);
    expect(msg.content).toBe(IMAGE_OMITTED_NOTE);
  });

  it('text + image blocks → text preserved, note appended once', () => {
    const msg = replayOne([{ type: 'text', text: 'took the shot' }, IMG]);
    expect(msg.content).toBe(`took the shot\n${IMAGE_OMITTED_NOTE}`);
  });

  it('multiple images → ONE note', () => {
    const msg = replayOne([IMG, { type: 'image', mediaType: 'image/jpeg', data: 'C64' }]);
    expect(noteCount(msg.content as string)).toBe(1);
  });

  it('text-only blocks → byte-identical projection, no note', () => {
    const msg = replayOne([{ type: 'text', text: 'found' }]);
    expect(msg.content).toBe('found');
  });
});

describe('one note per tool message across a live-push → replay lifecycle', () => {
  it('live push, journal replay, AND the per-request image strip each leave exactly one note', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: '[screenshot]' }, IMG];

    // Live turn: dispatch result pushed into the in-memory history.
    const live = pushOne({ toolUseId: 'shot', text: '[screenshot]', isError: false, blocks });
    expect(noteCount(live.content as string)).toBe(1);

    // Next turn: the SAME logical entry re-derived from the journal…
    const replayed = replayOne(blocks);
    expect(noteCount(replayed.content as string)).toBe(1);

    // …then run through stripImagesFromChatMessages (applied EVERY request on the
    // text-only lane) — string tool content must pass through untouched, not gain
    // a second note.
    const stripped = stripImagesFromChatMessages([replayed]);
    expect(stripped[0]).toEqual(replayed);
    expect(noteCount(stripped[0].content as string)).toBe(1);
  });
});

describe('user-message image stripping is unchanged (scope guard)', () => {
  it('the exported IMAGE_OMITTED_NOTE is the SAME string stripImagesFromChatMessages leaves (no divergent copy)', () => {
    const out = stripImagesFromChatMessages([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
    ]);
    expect(out[0].content).toBe(IMAGE_OMITTED_NOTE);
  });

  it('user message with image + text keeps the existing strip shape (double-newline join)', () => {
    const out = stripImagesFromChatMessages([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ]);
    expect(out[0].content).toBe(`what is this?\n\n${IMAGE_OMITTED_NOTE}`);
  });
});
