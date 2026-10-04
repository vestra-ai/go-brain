/**
 * fixtures: the harness bench's inputs, meaning the recorded runs, the lanes they replay
 * through (one per wire format, each a model family), and the product catalog.
 *
 * The catalog (`fixtures/catalog.json`) is the real tool list and system layers a
 * standard cloud session assembles, captured as data by
 * `node scripts/prompt-surface/measure.mjs --snapshot packages/agent-sdk/bench/fixtures/catalog.json`
 * so this package never imports apps/sandbox. Refresh it when the catalog or the soul
 * changes; its header names the flag set it was built under.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleInstructionStack, type InstructionLayer } from '../src/contract/instruction-stack.js';
import { parseFixture } from '../src/engine/replay/fixture.js';
import { ReplayTools } from '../src/engine/replay/replay-tools.js';
import {
  renderToolSearchIndex,
  resolveToolSearchRail,
  wideDeferralActive,
  widenDeferral,
  type ToolSearchRail,
} from '../src/engine/tool-search.js';
import type { RawToolOptions } from '../src/tools/tool-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPLAY_DIR = join(HERE, '../src/__fixtures__/replay');
export const CATALOG_PATH = join(HERE, 'fixtures/catalog.json');

export type WireFormat =
  | 'anthropic_messages'
  | 'openai_responses'
  | 'openai_chat_completions'
  | 'gemini'
  | 'gemini_interactions';

export interface Lane {
  wire: WireFormat;
  model: string;
  family: string;
}

/**
 * One lane per wire format. The model is the family's working default, which decides
 * the rail: Sonnet 5.5 carries `supportsToolSearch` (Anthropic's server-side
 * defer_loading when TOOL_DEFER_V1 is on); every other lane rides the client rail.
 * The legacy generateContent dialect has no seeded model, so it borrows Gemini 3.8
 * Flash's id; its body ignores model capabilities.
 */
export const LANES: readonly Lane[] = [
  { wire: 'anthropic_messages', model: 'claude-sonnet-5-5', family: 'Claude' },
  { wire: 'openai_responses', model: 'gpt-5.6-luna', family: 'GPT' },
  { wire: 'openai_chat_completions', model: 'deepseek-v4-flash', family: 'DeepSeek' },
  { wire: 'gemini', model: 'gemini-3.8-flash', family: 'Gemini (generateContent)' },
  { wire: 'gemini_interactions', model: 'gemini-3.8-flash', family: 'Gemini' },
];

export interface Fixture {
  name: string;
  path: string;
}

/** The recorded runs, in name order; `only` keeps those whose name starts with a prefix. */
export function listFixtures(only: readonly string[] = []): Fixture[] {
  return readdirSync(REPLAY_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => ({ name: f.replace(/\.jsonl$/, ''), path: join(REPLAY_DIR, f) }))
    .filter((f) => only.length === 0 || only.some((p) => f.name.startsWith(p)));
}

type CatalogTool = Omit<RawToolOptions, 'execute'>;

export interface Catalog {
  source: Record<string, unknown>;
  systemLayers: InstructionLayer[];
  tools: CatalogTool[];
  /** Per catalog-input flag (TOOL_DESC_TRIM_V1): the tool entries its ON build changes. */
  variants?: Record<string, CatalogTool[]>;
}

export function loadCatalog(path: string = CATALOG_PATH): Catalog {
  return JSON.parse(readFileSync(path, 'utf8')) as Catalog;
}

/**
 * The tools every run carries: the catalog, then a replay stub for each recorded tool
 * the catalog lacks (a connector tool such as a Composio send). The stubs are the
 * union over EVERY recording, so the standing prefix is the same for every run of a
 * lane. `execute` is replaced by the replay's own answerer (ReplayTools.wrap).
 *
 * `flagsOn` swaps in each listed flag's recorded variant entries (catalog-input flags the
 * bench cannot rebuild under; scripts/prompt-surface/catalog-snapshot.ts), by name and in
 * place, so the catalog order (a cache prefix) is the same in both passes.
 */
export function benchTools(catalog: Catalog, flagsOn: readonly string[] = []): { tools: RawToolOptions[]; stubbed: string[] } {
  const swap = new Map<string, CatalogTool>();
  for (const flag of flagsOn) for (const t of catalog.variants?.[flag] ?? []) swap.set(t.name, t);
  const tools: RawToolOptions[] = catalog.tools.map((t) => ({ ...(swap.get(t.name) ?? t), execute: () => '' }));
  const have = new Set(tools.map((t) => t.name));
  const recorded = listFixtures().flatMap((f) => parseFixture(readFileSync(f.path, 'utf8')).entries);
  // A stub stands in for a connector tool, which the product marks for the wide policy
  // like every tool outside its resident core (apps/sandbox deferrable-ring.ts).
  const stubs = new ReplayTools(recorded)
    .stubsFor()
    .filter((t) => !have.has(t.name))
    .map((t) => ({ ...t, deferrableWide: true }));
  return { tools: [...tools, ...stubs], stubbed: stubs.map((t) => t.name) };
}

/**
 * The system prompt the product assembles for this model: the catalog's layers plus
 * the `tool_search` index layer when a deferral rail is active. Same pieces as
 * apps/sandbox buildToolSearchIndexBlock + buildNativeSystemPrompt (the index lists
 * the catalog's deferred tools in catalog order, which the product's registry test
 * pins). Flags are read when this is called, so call it inside the flag scope.
 */
export function systemPromptFor(tools: readonly RawToolOptions[], catalog: Catalog, model: string): {
  system: string;
  rail: ToolSearchRail;
} {
  const deferred = widenDeferral([...tools]).filter((t) => t.deferrable === true);
  const rail = resolveToolSearchRail(model, deferred.length);
  // Under TOOL_DEFER_WIDE_V1 the product drops this layer and the engine appends the
  // index to the system prompt from the built catalog, inside the replayed run.
  const index = rail === 'none' || wideDeferralActive() ? '' : renderToolSearchIndex(deferred, rail).trim();
  const layers: InstructionLayer[] = index
    ? [...catalog.systemLayers, { id: 'tool_search', text: index, static: true }]
    : catalog.systemLayers;
  return { system: assembleInstructionStack(layers, 'native'), rail };
}
