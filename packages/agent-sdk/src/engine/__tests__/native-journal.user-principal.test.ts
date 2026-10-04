/**
 * The claim the `principal.kind` arm stands on, pinned at the mint.
 *
 * `policy/injection-screen.ts` treats a `user` payload whose `principal.kind` is
 * not `'user'` as engine-minted. That arm is only SAFE — only incapable of
 * suppressing a real person's ask, which is the worst thing it could do — if every
 * path a person's words take stamps `{kind:'user'}`. This file is that guarantee,
 * asserted against the real mints writing to a real journal rather than argued.
 *
 * WHY TWO TESTS COVER ALL NINE CALL SITES, and why this is exhaustive rather than
 * sampled: `appendUserEntry` has nine callers and `appendInjectedUserEntry` six of
 * them, but both are thin wrappers over ONE private `appendUserPayload`, which
 * stamps the principal as an unconditional literal — no branch, no parameter, no
 * caller influence. The private body is not exported, so no tenth path through it
 * can exist. Exercising both public doors therefore exercises every site's
 * principal, and a change that made ANY site differ would have to edit that
 * literal, which turns both of these red.
 *
 * The `injected` variant is the load-bearing half: it is the ONE mint that writes
 * engine text through the user principal on purpose, which is exactly why the field
 * had to exist alongside the principal arm rather than instead of it.
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
import type { NativeConfigLike } from '../native-config-like.js';
import { appendUserEntry, appendInjectedUserEntry } from '../native-journal.js';

const dir = join(tmpdir(), `native-journal-principal-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId: string) => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const ctxFor = (taskId: string, userId = 'u'): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId } } } as unknown as HarnessContext<NativeConfigLike>);

describe('appendUserEntry stamps the USER principal unconditionally', () => {
  it('a plain ask, an image-bearing turn, and an EMPTY-userId tenant all land as kind:user', async () => {
    const j = make('p-plain');
    const ctx = ctxFor('p-plain');
    await appendUserEntry(j, ctx, 'send the quarterly numbers');
    // The images branch is the only other shape this function builds; it must not
    // reach a different append.
    await appendUserEntry(j, ctx, 'what is in this?', [
      { type: 'image', data: 'AAA=', mediaType: 'image/png' },
    ]);
    // `userId` falls back to '' when runtimeConfig is absent — the FALLBACK path,
    // because an empty tenant string must still be kind:'user'. An entry that came
    // out `{kind:'system'}` here would be silently unaskable.
    await appendUserEntry(j, { taskId: 'p-plain', config: {} } as unknown as HarnessContext<NativeConfigLike>, 'no runtime config');

    const all = await j.snapshot();
    expect(all).toHaveLength(3);
    for (const e of all) {
      expect(e.payload.type).toBe('user');
      expect(e.principal.kind).toBe('user');
      // …and no `injected` key, so the field arm cannot claim a person's entry.
      expect((e.payload as { injected?: unknown }).injected).toBeUndefined();
    }
  });

  it('an ENGINE-minted entry carries the SAME user principal — the field is what separates them', async () => {
    // This is why the principal arm alone is not sufficient and the field is not
    // redundant: the loop's own injections come down the person's path.
    const j = make('p-injected');
    const ctx = ctxFor('p-injected');
    await appendInjectedUserEntry(j, ctx, 'a severance continuation', 'engine');
    await appendInjectedUserEntry(j, ctx, 'a hook additionalContext', 'hook');

    const all = await j.snapshot();
    expect(all.map((e) => e.principal.kind)).toEqual(['user', 'user']);
    expect(all.map((e) => (e.payload as { injected?: string }).injected)).toEqual(['engine', 'hook']);
  });

  it('the principal survives the disk round-trip, which is what a warm resume reads', async () => {
    const j = make('p-disk');
    await appendUserEntry(j, ctxFor('p-disk'), 'a real ask');
    await appendInjectedUserEntry(j, ctxFor('p-disk'), 'loop text', 'engine');

    // Re-read from the JSONL through the validating reader, not the warm buffer.
    const reread = new JsonlStore(join(dir, 'p-disk.jsonl'));
    const back = [];
    for await (const e of reread.read()) back.push(e);
    expect(back.map((e) => e.principal.kind)).toEqual(['user', 'user']);
    expect(back.map((e) => (e.payload as { injected?: string }).injected)).toEqual([undefined, 'engine']);
  });
});
