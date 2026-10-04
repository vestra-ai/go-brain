/**
 * tool-search — the CLIENT-side deferred-tool rail (TOOL_SEARCH_V1).
 *
 * THE PROBLEM. A large tool surface is paid for on every turn whether or not the
 * model ever reaches for it: schemas sit in the cached prefix, and the prefix is
 * re-read every round. #2598 solved this for ONE lane by handing the problem to
 * the provider — Anthropic's `defer_loading` + `tool_search_tool_regex_20251119`
 * withhold a schema from the context window until the model searches for it. That
 * rail is strictly cheaper (a deferred schema is never billed into context at all)
 * but it exists on exactly one provider, and only on the models whose seed row
 * carries `supportsToolSearch`.
 *
 * THIS MODULE is the same affordance built out of ordinary tool calls, so every
 * OTHER lane gets it: chat-completions (GLM / DeepSeek / Grok / Kimi), Gemini,
 * OpenAI Responses, and Anthropic models that are not tool-search capable. A small
 * resident tool (`ToolSearch`) takes a query, and its RESULT carries the matched
 * tools' full JSON Schemas. From that point on those tools ride the provider tools
 * array on every subsequent request, so the model can call them normally.
 *
 * THE TWO RAILS ARE MUTUALLY EXCLUSIVE, decided per model by
 * `resolveToolSearchRail`. They must agree on WHICH tools are deferred, and they
 * do by construction: both read the SAME `RawToolOptions.deferrable` marker, which
 * is the one registry (`deferrable-ring.ts` on the product side). Neither rail ever
 * invents a set of its own.
 *
 * FOUR PROPERTIES THIS RAIL PRESERVES, each of them a way it could have gone wrong:
 *
 *   1. ADDITIVE-ONLY. The loaded set never shrinks inside a session. A tool the
 *      model loaded on turn 3 is still callable on turn 30, and a recycle rebuilds
 *      the set by replaying the journal rather than starting empty. Nothing this
 *      module does can un-register a tool.
 *   2. DISPATCH IS NEVER GATED. Withholding is a WIRE-SHAPE decision only. The raw
 *      catalog handed to the dispatcher always holds every tool, so a model that
 *      calls a deferred tool by name — from a stale schema, from `execute_code`,
 *      from a resumed transcript — still reaches a real implementation instead of
 *      "Unknown tool".
 *   3. ZERO STANDING COST WHEN THERE IS NOTHING TO FIND. With the flag off, an
 *      empty deferred ring, or every deferred tool already loaded, `ToolSearch`
 *      itself is dropped from the wire. The rail costs nothing when it can do
 *      nothing.
 *   4. LOADS APPEND. Newly loaded schemas go at the END of the tools array, never
 *      at their catalog position. Providers render tools as a prefix (Anthropic
 *      literally puts them first), so appending keeps every previously-sent byte
 *      at the same offset and costs ONE cache write per load instead of one per
 *      load plus a reshuffle of everything downstream.
 *
 * PURITY: every export here is pure except `makeToolSearchTool`'s returned
 * `execute` (which mutates the session's loaded set and calls the persistence
 * hook). No I/O, no clock, no provider SDK — the module is importable from the
 * engine, which may not reach into `transports/`.
 */
import { z } from 'zod';
import { toToolJsonSchema } from '../contract/tool-json-schema.js';
import { modelSupportsToolSearch, resolveCapabilities, type ModelProvider } from '../contract/model-capabilities.js';
import type { RawToolOptions } from '../tools/tool-types.js';
import { toolDeferEnabled, toolDeferWideEnabled, toolSearchEnabled } from '../policy/feature-flags.js';
import { COMPOSIO_TOOL_PREFIX } from '../policy/engine-constants.js';

/**
 * The resident search tool's name. Deliberately NOT prefixed (`mcp__…`): the
 * capability gate keys off prefixes, and this tool is pure metadata — it reads
 * schemas the process already holds and reaches nothing outside it.
 */
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

/** Default cap on how many tools one query may load. Mirrors the harness default. */
export const TOOL_SEARCH_DEFAULT_MAX_RESULTS = 5;

/** Hard cap per index entry, so a verbose tool description can't bloat the prefix. */
const INDEX_DESCRIPTION_MAX_CHARS = 120;

/** Which rail carries deferral for a given model. */
export type ToolSearchRail = 'native' | 'client' | 'none';

/**
 * Decide which deferral rail a model rides. THE single routing decision — never
 * hand-list models at a call site.
 *
 *   'native' — Anthropic `defer_loading` (TOOL_DEFER_V1 + a `supportsToolSearch`
 *              seed row). Strictly cheaper: deferred schemas are never billed into
 *              context, and the provider expands a `tool_reference` server-side.
 *              This module then does NOTHING; the transport owns the shaping.
 *   'client' — this module's rail. Everything the native rail cannot cover.
 *   'none'   — no deferral (both flags off, or nothing marked deferrable).
 *
 * The native rail WINS whenever it is available, which is why `client` checks it
 * first. Note the asymmetry that makes this safe: mis-routing to `none` costs only
 * the saving, while double-deferring the same tool on both rails would hide it
 * from the wire AND from the provider's search index at once.
 */
export function resolveToolSearchRail(model: string, deferredCount: number): ToolSearchRail {
  if (deferredCount <= 0) return 'none';
  if (toolDeferEnabled() && modelSupportsToolSearch(model)) return 'native';
  if (toolSearchEnabled()) return 'client';
  return 'none';
}

// ── The wide policy (TOOL_DEFER_WIDE_V1) ────────────────────────────────────

/**
 * Is the wide policy in force? Its flag is a POLICY over the two rails, not a rail of
 * its own, so it means nothing while both rails are off.
 */
export function wideDeferralActive(): boolean {
  return toolDeferWideEnabled() && (toolSearchEnabled() || toolDeferEnabled());
}

/**
 * Turn the product's `deferrableWide` proposals into `deferrable` marks while the wide
 * policy is in force. ONE seam, the head of `attachToolSearch`, so both rails, the
 * index and the dispatcher read the same widened set. Copies, never mutates: the
 * product shares tool objects with the subagent toolset, which must not widen.
 *
 * Returns the input BY REFERENCE when the policy is off or nothing is marked, so the
 * flag-off path is byte-identical and allocation-free.
 */
export function widenDeferral(tools: RawToolOptions[]): RawToolOptions[] {
  if (!wideDeferralActive()) return tools;
  if (!tools.some((t) => t.deferrableWide === true && t.deferrable !== true)) return tools;
  return tools.map((t) => (t.deferrableWide === true && t.deferrable !== true ? { ...t, deferrable: true } : t));
}

/** How the deferred-tool index lists a tool: its name alone, or name plus one sentence. */
export type ToolIndexStyle = 'names' | 'summaries';

/**
 * THE PER-PROVIDER SWITCH for the index the wide policy renders. Anthropic models get
 * names only: they read a tool's purpose off its name well, and the native rail's regex
 * search matches descriptions server-side anyway. Everyone else keeps name plus one
 * sentence until an eval says names alone are enough for them. A full record, so a new
 * provider cannot land without a decision here.
 */
const TOOL_INDEX_STYLE: Readonly<Record<ModelProvider, ToolIndexStyle>> = {
  anthropic: 'names',
  openai: 'summaries',
  google: 'summaries',
  fireworks: 'summaries',
  meta: 'summaries',
  xai: 'summaries',
  deepseek: 'summaries',
};

export function toolIndexStyle(model: string): ToolIndexStyle {
  return TOOL_INDEX_STYLE[resolveCapabilities(model).provider] ?? 'summaries';
}

// ── The index the model always sees ─────────────────────────────────────────

/**
 * A tool's first description sentence, whitespace-collapsed and hard-capped. The
 * index trades completeness for size on purpose: it exists so the model knows a
 * capability EXISTS and can name it, not so it can call it without loading.
 */
function indexSummary(description: string): string {
  const flat = description.trim().replace(/\s+/g, ' ');
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > INDEX_DESCRIPTION_MAX_CHARS
    ? `${sentence.slice(0, INDEX_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
    : sentence;
}

/**
 * How to load a tool, per rail. The NAMES are the same on both — what differs is
 * the verb, because the two rails expose different search mechanisms.
 *
 * The native rail's searcher is Anthropic's `tool_search_tool_regex`, which takes a
 * case-insensitive Python `re.search()` pattern over names, descriptions and
 * argument names, and whose matches the API expands inline on its own. There is no
 * `select:` grammar there and no result for us to render, so telling the model
 * about one would be describing a tool the wire does not carry.
 */
function loadInstructions(rail: ToolSearchRail, count: number, style: ToolIndexStyle): string {
  const preamble =
    `These ${count} tools exist and work, but their full definitions are not loaded ` +
    `right now. `;
  // A names-only list shows no descriptions, so it must not say "these descriptions".
  const against = style === 'names' ? 'tool names and descriptions' : 'these names and descriptions';
  return rail === 'native'
    ? preamble +
        `To use one, search the tool catalog for it first — the search takes a regular ` +
        `expression matched case-insensitively against ${against}, so a ` +
        `tool's own name loads exactly it and a shared prefix loads a whole group. Matches ` +
        `are loaded for you and stay callable for the rest of this session.`
    : preamble +
        `You cannot call them until you load them: calling one directly fails. To load, ` +
        `call ${TOOL_SEARCH_TOOL_NAME} with either \`select:<name>,<name>\` for exact tools, ` +
        `or plain keywords to search ${style === 'names' ? 'their names and descriptions' : 'this list'}. ` +
        `The result returns their full parameter ` +
        `schemas, and from then on they are callable for the rest of this session.`;
}

/**
 * Render the deferred-tool index — the block that rides the system prompt as the
 * `tool_search` instruction layer.
 *
 * WHY BOTH RAILS GET ONE. A model cannot search for a capability it does not know
 * exists. The client rail always had this block; the native rail did not, on the
 * theory that the provider "runs discovery itself" — but discovery is a regex the
 * MODEL has to author, and it authors it out of a catalog it was never shown. That
 * is not discovery, it is guessing, and it is how `present_output` went silent on
 * prod for three days while the wire carried it the whole time. Anthropic's own
 * guidance says to name the categories in the system prompt; Hermes ships the same
 * listing for the same reason. ~800 tokens of names in the cached prefix buys back
 * ~9,200 tokens of schemas AND the model knowing what it has.
 *
 * CACHE CONTRACT: the output is a pure function of the deferred tools' names and
 * descriptions in catalog order, plus the rail. It carries NO per-turn state — not
 * the loaded set, not a count of remaining tools, not a timestamp — so the bytes
 * change only when the deferred SET changes, which is what lets it sit inside the
 * cached prefix. Putting "you have loaded 3 of 20" here would rewrite the whole
 * system prompt on every load and cost far more than it explains.
 *
 * Returns '' for an empty set, so the layer is dropped and the prompt is
 * byte-identical to a build with no deferral at all.
 */
export function renderToolSearchIndex(
  deferred: readonly RawToolOptions[],
  rail: ToolSearchRail = 'client',
  style: ToolIndexStyle = 'summaries',
): string {
  if (deferred.length === 0) return '';
  const lines = deferred.map((t) =>
    style === 'names' && !NAMES_NEED_A_SENTENCE.has(t.name)
      ? t.name
      : `${style === 'names' ? '' : '- '}${t.name}: ${indexSummary(t.description)}`,
  );
  // Only the wide policy ever defers a Composio tool, so the line is absent from every
  // index built without it.
  const connectedApps = deferred.some((t) => t.name.startsWith(COMPOSIO_TOOL_PREFIX)) ? [CONNECTED_APPS_LINE, ''] : [];
  return [
    `# Additional tools (load before use)`,
    '',
    loadInstructions(rail, deferred.length, style),
    '',
    ...connectedApps,
    ...lines,
  ].join('\n');
}

/**
 * The pair the connected-apps line tells the model to load, by their FULL names. The line
 * once named them bare (`COMPOSIO_SEARCH_TOOLS`), a model copied that into
 * `select:COMPOSIO_SEARCH_TOOLS`, and `select:` matches exact names only, so it got "No
 * tool matched" and spent a second search on the full name (staging drill, 30 Sep).
 * Derived from the prefix so the line can only name what the catalog carries. The native
 * rail's regex search matches either spelling, since a name is a substring of itself.
 */
const COMPOSIO_SEARCH_TOOL_NAME = `${COMPOSIO_TOOL_PREFIX}COMPOSIO_SEARCH_TOOLS`;
const COMPOSIO_MULTI_EXECUTE_TOOL_NAME = `${COMPOSIO_TOOL_PREFIX}COMPOSIO_MULTI_EXECUTE_TOOL`;

/**
 * The one category a names-only list cannot convey: the Composio tool names say
 * "composio", not "email" or "calendar", so a model asked about the inbox would not know
 * to look there. Static, never per-user: a pure function of whether any Composio tool is
 * deferred. It names the pair because the search result sends the model straight to the
 * execute tool.
 */
const CONNECTED_APPS_LINE =
  `${COMPOSIO_TOOL_PREFIX}*: the user's connected apps (email, calendar, chat, documents, CRM). ` +
  `Load ${COMPOSIO_SEARCH_TOOL_NAME} and ${COMPOSIO_MULTI_EXECUTE_TOOL_NAME} together.`;

/**
 * Built-ins whose names do not say what they do, so the names-only list keeps their
 * one sentence. An exact set: every other name stays bare.
 */
const NAMES_NEED_A_SENTENCE: ReadonlySet<string> = new Set(['Weave', 'Ability']);

// ── Query matching ──────────────────────────────────────────────────────────

/** Split a query into lowercased word tokens (alphanumerics + underscore). */
function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean);
}

/**
 * Rank one tool against the query tokens. Name hits outweigh description hits
 * because the index only ever showed the model a name plus one sentence — ranking
 * mostly on description would surface tools whose advertised line the model never
 * read. Returns 0 for no match at all (the caller drops those).
 */
function score(tool: RawToolOptions, tokens: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (name.includes(token)) total += 10;
    if (description.includes(token)) total += 1;
  }
  return total;
}

/**
 * Resolve a query against the deferred set.
 *
 * THREE FORMS, in precedence order:
 *   `select:A,B`  — exact names, no ranking, no cap. The model asking for a
 *                   specific tool it read in the index must always get exactly
 *                   that tool; silently returning a "better match" would strand it.
 *   `+kw rest`    — require `kw` as a substring of the NAME, rank the survivors by
 *                   the remaining tokens.
 *   `kw kw`       — plain ranking over name + description.
 *
 * Results are capped (`maxResults`) and returned in descending score, ties broken
 * by catalog order so the same query is always answered the same way. Pure.
 */
export function matchDeferredTools(
  query: string,
  deferred: readonly RawToolOptions[],
  maxResults: number = TOOL_SEARCH_DEFAULT_MAX_RESULTS,
): RawToolOptions[] {
  const raw = query.trim();
  if (!raw) return [];

  if (raw.toLowerCase().startsWith('select:')) {
    const wanted = new Set(
      raw
        .slice('select:'.length)
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    );
    return deferred.filter((t) => wanted.has(t.name.toLowerCase()));
  }

  let pool = deferred;
  let rest = raw;
  const required = /^\+(\S+)\s*/.exec(raw);
  if (required) {
    const needle = required[1].toLowerCase();
    pool = deferred.filter((t) => t.name.toLowerCase().includes(needle));
    rest = raw.slice(required[0].length);
  }

  const tokens = tokenize(rest);
  // `+kw` alone (no ranking terms left) is a pure filter — return the survivors in
  // catalog order rather than dropping everything for scoring 0.
  if (tokens.length === 0) return pool.slice(0, Math.max(0, maxResults));

  return pool
    .map((tool, index) => ({ tool, index, points: score(tool, tokens) }))
    .filter((r) => r.points > 0)
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : a.index - b.index))
    .slice(0, Math.max(0, maxResults))
    .map((r) => r.tool);
}

// ── Result rendering ────────────────────────────────────────────────────────

/**
 * Serialize matched tools into the block the model reads as a tool definition.
 *
 * The shape mirrors the provider's own tool encoding (one JSON object per line
 * inside a `<functions>` fence) so the model parses it with machinery it already
 * has, rather than a bespoke format it has to be taught. Schemas come from
 * `toToolJsonSchema` — the #2586 serializer — so a loaded schema is byte-identical
 * to the one the tool would have shipped had it been resident. Two sources here
 * would mean the model learns one shape and the wire later sends another.
 */
export function renderToolSchemas(tools: readonly RawToolOptions[]): string {
  const entries = tools.map((t) =>
    `<function>${JSON.stringify({
      description: t.description,
      name: t.name,
      parameters: toToolJsonSchema(t.parameters),
    })}</function>`,
  );
  return `<functions>\n${entries.join('\n')}\n</functions>`;
}

// ── The session's loaded set ────────────────────────────────────────────────

/**
 * The per-session record of which deferred tools have been loaded, in FIRST-LOAD
 * order. Order is load order, not catalog order, because that is what a journal
 * replay reproduces exactly — so a recycled runner rebuilds a byte-identical tools
 * array instead of one that merely holds the same set.
 *
 * PER-SESSION BY CONSTRUCTION: created by `createToolSearchState`, never a module
 * const. One sandbox process runs many sessions; a module-level set would let one
 * task's search results widen another task's wire surface.
 */
export interface ToolSearchState {
  /** Names in first-load order. Append-only for the life of the session. */
  readonly order: string[];
  /** Membership index over `order`. */
  readonly loaded: Set<string>;
}

/** A fresh state, optionally seeded from a journal replay (recycle). */
export function createToolSearchState(seed: readonly string[] = []): ToolSearchState {
  const state: ToolSearchState = { order: [], loaded: new Set() };
  for (const name of seed) recordLoaded(state, name);
  return state;
}

/** Append one name if new. Returns true when the set actually grew. */
export function recordLoaded(state: ToolSearchState, name: string): boolean {
  if (state.loaded.has(name)) return false;
  state.loaded.add(name);
  state.order.push(name);
  return true;
}

// ── Wire shaping ────────────────────────────────────────────────────────────

/**
 * Shape one request's provider tools array: drop the deferred-and-not-yet-loaded
 * schemas, append the loaded ones, and drop `ToolSearch` itself when it has
 * nothing left to find.
 *
 * INDEX ALIGNMENT is the load-bearing assumption. Every transport's `buildTools`
 * is a `raw.map(…)`, so `providerTools[i]` is the wire shape of `tools[i]`. That
 * is what lets this stay provider-neutral: the engine never has to know whether a
 * name lives at `.name` (Anthropic / Gemini / Responses) or `.function.name`
 * (chat-completions). A transport that ever appends a provider-side tool would
 * break the alignment silently, so the lengths are CHECKED and a mismatch degrades
 * to "send everything" — the pre-flag behavior, never a wrong tool list.
 *
 * Returns the input array BY REFERENCE when the rail is inactive, so the flag-off
 * path is byte-identical and allocation-free.
 */
export function shapeToolSearchTools<T>(args: {
  tools: readonly RawToolOptions[];
  providerTools: readonly T[];
  state: ToolSearchState;
  active: boolean;
}): readonly T[] {
  const { tools, providerTools, state, active } = args;
  if (!active) return providerTools;
  if (tools.length !== providerTools.length) return providerTools;

  const deferredByName = new Map<string, T>();
  let hidden = 0;
  for (let i = 0; i < tools.length; i++) {
    if (tools[i].deferrable !== true) continue;
    deferredByName.set(tools[i].name, providerTools[i]);
    if (!state.loaded.has(tools[i].name)) hidden++;
  }

  // Property 3: nothing hidden ⇒ the search tool can only ever answer "no
  // results", so it stops occupying the prefix.
  const dropSearchTool = hidden === 0;
  const resident = providerTools.filter(
    (_, i) =>
      tools[i].deferrable !== true && !(dropSearchTool && tools[i].name === TOOL_SEARCH_TOOL_NAME),
  );

  // Loaded tools APPEND in load order (see the module docblock, property 4). A
  // name with no current definition is a tool that vanished between sessions (a
  // retired group, a flag flipped off) — skip it. `announceVanishedTools` tells the
  // model it is gone; silently sending a stale schema would not.
  const loaded = state.order
    .map((name) => deferredByName.get(name))
    .filter((t): t is T => t !== undefined);

  return [...resident, ...loaded];
}

// ── Set-change announcement ─────────────────────────────────────────────────

/**
 * The note the model gets when tools it had LOADED are gone from the catalog — an
 * MCP server that disconnected between turns, a flagged group switched off.
 *
 * SCOPED TO THE LOADED SET ON PURPOSE. A deferred tool the model never loaded can
 * vanish silently: the index is re-rendered from the CURRENT set every turn, so the
 * next prompt simply stops listing it and nothing is ever stale. A LOADED tool is
 * different — the model has its schema, believes it is callable, and will call it.
 * That is the only case a note can fix, so it is the only case that gets one.
 *
 * WHY A NOTE AND NOT A REBUILT INDEX: the index lives in the system prompt, the
 * anchor of the prefix cache. Rewriting it to delete three names would bust the
 * whole cached prefix; a one-line note in the message stream costs a few tokens and
 * says the same thing.
 *
 * Returns undefined when nothing vanished, so the caller writes nothing at all.
 */
export function announceVanishedTools(
  loaded: readonly string[],
  catalog: readonly string[],
): string | undefined {
  const live = new Set(catalog);
  const gone = loaded.filter((n) => !live.has(n));
  if (gone.length === 0) return undefined;
  return (
    `${gone.length} previously loaded tool${gone.length === 1 ? ' is' : 's are'} no longer ` +
    `available and can no longer be called: ${gone.join(', ')}.`
  );
}

// ── The tool itself ─────────────────────────────────────────────────────────

/**
 * Build the resident `ToolSearch` tool.
 *
 * The description and schema are kept deliberately small: this tool's whole
 * purpose is to be cheap enough to sit in the prefix forever, and every sentence
 * here is paid for on every turn of every session. The index block (the system
 * layer) carries the tool NAMES, so this description only has to explain the query
 * grammar.
 *
 * `getDeferred` is a THUNK, not an array. The tool is constructed while the
 * catalog it searches is still being assembled (it is a member of that catalog),
 * and on the product side the catalog is also wrapped after construction by the
 * creations ledger — so binding the array eagerly would capture a stale,
 * pre-wrapping copy.
 */
export function makeToolSearchTool(deps: {
  getDeferred: () => readonly RawToolOptions[];
  state: ToolSearchState;
  /**
   * Persist newly loaded names (journal). AWAITED before the result returns: a
   * turn can pause for a human immediately after a load, and a recycle that came
   * back without the record would narrow the model's hands mid-task.
   */
  onLoad?: (names: readonly string[]) => void | Promise<void>;
}): RawToolOptions {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      'Load the full definitions of tools listed as not-yet-loaded, so you can call them. ' +
      'Query forms: "select:Name,OtherName" loads those exact tools; "+word rest" requires ' +
      '"word" in the tool name and ranks the rest; anything else is a keyword search over ' +
      'names and descriptions. The result carries the matched tools\' parameter schemas, ' +
      'and they stay callable for the rest of the session.',
    // L2 (TOOL_CONCURRENCY_CLASSES_V1): a catalog read. Its one write is a union into the
    // loaded set, so two searches in one batch load the same tools either way; they append
    // in the order their loads were journaled, which is the order a recycle replays.
    concurrency: 'shared',
    parameters: z.object({
      query: z
        .string()
        .describe('"select:Name,Name" for exact tools, or keywords to search for a capability.'),
      max_results: z
        .number()
        .int()
        .optional()
        .describe(`Maximum tools to load from a keyword search (default ${TOOL_SEARCH_DEFAULT_MAX_RESULTS}).`),
    }),
    execute: async (args: unknown) => {
      const input = (args ?? {}) as { query?: unknown; max_results?: unknown };
      const query = typeof input.query === 'string' ? input.query : '';
      const max =
        typeof input.max_results === 'number' && Number.isFinite(input.max_results)
          ? Math.trunc(input.max_results)
          : TOOL_SEARCH_DEFAULT_MAX_RESULTS;

      const deferred = deps.getDeferred();
      const matched = matchDeferredTools(query, deferred, max);
      if (matched.length === 0) {
        const names = deferred
          .filter((t) => !deps.state.loaded.has(t.name))
          .map((t) => t.name);
        return names.length === 0
          ? 'No tools left to load: every deferred tool is already loaded and callable.'
          : `No tool matched "${query}". Loadable tools: ${names.join(', ')}.`;
      }

      const fresh = matched.map((t) => t.name).filter((n) => recordLoaded(deps.state, n));
      if (fresh.length > 0) await deps.onLoad?.(fresh);

      // The schemas come back in the RESULT — that is the whole mechanism. The
      // "now callable" line matters as much as the schemas: without it a model
      // that just read a definition still has no signal that the NEXT request will
      // carry it, and tends to re-search instead of calling.
      return [
        renderToolSchemas(matched),
        '',
        `${matched.length} tool${matched.length === 1 ? '' : 's'} loaded and callable from now on: ` +
          `${matched.map((t) => t.name).join(', ')}.`,
      ].join('\n');
    },
  };
}
