/**
 * anthropic-tool-defer — the Anthropic lane's deferred tool-loading rail
 * (TOOL_DEFER_V1).
 *
 * Tools render FIRST in Anthropic's prompt (`tools → system → messages`), so every
 * schema in the catalog occupies the cached prefix on every turn whether or not the
 * model ever calls it. Anthropic's tool search lets a schema be *registered but not
 * resident*: mark it `defer_loading: true` and it is withheld from the context
 * prefix until the model searches for it, at which point the API expands a
 * `tool_reference` inline and the tool becomes callable.
 *
 * WHAT THIS IS NOT: a removal. `defer_loading` controls what enters the CONTEXT
 * window, not what is sent. Every deferred definition still ships in `tools` on
 * every request — the API needs it server-side to run the search and expand the
 * reference. So the saving is billed input tokens, not request bytes, and request
 * bytes in fact tick slightly UP (the flags plus the search tool). The mechanism is
 * additive-only: there is no inverse operation, and no tool this rail touches ever
 * stops being callable.
 *
 * TWO HARD 400s THIS MODULE EXISTS TO PREVENT, both silent-until-production:
 *
 *   1. "At least one tool must have defer_loading=false. All tools cannot be
 *      deferred." A catalog that deferred down to nothing resident is rejected
 *      outright — so an all-deferred shape falls back to sending every tool
 *      normally rather than failing the turn.
 *   2. A tool carrying BOTH `defer_loading: true` and `cache_control` is rejected.
 *      The lane's tools-tail breakpoint therefore has to anchor on the last
 *      NON-deferred tool, not the last tool.
 *
 * Eligibility is COMPUTED (`modelSupportsToolSearch`) off the seeded capability
 * table, never a hand-list here: a model that does not accept tool search 400s on
 * every turn, so an ineligible model gets the deferral stripped rather than the
 * request broken.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { modelSupportsToolSearch } from '../contract/model-capabilities.js';

/**
 * The regex variant, not BM25. Our deferrable group is uniformly namespaced
 * (`mcp__browser-control__*`), which is exactly the case Anthropic's guidance
 * calls out — one pattern matches the whole group deterministically, with no
 * dependence on how well a natural-language query happens to rank.
 *
 * Deliberately NOT deferred (deferring the search tool is the documented cause of
 * the all-deferred 400) and deliberately carries no `cache_control` — the caller
 * places the tools-tail breakpoint after this list is shaped.
 */
export const TOOL_SEARCH_TOOL: Anthropic.ToolSearchToolRegex20251119 = {
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
};

/** A tool the request asked to defer. Narrow structural read — no cast games. */
function isDeferred(t: Anthropic.ToolUnion): boolean {
  return (t as { defer_loading?: boolean }).defer_loading === true;
}

/** Strip `defer_loading` so the tool serializes exactly as it did before the flag. */
function undefer(t: Anthropic.ToolUnion): Anthropic.ToolUnion {
  if (!isDeferred(t)) return t;
  const { defer_loading: _dropped, ...rest } = t as { defer_loading?: boolean };
  return rest as Anthropic.ToolUnion;
}

/**
 * Shape the final `tools` array for one request: decide whether the deferral marks
 * `buildTools` proposed actually ride, and prepend the search tool when they do.
 *
 * Pure and total — returns the input array by reference when nothing is deferred
 * (the flag-OFF path, byte-identical), and never mutates the caller's objects.
 *
 * The search tool goes FIRST, mirroring Anthropic's own documented example. Order
 * matters only for the cached prefix bytes, which change once by construction when
 * this flag flips.
 */
export function applyToolDeferral(
  tools: readonly Anthropic.ToolUnion[],
  model: string,
): Anthropic.ToolUnion[] {
  const deferredCount = tools.filter(isDeferred).length;

  // Flag OFF, or a catalog with nothing deferrable in it (e.g. a teammate whose
  // attenuated toolset excluded the browser ring): nothing to do.
  if (deferredCount === 0) return tools as Anthropic.ToolUnion[];

  // Model can't parse the field — strip rather than 400 the turn. This is the
  // reason eligibility is checked here (per-request, model in hand) and not in
  // buildTools, which runs once and knows no model.
  if (!modelSupportsToolSearch(model)) return tools.map(undefer);

  // 400 #1: something must stay resident. Deferring everything is rejected, and a
  // model with no resident tool and no way to reach the search tool could not act
  // anyway — so send the catalog exactly as it would have shipped unflagged.
  if (deferredCount === tools.length) return tools.map(undefer);

  return [TOOL_SEARCH_TOOL, ...tools];
}

/**
 * Place the tools-tail `cache_control` breakpoint on the last tool that can carry
 * one — the last NON-deferred entry (400 #2 above). With nothing deferred this is
 * the last element, i.e. exactly the previous behavior.
 *
 * Returns a CLONE; the caller's array and objects are never mutated. A catalog
 * that is entirely deferred cannot happen here (`applyToolDeferral` already fell
 * back), but an all-deferred input is still handled by returning it unchanged
 * rather than forcing a breakpoint onto a tool that would reject it.
 */
export function withToolsTailBreakpoint(
  tools: readonly Anthropic.ToolUnion[],
  cacheControl: Anthropic.CacheControlEphemeral,
): Anthropic.ToolUnion[] {
  let anchor = -1;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (!isDeferred(tools[i])) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) return tools as Anthropic.ToolUnion[];
  const out = [...tools];
  out[anchor] = { ...out[anchor], cache_control: cacheControl } as Anthropic.ToolUnion;
  return out;
}
