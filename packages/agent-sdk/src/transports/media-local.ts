/**
 * Local media on the way to a provider Files API.
 *
 * Two jobs, both stream-only: put the bytes on local disk (they may arrive as a
 * signed url) and content-address them. A video is routinely hundreds of
 * megabytes, so nothing here ever holds a whole file in memory — a buffered
 * download of a 2 GB clip would take the runner down with it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { diskGuardRefuses } from '../policy/feature-flags.js';

/**
 * Why local bytes could not be produced, as a FIELD rather than a message to
 * parse. The caller turns this into something the model reads, and matching on
 * prose is how a reworded error silently becomes an unknown one.
 */
export class LocalMediaError extends Error {
  constructor(
    readonly kind: 'not_found' | 'download_failed' | 'outside_workspace' | 'no_space' | 'not_readable',
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'LocalMediaError';
  }
}

/**
 * Free space the box keeps whatever a download needs.
 *
 * The workspace volume is 4 GiB per user and a full one does not fail this
 * clip: it fails the WORKSPACE — the journal cannot be written, the session's
 * files cannot be saved, and the box comes back wedged rather than short of one
 * video (an ENOSPC incident on staging, which is why this is a precondition and
 * not an error path). Refusing one file before it starts is the cheap half of
 * that trade, so the margin is generous on purpose.
 */
export const MEDIA_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

/** Bytes a filesystem reports free (and its size, when it says), from `statfs`. Injectable for tests. */
export type StatfsLike = (path: string) => Promise<{ bavail: number; bsize: number; blocks?: number }>;

/**
 * The disk guard's full line (SANDBOX_DISK_GUARD_V1): with the guard on, a download may not
 * take the volume to 95% used, so the last 5% stays the person's. The engine cannot import
 * @bash/shared, so this is a copy of its FULL_LINE; apps/sandbox's disk-guard test pins the two
 * together.
 */
export const DISK_GUARD_FULL_LINE = 0.95;

/**
 * Free bytes at `dir` and the filesystem's size, or null when it will not say.
 *
 * A `statfs` that throws (an unsupported filesystem, a directory not created
 * yet) must not become a refusal: the guard exists to stop a download that
 * CANNOT fit, and "cannot measure" is not that. Unknown means proceed.
 */
async function room(dir: string, statfsFn: StatfsLike): Promise<{ free: number; cap?: number } | null> {
  const fs = await statfsFn(dir).catch(() => null);
  if (!fs) return null;
  return { free: fs.bavail * fs.bsize, ...(fs.blocks !== undefined ? { cap: fs.blocks * fs.bsize } : {}) };
}

/**
 * The most one media download may cost when nobody declared a size.
 *
 * A block's `sizeBytes` is a hint and a `.ref.yaml` omits `size_bytes` entirely
 * when it is falsy, so "unknown" is common — and an unknown transfer is bounded
 * only by what the fetcher will pull, which is this: the same 2 GiB as the
 * storage ceiling and as the sandbox prefetch's `curl --max-filesize`. Charging
 * the margin alone would let an undeclared clip start on a nearly full disk.
 */
export const MEDIA_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Is there room for `expectedBytes` plus the headroom? An unknown size (0) is
 * charged the full MEDIA_MAX_DOWNLOAD_BYTES — the only safe bound when nobody
 * declared one, and the same rule on both callers. With the disk guard on, the
 * headroom is at least the volume's last 5% (DISK_GUARD_FULL_LINE).
 */
export async function hasRoomFor(
  dir: string,
  expectedBytes: number,
  statfsFn: StatfsLike = statfs,
): Promise<{ ok: true } | { ok: false; free: number; needed: number }> {
  const fs = await room(dir, statfsFn);
  if (fs === null) return { ok: true };
  // With the disk guard on, the margin is the volume's last 5% when that is more: a download that
  // fits but leaves the volume past the full line is refused like one that does not fit.
  const guardReserve = diskGuardRefuses() && fs.cap ? Math.ceil(fs.cap * (1 - DISK_GUARD_FULL_LINE)) : 0;
  const needed = (expectedBytes > 0 ? expectedBytes : MEDIA_MAX_DOWNLOAD_BYTES) + Math.max(MEDIA_DISK_HEADROOM_BYTES, guardReserve);
  if (fs.free >= needed) return { ok: true };
  return { ok: false, free: fs.free, needed };
}

/**
 * Turn a journaled url into one that can be fetched NOW, or null when it cannot be
 * read. A journal outlives any short pass, so the product may journal a HANDLE
 * (the box door path) and mint the pass only at the moment of the download.
 */
export type MediaUrlResolver = (url: string, signal?: AbortSignal) => Promise<string | null>;

/**
 * Resolve `path` against the workspace (an absolute path is taken as given) and
 * guarantee the bytes are there: an existing file is returned as-is, otherwise
 * `url` is downloaded (through `resolveUrl` first, when the caller supplies one).
 * Returns the absolute path and the file's REAL size — every caller downstream
 * sizes its upload from a stat, never from a claim.
 */
export async function ensureLocalMedia(
  args: { path: string; url?: string; workspaceDir: string; sizeBytes?: number },
  deps?: { fetch?: typeof fetch; statfs?: StatfsLike; resolveUrl?: MediaUrlResolver },
  signal?: AbortSignal,
): Promise<{ absPath: string; sizeBytes: number }> {
  const absPath = resolve(args.workspaceDir, args.path);

  // The path comes off a journalled block, so it is user-shaped input: a
  // `../../etc/passwd` would resolve cleanly out of the workspace and be
  // uploaded to Google. Containment is checked on the RESOLVED path, which is
  // the only form that cannot be fooled by a `..` in the middle.
  const rel = relative(args.workspaceDir, absPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) {
    throw new LocalMediaError('outside_workspace', undefined, `media path escapes the workspace: ${args.path}`);
  }

  const existing = await stat(absPath).catch(() => null);
  if (existing?.isFile()) return { absPath, sizeBytes: existing.size };

  if (!args.url) {
    throw new LocalMediaError('not_found', undefined, `media file not found: ${absPath}`);
  }

  // Measured BEFORE the transfer starts, never discovered at byte 4 GiB. The
  // block's size is a hint (0 = unknown), and an unknown clip is charged the
  // full ceiling rather than the margin — the bytes are bounded by what the
  // transfer will pull, not by what the block forgot to say.
  const room = await hasRoomFor(args.workspaceDir, args.sizeBytes ?? 0, deps?.statfs ?? statfs);
  if (!room.ok) {
    throw new LocalMediaError(
      'no_space',
      undefined,
      `not enough workspace disk space for ${absPath}: ${room.free} free, ${room.needed} needed`,
    );
  }

  // Resolved only now: the file is not on disk and there is room for it, so a
  // pass is minted for a download that will actually start.
  const url = deps?.resolveUrl ? await deps.resolveUrl(args.url, signal) : args.url;
  if (!url) {
    throw new LocalMediaError('not_readable', undefined, `media url could not be resolved for ${absPath}`);
  }

  // The download is the long pole for a url-only clip, so an interrupted turn
  // must be able to end it rather than pay for the rest of the transfer.
  const res = await (deps?.fetch ?? fetch)(url, signal ? { signal } : {});
  if (!res.ok || !res.body) {
    throw new LocalMediaError(
      'download_failed',
      res.status,
      `media download failed (${res.status}) for ${absPath}`,
    );
  }

  // Stage under a PRIVATE name and rename. Staging at `<target>.part` is not
  // private: the sandbox's own prefetch (media-refs.ts) stages the same clip at
  // exactly that path and runs CONCURRENTLY by construction — it is fired
  // detached just before the turn is dispatched, and this runs inside the first
  // callModel. Whoever finished first moved or removed the other's file, so a
  // clip that was sitting right there came back "unavailable". Process id plus a
  // uuid means the two never meet.
  await mkdir(dirname(absPath), { recursive: true });
  const part = `${absPath}.${process.pid}.${randomUUID()}.part`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      createWriteStream(part),
      signal ? { signal } : {},
    );
    await rename(part, absPath);
  } catch (err) {
    // The other downloader may simply have won. Its bytes are the same bytes, so
    // a file that is now there is a SUCCESS, not the failure the throw suggests.
    const landed = await stat(absPath).catch(() => null);
    await unlink(part).catch(() => {});
    if (landed?.isFile()) return { absPath, sizeBytes: landed.size };
    throw err;
  }

  return { absPath, sizeBytes: (await stat(absPath)).size };
}

/**
 * The digest of a file we have ALREADY hashed, keyed by its identity on disk
 * (path + size + mtime). A media block that carries no `contentSha` is otherwise
 * re-hashed end to end on every model round of the turn — a 400 MB clip read
 * from disk per round, for an answer that cannot have changed unless the file
 * did. Any of the three key parts moving is a different file and re-hashes.
 *
 * Bounded and FIFO: the oldest entry goes when the map is full, so a long
 * session cannot grow it without limit.
 */
const SHA_MEMO_MAX = 256;
const shaMemo = new Map<string, string>();

/** Tests share this module-level memo; each one starts from empty. */
export function _resetSha256MemoForTest(): void {
  shaMemo.clear();
}

export interface Sha256FileDeps {
  /** Test seam: open the byte stream (so a test can count the reads). */
  readStream?: (absPath: string) => NodeJS.ReadableStream;
}

/** Streaming sha256 of a file, hex. The cache key for a provider file reference. */
export async function sha256File(absPath: string, deps?: Sha256FileDeps): Promise<string> {
  const st = await stat(absPath);
  const key = `${absPath}:${st.size}:${st.mtimeMs}`;
  const memo = shaMemo.get(key);
  if (memo !== undefined) return memo;

  const hash = createHash('sha256');
  await pipeline((deps?.readStream ?? createReadStream)(absPath), hash);
  const digest = hash.digest('hex');

  if (shaMemo.size >= SHA_MEMO_MAX) {
    const oldest = shaMemo.keys().next();
    if (!oldest.done) shaMemo.delete(oldest.value);
  }
  shaMemo.set(key, digest);
  return digest;
}
