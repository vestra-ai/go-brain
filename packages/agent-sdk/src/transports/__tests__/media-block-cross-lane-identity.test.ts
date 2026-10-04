/**
 * VIDEO_UNDERSTANDING_V1 — the media block is the GEMINI lane's alone.
 *
 * A `media` block rides the user turn of a journal every lane replays, so the
 * question the PR 1 review asked (M5) is not "does the block work on Gemini" but
 * "does its mere PRESENCE move anything on the other four wires". It must not: a
 * model that cannot take a native video reference has to see EXACTLY the request
 * it saw before the block existed, byte for byte — not a near-miss, not an empty
 * part, not a stray note.
 *
 * So each net here projects the SAME journal twice, once with the block and once
 * without, and compares the WHOLE projected structure. A lane that starts reading
 * the block — for any reason, however well meant — turns this red.
 */
import { describe, it, expect } from 'vitest';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { ContentBlock, MediaBlock } from '../../contract/blocks.js';
import { journalToOpenAIResponsesInput } from '../openai-responses-messages.js';
import { journalToChatCompletionsMessages } from '../chat-completions-messages.js';
import { journalToGeminiContents } from '../gemini-messages.js';
import { journalToAnthropicMessages } from '../../engine/native-messages.js';

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`, parentUuid: seq === 1 ? null : `u${seq - 1}`, seq, taskId: 't', rootTaskId: 't',
    spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-09-04T00:00:00.000Z', payload,
  };
}

const MEDIA: MediaBlock = {
  type: 'media', kind: 'video', filename: 'clip.mp4', path: 'files/clip.mp4',
  url: 'https://cdn/clip.mp4', mediaType: 'video/mp4', sizeBytes: 9000, contentSha: 'sha-1',
};

/** The same conversation, with and without the media block on its user turn. */
function pair(): { withMedia: JournalEntry[]; without: JournalEntry[] } {
  const build = (blocks: ContentBlock[]): JournalEntry[] => {
    seq = 0;
    return [
      entry({ type: 'user', blocks }),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'on it' }], api: 'anthropic_messages', provider: 'anthropic' }),
      entry({ type: 'tool_use', toolUseId: 'fc_1', name: 'Read', input: { p: '/a' } }),
      entry({ type: 'tool_result', toolUseId: 'fc_1', blocks: [{ type: 'text', text: 'file a' }] }),
    ];
  };
  return {
    withMedia: build([MEDIA, { type: 'text', text: 'watch this' }]),
    without: build([{ type: 'text', text: 'watch this' }]),
  };
}

describe('a media block is invisible to every lane but Gemini Interactions', () => {
  it('a journal with a media block projects to EXACTLY the same OpenAI Responses input as the same journal without it', () => {
    const { withMedia, without } = pair();
    expect(journalToOpenAIResponsesInput(withMedia)).toEqual(journalToOpenAIResponsesInput(without));
  });

  it('… the same Chat Completions messages …', () => {
    const { withMedia, without } = pair();
    expect(journalToChatCompletionsMessages(withMedia)).toEqual(journalToChatCompletionsMessages(without));
  });

  it('… the same generateContent Gemini contents', () => {
    const { withMedia, without } = pair();
    expect(journalToGeminiContents(withMedia)).toEqual(journalToGeminiContents(without));
  });

  it('… the same Anthropic MessageParam[]', () => {
    const { withMedia, without } = pair();
    expect(journalToAnthropicMessages(withMedia)).toEqual(journalToAnthropicMessages(without));
  });

  it('the projections are not vacuously equal — they carry the turn they were given', () => {
    const { without } = pair();
    expect(JSON.stringify(journalToOpenAIResponsesInput(without))).toContain('watch this');
    expect(JSON.stringify(journalToChatCompletionsMessages(without))).toContain('watch this');
    expect(JSON.stringify(journalToGeminiContents(without))).toContain('watch this');
    expect(JSON.stringify(journalToAnthropicMessages(without))).toContain('watch this');
  });
});
