import { describe, it, expect } from 'vitest';
import { transcriptToBlocks, serializeEpisode, type CaptureEpisode } from '../episode.js';

describe('transcriptToBlocks', () => {
  it('splits a user/assistant transcript into two ordered, labeled blocks', () => {
    const blocks = transcriptToBlocks('user: hi\n\nassistant: hello');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hi' });
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: 'hello' });
  });
});

describe('serializeEpisode', () => {
  it('labels each block by kind, flags tool errors, and prefixes the observed time', () => {
    const ep: CaptureEpisode = {
      taskId: 't1',
      observedAt: '2026-06-29T00:00:00.000Z',
      blocks: [
        { kind: 'user', text: 'run it' },
        { kind: 'tool_result', text: 'boom', isError: true },
      ],
    };
    const s = serializeEpisode(ep);
    expect(s).toContain('now: 2026-06-29T00:00:00.000Z');
    expect(s).toContain('[user] run it');
    expect(s).toContain('[tool_result error] boom');
  });
});
