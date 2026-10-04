/**
 * TOOL_DEFER_WIDE_V1 — the wide deferral policy, engine half (harness to nine T1b).
 *
 * The product marks every tool outside its resident core `deferrableWide`, always; this
 * file proves the engine turns those marks into deferral only while the policy is in
 * force, on both rails, that a deferred connector tool is still found and callable, that
 * the index it renders is names only for Anthropic models, and that with the flag off
 * every wire format builds the same bytes as a catalog that never carried the marker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HarnessContext } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { attachToolSearch } from '../tool-search-session.js';
import {
  TOOL_SEARCH_TOOL_NAME,
  renderToolSearchIndex,
  toolIndexStyle,
  wideDeferralActive,
  widenDeferral,
} from '../tool-search.js';
import type { ProviderTool } from '../transport.js';

function tool(name: string, description: string, marks: Partial<RawToolOptions> = {}): RawToolOptions {
  return {
    name,
    description,
    parameters: z.object({ target: z.string().describe('what to act on') }),
    execute: async () => `ran ${name}`,
    ...marks,
  };
}

/** Shaped like the product's: a resident core, the base ring, and the wide proposals. */
function catalog(): RawToolOptions[] {
  return [
    tool('Bash', 'Run a shell command.'),
    tool('Read', 'Read a file from disk.'),
    tool('mcp__browser-control__computer_click', 'Click an element in the browser.', { deferrable: true }),
    tool('Weave', 'Run a deterministic orchestration script over helpers.', { deferrableWide: true }),
    tool('Ability', 'Open an installed ability to see what it bundles.', { deferrableWide: true }),
    tool('session_search', 'Search and read the user past sessions.', { deferrableWide: true }),
    // The user-MCP pair stays resident under the product's policy: no wide marker.
    tool('mcp_search', 'Search the tools of connected MCP servers, then run one with mcp_invoke.'),
    tool('mcp_invoke', 'Call a tool on a connected MCP server, found first with mcp_search.'),
    tool('mcp__composio__COMPOSIO_SEARCH_TOOLS', 'Find the connected app actions for a task.', { deferrableWide: true }),
    tool('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', 'Run connected app actions found by the search.', { deferrableWide: true }),
    tool('WebSearch', 'Search the web.'),
  ];
}

/** The same catalog as it was before this flag existed: no wide marker anywhere. */
function unmarked(): RawToolOptions[] {
  return catalog().map(({ deferrableWide: _dropped, ...t }) => t);
}

const WIDE_MARKED = [
  'Weave', 'Ability', 'session_search',
  'mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
];

const CONNECTED_APPS =
  "mcp__composio__*: the user's connected apps (email, calendar, chat, documents, CRM). " +
  'Load mcp__composio__COMPOSIO_SEARCH_TOOLS and mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL together.';

/** The tool names the connected-apps line tells the model to load, read off the rendered line. */
function namedByConnectedAppsLine(index: string): string[] {
  const line = index.split('\n').find((l) => l.startsWith('mcp__composio__*: '));
  const m = line ? /Load (\S+) and (\S+) together\.$/.exec(line) : null;
  if (!m) throw new Error(`no connected-apps line in:\n${index}`);
  return [m[1], m[2]];
}

const ctx = (model: string): HarnessContext<NativeConfigLike> =>
  ({ taskId: 'task-1', sessionId: 's', cwd: '/tmp', model, signal: new AbortController().signal, config: {} }) as never;

const SYSTEM = 'You are the agent.';
const nameOf = (t: ProviderTool): string =>
  (t as { name?: string }).name ?? (t as { function: { name: string } }).function.name;

const FLAGS = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'] as const;
const saved = new Map(FLAGS.map((f) => [f, process.env[f]]));
function flags(...on: (typeof FLAGS)[number][]): void {
  for (const f of FLAGS) {
    if (on.includes(f)) process.env[f] = 'true';
    else delete process.env[f];
  }
}
afterEach(() => {
  for (const [f, v] of saved) {
    if (v === undefined) delete process.env[f];
    else process.env[f] = v;
  }
});

/** One lane per wire format, each with its family's working model. */
const LANES = [
  { wire: 'anthropic_messages', model: 'claude-sonnet-5-5', make: () => new AnthropicMessagesTransport() },
  { wire: 'openai_responses', model: 'gpt-5.6-luna', make: () => new OpenAIResponsesTransport() },
  { wire: 'openai_chat_completions', model: 'deepseek-v4-flash', make: () => new ChatCompletionsTransport() },
  { wire: 'gemini', model: 'gemini-3.8-flash', make: () => new GeminiTransport() },
  { wire: 'gemini_interactions', model: 'gemini-3.8-flash', make: () => new GeminiInteractionsTransport() },
] as const;

describe('TOOL_DEFER_WIDE_V1 — off is byte-identical', () => {
  const states: (typeof FLAGS)[number][][] = [
    [], ['TOOL_SEARCH_V1'], ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1'], ['TOOL_DEFER_WIDE_V1'],
  ];

  it('wide off: the marker is inert on all five wire formats, with every rail state underneath', async () => {
    for (const on of states) {
      flags(...on);
      for (const lane of LANES) {
        const before = await attachToolSearch(ctx(lane.model), unmarked(), undefined, lane.make(), SYSTEM);
        const after = await attachToolSearch(ctx(lane.model), catalog(), undefined, lane.make(), SYSTEM);
        const at = `${lane.wire} with [${on.join(', ')}]`;
        expect(JSON.stringify(after.wireTools()), at).toBe(JSON.stringify(before.wireTools()));
        expect(after.tools.map((t) => t.name), at).toEqual(before.tools.map((t) => t.name));
        // The legacy index is the product's layer; the engine appends nothing.
        expect(after.system, at).toBe(SYSTEM);
      }
    }
  });

  it('wide policy: the flag alone is inert, it is a policy over the two rails', () => {
    flags('TOOL_DEFER_WIDE_V1');
    expect(wideDeferralActive()).toBe(false);
    const tools = catalog();
    expect(widenDeferral(tools)).toBe(tools);
  });
});

describe('TOOL_DEFER_WIDE_V1 — on', () => {
  it('wide: every marked tool leaves the client wire and the resident core stays', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('deepseek-v4-flash'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    expect(s.wireTools().map(nameOf)).toEqual(['Bash', 'Read', 'mcp_search', 'mcp_invoke', 'WebSearch', TOOL_SEARCH_TOOL_NAME]);
    // Dispatch is never gated: the catalog still holds every tool, with a real execute.
    for (const name of WIDE_MARKED) expect(s.tools.find((t) => t.name === name)?.execute).toBeTypeOf('function');
  });

  it('wide: a deferred Composio tool is found by select:, then rides the wire and is callable', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('deepseek-v4-flash'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    const search = s.tools.find((t) => t.name === TOOL_SEARCH_TOOL_NAME)!;
    const result = String(await search.execute({ query: 'select:mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL' }, {} as never));
    expect(result).toContain('<functions>');
    expect(result).toContain('"name":"mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"');
    expect(s.wireTools().map(nameOf).at(-1)).toBe('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL');
    const loaded = s.tools.find((t) => t.name === 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL')!;
    expect(await loaded.execute({ target: 'x' }, {} as never)).toBe('ran mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL');
  });

  it('wide: found by keyword too, and one search for the shared stem loads the Composio pair', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('glm-5.2'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    const search = s.tools.find((t) => t.name === TOOL_SEARCH_TOOL_NAME)!;
    expect(s.wireTools().map(nameOf)).not.toContain('mcp__composio__COMPOSIO_SEARCH_TOOLS');
    await search.execute({ query: 'composio' }, {} as never);
    expect(s.wireTools().map(nameOf)).toEqual(
      expect.arrayContaining(['mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL']),
    );
  });

  it('wide: on the native rail the marked tools carry defer_loading and the core does not', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('claude-sonnet-5-5'), catalog(), undefined, new AnthropicMessagesTransport(), SYSTEM);
    const wire = s.wireTools() as { name: string; defer_loading?: boolean }[];
    const deferred = wire.filter((t) => t.defer_loading === true).map((t) => t.name);
    expect(deferred).toEqual(['mcp__browser-control__computer_click', ...WIDE_MARKED]);
    expect(wire.map((t) => t.name)).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it('widenDeferral copies, never mutates: the subagent toolset shares these objects', () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const tools = catalog();
    const widened = widenDeferral(tools);
    expect(tools.filter((t) => t.deferrable === true).map((t) => t.name)).toEqual(['mcp__browser-control__computer_click']);
    expect(widened[0]).toBe(tools[0]);
    expect(widened.filter((t) => t.deferrable === true)).toHaveLength(1 + WIDE_MARKED.length);
  });
});

describe('TOOL_DEFER_WIDE_V1 — the index, per provider', () => {
  const indexOf = (system: string): string => system.slice(system.indexOf('# Additional tools'));

  it('names only for Anthropic models, name plus one sentence for the others', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-opus-4-7']) expect(toolIndexStyle(m), m).toBe('names');
    for (const m of ['gpt-5.6-luna', 'deepseek-v4-flash', 'gemini-3.8-flash', 'glm-5.2', 'grok-4.7']) {
      expect(toolIndexStyle(m), m).toBe('summaries');
    }
  });

  it('wide: an Anthropic model reads a names-only list, on either rail', async () => {
    for (const on of [['TOOL_SEARCH_V1', 'TOOL_DEFER_V1'], ['TOOL_SEARCH_V1']] as const) {
      flags(...on, 'TOOL_DEFER_WIDE_V1');
      const s = await attachToolSearch(ctx('claude-sonnet-5-5'), catalog(), undefined, new AnthropicMessagesTransport(), SYSTEM);
      expect(s.system.startsWith(`${SYSTEM}\n\n# Additional tools (load before use)`)).toBe(true);
      // header, blank, instructions, blank, the connected-apps line, blank, then the tools.
      const lines = indexOf(s.system).split('\n');
      expect(lines[4]).toBe(CONNECTED_APPS);
      expect(lines.slice(6)).toEqual([
        'mcp__browser-control__computer_click',
        'Weave: Run a deterministic orchestration script over helpers.',
        'Ability: Open an installed ability to see what it bundles.',
        'session_search',
        'mcp__composio__COMPOSIO_SEARCH_TOOLS',
        'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
      ]);
      expect(indexOf(s.system)).not.toContain('Search and read the user past sessions');
    }
  });

  it('wide: every other provider keeps the one-line summary', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('deepseek-v4-flash'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    expect(indexOf(s.system)).toContain('- session_search: Search and read the user past sessions.');
    expect(indexOf(s.system)).toContain(`${CONNECTED_APPS}\n\n- mcp__browser-control__computer_click: `);
    expect(indexOf(s.system)).toContain(`call ${TOOL_SEARCH_TOOL_NAME} with either \`select:<name>,<name>\``);
  });

  it('index: the connected-apps line renders once when a Composio tool is deferred, and never otherwise', () => {
    const deferred = catalog().filter((t) => t.deferrable === true || t.deferrableWide === true);
    const withoutComposio = deferred.filter((t) => !t.name.startsWith('mcp__composio__'));
    for (const style of ['names', 'summaries'] as const) {
      for (const rail of ['native', 'client'] as const) {
        const on = renderToolSearchIndex(deferred, rail, style);
        expect(on.split(CONNECTED_APPS).length - 1, `${style} ${rail}`).toBe(1);
        expect(renderToolSearchIndex(withoutComposio, rail, style), `${style} ${rail}`).not.toContain('mcp__composio__');
      }
    }
    expect(CONNECTED_APPS).not.toMatch(/[–—]|Claude/);
  });

  it('index: the connected-apps line names the pair so that one select: loads both (client rail)', async () => {
    // The 30 Sep staging drill: an Anthropic model on the client rail copied the line's bare
    // names into select:COMPOSIO_SEARCH_TOOLS,COMPOSIO_MULTI_EXECUTE_TOOL, got "No tool
    // matched", and spent a second search on the full names.
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const s = await attachToolSearch(ctx('claude-sonnet-5-5'), catalog(), undefined, new AnthropicMessagesTransport(), SYSTEM);
    const named = namedByConnectedAppsLine(indexOf(s.system));
    const search = s.tools.find((t) => t.name === TOOL_SEARCH_TOOL_NAME)!;
    const result = String(await search.execute({ query: `select:${named.join(',')}` }, {} as never));
    expect(result).not.toContain('No tool matched');
    expect(result).toContain(
      '2 tools loaded and callable from now on: ' +
        'mcp__composio__COMPOSIO_SEARCH_TOOLS, mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL.',
    );
    expect(s.wireTools().map(nameOf).slice(-2)).toEqual([
      'mcp__composio__COMPOSIO_SEARCH_TOOLS',
      'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
    ]);
  });

  it('index: on the native rail the regex search finds each named tool by its full or its bare name', () => {
    const deferred = catalog().filter((t) => t.deferrable === true || t.deferrableWide === true);
    const names = deferred.map((t) => t.name);
    const named = namedByConnectedAppsLine(renderToolSearchIndex(deferred, 'native', 'names'));
    // The line names only tools the deferred set carries, exactly.
    for (const full of named) expect(names, full).toContain(full);
    for (const full of named) {
      // tool_search_tool_regex runs a case-insensitive Python re.search; these patterns carry
      // no regex metacharacters, so a JS RegExp with the i flag reads them the same way.
      for (const pattern of [full, full.slice('mcp__composio__'.length)]) {
        expect(names.filter((n) => new RegExp(pattern, 'i').test(n)), pattern).toEqual([full]);
      }
    }
  });

  it('index: on names-only, Weave and Ability keep one sentence and every other name stays bare', () => {
    const deferred = catalog().filter((t) => t.deferrable === true || t.deferrableWide === true);
    const tools = renderToolSearchIndex(deferred, 'native', 'names').split('\n').slice(6);
    const withSentence = tools.filter((l) => l.includes(': ')).map((l) => l.slice(0, l.indexOf(':')));
    expect(withSentence).toEqual(['Weave', 'Ability']);
    expect(tools.filter((l) => !l.includes(' '))).toHaveLength(deferred.length - 2);
  });

  it('cache: the index is byte-stable across builds, and a load only appends to the wire', async () => {
    flags('TOOL_SEARCH_V1', 'TOOL_DEFER_WIDE_V1');
    const a = await attachToolSearch(ctx('deepseek-v4-flash'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    const b = await attachToolSearch(ctx('deepseek-v4-flash'), catalog(), undefined, new ChatCompletionsTransport(), SYSTEM);
    expect(b.system).toBe(a.system);
    const before = a.wireTools().map((t) => JSON.stringify(t));
    await a.tools.find((t) => t.name === TOOL_SEARCH_TOOL_NAME)!.execute({ query: 'select:Weave' }, {} as never);
    const after = a.wireTools().map((t) => JSON.stringify(t));
    // ToolSearch stays (other tools remain to find), so the old array is an exact prefix.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((t) => JSON.parse(t).function.name)).toEqual(['Weave']);
  });
});
