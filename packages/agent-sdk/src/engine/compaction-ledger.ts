/**
 * compaction-ledger — the trigger's measurement of the projected messages, moved out of
 * compaction-run.ts under its size ratchet (COMPACTION_POST_TURN_V1 added the post-turn
 * check beside it). Body and doc unchanged.
 */
import type { JournalEntry } from '../contract/journal.js';
import type { FrozenElision } from './context-elision.js';
import { wireMessages, measureWireMessages } from './context-elision.js';
import { projectTokenCount } from '../kernel/index.js';
import { compactionV2Enabled } from '../policy/feature-flags.js';

/**
 * The ledger's `messages` bucket.
 *
 * V2 ON: the WIRE view, always — `wireMessages` elided when CONTEXT_ELISION_V1 is
 * on, the raw projection when it is off — with images charged either way, because
 * images ride the wire either way.
 *
 * V2 OFF: `measureWireMessages`, unchanged, including its flag-off branch through
 * the prune tier.
 *
 * THE PRUNE TIER DIES HERE. `pruneToolResults` only ever shrank a COPY used for
 * this measurement: the compaction body was handed the ORIGINAL projection and
 * every wire projection re-projected the journal raw, so the tier lowered the
 * number the trigger read while the full bytes still shipped — compaction fired
 * LATER than it should and the prune bought back no context at all. Under V2 the
 * measurement is the wire view by construction, so there is nothing left for a
 * prune tier to do that elision does not already do better (reversibly, with the
 * full bytes spilled to disk, on a cache-safe quantized cut). Keeping both would
 * mean two cut points to hold coherent; the config field survives only so the
 * flag-off path stays byte-identical.
 */
export function measureLedger(
  messages: JournalEntry[],
  elision: FrozenElision | null,
  pruneCfg: { ageThresholdEntries: number; sizeThresholdTokens: number },
): number {
  if (!compactionV2Enabled()) return measureWireMessages(messages, elision, pruneCfg);
  return projectTokenCount(wireMessages(messages, elision), { countImages: true }).messages;
}
