import type { JournalEntry } from '../../contract/journal.js';
import type { ImageBlock, TextBlock } from '../../contract/blocks.js';
import { CHECKPOINT_KEY } from './checkpoint.js';

/**
 * The mirror-only copy of a journal entry (moved out of journal.ts, which sits over
 * its size baseline). The local JSONL always keeps the full entry.
 *
 * PASTED IMAGES NEVER RIDE THE MIRROR (file access Train A, R2(b) fix round). A user
 * entry journals its images as base64 (so a replay needs no network), and a ~1 MB
 * image is ~1.33 M chars: past the entry cap, the whole entry, WORDS INCLUDED, used
 * to become a `system` note, and a fresh machine hydrated a conversation with the
 * turn missing. So, before any size check, every image block of a USER entry becomes
 * one small text block naming the file (filename, file id, content hash when known).
 * The words always survive, no image bytes (or legacy url passes) sit at rest in the
 * mirror, and the hydrated entry is plain text every projection replays. The agent
 * can still read the file by id (its `.ref.yaml` on the volume, the box door). Every
 * other entry type is untouched here and clamped exactly as before.
 */
export function mirrorImagePlaceholder(b: ImageBlock): TextBlock {
  const parts = [b.filename || 'image', ...(b.fileId ? [`file ${b.fileId}`] : []), ...(b.contentSha ? [`sha256 ${b.contentSha}`] : [])];
  return { type: 'text', text: `[image: ${parts.join(', ')} (not stored in the mirror)]` };
}

function withoutUserImageBytes(entry: JournalEntry): JournalEntry {
  const p = entry.payload;
  if (p.type !== 'user' || !p.blocks.some((b) => b.type === 'image')) return entry;
  return { ...entry, payload: { ...p, blocks: p.blocks.map((b) => (b.type === 'image' ? mirrorImagePlaceholder(b) : b)) } };
}

/**
 * Mirror-only clamp for an oversize entry — keeps the FULL envelope (seq/uuid/parentUuid
 * chain intact, shape validation passes on hydrate) and shrinks only the bulky payload,
 * exactly like the server's store-time clamp: a tool_result keeps type/toolUseId/isError
 * and gets ONE small text block (the slot stays ANSWERED — no orphan tool_use). Any other
 * oversize type degrades to a `system` note, and the type change is the POINT: a stub that
 * keeps the original `type` with the bulky fields dropped sails through the hydrate gate —
 * validateJournalEntry checks only that `payload.type` is a known type, never the variant's
 * internals — and then breaks the consumers that read those fields one layer later (the
 * 2026-07-15 computeSuspendedToolUseIds crash, whose comment in kernel/interaction/
 * strategy.ts still names "the mirror's legacy oversize stub"). A `system` payload carries
 * exactly one required field, which this clamp supplies, so every consumer stays safe.
 */
export function clampForMirror(original: JournalEntry, maxBytes: number): JournalEntry {
  const entry = withoutUserImageBytes(original);
  const size = JSON.stringify(entry).length;
  if (size <= maxBytes) return entry;
  const p = entry.payload;
  // R2: a journal checkpoint only caches entries the mirror holds row by row. Oversize it keeps its
  // type with no data (non-context; checkpointOf reads it as not whole, so that journal rebuilds in
  // full), never a `system` note, which is CONTEXT and would sit in the model's view after every
  // compaction of a journal hydrated from the mirror.
  if (p.type === 'custom' && p.key === CHECKPOINT_KEY) return { ...entry, payload: { type: 'custom', key: p.key, data: null } };
  if (p.type === 'tool_result') {
    return {
      ...entry,
      payload: {
        type: 'tool_result',
        toolUseId: p.toolUseId,
        isError: p.isError ?? false,
        blocks: [{ type: 'text', text: `[tool result omitted from mirror: ${size} bytes exceeds ${maxBytes}; the local journal keeps the full entry]` }],
      },
    };
  }
  return { ...entry, payload: { type: 'system', event: `[entry omitted from mirror: ${p.type} payload of ${size} bytes exceeds ${maxBytes}; the local journal keeps the full entry]` } };
}

// The mirror window, moved out of journal.ts (over its size baseline) with its three limits.

/** A single entry above this is clamped for the MIRROR only (the local JSONL keeps the
 *  full entry) so a >1 MiB entry can never wedge the queue. Must stay <= the server's
 *  own store-time cap (`MAX_ENTRY_BYTES = 250_000` in
 *  apps/server/src/handlers/kernel-journal-mirror-routes.handler.ts): anything in
 *  between would sail past this clamp only to be clamped by `capEntry` on arrival,
 *  which is the same loss with none of the control over what survives. */
export const MIRROR_MAX_ENTRY_BYTES = 250 * 1000;
/** P2.0 — mirror flush window: matches the server endpoint's MAX_ROWS. */
const MIRROR_BATCH_ROWS = 200;
/** Byte budget per mirror POST, measured as JSON.stringify length (UTF-16 units: equal
 *  to bytes for the ASCII that dominates journal JSON, at worst 3x for multibyte text —
 *  so a full window still lands far under the server route's 4 MiB bodyLimit). A window
 *  that would exceed it is split; the old 200-row-only window could reach tens of MB and
 *  413'd forever (head-requeue re-sent the same bytes every turn boundary). */
const MIRROR_BATCH_BYTES = 768 * 1024;

/** The next mirror window: <= MIRROR_BATCH_ROWS rows AND <= MIRROR_BATCH_BYTES serialized
 *  bytes (always at least one entry). `batch` = the original pending entries (for the
 *  splice-on-success); `wire` = what is sent (oversize entries clamped). A `whole` store
 *  (JOURNAL_LOSSLESS_MIRROR_V1) is sent the entries unclamped and uploads every one the clamp
 *  would change, so its window is budgeted by WHOLE size: the bytes one awaited window uploads
 *  stay under MIRROR_BATCH_BYTES (a single bigger entry rides alone), and the rest of a
 *  backlog rides the unref'd chain, never the turn's end. */
export function mirrorWindow(pending: readonly JournalEntry[], whole: boolean): { batch: JournalEntry[]; wire: JournalEntry[] } {
  const batch: JournalEntry[] = [];
  const wire: JournalEntry[] = [];
  let bytes = 0;
  for (const entry of pending) {
    if (batch.length >= MIRROR_BATCH_ROWS) break;
    const sendable = whole ? entry : clampForMirror(entry, MIRROR_MAX_ENTRY_BYTES);
    const size = JSON.stringify(sendable).length;
    if (batch.length > 0 && bytes + size > MIRROR_BATCH_BYTES) break;
    batch.push(entry);
    wire.push(sendable);
    bytes += size;
  }
  return { batch, wire };
}
