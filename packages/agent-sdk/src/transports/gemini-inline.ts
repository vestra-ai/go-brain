/**
 * Gemini lane wire-pass (media-refs S1, spec §Rule 3): url-only image blocks
 * are edge-fetched and inlined at request build — Gemini's inlineData accepts
 * only base64 bytes, and before this pass a url-only ImageBlock produced an
 * EMPTY inlineData part (the latent 400 the spec's defect #6 names).
 *
 * Contract:
 *  - flag ON, marker + empty data  → fetch bytes and inline; on fetch failure
 *    the part becomes a text placeholder NAMING the file (never an empty part).
 *  - flag ON, marker + data        → data already present; marker stripped.
 *  - flag OFF                      → marker stripped, nothing else touched —
 *    the wire stays byte-identical to today (including the dormant empty-
 *    inlineData shape; the lane is unreachable in prod without a key).
 *
 * The vestraImageUrl marker is INTERNAL (projection→transport) and is removed
 * in every flag state. Clone-only-touched-nodes throughout.
 *
 * The Interactions pass below carries a SECOND marker on the same contract
 * (VIDEO_UNDERSTANDING_V1, spec §7): `vestraMediaRef` on a video / audio / PDF
 * item, resolved to a Google Files API `uri` here — the only place a uri ever
 * enters the wire, and never the journal, because a reference expires in 48h.
 */
import type { GeminiContent, GeminiPart } from '../engine/request-validity.js';
import { mediaInlineGeminiEnabled } from '../policy/feature-flags.js';
import { fetchImageAsBase64, filenameFromUrl } from './media-bytes.js';
import { ensureGeminiFileUri, GeminiFileError } from './gemini-files.js';
import type { GeminiMediaDeps } from './gemini-files.js';
import { ensureLocalMedia, LocalMediaError, sha256File } from './media-local.js';

interface GeminiBody {
  contents: GeminiContent[];
  [key: string]: unknown;
}

function unavailableNote(url: string): string {
  const name = filenameFromUrl(url);
  return name
    ? `[image unavailable: ${name} — re-read it from files/ if needed]`
    : '[image unavailable — re-read it from files/ if needed]';
}

export async function materializeGeminiBody(body: unknown): Promise<unknown> {
  const b = body as GeminiBody;
  if (!Array.isArray(b?.contents)) return body;

  const marked: GeminiPart[] = [];
  for (const c of b.contents) {
    if (!Array.isArray(c?.parts)) continue;
    for (const p of c.parts) if (p.vestraImageUrl) marked.push(p);
  }
  if (marked.length === 0) return body;

  // Flag ON: resolve bytes for the url-only parts (data already present ⇒ no fetch).
  const fetched = new Map<string, { data: string; mediaType: string } | null>();
  if (mediaInlineGeminiEnabled()) {
    const urls = [
      ...new Set(
        marked
          .filter((p) => p.inlineData !== undefined && p.inlineData.data === '')
          .map((p) => p.vestraImageUrl!),
      ),
    ];
    await Promise.all(
      urls.map(async (url) => {
        fetched.set(url, await fetchImageAsBase64(url));
      }),
    );
  }

  const substitutePart = (p: GeminiPart): GeminiPart => {
    if (!p.vestraImageUrl) return p;
    const { vestraImageUrl: url, ...rest } = p;
    if (mediaInlineGeminiEnabled() && rest.inlineData !== undefined && rest.inlineData.data === '') {
      const bytes = fetched.get(url);
      if (bytes) {
        return { ...rest, inlineData: { mimeType: bytes.mediaType, data: bytes.data } };
      }
      // Fetch failed: a placeholder that names the file — never an empty part.
      return { text: unavailableNote(url) };
    }
    return rest as GeminiPart;
  };

  const contents = b.contents.map((c) => {
    if (!Array.isArray(c?.parts) || !c.parts.some((p) => p.vestraImageUrl)) return c;
    return { ...c, parts: c.parts.map(substitutePart) };
  });

  return { ...b, contents };
}

// ─────────────────────────────────────────────────────────────────────────────
// The SAME contract on the Interactions `input` steps shape: images live in
// user_input.content[] and function_result.result[] as {type:'image', data,
// mime_type, vestraImageUrl?}. Flag ON + url-only → fetched bytes (or a text
// placeholder naming the file); the marker is stripped in every flag state.
// ─────────────────────────────────────────────────────────────────────────────

interface InteractionsImage {
  type: 'image';
  data: string;
  mime_type: string;
  vestraImageUrl?: string;
}
/** The only kind this pass touches: an image carrying the INTERNAL url marker. */
type MarkedInteractionsImage = InteractionsImage & { vestraImageUrl: string };

/** A video / audio / PDF item still carrying the INTERNAL ref marker. */
interface MarkedInteractionsMedia {
  /** UNVALIDATED for the same reason as `path` below — the guard is presence-only. */
  type: 'video' | 'audio' | 'document' | (string & {});
  mime_type: string;
  uri: string;
  resolution?: string;
  processing?: Record<string, unknown>;
  vestraMediaRef: {
    /** `watch` only: this file's resolution THROWS rather than degrading to a
     *  placeholder note. UNVALIDATED like the rest of the marker. */
    strict?: unknown;
    /** UNVALIDATED: `isMarkedMedia` gates on the marker's presence, not its shape. */
    path?: unknown;
    url?: string;
    sha?: string;
    mimeType: string;
    /** The block's HINT (0 = unknown) — never the upload's length. */
    sizeBytes: number;
    displayName: string;
  };
}

interface InteractionsStepLike {
  type: string;
  content?: unknown[];
  result?: unknown[];
  [k: string]: unknown;
}
interface InteractionsBody {
  input: InteractionsStepLike[];
  [k: string]: unknown;
}

function isMarkedImage(c: unknown): c is MarkedInteractionsImage {
  const x = c as { type?: unknown; vestraImageUrl?: unknown } | null | undefined;
  return x?.type === 'image' && typeof x.vestraImageUrl === 'string';
}

/**
 * The marker is INTERNAL and must never reach the wire, so its mere PRESENCE is
 * what this recognises — not its shape. A malformed ref (no `path`) used to fail
 * a stricter guard and sail through with `uri: ''` AND the marker still attached;
 * it is now stripped like any other and becomes the placeholder below.
 */
function isMarkedMedia(c: unknown): c is MarkedInteractionsMedia {
  const x = c as { vestraMediaRef?: unknown } | null | undefined;
  return typeof x?.vestraMediaRef === 'object' && x.vestraMediaRef !== null;
}

/** The one field the resolution cannot proceed without. */
function markerPath(ref: MarkedInteractionsMedia['vestraMediaRef']): string | undefined {
  return typeof ref.path === 'string' && ref.path !== '' ? ref.path : undefined;
}

/** The list a step carries content items in, or undefined. */
function contentListKey(step: InteractionsStepLike): 'content' | 'result' | undefined {
  if (step.type === 'user_input' && Array.isArray(step.content)) return 'content';
  if (step.type === 'function_result' && Array.isArray(step.result)) return 'result';
  return undefined;
}

/** Why a media item never became a reference, when the lane cannot send one at all. */
const NO_MEDIA_DEPS_REASON = 'native media input is off';
/** A marker with no usable `path` — nothing to stat, nothing to upload. */
const NO_PATH_REASON = 'no file path';

/**
 * A SHORT reason the model can act on, read from a typed field — never a raw
 * `Error.message`, which arrives naming the file a second time and carrying the
 * absolute container path (`/app/workspace/files/clip.mp4`). The note the model
 * reads names the workspace-relative path exactly once.
 */
function failureReason(err: unknown): string {
  // GeminiFileError already names the file; only its reason belongs in the note.
  if (err instanceof GeminiFileError) return err.reason;
  if (err instanceof LocalMediaError) {
    if (err.kind === 'not_found') return 'file not found on disk';
    if (err.kind === 'outside_workspace') return 'path outside the workspace';
    if (err.kind === 'no_space') return 'not enough workspace disk space';
    if (err.kind === 'not_readable') return 'file could not be read';
    return `download failed (${err.status})`;
  }
  return 'unavailable';
}

/** A placeholder that NAMES the file and where it sits — never an empty item, and
 *  never silence: the model can still open the path with its ordinary tools. */
function mediaUnavailableNote(item: MarkedInteractionsMedia, reason: string): string {
  const ref = item.vestraMediaRef;
  const name = typeof ref.displayName === 'string' && ref.displayName !== '' ? ref.displayName : 'file';
  const path = markerPath(ref);
  const kind = typeof item.type === 'string' && item.type !== '' ? item.type : 'media';
  return `[${kind} unavailable: ${name} — ${reason}${path ? `; it is at ${path}` : ''}]`;
}

type MediaResolution = { uri: string; mimeType: string } | { reason: string };

/**
 * What a STRICT item throws when it cannot be resolved (MediaWatchOptions.strict).
 * The SHORT reason rides as a typed field, not inside the message: the `watch`
 * tool lives in the engine, which may not import `transports/`, so it reads
 * `err.reason` structurally rather than regexing an Error string.
 */
export class StrictMediaResolutionError extends Error {
  readonly reason: string;
  constructor(displayName: string, reason: string) {
    super(`${displayName}: ${reason}`);
    this.name = 'StrictMediaResolutionError';
    this.reason = reason;
  }
}

/**
 * The whole resolution's ceiling. Per-request bounds (gemini-files.ts) stop a
 * dead socket; this stops the OTHER shape — every request answering, slowly,
 * forever. Without it the keep-alive would talk over an upload that is never
 * going to finish, which is a nicer-looking version of the same hang.
 */
export const GEMINI_MEDIA_RESOLVE_DEADLINE_MS = 20 * 60_000;

/**
 * How many uploads may be in flight at once. A turn can attach several clips,
 * and each one holds a 32 MiB chunk in memory on its way through the SINGLE
 * ai-proxy replica every sandbox shares — so N files meant N × 32 MiB resident
 * there, decided by whoever sent the message. Two is enough to overlap a stalled
 * upload with a healthy one and small enough that nobody can aim it.
 */
const MEDIA_UPLOAD_CONCURRENCY = 2;

/** `limit` workers draining one queue — the whole semaphore, with no dependency. */
async function mapWithLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The caller's signal and the deadline as ONE signal, plus which of the two
 * fired. They mean opposite things downstream: an interrupt ends the turn, a
 * deadline is one file's failure and the turn carries on with a placeholder.
 */
function resolveDeadline(ms: number, caller?: AbortSignal) {
  const ctl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    ctl.abort();
  }, ms);
  timer.unref?.();
  const onAbort = (): void => ctl.abort();
  if (caller?.aborted) ctl.abort();
  else caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    get expired(): boolean {
      return expired;
    },
    dispose(): void {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * One resolution per unique PATH: the same clip cited twice (replay + the live
 * turn) is stat-ed, hashed and uploaded once. Two DIFFERENT paths holding the same
 * bytes still share a single upload — the client de-dups by content hash.
 *
 * Uploads run in parallel and a failure is per-file: one unreadable clip must not
 * cost the turn its other media, or its text.
 */
async function resolveMediaRefs(
  marked: MarkedInteractionsMedia[],
  deps: GeminiMediaDeps,
  signal?: AbortSignal,
): Promise<Map<string, MediaResolution>> {
  const refByPath = new Map<string, MarkedInteractionsMedia['vestraMediaRef']>();
  for (const m of marked) {
    const path = markerPath(m.vestraMediaRef);
    if (path !== undefined) refByPath.set(path, m.vestraMediaRef);
  }

  const out = new Map<string, MediaResolution>();
  const deadline = resolveDeadline(deps.resolveDeadlineMs ?? GEMINI_MEDIA_RESOLVE_DEADLINE_MS, signal);
  try {
    await mapWithLimit([...refByPath], MEDIA_UPLOAD_CONCURRENCY, async ([path, ref]) => {
      try {
        // The upload's length is the STAT's, never the block's: a sync ref may say
        // 0 (unknown) and a wrong length finalizes a truncated file.
        const { absPath, sizeBytes } = await ensureLocalMedia(
          // The block's sizeBytes is a HINT (0 = unknown) and is used for one
          // thing only: asking whether the download can fit before it starts.
          // The upload's own length still comes from the stat below.
          { path, ...(ref.url ? { url: ref.url } : {}), workspaceDir: deps.workspaceDir, sizeBytes: ref.sizeBytes },
          deps.resolveUrl ? { resolveUrl: deps.resolveUrl } : undefined,
          deadline.signal,
        );
        const sha = ref.sha ?? (await sha256File(absPath));
        const file = await ensureGeminiFileUri(
          { path: absPath, mimeType: ref.mimeType, sizeBytes, sha, displayName: ref.displayName },
          deps.files,
          deadline.signal,
        );
        out.set(path, { uri: file.uri, mimeType: file.mimeType });
      } catch (err) {
        // An interrupt is NOT a per-file failure. The turn is over, so the whole
        // request build fails rather than sending the model a placeholder for a
        // clip nobody is waiting on any more. The DEADLINE is the opposite: this
        // one file gave up, and the rest of the turn still goes out.
        if (signal?.aborted) throw err;
        const reason = deadline.expired ? 'upload timed out' : failureReason(err);
        // The error object rides as a second argument: the short reason is what
        // the MODEL reads, and collapsing an unknown throw to "unavailable" in the
        // log too would leave whoever is debugging with nothing at all.
        console.warn(`[gemini-media] ${ref.displayName} unavailable: ${reason}`, err);
        // STRICT (a `watch` call): the request is nothing but this file, so a
        // placeholder would buy a confident wrong answer at full price. Fail the
        // build instead and let the tool report the reason.
        if (ref.strict === true) throw new StrictMediaResolutionError(String(ref.displayName), reason);
        out.set(path, { reason });
      }
    });
  } finally {
    deadline.dispose();
  }
  return out;
}

export async function materializeGeminiInteractionsBody(
  body: unknown,
  mediaDeps?: GeminiMediaDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const b = body as InteractionsBody;
  if (!Array.isArray(b?.input)) return body;

  const markedImages: MarkedInteractionsImage[] = [];
  const markedMedia: MarkedInteractionsMedia[] = [];
  for (const step of b.input) {
    const key = contentListKey(step);
    if (!key) continue;
    for (const c of step[key] as unknown[]) {
      if (isMarkedImage(c)) markedImages.push(c);
      else if (isMarkedMedia(c)) markedMedia.push(c);
    }
  }
  if (markedImages.length === 0 && markedMedia.length === 0) return body;

  const fetched = new Map<string, { data: string; mediaType: string } | null>();
  if (mediaInlineGeminiEnabled()) {
    const urls = [...new Set(markedImages.filter((c) => c.data === '').map((c) => c.vestraImageUrl))];
    await Promise.all(urls.map(async (url) => { fetched.set(url, await fetchImageAsBase64(url)); }));
  }

  // No deps (flag off, or a legacy construction) ⇒ nothing is resolved and every
  // marked media item degrades to the placeholder below.
  const media =
    mediaDeps && markedMedia.length > 0
      ? await resolveMediaRefs(markedMedia, mediaDeps, signal)
      : new Map<string, MediaResolution>();

  const substitute = (c: unknown): unknown => {
    if (isMarkedImage(c)) {
      const { vestraImageUrl: url, ...rest } = c;
      if (mediaInlineGeminiEnabled() && rest.data === '') {
        const bytes = fetched.get(url);
        if (bytes) return { type: 'image', data: bytes.data, mime_type: bytes.mediaType };
        return { type: 'text', text: unavailableNote(url) };
      }
      return rest;
    }
    if (isMarkedMedia(c)) {
      const { vestraMediaRef: ref, ...rest } = c;
      const path = markerPath(ref);
      const got = path === undefined ? undefined : media.get(path);
      // The uri enters the wire HERE and nowhere else — it is never journaled.
      if (got && 'uri' in got) return { ...rest, mime_type: got.mimeType, uri: got.uri };
      const reason = got ? got.reason : path === undefined ? NO_PATH_REASON : NO_MEDIA_DEPS_REASON;
      return { type: 'text', text: mediaUnavailableNote(c, reason) };
    }
    return c;
  };

  const isMarked = (c: unknown): boolean => isMarkedImage(c) || isMarkedMedia(c);
  const input = b.input.map((step) => {
    const key = contentListKey(step);
    if (!key || !(step[key] as unknown[]).some(isMarked)) return step;
    return { ...step, [key]: (step[key] as unknown[]).map(substitute) };
  });
  return { ...b, input };
}
