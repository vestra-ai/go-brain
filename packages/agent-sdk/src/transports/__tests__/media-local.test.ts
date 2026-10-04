import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir, stat, utimes } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSha256MemoForTest,
  ensureLocalMedia,
  LocalMediaError,
  sha256File,
} from '../media-local.js';

let workspaceDir = '';

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'media-local-'));
});
afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

/** A web ReadableStream over `chunks`; errors instead of emitting chunk #failAt. */
function bodyStream(chunks: Uint8Array[], failAt?: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAt !== undefined && i === failAt) {
        controller.error(new Error('connection reset'));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]!);
    },
  });
}

describe('ensureLocalMedia', () => {
  it('returns an existing file with its real size and never fetches', async () => {
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await writeFile(join(workspaceDir, 'files/clip.mp4'), Buffer.alloc(1234, 7));
    let fetched = 0;
    const got = await ensureLocalMedia(
      { path: 'files/clip.mp4', workspaceDir },
      {
        fetch: (async () => {
          fetched += 1;
          return new Response('nope');
        }) as unknown as typeof fetch,
      },
    );
    expect(got).toEqual({ absPath: join(workspaceDir, 'files/clip.mp4'), sizeBytes: 1234 });
    expect(fetched).toBe(0);
  });

  // An absolute path is still taken as given — but only INSIDE the workspace.
  // Containment (M1) narrowed this deliberately: the path arrives on a journalled
  // block, so "absolute" used to mean "anywhere on the box".
  it('accepts an absolute path as-is when it sits inside the workspace, and refuses one that does not', async () => {
    const abs = join(workspaceDir, 'elsewhere.mp4');
    await writeFile(abs, Buffer.alloc(10));
    expect(await ensureLocalMedia({ path: abs, workspaceDir })).toEqual({
      absPath: abs,
      sizeBytes: 10,
    });
    await expect(ensureLocalMedia({ path: abs, workspaceDir: '/nowhere' })).rejects.toMatchObject({
      kind: 'outside_workspace',
    });
  });

  it('streams a url download to <path>.part, renames it, and reports the size', async () => {
    const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2), Buffer.alloc(7, 3)];
    let seen = '';
    const got = await ensureLocalMedia(
      { path: 'files/remote.mp4', url: 'https://cdn.test/a.mp4', workspaceDir },
      {
        fetch: (async (url: string) => {
          seen = String(url);
          return new Response(bodyStream(chunks.map((c) => new Uint8Array(c))));
        }) as unknown as typeof fetch,
      },
    );
    const abs = join(workspaceDir, 'files/remote.mp4');
    expect(seen).toBe('https://cdn.test/a.mp4');
    expect(got).toEqual({ absPath: abs, sizeBytes: 64 * 1024 * 2 + 7 });
    expect((await stat(abs)).size).toBe(64 * 1024 * 2 + 7);
    // The staging file is renamed, not copied — nothing is left behind.
    expect(existsSync(`${abs}.part`)).toBe(false);
  });

  it('never leaves a truncated file at the destination when the download dies mid-stream', async () => {
    const abs = join(workspaceDir, 'files/broken.mp4');
    await expect(
      ensureLocalMedia(
        { path: 'files/broken.mp4', url: 'https://cdn.test/a.mp4', workspaceDir },
        {
          fetch: (async () =>
            new Response(
              bodyStream([new Uint8Array(Buffer.alloc(64 * 1024, 1))], 1),
            )) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/connection reset/);
    // Half a video at the real path would be indistinguishable from a good download.
    expect(existsSync(abs)).toBe(false);
  });

  // The caller turns a failure into a short note the MODEL reads, so the reason has
  // to be a field. Matching the prose would make a reworded message an unknown error.
  it('a failure carries a typed kind, not just a message', async () => {
    const missing = await ensureLocalMedia({ path: 'files/gone.mp4', workspaceDir }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(LocalMediaError);
    expect((missing as LocalMediaError).kind).toBe('not_found');

    const bad = await ensureLocalMedia(
      { path: 'files/x.mp4', url: 'https://cdn/x.mp4', workspaceDir },
      { fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch },
    ).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(LocalMediaError);
    expect((bad as LocalMediaError).kind).toBe('download_failed');
    expect((bad as LocalMediaError).status).toBe(404);
  });

  it('an aborted signal ends the download instead of paying for the rest of the transfer', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ensureLocalMedia(
        { path: 'files/x.mp4', url: 'https://cdn/x.mp4', workspaceDir },
        {
          fetch: (async (_u: unknown, init?: RequestInit) => {
            if (init?.signal?.aborted) {
              throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
            }
            return new Response('bytes', { status: 200 });
          }) as unknown as typeof fetch,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
  });

  // C1 — the sandbox's own prefetch (turn-router.ts) stages the SAME clip at
  // `<target>.part` and runs concurrently by construction. Sharing that name meant
  // whoever finished first moved or unlinked the other's file, and a clip sitting
  // right there came back "unavailable".
  it('stages under a private name, never at <target>.part where the prefetch stages', async () => {
    const parts: string[] = [];
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await ensureLocalMedia(
      { path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', workspaceDir },
      {
        fetch: (async () => {
          // Snapshot the staging directory WHILE the write is in flight.
          parts.push(...(await readdir(join(workspaceDir, 'files'))));
          return new Response(bodyStream([new Uint8Array([1, 2, 3])]), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    const after = await readdir(join(workspaceDir, 'files'));
    expect(after).toEqual(['clip.mp4']);
    expect(existsSync(join(workspaceDir, 'files', 'clip.mp4.part'))).toBe(false);
  });

  it('a target that appears underneath us is a SUCCESS, not a failure, and leaves no part behind', async () => {
    const target = join(workspaceDir, 'files', 'clip.mp4');
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    const result = await ensureLocalMedia(
      { path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', workspaceDir },
      {
        fetch: (async () => {
          // The prefetch's curl wins the race: its mv lands the real file, and our
          // own rename is about to fail on a part that no longer matters.
          await writeFile(target, 'from the prefetch');
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                c.error(new Error('connection reset'));
              },
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ absPath: target, sizeBytes: 'from the prefetch'.length });
    expect((await readdir(join(workspaceDir, 'files')))).toEqual(['clip.mp4']);
  });

  it('a failed download leaves no .part behind at all', async () => {
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await expect(
      ensureLocalMedia(
        { path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', workspaceDir },
        {
          fetch: (async () => new Response(bodyStream([new Uint8Array([1])], 0), { status: 200 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/connection reset/);
    expect(await readdir(join(workspaceDir, 'files'))).toEqual([]);
  });

  it('two concurrent calls for the same path both resolve, and exactly one file remains', async () => {
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    const download = (async () =>
      new Response(bodyStream([new Uint8Array([9, 9, 9])]), { status: 200 })) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      ensureLocalMedia({ path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', workspaceDir }, { fetch: download }),
      ensureLocalMedia({ path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', workspaceDir }, { fetch: download }),
    ]);
    expect(a.sizeBytes).toBe(3);
    expect(b.sizeBytes).toBe(3);
    expect(await readdir(join(workspaceDir, 'files'))).toEqual(['clip.mp4']);
  });

  // M1 — the path rides off a journalled block, so it is user-shaped input.
  it('refuses a path that escapes the workspace before it touches the disk', async () => {
    for (const path of ['../../etc/passwd', 'files/../../secrets.mp4', '/etc/passwd']) {
      const err = await ensureLocalMedia({ path, workspaceDir }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LocalMediaError);
      expect((err as LocalMediaError).kind).toBe('outside_workspace');
    }
    // …and an ordinary nested path is still fine.
    await mkdir(join(workspaceDir, 'files', 'sub'), { recursive: true });
    await writeFile(join(workspaceDir, 'files', 'sub', 'ok.mp4'), 'yes');
    await expect(ensureLocalMedia({ path: 'files/sub/ok.mp4', workspaceDir })).resolves.toMatchObject({ sizeBytes: 3 });
  });

  it('throws naming the path when the file is missing and there is no url', async () => {
    await expect(ensureLocalMedia({ path: 'files/gone.mp4', workspaceDir })).rejects.toThrow(
      join(workspaceDir, 'files/gone.mp4'),
    );
  });

  it('surfaces a non-ok download instead of writing an error page to disk', async () => {
    const abs = join(workspaceDir, 'files/404.mp4');
    await expect(
      ensureLocalMedia(
        { path: 'files/404.mp4', url: 'https://cdn.test/a.mp4', workspaceDir },
        { fetch: (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/404/);
    expect(existsSync(abs)).toBe(false);
  });
});

describe('sha256File', () => {
  it('hashes a 3 MiB file to the known digest without buffering it', async () => {
    const abs = join(workspaceDir, 'big.bin');
    await writeFile(abs, Buffer.alloc(3 * 1024 * 1024));
    expect(await sha256File(abs)).toBe(
      'bbd05cf6097ac9b1f89ea29d2542c1b7b67ee46848393895f5a9e43fa1f621e5',
    );
  });

  it('gives two different files two different digests', async () => {
    await writeFile(join(workspaceDir, 'a.bin'), 'a');
    await writeFile(join(workspaceDir, 'b.bin'), 'b');
    expect(await sha256File(join(workspaceDir, 'a.bin'))).not.toBe(
      await sha256File(join(workspaceDir, 'b.bin')),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The digest memo. A media block with no contentSha is hashed at request build,
// which happens on EVERY model round of the turn — so a 400 MB clip was read off
// disk once per round for an answer that cannot change unless the file does.
// ─────────────────────────────────────────────────────────────────────────────
describe('sha256File — memoised by path + size + mtime', () => {
  beforeEach(() => {
    _resetSha256MemoForTest();
  });
  afterEach(() => {
    _resetSha256MemoForTest();
  });

  /** Counts opens while still hashing the real bytes. */
  function countingReader() {
    const opened: string[] = [];
    return {
      opened,
      readStream: (p: string): NodeJS.ReadableStream => {
        opened.push(p);
        return createReadStream(p);
      },
    };
  }

  it('a second call on an unchanged file does not re-read it, and returns the same digest', async () => {
    const file = join(workspaceDir, 'clip.mp4');
    await writeFile(file, 'the same bytes');
    const r = countingReader();

    const first = await sha256File(file, r);
    const second = await sha256File(file, r);

    expect(second).toBe(first);
    expect(r.opened).toEqual([file]);
  });

  it('a changed file re-hashes: a new mtime is a new key', async () => {
    const file = join(workspaceDir, 'clip.mp4');
    await writeFile(file, 'first take');
    const r = countingReader();
    const before = await sha256File(file, r);

    // Same length, different bytes AND a different mtime — the key moves on both.
    await writeFile(file, 'first tale');
    await utimes(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const after = await sha256File(file, r);

    expect(after).not.toBe(before);
    expect(r.opened).toHaveLength(2);
  });

  it('two different files never share an entry', async () => {
    const a = join(workspaceDir, 'a.mp4');
    const b = join(workspaceDir, 'b.mp4');
    await writeFile(a, 'aaaa');
    await writeFile(b, 'bbbb');
    expect(await sha256File(a)).not.toBe(await sha256File(b));
  });
});

/**
 * THE DISK IS A PRECONDITION, NOT AN ERROR PATH. The workspace volume is 4 GiB
 * per user and a video is routinely hundreds of megabytes: a download that fills
 * it does not fail this clip, it fails the workspace — the journal cannot be
 * written and the box comes back wedged (an ENOSPC incident on staging). So the
 * room is measured before the transfer starts, and the refusal is a TYPED kind
 * the caller turns into a reason the model can read.
 */
describe('ensureLocalMedia — the free-space guard', () => {
  const GB = 1024 * 1024 * 1024;
  const statfsWith = (freeBytes: number) => async () => ({ bavail: freeBytes / 4096, bsize: 4096 });
  const never = (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch;
  const serves = (bytes: number) =>
    (async () => new Response(Buffer.alloc(bytes, 1), { status: 200 })) as unknown as typeof fetch;

  it('refuses BEFORE fetching when the clip plus the margin does not fit', async () => {
    const err = await ensureLocalMedia(
      { path: 'files/big.mp4', url: 'https://cdn/big.mp4', workspaceDir, sizeBytes: 900 * 1024 * 1024 },
      { fetch: never, statfs: statfsWith(GB) },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LocalMediaError);
    expect((err as LocalMediaError).kind).toBe('no_space');
    // The numbers belong in the log, not in a note the model reads.
    expect((err as LocalMediaError).message).toMatch(/not enough workspace disk space/);
  });

  it('downloads when the clip AND the margin fit', async () => {
    const got = await ensureLocalMedia(
      { path: 'files/ok.mp4', url: 'https://cdn/ok.mp4', workspaceDir, sizeBytes: 200 * 1024 * 1024 },
      { fetch: serves(4), statfs: statfsWith(4 * GB) },
    );
    expect(got.sizeBytes).toBe(4);
  });

  /**
   * An unknown size is charged the FULL ceiling, not the margin. `size_bytes` is
   * omitted from a ref whenever it is falsy, so "unknown" is the common case —
   * and what an undeclared transfer may pull is bounded by the fetcher, not by
   * what the block forgot to say. The sandbox prefetch applies the same rule
   * through the same helper.
   */
  it('an UNKNOWN size (0) is charged the whole 2 GiB ceiling', async () => {
    // Comfortably past the 256 MiB margin, nowhere near 2 GiB: the margin-only
    // rule would have started this download.
    const err = await ensureLocalMedia(
      { path: 'files/unknown.mp4', url: 'https://cdn/unknown.mp4', workspaceDir, sizeBytes: 0 },
      { fetch: never, statfs: statfsWith(GB) },
    ).catch((e: unknown) => e);
    expect((err as LocalMediaError).kind).toBe('no_space');
  });

  it('an unknown size DOES download when the whole ceiling fits', async () => {
    const got = await ensureLocalMedia(
      { path: 'files/unknown-ok.mp4', url: 'https://cdn/unknown-ok.mp4', workspaceDir, sizeBytes: 0 },
      { fetch: serves(3), statfs: statfsWith(3 * GB) },
    );
    expect(got.sizeBytes).toBe(3);
  });

  it('a filesystem that will not answer is not a refusal — "cannot measure" is not "cannot fit"', async () => {
    const got = await ensureLocalMedia(
      { path: 'files/anyway.mp4', url: 'https://cdn/anyway.mp4', workspaceDir, sizeBytes: 10 },
      { fetch: serves(3), statfs: async () => { throw new Error('ENOTSUP'); } },
    );
    expect(got.sizeBytes).toBe(3);
  });

  /**
   * The disk guard (SANDBOX_DISK_GUARD_V1=on): a download may not take the volume to 95% used,
   * so on a big volume the margin is its last 5%, not 256 MiB. Off and dry change nothing.
   */
  describe('with the disk guard on', () => {
    const CAP = 100 * GB;
    /** A 100 GiB volume with `freeBytes` free. */
    const volumeWith = (freeBytes: number) => async () => ({ blocks: CAP / 4096, bavail: freeBytes / 4096, bsize: 4096 });
    afterEach(() => vi.unstubAllEnvs());

    it('refuses a download that would leave less than 5% of the volume free', async () => {
      vi.stubEnv('SANDBOX_DISK_GUARD_V1', 'on');
      // 6 GiB free, a 2 GiB clip: 4 GiB would be left, under the 5 GiB that is 5% of the volume.
      const err = await ensureLocalMedia(
        { path: 'files/g1.mp4', url: 'https://cdn/g1.mp4', workspaceDir, sizeBytes: 2 * GB },
        { fetch: never, statfs: volumeWith(6 * GB) },
      ).catch((e: unknown) => e);
      expect((err as LocalMediaError).kind).toBe('no_space');
    });

    it('lets it through when 5% stays free', async () => {
      vi.stubEnv('SANDBOX_DISK_GUARD_V1', 'on');
      const got = await ensureLocalMedia(
        { path: 'files/g2.mp4', url: 'https://cdn/g2.mp4', workspaceDir, sizeBytes: GB },
        { fetch: serves(4), statfs: volumeWith(6.5 * GB) },
      );
      expect(got.sizeBytes).toBe(4);
    });

    it.each([['dry'], ['true'], ['']])('SANDBOX_DISK_GUARD_V1=%j keeps the 256 MiB margin alone', async (value) => {
      vi.stubEnv('SANDBOX_DISK_GUARD_V1', value);
      const got = await ensureLocalMedia(
        { path: `files/g3-${value}.mp4`, url: 'https://cdn/g3.mp4', workspaceDir, sizeBytes: 2 * GB },
        { fetch: serves(5), statfs: volumeWith(6 * GB) },
      );
      expect(got.sizeBytes).toBe(5);
    });

    it('a filesystem that does not say its size keeps the 256 MiB margin', async () => {
      vi.stubEnv('SANDBOX_DISK_GUARD_V1', 'on');
      const got = await ensureLocalMedia(
        { path: 'files/g4.mp4', url: 'https://cdn/g4.mp4', workspaceDir, sizeBytes: 2 * GB },
        { fetch: serves(6), statfs: statfsWith(6 * GB) },
      );
      expect(got.sizeBytes).toBe(6);
    });
  });

  it('a file ALREADY on disk never asks about space — nothing is being written', async () => {
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await writeFile(join(workspaceDir, 'files/here.mp4'), Buffer.alloc(9, 1));
    let asked = 0;
    const got = await ensureLocalMedia(
      { path: 'files/here.mp4', url: 'https://cdn/here.mp4', workspaceDir, sizeBytes: 9 },
      { fetch: never, statfs: async () => { asked += 1; return { bavail: 0, bsize: 4096 }; } },
    );
    expect(got.sizeBytes).toBe(9);
    expect(asked).toBe(0);
  });
});

/**
 * A journaled url may be a HANDLE, not an address: the box journals a file's door
 * path (`/api/box/files/<id>`) and never the short pass it reads the bytes by, so a
 * replay any time later still reads the file. `resolveUrl` turns the handle into a
 * fetchable url at the moment of the download, and only then.
 */
describe('ensureLocalMedia — a journaled url resolved at download time', () => {
  const DOOR = '/api/box/files/22222222-2222-4222-8222-222222222222';
  const roomy = async () => ({ bavail: 1e12, bsize: 1 });

  it('a file already on disk never resolves the url', async () => {
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await writeFile(join(workspaceDir, 'files/here.mp4'), Buffer.alloc(5, 1));
    let resolved = 0;
    const got = await ensureLocalMedia(
      { path: 'files/here.mp4', url: DOOR, workspaceDir },
      { resolveUrl: async () => { resolved += 1; return 'https://p/pass'; }, statfs: roomy },
    );
    expect(got.sizeBytes).toBe(5);
    expect(resolved).toBe(0);
  });

  it('a missing file fetches what the url resolves to NOW, with the caller signal', async () => {
    const ctl = new AbortController();
    const asked: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    let fetched = '';
    const got = await ensureLocalMedia(
      { path: 'files/away.mp4', url: DOOR, workspaceDir, sizeBytes: 3 },
      {
        resolveUrl: async (url, signal) => { asked.push({ url, signal }); return 'https://p/fresh-pass'; },
        fetch: (async (url: string) => { fetched = String(url); return new Response(Buffer.alloc(3, 1)); }) as unknown as typeof fetch,
        statfs: roomy,
      },
      ctl.signal,
    );
    expect(asked).toEqual([{ url: DOOR, signal: ctl.signal }]);
    expect(fetched).toBe('https://p/fresh-pass');
    expect(got.sizeBytes).toBe(3);
  });

  it('a url that resolves to nothing is not_readable, and nothing is fetched', async () => {
    const err = await ensureLocalMedia(
      { path: 'files/refused.mp4', url: DOOR, workspaceDir, sizeBytes: 3 },
      {
        resolveUrl: async () => null,
        fetch: (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch,
        statfs: roomy,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalMediaError);
    expect((err as LocalMediaError).kind).toBe('not_readable');
  });

  it('a full disk refuses before the url is resolved: no pass is minted for a download that cannot start', async () => {
    let resolved = 0;
    const err = await ensureLocalMedia(
      { path: 'files/big.mp4', url: DOOR, workspaceDir, sizeBytes: 3 },
      { resolveUrl: async () => { resolved += 1; return 'https://p/pass'; }, statfs: async () => ({ bavail: 0, bsize: 4096 }) },
    ).catch((e: unknown) => e);
    expect((err as LocalMediaError).kind).toBe('no_space');
    expect(resolved).toBe(0);
  });
});
