/**
 * TOOL_SEARCH_V1 — the client-side deferred-tool rail.
 *
 * Three axes, per the flag-gated-change rule: OFF byte-identical; ON = the
 * deferrable ring withheld and loadable; ON-base = everything that is not
 * deferrable stays exactly where it was.
 *
 * THE FAILURE MODES THESE GUARD are quieter than the Anthropic rail's (that one
 * 400s loudly when it is wrong). Every one of these is a silent capability loss:
 *   - a tool withheld from the wire but ALSO unreachable by the dispatcher ⇒
 *     "Unknown tool" on a tool the model was told it could load;
 *   - a loaded set that resets on recycle ⇒ the model's hands narrow mid-task,
 *     hours after the pause, with no error anywhere;
 *   - a `ToolSearch` tool that stays resident with nothing left to find ⇒ pure
 *     standing cost, invisible except on the bill;
 *   - index/wire disagreement ⇒ the model is advertised a tool that no longer
 *     exists and burns a round-trip discovering that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  TOOL_SEARCH_TOOL_NAME,
  announceVanishedTools,
  createToolSearchState,
  makeToolSearchTool,
  matchDeferredTools,
  recordLoaded,
  renderToolSchemas,
  renderToolSearchIndex,
  resolveToolSearchRail,
  shapeToolSearchTools,
} from '../tool-search.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

function tool(name: string, description: string, deferrable = false): RawToolOptions {
  return {
    name,
    description,
    parameters: z.object({ target: z.string().describe('what to act on') }),
    execute: async () => `ran ${name}`,
    ...(deferrable ? { deferrable: true } : {}),
  };
}

/** A catalog shaped like the real one: a resident core plus a deferrable ring. */
function catalog(): RawToolOptions[] {
  return [
    tool('Bash', 'Run a shell command.'),
    tool('Read', 'Read a file from disk.'),
    tool('mcp__browser-control__computer_click', 'Click an element in the browser. Uses a ref.', true),
    tool('mcp__browser-control__computer_type', 'Type text into the focused browser field.', true),
    tool('mcp__os-hands__os_open', 'Open an app on the user Mac.', true),
    tool('WebSearch', 'Search the web.'),
  ];
}

const FLAGS = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1'] as const;
const saved = new Map<string, string | undefined>();
for (const f of FLAGS) saved.set(f, process.env[f]);
afterEach(() => {
  for (const f of FLAGS) {
    const v = saved.get(f);
    if (v === undefined) delete process.env[f];
    else process.env[f] = v;
  }
});

// ── Rail routing ────────────────────────────────────────────────────────────

describe('resolveToolSearchRail — one registry decides per model', () => {
  it('OFF axis: both flags off is "none" on every lane', () => {
    delete process.env.TOOL_SEARCH_V1;
    delete process.env.TOOL_DEFER_V1;
    for (const model of ['claude-sonnet-5', 'deepseek-v4-flash', 'glm-5.2', 'gpt-5.6-sol']) {
      expect(resolveToolSearchRail(model, 20)).toBe('none');
    }
  });

  it('the NATIVE rail wins wherever it is available — the server-side path is cheaper', () => {
    process.env.TOOL_SEARCH_V1 = '1';
    process.env.TOOL_DEFER_V1 = '1';
    // claude-sonnet-5 carries supportsToolSearch (live-probed, #2604).
    expect(resolveToolSearchRail('claude-sonnet-5', 20)).toBe('native');
  });

  it('the CLIENT rail covers every lane the native one cannot', () => {
    process.env.TOOL_SEARCH_V1 = '1';
    process.env.TOOL_DEFER_V1 = '1';
    // Fireworks OSS, OpenAI, Gemini: no defer_loading analogue anywhere.
    expect(resolveToolSearchRail('deepseek-v4-flash', 20)).toBe('client');
    expect(resolveToolSearchRail('glm-5.2', 20)).toBe('client');
    expect(resolveToolSearchRail('gpt-5.6-sol', 20)).toBe('client');
    expect(resolveToolSearchRail('gemini-3.8-flash', 20)).toBe('client');
    // An INELIGIBLE Anthropic model (mythos-preview carries no supportsToolSearch)
    // falls to the client rail rather than losing the saving entirely.
    expect(resolveToolSearchRail('claude-mythos-preview', 20)).toBe('client');
  });

  it('the client rail also covers a capable model when the NATIVE flag is off', () => {
    process.env.TOOL_SEARCH_V1 = '1';
    delete process.env.TOOL_DEFER_V1;
    expect(resolveToolSearchRail('claude-sonnet-5', 20)).toBe('client');
  });

  it('nothing deferrable is "none" even with both flags on — no standing cost', () => {
    process.env.TOOL_SEARCH_V1 = '1';
    process.env.TOOL_DEFER_V1 = '1';
    expect(resolveToolSearchRail('deepseek-v4-flash', 0)).toBe('none');
    expect(resolveToolSearchRail('claude-sonnet-5', 0)).toBe('none');
  });

  it('THE TWO RAILS AGREE ON THE SET: membership is the `deferrable` marker, never a per-rail list', () => {
    process.env.TOOL_SEARCH_V1 = '1';
    process.env.TOOL_DEFER_V1 = '1';
    const tools = catalog();
    const marked = tools.filter((t) => t.deferrable === true).map((t) => t.name);

    // Native rail (Anthropic): the transport defers exactly the marked tools.
    // Client rail: the shaping withholds exactly the marked tools.
    const state = createToolSearchState();
    const shaped = shapeToolSearchTools({
      tools,
      providerTools: tools.map((t) => t.name),
      state,
      active: true,
    });
    const withheldByClient = tools
      .map((t) => t.name)
      .filter((n) => !shaped.includes(n) && n !== TOOL_SEARCH_TOOL_NAME);

    expect(withheldByClient).toEqual(marked);
    // And the rails are mutually exclusive per model, so no tool is ever deferred twice.
    expect(resolveToolSearchRail('claude-sonnet-5', marked.length)).toBe('native');
    expect(resolveToolSearchRail('glm-5.2', marked.length)).toBe('client');
  });
});

// ── The index ───────────────────────────────────────────────────────────────

describe('renderToolSearchIndex — the block the model always sees', () => {
  it('lists every deferred tool by name with its FIRST description sentence', () => {
    const ring = catalog().filter((t) => t.deferrable);
    const index = renderToolSearchIndex(ring);
    for (const t of ring) expect(index).toContain(t.name);
    // First sentence only — the "Uses a ref." tail is dropped.
    expect(index).toContain('Click an element in the browser.');
    expect(index).not.toContain('Uses a ref.');
  });

  it('caps a runaway description so one verbose tool cannot bloat the cached prefix', () => {
    const long = tool('mcp__x__verbose', `${'word '.repeat(200)}.`, true);
    const line = renderToolSearchIndex([long]).split('\n').find((l) => l.startsWith('- '));
    expect(line!.length).toBeLessThan(160);
  });

  it('CACHE CONTRACT: bytes depend on the deferred SET only, never on what is loaded', () => {
    const ring = catalog().filter((t) => t.deferrable);
    const first = renderToolSearchIndex(ring);
    // Loading tools must not move a single byte of the system prompt.
    const state = createToolSearchState();
    recordLoaded(state, ring[0].name);
    recordLoaded(state, ring[1].name);
    expect(renderToolSearchIndex(ring)).toBe(first);
  });

  it('is EMPTY for an empty set, so the layer drops and the prompt is byte-identical', () => {
    expect(renderToolSearchIndex([])).toBe('');
  });
});

// ── Query matching ──────────────────────────────────────────────────────────

describe('matchDeferredTools', () => {
  const ring = catalog().filter((t) => t.deferrable);

  it('`select:` returns EXACTLY the named tools — never a "better" match', () => {
    const got = matchDeferredTools(
      'select:mcp__browser-control__computer_type,mcp__os-hands__os_open',
      ring,
    );
    expect(got.map((t) => t.name)).toEqual([
      'mcp__browser-control__computer_type',
      'mcp__os-hands__os_open',
    ]);
  });

  it('`select:` ignores the result cap — an explicit ask is always honored in full', () => {
    const got = matchDeferredTools(`select:${ring.map((t) => t.name).join(',')}`, ring, 1);
    expect(got).toHaveLength(ring.length);
  });

  it('`select:` on an unknown name returns nothing rather than a near-miss', () => {
    expect(matchDeferredTools('select:NoSuchTool', ring)).toEqual([]);
  });

  it('keyword search ranks NAME hits above description hits', () => {
    // "browser" is in two names and in one other tool's description.
    const got = matchDeferredTools('browser', ring, 3).map((t) => t.name);
    expect(got.slice(0, 2)).toEqual([
      'mcp__browser-control__computer_click',
      'mcp__browser-control__computer_type',
    ]);
  });

  it('`+kw` requires the token in the NAME and ranks the survivors', () => {
    const got = matchDeferredTools('+os-hands open an app', ring).map((t) => t.name);
    expect(got).toEqual(['mcp__os-hands__os_open']);
  });

  it('caps keyword results and is deterministic — ties break on catalog order', () => {
    const got = matchDeferredTools('computer', ring, 1);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('mcp__browser-control__computer_click');
    expect(matchDeferredTools('computer', ring, 1)).toEqual(got);
  });

  it('a bare `+kw` with no ranking terms is a pure FILTER, not an empty result', () => {
    // Every survivor scores 0 with no tokens left to rank on; returning [] there
    // would answer "no such tool" to a query that matched two.
    const got = matchDeferredTools('+browser-control', ring).map((t) => t.name);
    expect(got).toEqual([
      'mcp__browser-control__computer_click',
      'mcp__browser-control__computer_type',
    ]);
  });

  it('an empty or unmatched query returns nothing (the tool then lists what IS loadable)', () => {
    expect(matchDeferredTools('   ', ring)).toEqual([]);
    expect(matchDeferredTools('quantum tunnelling', ring)).toEqual([]);
  });
});

// ── Result rendering ────────────────────────────────────────────────────────

describe('renderToolSchemas', () => {
  it('carries the REAL JSON Schema (the #2586 serializer), not the Zod blob', () => {
    const out = renderToolSchemas([catalog()[2]]);
    expect(out).toContain('<functions>');
    const json = JSON.parse(out.split('<function>')[1].split('</function>')[0]) as {
      name: string;
      parameters: { type: string; properties: Record<string, { description?: string }> };
    };
    expect(json.name).toBe('mcp__browser-control__computer_click');
    expect(json.parameters.type).toBe('object');
    // The per-field `.describe()` docs the raw Zod object never carried.
    expect(json.parameters.properties.target.description).toBe('what to act on');
    expect(out).not.toContain('"def"');
  });
});

// ── Wire shaping ────────────────────────────────────────────────────────────

describe('shapeToolSearchTools', () => {
  const tools = catalog();
  const provider = tools.map((t) => t.name);

  it('OFF axis: inactive returns the SAME ARRAY BY REFERENCE — byte-identical, no allocation', () => {
    const state = createToolSearchState();
    expect(shapeToolSearchTools({ tools, providerTools: provider, state, active: false })).toBe(provider);
  });

  it('ON: withholds deferred-and-unloaded schemas, keeps every resident tool in catalog order', () => {
    const state = createToolSearchState();
    const shaped = shapeToolSearchTools({ tools, providerTools: provider, state, active: true });
    expect(shaped).toEqual(['Bash', 'Read', 'WebSearch']);
  });

  it('ON: a loaded tool APPENDS — every previously sent byte keeps its offset', () => {
    const state = createToolSearchState(['mcp__os-hands__os_open']);
    const shaped = shapeToolSearchTools({ tools, providerTools: provider, state, active: true });
    // Resident prefix is untouched; the load lands at the END, not at its catalog slot.
    expect(shaped).toEqual(['Bash', 'Read', 'WebSearch', 'mcp__os-hands__os_open']);
  });

  it('ON: loads keep FIRST-LOAD order, so a journal replay rebuilds the same array', () => {
    const order = ['mcp__os-hands__os_open', 'mcp__browser-control__computer_click'];
    const live = createToolSearchState();
    for (const n of order) recordLoaded(live, n);
    const replayed = createToolSearchState(order); // what a recycle reconstructs
    expect(shapeToolSearchTools({ tools, providerTools: provider, state: replayed, active: true })).toEqual(
      shapeToolSearchTools({ tools, providerTools: provider, state: live, active: true }),
    );
  });

  it('SELF-REMOVING: the search tool is dropped once nothing is left to find', () => {
    const withSearch = [...tools, tool(TOOL_SEARCH_TOOL_NAME, 'Load tools.')];
    const withSearchProvider = withSearch.map((t) => t.name);
    const ring = tools.filter((t) => t.deferrable).map((t) => t.name);

    const partial = createToolSearchState([ring[0]]);
    expect(
      shapeToolSearchTools({ tools: withSearch, providerTools: withSearchProvider, state: partial, active: true }),
    ).toContain(TOOL_SEARCH_TOOL_NAME);

    const everything = createToolSearchState(ring);
    expect(
      shapeToolSearchTools({ tools: withSearch, providerTools: withSearchProvider, state: everything, active: true }),
    ).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it('a loaded name with no live definition is skipped, never sent as a stale schema', () => {
    const state = createToolSearchState(['mcp__retired__gone']);
    const shaped = shapeToolSearchTools({ tools, providerTools: provider, state, active: true });
    expect(shaped).toEqual(['Bash', 'Read', 'WebSearch']);
  });

  it('DEGRADES SAFELY: a length mismatch sends everything rather than a wrong tool list', () => {
    // The index-alignment invariant broken (a transport that appended a provider
    // tool). Sending the full catalog costs the saving; sending a misaligned array
    // would advertise one tool under another tool schema.
    const state = createToolSearchState();
    const misaligned = [...provider, 'provider_side_tool'];
    expect(shapeToolSearchTools({ tools, providerTools: misaligned, state, active: true })).toBe(misaligned);
  });

  it('ON-BASE: a catalog with nothing deferrable is unchanged apart from dropping the search tool', () => {
    const plain = [tool('Bash', 'Run a shell command.'), tool('Read', 'Read a file.')];
    const state = createToolSearchState();
    expect(
      shapeToolSearchTools({ tools: plain, providerTools: plain.map((t) => t.name), state, active: true }),
    ).toEqual(['Bash', 'Read']);
  });
});

// ── The loaded set ──────────────────────────────────────────────────────────

describe('ToolSearchState — additive-only', () => {
  it('records first-load order and never double-counts', () => {
    const state = createToolSearchState();
    expect(recordLoaded(state, 'a')).toBe(true);
    expect(recordLoaded(state, 'b')).toBe(true);
    expect(recordLoaded(state, 'a')).toBe(false);
    expect(state.order).toEqual(['a', 'b']);
  });

  it('seeds from a replay, deduping while preserving order', () => {
    expect(createToolSearchState(['a', 'b', 'a']).order).toEqual(['a', 'b']);
  });

  it('is PER-SESSION: two states never share a set', () => {
    const one = createToolSearchState();
    const two = createToolSearchState();
    recordLoaded(one, 'a');
    expect(two.loaded.has('a')).toBe(false);
  });
});

// ── The set-change announcement ─────────────────────────────────────────────

describe('announceVanishedTools', () => {
  it('names the LOADED tools that are gone from the catalog', () => {
    const note = announceVanishedTools(['a', 'b', 'c'], ['a', 'c']);
    expect(note).toContain('b');
    expect(note).toContain('no longer');
    expect(note).toContain('tool is'); // singular reads correctly
  });

  it('reads correctly when SEVERAL vanish at once (a whole server dropping)', () => {
    const note = announceVanishedTools(['a', 'b', 'c'], ['c']);
    expect(note).toContain('2 previously loaded tools are');
    expect(note).toContain('a, b');
  });

  it('says nothing when everything the model loaded is still there', () => {
    expect(announceVanishedTools(['a'], ['a', 'b'])).toBeUndefined();
    expect(announceVanishedTools([], [])).toBeUndefined();
  });

  it('ignores a NEVER-loaded tool vanishing — the re-rendered index already fixed that', () => {
    // The model was told about `b` in a previous turn's index but never loaded it.
    // The current turn's index simply omits it; a note would be noise.
    expect(announceVanishedTools([], ['a'])).toBeUndefined();
  });
});

// ── The tool ────────────────────────────────────────────────────────────────

describe('makeToolSearchTool', () => {
  const ring = catalog().filter((t) => t.deferrable);

  function build(state = createToolSearchState(), loads: string[][] = []) {
    return makeToolSearchTool({
      getDeferred: () => ring,
      state,
      onLoad: (names) => {
        loads.push([...names]);
      },
    });
  }

  it('is cheap enough to sit in the prefix forever', () => {
    const t = build();
    expect(t.name).toBe(TOOL_SEARCH_TOOL_NAME);
    expect(t.description.length).toBeLessThan(700);
  });

  it('returns the matched schemas AND says they are now callable', async () => {
    const state = createToolSearchState();
    const out = (await build(state).execute(
      { query: 'select:mcp__os-hands__os_open' },
      {} as never,
    )) as string;
    expect(out).toContain('<functions>');
    expect(out).toContain('mcp__os-hands__os_open');
    expect(out).toContain('callable');
    expect(state.loaded.has('mcp__os-hands__os_open')).toBe(true);
  });

  it('persists ONLY the newly loaded names, so a repeat search writes nothing', async () => {
    const loads: string[][] = [];
    const state = createToolSearchState();
    const t = build(state, loads);
    await t.execute({ query: 'select:mcp__os-hands__os_open' }, {} as never);
    await t.execute({ query: 'select:mcp__os-hands__os_open' }, {} as never);
    expect(loads).toEqual([['mcp__os-hands__os_open']]);
  });

  it('on no match, LISTS what is still loadable instead of dead-ending', async () => {
    const out = (await build().execute({ query: 'nothing matches this' }, {} as never)) as string;
    expect(out).toContain('mcp__browser-control__computer_click');
  });

  it('when everything is already loaded, says so rather than listing an empty set', async () => {
    const state = createToolSearchState(ring.map((t) => t.name));
    const out = (await build(state).execute({ query: 'zzz' }, {} as never)) as string;
    expect(out).toContain('already loaded');
  });

  it('survives a junk argument shape rather than throwing mid-turn', async () => {
    await expect(build().execute({}, {} as never)).resolves.toBeTypeOf('string');
    await expect(build().execute(undefined, {} as never)).resolves.toBeTypeOf('string');
    await expect(
      build().execute({ query: 'browser', max_results: 'lots' }, {} as never),
    ).resolves.toBeTypeOf('string');
  });

  it('a non-finite max_results falls back to the default instead of slicing to NaN', async () => {
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = (await build().execute({ query: 'computer', max_results: max }, {} as never)) as string;
      expect(out).toContain('<functions>');
    }
  });
});
