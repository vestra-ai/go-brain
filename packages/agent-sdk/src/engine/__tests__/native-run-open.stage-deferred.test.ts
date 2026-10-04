import { describe, it, expect } from 'vitest';
import { stageDeferredTurn } from '../native-run-open.js';
import type { UserTurn } from '../../contract/harness.js';
import type { ImageBlock, MediaBlock } from '../../contract/blocks.js';

const image = (data: string): ImageBlock => ({ type: 'image', data, mediaType: 'image/png' });
const media = (filename: string): MediaBlock => ({
  type: 'media',
  kind: 'video',
  filename,
  path: `files/${filename}`,
  mediaType: 'video/mp4',
  sizeBytes: 0,
});

const emptyStaged = (): { texts: string[]; images: ImageBlock[]; media: MediaBlock[] } => ({
  texts: [],
  images: [],
  media: [],
});

describe('stageDeferredTurn', () => {
  it('stages the text of every deferred turn, in order', () => {
    const staged = emptyStaged();
    stageDeferredTurn({ text: 'first' } as UserTurn, staged);
    stageDeferredTurn({ text: 'second' } as UserTurn, staged);
    expect(staged.texts).toEqual(['first', 'second']);
  });

  it('leaves images and media untouched when the turn carries neither', () => {
    const staged = emptyStaged();
    stageDeferredTurn({ text: 'text only' } as UserTurn, staged);
    expect(staged.images).toEqual([]);
    expect(staged.media).toEqual([]);
  });

  it('appends images and media when the turn carries them', () => {
    const staged = emptyStaged();
    stageDeferredTurn(
      { text: 'with attachments', images: [image('a')], media: [media('clip.mp4')] } as UserTurn,
      staged,
    );
    expect(staged.texts).toEqual(['with attachments']);
    expect(staged.images).toEqual([image('a')]);
    expect(staged.media).toEqual([media('clip.mp4')]);
  });

  it('appends across turns rather than replacing', () => {
    const staged = emptyStaged();
    stageDeferredTurn({ text: 'one', images: [image('a')] } as UserTurn, staged);
    stageDeferredTurn({ text: 'two', images: [image('b')], media: [media('b.mp4')] } as UserTurn, staged);
    expect(staged.images).toEqual([image('a'), image('b')]);
    expect(staged.media).toEqual([media('b.mp4')]);
  });

  it('treats an empty images/media array as absent', () => {
    const staged = emptyStaged();
    stageDeferredTurn({ text: 'empty arrays', images: [], media: [] } as UserTurn, staged);
    expect(staged.texts).toEqual(['empty arrays']);
    expect(staged.images).toEqual([]);
    expect(staged.media).toEqual([]);
  });
});
