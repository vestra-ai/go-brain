/**
 * VIDEO_UNDERSTANDING_V1 — the media block rides the user entry, and only there.
 *
 * The journal is the conversation's record: an attached video must appear on the
 * user turn as a POINTER (path + signed url + hash), never as bytes and never as
 * a provider-side file uri (a 48-hour cache is not a fact about the conversation
 * — spec §4). These pin the block order the projections read (`images…`,
 * `media…`, then the text) and, just as load-bearing, that a turn with NO media
 * journals exactly the entry it journals today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { MediaBlock } from '../../contract/blocks.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { appendUserEntry } from '../native-journal.js';

const dir = join(tmpdir(), `native-journal-media-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId: string) => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const ctxFor = (taskId: string): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId: 'u' } } } as unknown as HarnessContext<NativeConfigLike>);

const CLIP: MediaBlock = {
  type: 'media',
  kind: 'video',
  filename: 'clip.mp4',
  path: 'files/clip.mp4',
  url: 'https://cdn/clip.mp4?sig=1',
  mediaType: 'video/mp4',
  sizeBytes: 9_000_000,
  contentSha: 'cd'.repeat(32),
};

async function blocksOf(j: Journal): Promise<unknown[]> {
  const blocks: unknown[] = [];
  for await (const e of j.read()) {
    if ((e.payload as { type?: string }).type === 'user') blocks.push((e.payload as { blocks: unknown[] }).blocks);
  }
  return blocks;
}

describe('appendUserEntry — the media block on the user entry', () => {
  it('journals [images…, media…, text] and the media block carries no bytes and no provider uri', async () => {
    const j = make('m-order');
    await appendUserEntry(
      j,
      ctxFor('m-order'),
      'what happens at 0:42?',
      [{ type: 'image', data: 'AAA=', mediaType: 'image/png' }],
      [CLIP],
    );
    const [blocks] = await blocksOf(j);
    expect((blocks as Array<{ type: string }>).map((b) => b.type)).toEqual(['image', 'media', 'text']);
    const media = (blocks as Array<Record<string, unknown>>)[1];
    expect(media).toEqual(CLIP);
    // The two things the spec forbids on this block, asserted by absence.
    expect(media).not.toHaveProperty('data');
    expect(media).not.toHaveProperty('uri');
  });

  it('media with NO caption journals no empty text block (media-only upload)', async () => {
    const j = make('m-caption');
    await appendUserEntry(j, ctxFor('m-caption'), '', undefined, [CLIP]);
    const [blocks] = await blocksOf(j);
    expect(blocks).toEqual([CLIP]);
  });

  it('keeps every media block, in order, for a multi-attachment turn', async () => {
    const j = make('m-many');
    const doc: MediaBlock = {
      type: 'media', kind: 'document', filename: 'deck.pdf', path: 'files/deck.pdf',
      mediaType: 'application/pdf', sizeBytes: 1234,
    };
    await appendUserEntry(j, ctxFor('m-many'), 'compare these', undefined, [CLIP, doc]);
    const [blocks] = await blocksOf(j);
    expect(blocks).toEqual([CLIP, doc, { type: 'text', text: 'compare these' }]);
  });

  it('no media ⇒ the entry shape is exactly today\'s (flag-off byte-identity)', async () => {
    const j = make('m-none');
    const ctx = ctxFor('m-none');
    await appendUserEntry(j, ctx, 'plain ask');
    await appendUserEntry(j, ctx, 'plain ask', undefined, []);
    await appendUserEntry(j, ctx, 'what is in this?', [{ type: 'image', data: 'AAA=', mediaType: 'image/png' }], []);
    const [plain, plainEmptyMedia, withImage] = await blocksOf(j);
    // A text-only turn keeps its single text block — even the empty-media call.
    expect(plain).toEqual([{ type: 'text', text: 'plain ask' }]);
    expect(plainEmptyMedia).toEqual(plain);
    expect(withImage).toEqual([
      { type: 'image', data: 'AAA=', mediaType: 'image/png' },
      { type: 'text', text: 'what is in this?' },
    ]);
  });
});
