/**
 * COMPOSIO VENDOR HINTS — which slugs the sandbox must ask the vendor about.
 *
 * Composio tags every tool with MCP hints (readOnly / destructive / update /
 * create), and at the catalog the agent actually runs they are precise —
 * GMAIL_MOVE_TO_TRASH is an update, GOOGLEDRIVE_EMPTY_TRASH is destructive,
 * POSTHOG_LIST_OR_DELETE_PERSONS… is a read. Those tags ARE the classification
 * for Composio tools (sensitivity-floor `composioVerdict`); the name rule is
 * only the fallback for a slug the vendor is silent on. So every real tool a
 * call names is worth the vendor's word, once per process (the sandbox memo).
 *
 * The slug walk is the classifier's own (`collectComposioSlugs`), so the lookup
 * and the gate can never disagree on which slugs matter. Composio's own meta
 * layer (`COMPOSIO_*`, `MY_*`) has no vendor catalog entry and is skipped.
 * Pure / total.
 */
import type { ToolCall } from '../contract/harness.js';
import { collectComposioSlugs } from './side-effect-classifier.js';

/** Composio's meta tools (search / schemas / connections / executors) — not vendor catalog entries. */
const META_LAYER = /^(COMPOSIO|MY)_/;

/** The real Composio slugs of `call`, deduped, in payload order. Empty for non-Composio calls and unreadable payloads. */
export function composioSlugsNeedingHints(call: ToolCall): string[] {
  try {
    const out: string[] = [];
    for (const slug of collectComposioSlugs(call)) {
      if (!META_LAYER.test(slug) && !out.includes(slug)) out.push(slug);
    }
    return out;
  } catch {
    return [];
  }
}
