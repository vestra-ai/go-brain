/**
 * The kernel journal mirror never holds a pasted image's bytes (file access Train A,
 * ruling R2(b) fix round).
 *
 * The runner journals a pasted image as base64 in the USER entry (a replay needs no
 * network). Before this, the mirror's oversize clamp swapped any user entry over the
 * cap for a `system` note: a ~1 MB image (~1.33 M base64 chars) took the person's
 * WORDS with it, and a fresh machine hydrated a conversation with the turn missing.
 *
 * Now every image block of a user entry becomes one small text placeholder that
 * names the file (filename, file id, content hash when known) BEFORE the size check,
 * so the words always survive and no image bytes sit at rest in the mirror. The
 * local JSONL keeps the full entry. Every other entry type is clamped exactly as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';
import type { ContentBlock } from '../../../contract/blocks.js';
import { journalToAnthropicMessages } from '../../../engine/native-messages.js';

const dir = join(tmpdir(), `journal-mirror-images-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

let n = 0;
const path = (): string => join(dir, `t-${n++}.jsonl`);
const clock = (): ReturnType<typeof sequentialClock> => sequentialClock('2026-01-01T00:00:00.000Z');
const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '',
} as const;
const entry = (payload: NewEntry['payload'], kind: 'user' | 'agent' = 'user'): NewEntry => ({
  ...base,
  principal: kind === 'user' ? { kind: 'user', userId: 'u' } : { kind: 'agent', agentId: 'g' },
  payload,
} as NewEntry);

const FILE_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'ab'.repeat(32);
const BIG = 'A'.repeat(1_400_000); // ~1 MB of image bytes, as base64
const SMALL = 'B'.repeat(100_000); // ~75 KB of image bytes: under the cap on its own
const image = (data: string, extra: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'image', data, mediaType: 'image/png', filename: 'shot.png', sizeBytes: 70, ...extra }) as ContentBlock;

/** Append to a journal over a fresh mirror, flush, and read back what the mirror holds. */
async function mirrored(...entries: NewEntry[]): Promise<{ mirror: InMemorySessionStore; stored: JournalEntry[] }> {
  const mirror = new InMemorySessionStore();
  const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock() });
  for (const e of entries) await j.append(e);
  await j.flushMirror();
  return { mirror, stored: (await mirror.load('t')) ?? [] };
}

describe('the journal mirror and pasted images', () => {
  it('a user entry with a 1 MB image mirrors with its words intact and no base64', async () => {
    const { stored } = await mirrored(entry({
      type: 'user',
      blocks: [image(BIG, { fileId: FILE_ID, contentSha: SHA }), { type: 'text', text: 'what is in this picture' }],
    }));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.payload).toEqual({
      type: 'user',
      blocks: [
        { type: 'text', text: `[image: shot.png, file ${FILE_ID}, sha256 ${SHA} (not stored in the mirror)]` },
        { type: 'text', text: 'what is in this picture' },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain('AAAA');
  });

  it('a small image is placeholdered too: no image bytes sit at rest in the mirror', async () => {
    const { stored } = await mirrored(entry({ type: 'user', blocks: [image(SMALL), { type: 'text', text: 'look' }] }));
    expect(stored[0]!.payload).toEqual({
      type: 'user',
      blocks: [{ type: 'text', text: '[image: shot.png (not stored in the mirror)]' }, { type: 'text', text: 'look' }],
    });
    expect(JSON.stringify(stored)).not.toContain('BBBB');
  });

  it('an older url image block is placeholdered too: no pass sits at rest in the mirror', async () => {
    const { stored } = await mirrored(entry({
      type: 'user',
      blocks: [image('', { url: 'https://x.supabase.co/storage/v1/object/sign/uploads/u/p.png?token=abc' }), { type: 'text', text: 'look' }],
    }));
    expect(JSON.stringify(stored)).not.toContain('token=');
    expect((stored[0]!.payload as { blocks: ContentBlock[] }).blocks[1]).toEqual({ type: 'text', text: 'look' });
  });

  it('the local journal keeps the full entry (bytes and all): only the mirror copy changes', async () => {
    const mirror = new InMemorySessionStore();
    const p = path();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock() });
    await j.append(entry({ type: 'user', blocks: [image(SMALL), { type: 'text', text: 'look' }] }));
    await j.flushMirror();
    const reread = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(), clock: clock() });
    const [local] = (await reread.project()).messages;
    expect((local!.payload as { blocks: ContentBlock[] }).blocks[0]).toMatchObject({ type: 'image', data: SMALL });
  });

  it('a user entry still over the cap without its images degrades to a system note, as before', async () => {
    const { stored } = await mirrored(entry({ type: 'user', blocks: [image(SMALL), { type: 'text', text: 'x'.repeat(300_000) }] }));
    expect(stored[0]!.payload.type).toBe('system');
  });

  it('non-user entries behave exactly as before: a small tool image rides, an oversize result and an oversize assistant clamp', async () => {
    const shot = image(SMALL);
    const { stored } = await mirrored(
      entry({ type: 'tool_use', toolUseId: 'tu1', name: 'screenshot', input: {} } as never, 'agent'),
      entry({ type: 'tool_result', toolUseId: 'tu1', isError: false, blocks: [shot] } as never, 'agent'),
      entry({ type: 'tool_result', toolUseId: 'tu1', isError: false, blocks: [image(BIG)] } as never, 'agent'),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'y'.repeat(300_000) }] } as never, 'agent'),
    );
    expect((stored[1]!.payload as { blocks: ContentBlock[] }).blocks).toEqual([shot]);
    expect(stored[2]!.payload).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text' }] });
    expect(JSON.stringify(stored[2])).not.toContain('AAAA');
    expect(stored[3]!.payload.type).toBe('system');
  });

  it('a journal hydrated from the mirror replays as a valid conversation: the words plus the placeholder, no image', async () => {
    const { mirror } = await mirrored(
      entry({ type: 'user', blocks: [image(BIG, { fileId: FILE_ID }), { type: 'text', text: 'what is this' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'a small square' }] } as never, 'agent'),
      entry({ type: 'user', blocks: [{ type: 'text', text: 'and its colour' }] }),
    );
    const fresh = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true });
    const messages = journalToAnthropicMessages((await fresh.project()).messages);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: `[image: shot.png, file ${FILE_ID} (not stored in the mirror)]` },
      { type: 'text', text: 'what is this' },
    ]);
    expect(JSON.stringify(messages)).not.toContain('"image"');
  });
});
