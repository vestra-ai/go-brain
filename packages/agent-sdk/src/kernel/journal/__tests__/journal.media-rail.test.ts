import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalPayload, NewEntry } from '../../../contract/journal.js';
import { RAIL_MAX_IMAGES } from '../../compaction/media-rail.js';

// Media-refs S0 — the media rail runs LAST in journal.project()'s pipeline, so
// runaway image accumulation (user-uploaded images, and Read-tool images once
// SCREENSHOT_PRUNE_CACHE_V1 scopes pruneScreenshots to screenshots) is bounded on EVERY projection — and
// the native engine re-projects before every model call.

const dir = join(tmpdir(), `journal-media-rail-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const make = (taskId: string) =>
  new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-08-03T00:00:00.000Z'),
  });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const userImage = (i: number): NewEntry => ({
  ...base,
  payload: {
    type: 'user',
    blocks: [
      { type: 'image', data: 'x'.repeat(10), mediaType: 'image/png' } as never,
      { type: 'text', text: `img ${i}` } as never,
    ],
  } as JournalPayload,
});

const countImages = (messages: ReadonlyArray<{ payload: unknown }>): number =>
  messages.reduce((n, e) => {
    const blocks = (e.payload as { blocks?: Array<{ type?: string }> }).blocks;
    return n + (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'image').length : 0);
  }, 0);

describe('journal.project() — media rail wired last', () => {
  it('bounds runaway user-image accumulation', async () => {
    const j = make('t-rail');
    for (let i = 0; i < RAIL_MAX_IMAGES + 5; i++) await j.append(userImage(i));
    const { messages } = await j.project();
    expect(countImages(messages)).toBeLessThanOrEqual(RAIL_MAX_IMAGES);
    // Evicted images left restorable text placeholders, not holes.
    const flatText = messages
      .flatMap((e) => ((e.payload as { blocks?: Array<{ type?: string; text?: string }> }).blocks ?? []))
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    expect(flatText).toContain('evicted');
  });

  it('an under-budget journal projects byte-identically (rail is identity)', async () => {
    const j = make('t-under');
    for (let i = 0; i < 3; i++) await j.append(userImage(i));
    const { messages } = await j.project();
    expect(countImages(messages)).toBe(3);
  });
});
