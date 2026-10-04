/**
 * Media-refs S0 — applyMediaRail: the PHYSICS bound on request media.
 *
 * pruneScreenshots (policy, keep-2) never touches USER-uploaded images. With
 * SCREENSHOT_PRUNE_CACHE_V1 it bounds only the host's screenshot tools, so Read-tool
 * images are exempt too; without it, it counts EVERY image-bearing tool_result, a Read
 * of a PNG included (prune-screenshots.ts). User images are the exact class behind the
 * 07-30 stamp 413. This pass is the
 * guarantee layer: it bounds ALL image blocks the model would see, by COUNT and
 * by (approximate wire) BYTES, so an oversized request is structurally
 * impossible. Spec: docs/superpowers/specs/2026-08-02-media-refs-architecture-design.md Rule 4.
 *
 * Runs LAST in journal.project()'s pipeline (after pruneScreenshots/pruneSnapshots)
 * — and the native engine re-projects before EVERY model call, so this is
 * request-build enforcement on all four lanes at once.
 *
 * Budgets: keep-all until breach (the prompt-cache prefix is never busted for
 * tidiness). On breach: evict oldest-first, in ONE chunk down to 75% of the
 * breached budget (hysteresis), never touching the newest RAIL_PROTECT_NEWEST
 * image instances. Placeholder carries the filename when the block has a URL —
 * restorable per the Manus invariant (the agent can re-read the file).
 *
 * PURITY CONTRACT (mirrors prune-screenshots.ts):
 *   - ReadonlyArray in; SAME reference out when under budget (identity).
 *   - No env, no clock, no FS, never throws; degenerate input tolerated.
 *   - NEVER deletes an entry (pairing survives on every wire format); only
 *     image blocks inside 'user' / 'tool_result' payloads are stubbed to text.
 *   - Idempotent: placeholders aren't images, so a railed projection re-rails
 *     to identity.
 */

import type { JournalEntry } from '../../contract/journal.js';
import type { ContentBlock, ImageBlock } from '../../contract/blocks.js';

export const RAIL_MAX_IMAGES = 20;
export const RAIL_MAX_MEDIA_BYTES = 24 * 1024 * 1024;
export const RAIL_PROTECT_NEWEST = 3;
const EVICT_TO_FRACTION = 0.75;

/**
 * SCREENSHOT_PRUNE_CACHE_V1 (#4357 review): the rail's policy when the flag is on. Absent ⇒ the
 * legacy rail below, byte-identical.
 *
 * WHY. With the flag on, Read images are no longer stubbed by the screenshot prune, so the rail is
 * what bounds them, and two things in the legacy rail no longer hold up:
 *   - its byte budget (RAIL_MAX_MEDIA_BYTES, 24 MiB of base64) sits above Gemini's 20 MB inline
 *     request cap, and its protected newest three can exceed any budget on their own;
 *   - its "evict to 75%" hysteresis has no memory: the rail is a pure function of the projection,
 *     so past 20 images it keeps the newest 15 and EVERY new image moves the cut, an edit behind
 *     the cache breakpoint on every Read.
 * WITH A POLICY:
 *   - the byte budget is `maxBytes` (RAIL_INLINE_SAFE_BYTES: under the smallest inline cap with
 *     room for the text), and it binds the newest images too, keeping at least the newest one
 *     whenever it alone fits, so a request's images never exceed it;
 *   - evictions move in whole batches of `batch`: by count the oldest `ceil((n - 20) / batch) *
 *     batch` go (the kept count sits between 20 - batch + 1 and 20), and by bytes the fewest that
 *     fit, rounded up to a batch, so the cut moves once a batch of images, not once an image.
 */
export interface MediaRailPolicy {
  maxBytes: number;
  batch: number;
}
/** The smallest request cap among the lanes that send images inline: Gemini's 20 MB. */
export const SMALLEST_INLINE_REQUEST_CAP = 20_000_000;
/** What a request's text (system, tools, history) may take beside its images. */
export const REQUEST_TEXT_HEADROOM = 6 * 1024 * 1024;
/** The policy's byte budget (base64 chars ride verbatim on the wire): images + text stay under every lane's cap. */
export const RAIL_INLINE_SAFE_BYTES = SMALLEST_INLINE_REQUEST_CAP - REQUEST_TEXT_HEADROOM;
/** The policy's eviction batch: by count, once every 6 images (the legacy rail's 75% target, made stable). */
export const RAIL_BATCH = 6;

interface ImageInstance {
  entryIdx: number;
  blockIdx: number;
  weight: number;
}

/** Approximate wire weight: base64 chars ride verbatim in a JSON body; a
 *  url-sourced block weighs only its URL string. */
function imageWeight(b: ImageBlock): number {
  return b.data && b.data.length > 0 ? b.data.length : (b.url?.length ?? 0);
}

function imageName(b: ImageBlock): string | undefined {
  // Media-refs S2: prefer the ref's display filename (the name the user and
  // the files/ tree actually know) over the storage-UUID url basename.
  if (b.filename) return b.filename;
  if (!b.url) return undefined;
  try {
    const path = new URL(b.url).pathname;
    const base = path.slice(path.lastIndexOf('/') + 1);
    return base || undefined;
  } catch {
    return undefined;
  }
}

function placeholderText(name: string | undefined): string {
  return name
    ? `[image evicted from context to keep this request under the media budget — re-read ${name} if needed]`
    : '[image evicted from context to keep this request under the media budget]';
}

function blocksOf(e: JournalEntry): ContentBlock[] | undefined {
  const p = e.payload as { type?: string; blocks?: unknown };
  if (p.type !== 'user' && p.type !== 'tool_result') return undefined;
  return Array.isArray(p.blocks) ? (p.blocks as ContentBlock[]) : undefined;
}

/** SCREENSHOT_PRUNE_CACHE_V1: the oldest images to evict, in whole batches, with the byte budget binding all. */
function batchedEvictions(instances: ImageInstance[], totalWeight: number, policy: MediaRailPolicy): Set<ImageInstance> {
  const n = instances.length;
  const batch = Number.isFinite(policy.batch) && policy.batch >= 1 ? Math.floor(policy.batch) : 1;
  const up = (k: number) => Math.ceil(k / batch) * batch;
  const over = n - RAIL_MAX_IMAGES;
  const byCount = over > 0 ? Math.min(up(over), n - 1) : 0;
  let need = 0;
  for (let rest = totalWeight; need < n && rest > policy.maxBytes; need++) rest -= instances[need].weight;
  // Rounded up to a batch, but never past the newest when the newest alone fits (need < n).
  const byBytes = need === 0 ? 0 : Math.max(need, Math.min(up(need), n - 1));
  return new Set(instances.slice(0, Math.max(byCount, byBytes)));
}

export function applyMediaRail(entries: ReadonlyArray<JournalEntry>, policy?: MediaRailPolicy): JournalEntry[] {
  // Pass 1 — every image block instance, oldest → newest.
  const instances: ImageInstance[] = [];
  let totalWeight = 0;
  for (let i = 0; i < entries.length; i++) {
    const blocks = blocksOf(entries[i]);
    if (!blocks) continue;
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[j] as { type?: string } | null;
      if (b == null || b.type !== 'image') continue;
      const w = imageWeight(blocks[j] as ImageBlock);
      instances.push({ entryIdx: i, blockIdx: j, weight: w });
      totalWeight += w;
    }
  }

  // Under both budgets → identity (the common case, and the cache-stable one).
  if (instances.length <= RAIL_MAX_IMAGES && totalWeight <= (policy ? policy.maxBytes : RAIL_MAX_MEDIA_BYTES)) {
    return entries as JournalEntry[];
  }

  // Breach — evict oldest-first (skipping the protected newest) until BOTH
  // hysteresis targets hold or only protected instances remain.
  const evict = policy ? batchedEvictions(instances, totalWeight, policy) : new Set<ImageInstance>();
  if (!policy) {
    const countTarget = Math.floor(RAIL_MAX_IMAGES * EVICT_TO_FRACTION);
    const bytesTarget = Math.floor(RAIL_MAX_MEDIA_BYTES * EVICT_TO_FRACTION);
    const protectedFrom = Math.max(0, instances.length - RAIL_PROTECT_NEWEST);
    let count = instances.length;
    let weight = totalWeight;
    for (let k = 0; k < protectedFrom && (count > countTarget || weight > bytesTarget); k++) {
      evict.add(instances[k]);
      count -= 1;
      weight -= instances[k].weight;
    }
  }
  if (evict.size === 0) return entries as JournalEntry[]; // only protected instances exist

  // Pass 2 — rebuild, cloning only touched entries.
  const evictByEntry = new Map<number, Set<number>>();
  for (const inst of evict) {
    let set = evictByEntry.get(inst.entryIdx);
    if (!set) evictByEntry.set(inst.entryIdx, (set = new Set()));
    set.add(inst.blockIdx);
  }
  const result: JournalEntry[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const evictIdx = evictByEntry.get(i);
    if (!evictIdx) {
      result[i] = e;
      continue;
    }
    const p = e.payload as { blocks: ContentBlock[] };
    const stubbed: ContentBlock[] = p.blocks.map((b, j) =>
      evictIdx.has(j)
        ? ({ type: 'text', text: placeholderText(imageName(b as ImageBlock)) } as ContentBlock)
        : b,
    );
    result[i] = { ...e, payload: { ...p, blocks: stubbed } } as JournalEntry;
  }
  return result;
}
