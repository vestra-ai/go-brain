/**
 * tool-search-session — the per-run wiring of the client-side deferred-tool rail.
 *
 * `tool-search.ts` is the pure half: routing, matching, index rendering, wire
 * shaping. This is the half that touches the run — it replays the loaded set off
 * the journal, tells the model when a loaded tool has vanished, registers the
 * `ToolSearch` tool into the catalog, and hands back the closure the loop calls to
 * get the current wire shape. Split so the pure half stays trivially testable and
 * `native-harness.ts` (which only ratchets down) grows by a call, not a block.
 *
 * ONE CALL SITE: the harness prologue, once per run.
 */
import type { Journal } from '../kernel/journal/journal.js';
import type { HarnessContext } from '../contract/harness.js';
import type { NativeConfigLike } from './native-config-like.js';
import type { RawToolOptions } from '../tools/tool-types.js';
import type { ProviderTool } from './transport.js';
import { appendToolSearchLoaded, readToolSearchLoaded } from './native-journal.js';
import {
  announceVanishedTools,
  createToolSearchState,
  makeToolSearchTool,
  renderToolSearchIndex,
  resolveToolSearchRail,
  shapeToolSearchTools,
  toolIndexStyle,
  wideDeferralActive,
  widenDeferral,
  type ToolSearchRail,
} from './tool-search.js';

export interface ToolSearchSession {
  /**
   * The catalog the DISPATCHER sees. Always holds every tool, plus `ToolSearch`
   * itself when the client rail is active. Deferral is a wire-shape decision, so
   * this is never narrowed — a call arriving for a withheld tool still finds a real
   * implementation instead of "Unknown tool".
   */
  tools: RawToolOptions[];
  /**
   * The tools array as it rides the WIRE right now. Returns the transport's own
   * array BY REFERENCE when the rail is inactive, so the flag-off path is
   * byte-identical and allocation-free.
   *
   * A FUNCTION, not a value: the loaded set grows mid-turn, and every consumer (the
   * round call, the context meter, the compaction ledger, the off-loop sweep) must
   * see the same current shape. A snapshot taken at prologue time would make the
   * ledger measure bytes the wire no longer carries and would cost the sweep its
   * byte-identical-prefix cache hit.
   */
  wireTools: () => ProviderTool[];
  /**
   * The system prompt the run sends: the caller's, unchanged, unless the wide policy
   * (TOOL_DEFER_WIDE_V1) is in force, in which case the deferred-tool index is appended.
   */
  system: string;
  /** The wide policy's index exactly as appended to `system`; '' when none rides it (CONTEXT_APPEND_V1 freezes it). */
  toolIndex: string;
}

/**
 * The wide policy's index, appended to the END of the system prompt. It is rendered
 * HERE, from the built catalog, because the wide deferred set holds tools only a build
 * knows (the Composio tools arrive with the MCP connect), and the product assembles
 * its prompt before that. The product drops its own `tool_search` layer while the
 * policy is in force, so there is exactly one index.
 *
 * CACHE: a pure function of the deferred set and the model, never of the loaded set,
 * so it is byte-stable for a given installed set; at the end, it sits past the fleet
 * boundary and the session-frozen tail, and neither moves.
 */
function wideIndex(deferred: readonly RawToolOptions[], rail: ToolSearchRail, model: string): string {
  if (!wideDeferralActive() || rail === 'none') return '';
  return renderToolSearchIndex(deferred, rail, toolIndexStyle(model)) || '';
}

/**
 * Wire the rail for one run, and build the provider tools array.
 *
 * `transport.buildTools` lives HERE rather than at the call site because the
 * shaping depends on its result being INDEX-ALIGNED with `tools` — every lane's
 * buildTools is a `raw.map`, which is what lets the shaping stay provider-neutral.
 * Owning both sides of that invariant in one function is what keeps it true; split
 * across two files it would be a comment.
 *
 * Inert on every path but `client`: with the flag off, nothing deferrable, or a
 * model riding Anthropic's server-side rail, the catalog is untouched and
 * `wireTools` is the transport's array by reference.
 */
export async function attachToolSearch(
  ctx: HarnessContext<NativeConfigLike>,
  built: RawToolOptions[],
  journal: Journal | undefined,
  transport: { buildTools(raw: RawToolOptions[]): ProviderTool[] },
  baseSystem = '',
): Promise<ToolSearchSession> {
  // TOOL_DEFER_WIDE_V1: widened FIRST, so the native rail's defer_loading marks
  // (transport.buildTools), the client rail and the index all read one set.
  const catalog = widenDeferral(built);
  const deferred = catalog.filter((t) => t.deferrable === true);
  const rail = resolveToolSearchRail(ctx.model, deferred.length);
  const toolIndex = wideIndex(deferred, rail, ctx.model);
  const system = toolIndex ? (baseSystem ? `${baseSystem}\n\n${toolIndex}` : toolIndex) : baseSystem;
  if (rail !== 'client') {
    const providerTools = transport.buildTools(catalog);
    observeWire(ctx, providerTools);
    return { tools: catalog, wireTools: () => providerTools, system, toolIndex };
  }

  const state = createToolSearchState(await readToolSearchLoaded(journal));

  // A tool the model loaded in an earlier turn can be GONE now (a disconnected MCP
  // server, a group whose flag flipped off). The re-rendered index handles that for
  // tools it never loaded; only a loaded one needs telling, because only that one
  // will be called. See announceVanishedTools.
  const vanished = announceVanishedTools(state.order, catalog.map((t) => t.name));
  if (vanished !== undefined) await journal?.appendWorldDeltaBreadcrumb(vanished);

  // APPENDED LAST so every other tool keeps its catalog offset — the whole resident
  // prefix stays byte-stable as tools load in behind it. `getDeferred` is a thunk
  // over `tools` because the search tool is a member of the array it searches.
  const tools: RawToolOptions[] = [
    ...catalog,
    makeToolSearchTool({
      getDeferred: () => tools.filter((t) => t.deferrable === true),
      state,
      onLoad: (names) => appendToolSearchLoaded(journal, ctx, names),
    }),
  ];

  const providerTools = transport.buildTools(tools);
  const wireTools = (): ProviderTool[] =>
    shapeToolSearchTools({ tools, providerTools, state, active: true }) as ProviderTool[];
  observeWire(ctx, wireTools());
  return { tools, wireTools, system, toolIndex };
}

/**
 * Hand the first request's tools array to the product's observer (NativeConfig.onWireTools),
 * the array itself, never a copy or a re-derivation. Observation only: a throwing observer
 * must never cost the run its tools, so it is contained here.
 */
function observeWire(ctx: HarnessContext<NativeConfigLike>, wire: readonly ProviderTool[]): void {
  try {
    ctx.config.onWireTools?.(wire, ctx.model);
  } catch {
    // observation only
  }
}
