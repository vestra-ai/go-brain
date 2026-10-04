/**
 * L2 (TOOL_CONCURRENCY_CLASSES_V1) — shared and exclusive tools.
 *
 * Every tool declares `concurrency: 'shared' | 'exclusive'` (absent = exclusive). With the
 * flag on, consecutive shared calls overlap through the EXISTING concurrent-run executor (the
 * W3-2 / T6 `:turnbatch` pool, PASS 1 start-all, PASS 2 batch-order drain) and an exclusive
 * call waits for everything before it and runs alone. With the flag off the W3-2
 * `concurrencySafe` marker alone decides, byte-identical to before.
 *
 * The risks the program review asked about, each pinned here: call order on the wire and in
 * the journal when a later read finishes first; a paused ask mid-batch; an interrupt
 * mid-batch; the output token budget per result; the sub-agent cost gate per spawn.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateResult, HarnessContext, ToolCall, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { NativeConfig } from '../native-config.js';
import { FakeTransport, type StreamEvent, type Transport, type ProviderHistory, type ProviderStream } from '../transport.js';
import type { Journal as JournalType } from '../../kernel/index.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { NativeHarness } from '../native-harness.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { defaultNodeReserveUsd, _resetFuelTanksForTest } from '../fuel-tank.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { partitionToolBatch, sharedToolNames, toolBatchShape } from '../batch-shape.js';
import { createToolSearchState, makeToolSearchTool } from '../tool-search.js';
import { readToolSearchLoaded } from '../native-journal.js';
import { toolConcurrencyClassesEnabled } from '../../policy/feature-flags.js';
import {
  makeReadTool, makeGrepTool, makeGlobTool, makeWebSearchTool, makeWebFetchTool,
  makeRawWebFetchTool, makeEditTool, makeWriteTool, makeBashTool,
} from '../../tools/index.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';

const FLAG = 'TOOL_CONCURRENCY_CLASSES_V1';
const BUDGET_FLAG = 'TOOL_OUTPUT_TOKEN_BUDGET_V1';
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[BUDGET_FLAG];
  vi.useRealTimers();
});

type Decl = Pick<RawToolOptions, 'name' | 'concurrency' | 'concurrencySafe'>;
/** The live catalog's declarations: the W3-2 read family carries both markers; the L2
 *  additions (Nami read, MCP search, ToolSearch, Agent) carry only the class. */
const CATALOG: Decl[] = [
  ...['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].map((name) => ({ name, concurrencySafe: true, concurrency: 'shared' as const })),
  ...['context_query', 'mcp_search', 'ToolSearch', 'Agent'].map((name) => ({ name, concurrency: 'shared' as const })),
  { name: 'Edit' }, { name: 'Write' }, { name: 'Bash' }, { name: 'mcp_invoke' },
  { name: 'mcp__browser-control__browser_click' },
];

const tus = (names: string[]) => names.map((name, i) => ({ id: `${name}#${i}`, name }));
const shapeOf = (names: string[], classesOn: boolean, catalog: Decl[] = CATALOG, mainLoop = true) => {
  const shared = sharedToolNames(catalog, classesOn);
  return partitionToolBatch(tus(names), mainLoop, (n) => shared.has(n))
    .map((s) => `${s.concurrent ? 'C' : 'S'}[${s.tus.map((t) => t.name).join(',')}]`);
};

describe('concurrency classes: the partition', () => {
  it('concurrency: an exclusive tool between shared ones splits the batch', () => {
    expect(shapeOf(['Read', 'Grep', 'Edit', 'WebFetch', 'context_query'], true))
      .toEqual(['C[Read,Grep]', 'S[Edit]', 'C[WebFetch,context_query]']);
    expect(shapeOf(['mcp_search', 'Agent', 'Bash', 'context_query', 'Read'], true))
      .toEqual(['C[mcp_search,Agent]', 'S[Bash]', 'C[context_query,Read]']);
    // A Read of what an earlier Write in the same round wrote waits for the Write: the
    // lone Read after it coalesces into the sequential run, the pair after that overlaps.
    expect(shapeOf(['Write', 'Read', 'Edit', 'Read', 'Grep'], true))
      .toEqual(['S[Write,Read,Edit]', 'C[Read,Grep]']);
    // One terminal per task, one browser per box: Bash and the browser ring stay exclusive.
    expect(shapeOf(['Bash', 'Bash', 'mcp__browser-control__browser_click', 'mcp__browser-control__browser_click'], true))
      .toEqual(['S[Bash,Bash,mcp__browser-control__browser_click,mcp__browser-control__browser_click]']);
  });

  it('concurrency: unknown tools are exclusive', () => {
    // Not in the registry at all, and registered with no declaration: both exclusive.
    expect(shapeOf(['Read', 'not_a_tool', 'Grep'], true)).toEqual(['S[Read,not_a_tool,Grep]']);
    expect(shapeOf(['mcp_invoke', 'mcp_invoke'], true)).toEqual(['S[mcp_invoke,mcp_invoke]']);
    expect(shapeOf(['Mystery', 'Mystery'], true, [{ name: 'Mystery' }])).toEqual(['S[Mystery,Mystery]']);
    // An explicit `exclusive` outranks a legacy `concurrencySafe: true`.
    expect(shapeOf(['Read', 'Read'], true, [{ name: 'Read', concurrencySafe: true, concurrency: 'exclusive' }]))
      .toEqual(['S[Read,Read]']);
  });

  it('concurrency: a legacy concurrencySafe-only tool stays shared with the flag on (server tools keep their overlap)', () => {
    expect(shapeOf(['nami_read', 'nami_read'], true, [{ name: 'nami_read', concurrencySafe: true }])).toEqual(['C[nami_read,nami_read]']);
  });

  it('concurrency: a subagent batch still never forms a run without the walls', () => {
    expect(shapeOf(['Read', 'context_query'], true, CATALOG, false)).toEqual(['S[Read,context_query]']);
  });

  it('concurrency off: batch shapes byte-identical', () => {
    const legacy = new Set(CATALOG.filter((t) => t.concurrencySafe === true).map((t) => t.name));
    const batches = [
      ['Read', 'Grep', 'Edit', 'WebFetch', 'context_query'], ['context_query', 'mcp_search'],
      ['mcp_search', 'Agent', 'Bash', 'context_query', 'Read'], ['Agent', 'Agent', 'Read'],
      ['Read', 'WebSearch', 'Glob', 'Write'], ['ToolSearch', 'Read'], ['context_query'], ['Agent'], ['Edit'], [],
    ];
    const ident = { round: 1, api: 'anthropic_messages', model: 'm' };
    for (const names of batches) {
      const off = sharedToolNames(CATALOG, false);
      const segsOff = partitionToolBatch(tus(names), true, (n) => off.has(n));
      const segsLegacy = partitionToolBatch(tus(names), true, (n) => legacy.has(n));
      expect(JSON.stringify(segsOff)).toBe(JSON.stringify(segsLegacy));
      expect(JSON.stringify(toolBatchShape(tus(names), segsOff, (n) => off.has(n), ident)))
        .toBe(JSON.stringify(toolBatchShape(tus(names), segsLegacy, (n) => legacy.has(n), ident)));
    }
    // Pinned literally: the L2 additions do not overlap with the flag off.
    expect(shapeOf(['context_query', 'mcp_search', 'ToolSearch'], false)).toEqual(['S[context_query,mcp_search,ToolSearch]']);
    // The default argument reads the flag per call: unset is off, 'true' is on.
    expect(sharedToolNames(CATALOG)).toEqual(legacy);
    process.env[FLAG] = 'true';
    expect(toolConcurrencyClassesEnabled()).toBe(true);
    expect(sharedToolNames(CATALOG).has('context_query')).toBe(true);
  });
});

describe('concurrency classes: the tool definitions', () => {
  const cwd = () => '/tmp';
  const cfg = () => ({});
  it('reads, search, fetch and ToolSearch declare shared; writes and commands stay exclusive', () => {
    const toolSearch = makeToolSearchTool({ getDeferred: () => [], state: createToolSearchState() });
    const shared = [makeReadTool(cwd), makeGrepTool(cwd), makeGlobTool(cwd), makeWebSearchTool('t', cfg),
      makeWebFetchTool('t', cfg), makeRawWebFetchTool(), toolSearch];
    for (const t of shared) expect([t.name, t.concurrency]).toEqual([t.name, 'shared']);
    for (const t of [makeEditTool(cwd), makeWriteTool(cwd), makeBashTool(cwd, 't')]) {
      expect([t.name, t.concurrency]).toEqual([t.name, undefined]);
    }
  });

  it('the class never reaches the wire on any of the five formats', () => {
    const tool: RawToolOptions = { name: 'Read', description: 'r', parameters: z.object({ p: z.string() }), execute: async () => '' };
    const transports = [
      new AnthropicMessagesTransport({ client: {} as never }), new ChatCompletionsTransport(),
      new OpenAIResponsesTransport(), new GeminiTransport(), new GeminiInteractionsTransport(),
    ];
    for (const on of [false, true]) {
      if (on) process.env[FLAG] = 'true';
      for (const t of transports) {
        expect(JSON.stringify(t.buildTools([{ ...tool, concurrency: 'shared' }]))).toBe(JSON.stringify(t.buildTools([tool])));
      }
    }
  });
});

// ── round level: the pool really overlaps shared calls and holds the exclusive one ──

function scriptedTransport(round: StreamEvent[]): Transport {
  let served = false;
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (served ? [] : ((served = true), round)) as unknown as ProviderStream,
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: () => 0,
  };
  return t as Transport;
}

const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };

/** An append-only journal that records `type:toolUseId` in append order. */
function captureJournal(): { journal: JournalType; appended: string[] } {
  const appended: string[] = [];
  const journal = {
    append: async (e: { payload: { type: string; toolUseId?: string } }) => {
      if (e.payload.toolUseId !== undefined) appended.push(`${e.payload.type}:${e.payload.toolUseId}`);
      return { uuid: `u${appended.length}` } as unknown as JournalEntry;
    },
  } as unknown as JournalType;
  return { journal, appended };
}

async function runRound(
  tools: RawToolOptions[],
  calls: Array<[string, string]>,
  over: { harness?: typeof allow; cfg?: Record<string, unknown>; ctx?: Partial<RoundDeps['ctx']>; onPause?: () => Promise<string> } = {},
) {
  const transport = scriptedTransport([
    ...calls.map(([id, name]): StreamEvent => ({ kind: 'tool_use', toolUse: { id, name, input: { tag: id } } })),
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const harness = over.harness ?? allow;
  const deps = {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal, ...over.ctx },
    cfg: { ...over.cfg }, transport, rc: createRunContext('t'), harness, dispatcher: createNativeHookDispatcher(harness),
    tools, providerTools: [], system: 'sys', onPause: over.onPause ?? (async () => 'PAUSED'), onAuthHalt: undefined,
    requestedModel: 'm', cachePrefixHint: undefined, history: transport.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const st: RoundState = {
    assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
    stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
  };
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) { events.push(n.value); n = await gen.next(); }
  const blocks = events
    .filter((e): e is Extract<HarnessEvent, { kind: 'block' }> => e.kind === 'block')
    .map((e) => e.block as { type: string; toolUseId?: string })
    .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => `${b.type === 'tool_use' ? 'use' : 'res'}:${b.toolUseId}`);
  return { results: n.value.results, blocks };
}

/** A bounded wait: resolves on `p` or after `ms`, so a wrongly sequential path runs slow
 *  and fails the assertions instead of hanging the test. */
const bounded = (p: Promise<unknown>, ms = 100) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * Three shared reads built so the LAST call finishes FIRST: each waits (bounded) until all
 * three have started, then for its later sibling to finish. Overlap is proven by
 * construction (width 3); sequential execution just runs slower with width 1. The Edit logs
 * how many reads were still running when it started.
 */
function reversedReads(decl: Partial<RawToolOptions>) {
  const names = ['Read', 'Grep', 'WebFetch'];
  const log: string[] = [];
  const width = { now: 0, max: 0 };
  const done = new Map<string, () => void>();
  const finished = new Map(names.map((n) => [n, new Promise<void>((r) => done.set(n, r))]));
  let started = 0;
  let allStarted!: () => void;
  const barrier = new Promise<void>((r) => { allStarted = r; });
  const read = (name: string, i: number): RawToolOptions => ({
    name, description: name, parameters: z.object({ tag: z.string() }), ...decl,
    execute: async (input) => {
      const tag = (input as { tag: string }).tag;
      log.push(`start:${tag}`);
      width.now += 1; width.max = Math.max(width.max, width.now);
      if (++started === names.length) allStarted();
      await bounded(barrier);
      const later = names[i + 1];
      if (later) await bounded(finished.get(later)!);
      width.now -= 1;
      log.push(`end:${tag}`);
      done.get(name)!();
      return `${name}:${tag}`;
    },
  });
  const edit: RawToolOptions = {
    name: 'Edit', description: 'Edit', parameters: z.object({ tag: z.string() }),
    execute: async () => { log.push(`start:e1:running=${width.now}`); return 'Edit:e1'; },
  };
  return { tools: [...names.map(read), edit], log, width };
}
const CALLS: Array<[string, string]> = [['r1', 'Read'], ['g1', 'Grep'], ['w1', 'WebFetch'], ['e1', 'Edit']];

describe('concurrency classes: a real round', () => {
  it('concurrency: reads overlap, edit waits', async () => {
    process.env[FLAG] = 'true';
    const { tools, log, width } = reversedReads({ concurrency: 'shared' });
    const { journal, appended } = captureJournal();
    const { results, blocks } = await runRound(tools, CALLS, { cfg: { journal, reconstructionCheck: 'off' } });
    // The three reads ran at once, the LAST one finished first…
    expect(width.max).toBe(3);
    expect(log.slice(0, 3)).toEqual(['start:r1', 'start:g1', 'start:w1']);
    expect(log.slice(3, 6)).toEqual(['end:w1', 'end:g1', 'end:r1']);
    // …and the Edit started only after all three were done.
    expect(log.at(-1)).toBe('start:e1:running=0');
    // Results, wire blocks and the journal are all in CALL order.
    expect(results.map((r) => r.text)).toEqual(['Read:r1', 'Grep:g1', 'WebFetch:w1', 'Edit:e1']);
    expect(blocks).toEqual(['use:r1', 'use:g1', 'use:w1', 'res:r1', 'res:g1', 'res:w1', 'use:e1', 'res:e1']);
    expect(appended).toEqual([
      'tool_use:r1', 'tool_use:g1', 'tool_use:w1', 'tool_result:r1', 'tool_result:g1', 'tool_result:w1',
      'tool_use:e1', 'tool_result:e1',
    ]);
  });

  it('concurrency off: the same shared-declared round runs one call at a time, as before', async () => {
    const { tools, log, width } = reversedReads({ concurrency: 'shared' });
    const { journal, appended } = captureJournal();
    const { results, blocks } = await runRound(tools, CALLS, { cfg: { journal, reconstructionCheck: 'off' } });
    expect(width.max).toBe(1);
    expect(log).toEqual(['start:r1', 'end:r1', 'start:g1', 'end:g1', 'start:w1', 'end:w1', 'start:e1:running=0']);
    expect(results.map((r) => r.text)).toEqual(['Read:r1', 'Grep:g1', 'WebFetch:w1', 'Edit:e1']);
    expect(blocks).toEqual(['use:r1', 'res:r1', 'use:g1', 'res:g1', 'use:w1', 'res:w1', 'use:e1', 'res:e1']);
    expect(appended).toEqual([
      'tool_use:r1', 'tool_result:r1', 'tool_use:g1', 'tool_result:g1', 'tool_use:w1', 'tool_result:w1',
      'tool_use:e1', 'tool_result:e1',
    ]);
  });

  it('concurrency: a paused ask mid-batch waits for the calls it started, then pauses, in call order', async () => {
    process.env[FLAG] = 'true';
    const log: string[] = [];
    const width = { now: 0, max: 0 };
    const shared = (name: string): RawToolOptions => ({
      name, description: name, parameters: z.object({ tag: z.string() }), concurrency: 'shared',
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        width.now += 1; width.max = Math.max(width.max, width.now);
        await new Promise((r) => setTimeout(r, 20));
        width.now -= 1;
        log.push(`ran:${tag}`);
        return `${name}:${tag}`;
      },
    });
    const edit: RawToolOptions = {
      name: 'Edit', description: 'Edit', parameters: z.object({ tag: z.string() }),
      execute: async () => { log.push('ran:e1'); return 'Edit:e1'; },
    };
    // The Grep asks the person: the gate says needs_human, the loop mints the card.
    const asking = {
      gateTool: async (c: ToolCall): Promise<GateResult> =>
        c.toolCallId === 'g1'
          ? ({ decision: 'needs_human', interactionKind: 'tool_permission' } as GateResult)
          : ({ decision: 'allow' } as GateResult),
    };
    const paused: string[] = [];
    const { journal, appended } = captureJournal();
    const { results, blocks } = await runRound([shared('Read'), shared('Grep'), shared('WebFetch'), edit], CALLS, {
      harness: asking,
      onPause: async () => { paused.push('card'); return 'PAUSED'; },
      cfg: { journal, reconstructionCheck: 'off' },
    });
    // One card, for the Grep; its siblings still ran together and finished.
    expect(paused).toEqual(['card']);
    expect(width.max).toBe(2);
    // The main loop's rule, unchanged: every call in the batch settles, then the turn pauses
    // at the batch boundary (the same thing a sequential batch does today).
    expect(results.map((r) => [r.toolUseId, r.pausedHalt === true])).toEqual([
      ['r1', false], ['g1', true], ['w1', false], ['e1', false],
    ]);
    expect(blocks).toEqual(['use:r1', 'use:g1', 'use:w1', 'res:r1', 'res:g1', 'res:w1', 'use:e1', 'res:e1']);
    // The paused call's result is withheld so the resume re-drives only it; the rest land in call order.
    expect(appended.filter((e) => e.startsWith('tool_result'))).toEqual(['tool_result:r1', 'tool_result:w1', 'tool_result:e1']);
    expect(log).toContain('ran:e1');
  });

  it('concurrency: the output token budget holds each shared result once, to its own spill file', async () => {
    process.env[FLAG] = 'true';
    process.env[BUDGET_FLAG] = 'true';
    const big = (tag: string) => `${tag} `.repeat(60_000);
    const width = { now: 0, max: 0 };
    const shared = (name: string): RawToolOptions => ({
      name, description: name, parameters: z.object({ tag: z.string() }), concurrency: 'shared',
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        width.now += 1; width.max = Math.max(width.max, width.now);
        // The later calls finish first, so a budget keyed on completion order would show.
        await new Promise((r) => setTimeout(r, tag === 'r1' ? 30 : tag === 'g1' ? 15 : 0));
        width.now -= 1;
        return big(tag);
      },
    });
    const cwd = mkdtempSync(join(tmpdir(), 'l2-budget-'));
    const { results } = await runRound(
      [shared('Read'), shared('Grep'), shared('WebFetch')],
      [['r1', 'Read'], ['g1', 'Grep'], ['w1', 'WebFetch']],
      { ctx: { cwd, taskId: 'l2-budget' } },
    );
    expect(width.max).toBe(3);
    expect(results.map((r) => r.toolUseId)).toEqual(['r1', 'g1', 'w1']);
    for (const r of results) {
      // Each result is its OWN body, held to the budget once, naming its own spill file.
      expect(r.text.length).toBeLessThan(big(r.toolUseId).length);
      expect(r.text).toContain(r.toolUseId);
      expect(r.text.split(`${r.toolUseId} `).length).toBeGreaterThan(10);
      for (const other of ['r1', 'g1', 'w1'].filter((t) => t !== r.toolUseId)) expect(r.text).not.toContain(`${other} ${other}`);
    }
  });

  it('concurrency: the sub-agent cost gate still admits each Agent spawn in a shared run, one by one', async () => {
    process.env[FLAG] = 'true';
    _resetFuelTanksForTest();
    const MODEL = 'claude-sonnet-4-6';
    const reserve = defaultNodeReserveUsd(MODEL, resolveCapabilities(MODEL).maxOutputTokens);
    const log: string[] = [];
    const query: RawToolOptions = {
      name: 'context_query', description: 'q', parameters: z.object({ tag: z.string() }), concurrency: 'shared',
      execute: async () => { log.push('ran:q1'); return 'memory'; },
    };
    const agent: RawToolOptions = {
      name: 'Agent', description: 'a', parameters: z.object({ tag: z.string() }), concurrency: 'shared',
      execute: async (input) => {
        const tag = (input as { tag: string }).tag;
        log.push(`ran:${tag}`);
        await new Promise((r) => setTimeout(r, 20)); // hold the reserve while the sibling asks
        return `agent:${tag}`;
      },
    };
    const { results, blocks } = await runRound([query, agent], [['q1', 'context_query'], ['a1', 'Agent'], ['a2', 'Agent']], {
      ctx: { taskId: 'l2-fuel', model: MODEL },
      // Room for ONE spawn's reserve: the first Agent is admitted, the second refused
      // before launch, and the Nami read is never fuel-gated at all.
      cfg: { sessionFuelTankUsd: reserve * 1.5 },
    });
    expect(blocks).toEqual(['use:q1', 'use:a1', 'use:a2', 'res:q1', 'res:a1', 'res:a2']);
    expect(results[0]).toMatchObject({ toolUseId: 'q1', text: 'memory' });
    expect(results[1]).toMatchObject({ toolUseId: 'a1', text: 'agent:a1' });
    expect(results[2].text).toContain('Skipped: session fuel ceiling');
    expect((results[2] as { fuelDenied?: boolean }).fuelDenied).toBe(true);
    expect(log.sort()).toEqual(['ran:a1', 'ran:q1']);
    _resetFuelTanksForTest();
  });

  it('concurrency: three 200 ms shared reads take about 200 ms, not about 600 ms', async () => {
    vi.useFakeTimers();
    const slow = (name: string): RawToolOptions => ({
      name, description: name, parameters: z.object({ tag: z.string() }), concurrency: 'shared',
      execute: async (input) => {
        await new Promise((r) => setTimeout(r, 200));
        return `${name}:${(input as { tag: string }).tag}`;
      },
    });
    const calls: Array<[string, string]> = [['q1', 'context_query'], ['m1', 'mcp_search'], ['q2', 'context_query']];
    const wall = async (): Promise<number> => {
      const t0 = Date.now();
      let settled = false;
      const run = runRound([slow('context_query'), slow('mcp_search')], calls).finally(() => { settled = true; });
      while (!settled) await vi.advanceTimersByTimeAsync(10);
      const { results } = await run;
      expect(results.map((r) => r.text)).toEqual(['context_query:q1', 'mcp_search:m1', 'context_query:q2']);
      return Date.now() - t0;
    };
    const off = await wall();
    process.env[FLAG] = 'true';
    const on = await wall();
    console.info(`[L2] three 200 ms shared reads, wall time: flag off ${off} ms, flag on ${on} ms`);
    expect(off).toBeGreaterThanOrEqual(600);
    expect(on).toBeGreaterThanOrEqual(200);
    expect(on).toBeLessThanOrEqual(210);
  });
});

// ── the whole turn: an interrupt mid-batch ──────────────────────────────────

class ScriptTransport extends FakeTransport {
  private served = false;
  constructor(private readonly round: StreamEvent[]) { super([]); }
  override callModel(): StreamEvent[] {
    if (this.served) return [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }];
    this.served = true;
    return this.round;
  }
}

describe('concurrency classes: an interrupt mid-batch', () => {
  it('concurrency: an interrupt aborts every in-flight shared call and seals each; the exclusive call never runs', async () => {
    vi.useFakeTimers();
    process.env[FLAG] = 'true';
    const aborted: string[] = [];
    const ran: string[] = [];
    let entered = 0;
    let allEntered!: () => void;
    const inFlight = new Promise<void>((r) => { allEntered = r; });
    const hanging = (name: string): RawToolOptions => ({
      name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true },
      concurrency: 'shared',
      execute: (input, ctx) => {
        const tag = (input as { tag: string }).tag;
        ctx?.signal?.addEventListener('abort', () => aborted.push(tag));
        if (++entered === 3) allEntered();
        return new Promise<never>(() => {});
      },
    });
    const edit: RawToolOptions = {
      name: 'Edit', description: 'Edit', parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: async () => { ran.push('e1'); return 'edited'; },
    };
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return { tools: [hanging('Read'), hanging('Grep'), hanging('WebFetch'), edit], onAuthHalt: async () => {} };
      },
    };
    const transport = new ScriptTransport([
      ...CALLS.map(([id, name]): StreamEvent => ({ kind: 'tool_use', toolUse: { id, name, input: { tag: id } } })),
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const journal = new Journal({
      taskId: 't-l2-abort', workspaceId: 'w',
      jsonl: new JsonlStore(join(tmpdir(), `l2-abort-${process.pid}-${Math.random().toString(36).slice(2)}`, 't.jsonl')),
      mirror: new InMemorySessionStore(), clock: sequentialClock('2024-01-01T00:00:00.000Z'),
    });
    const controller = new AbortController();
    const ctx: HarnessContext<NativeConfig> = {
      taskId: 't-l2-abort', sessionId: 's', cwd: '/tmp', model: 'fake-model', signal: controller.signal,
      config: { onAttached: () => {}, maxTurns: 10, transport, toolHost, journal, signal: controller.signal } as unknown as NativeConfig,
    };
    const events: HarnessEvent[] = [];
    const done = (async () => {
      const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'read three things' } as UserTurn; })();
      for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
    })();
    await inFlight; // all three shared calls are running at once
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000); // the drain grace
    await done;

    // Every in-flight shared call saw the abort; the Edit behind them never started.
    expect(aborted.sort()).toEqual(['g1', 'r1', 'w1']);
    expect(ran).toEqual([]);
    const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    expect(ends.map((e) => e.outcome.kind)).toEqual(['user_aborted']);
    // Every journaled tool_use is answered with the existing interrupted result.
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    const uses = entries.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId);
    const sealed = new Map(entries.filter((e) => e.payload.type === 'tool_result').map((e) => {
      const p = e.payload as { toolUseId: string; isError?: boolean; blocks?: Array<{ text?: string }> };
      return [p.toolUseId, { isError: p.isError, text: p.blocks?.[0]?.text ?? '' }];
    }));
    expect(uses).toEqual(['r1', 'g1', 'w1']);
    for (const id of uses) {
      expect(sealed.get(id)?.isError, id).toBe(true);
      expect(sealed.get(id)?.text, id).toMatch(/^Interrupted by user\./);
    }
  });
});

// ── the whole turn: two ToolSearch loads in one shared round ────────────────

/**
 * The REAL Anthropic history (push*, historyFromJournal) under a scripted model, so the
 * history a request carries is the true wire shape (FakeTransport projects to a constant
 * `[]`). Records the tool names and the history each request carried.
 */
class ScriptedAnthropic extends AnthropicMessagesTransport {
  readonly wireNames: string[][] = [];
  readonly histories: unknown[] = [];
  private served = 0;
  constructor(private readonly rounds: StreamEvent[][]) { super({ client: {} as never }); }
  override callModel(p: Parameters<AnthropicMessagesTransport['callModel']>[0]): ProviderStream {
    this.wireNames.push(p.tools.map((t) => (t as { name: string }).name));
    this.histories.push(structuredClone(p.history));
    const round = this.rounds[this.served++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }];
    return round as unknown as ProviderStream;
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    for (const ev of stream as unknown as StreamEvent[]) yield ev;
  }
}

/**
 * Holds the SECOND tool_use append until the first search's load row is written, so a
 * `custom` row lands BETWEEN the two tool_use rows: the interleave live traffic makes when
 * the event consumer is slow between PASS 1's appends. Bounded, so a path that never
 * writes the row runs slow and fails the order assertion instead of hanging.
 */
class InterleavingJournal extends Journal {
  private firstLoad!: () => void;
  private readonly loaded = new Promise<void>((r) => { this.firstLoad = r; });
  override async append(e: NewEntry): Promise<JournalEntry> {
    const p = e.payload as { type: string; toolUseId?: string; key?: string };
    if (p.type === 'tool_use' && p.toolUseId === 's2') await bounded(this.loaded, 200);
    const out = await super.append(e);
    if (p.type === 'custom' && p.key === 'tool_search_loaded') this.firstLoad();
    return out;
  }
}

describe('concurrency classes: two ToolSearch loads in one round', () => {
  it('concurrency: live load order == the load rows in seq order == the replayed order, and the check holds', async () => {
    process.env[FLAG] = 'true';
    process.env.TOOL_SEARCH_V1 = 'true';
    const dir = mkdtempSync(join(tmpdir(), 'l2-toolsearch-'));
    const file = join(dir, 't.jsonl');
    const journalFor = (J: typeof Journal) => new J({
      taskId: 't-l2-ts', workspaceId: 'w', jsonl: new JsonlStore(file),
      mirror: new InMemorySessionStore(), clock: sequentialClock('2024-01-01T00:00:00.000Z'),
    });
    try {
      const tool = (name: string, deferrable: boolean): RawToolOptions => ({
        name, description: `${name} tool`, parameters: z.object({}), ...(deferrable ? { deferrable: true } : {}),
        execute: async () => name,
      });
      // Gamma is never loaded, so ToolSearch stays on the wire and the loaded tail is only Alpha, Beta.
      const DEFERRED = new Set(['Alpha', 'Beta', 'Gamma']);
      const toolHost: ToolHost = {
        async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
          return { tools: [tool('Read', false), tool('Alpha', true), tool('Beta', true), tool('Gamma', true)], onAuthHalt: async () => {} };
        },
      };
      const transport = new ScriptedAnthropic([[
        { kind: 'tool_use', toolUse: { id: 's1', name: 'ToolSearch', input: { query: 'select:Alpha' } } },
        { kind: 'tool_use', toolUse: { id: 's2', name: 'ToolSearch', input: { query: 'select:Beta' } } },
        { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      ], [
        { kind: 'text', text: 'Both are loaded.' },
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ]]);
      const journal = journalFor(InterleavingJournal);
      const mismatches: unknown[] = [];
      const signal = new AbortController().signal;
      const ctx: HarnessContext<NativeConfig> = {
        taskId: 't-l2-ts', sessionId: 's', cwd: dir, model: 'claude-sonnet-4-6', signal,
        config: {
          onAttached: () => {}, maxTurns: 10, transport, toolHost, journal, signal,
          reconstructionCheck: 'throw', onReconstructionMismatch: (m: unknown) => mismatches.push(m),
        } as unknown as NativeConfig,
      };
      const events: HarnessEvent[] = [];
      const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'load two tools' } as UserTurn; })();
      for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);

      // The turn completed: 'throw' would have ended it on the first mismatch.
      expect(mismatches).toEqual([]);
      expect(events.filter((e) => e.kind === 'turn_end').map((e) => (e as Extract<HarnessEvent, { kind: 'turn_end' }>).outcome.kind))
        .toEqual(['completed']);
      expect(transport.wireNames).toHaveLength(2);

      // The wire, not only the check: on the journal path the loop re-projects the history
      // after every tool batch, so the check there compares the projection with itself. The
      // request that followed carried ONE assistant message holding both calls in call
      // order, then both results: the load row between the two calls never reached it.
      type Msg = { role: string; content: Array<{ type: string; id?: string; tool_use_id?: string }> };
      const next = transport.histories[1] as Msg[];
      expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(next[1].content.map((b) => `${b.type}:${b.id}`)).toEqual(['tool_use:s1', 'tool_use:s2']);
      expect(next[2].content.map((b) => `${b.type}:${b.tool_use_id}`)).toEqual(['tool_result:s1', 'tool_result:s2']);
      expect(JSON.stringify(next)).not.toContain('tool_search_loaded');

      const entries: JournalEntry[] = [];
      for await (const e of journal.read()) entries.push(e);
      const row = (e: JournalEntry): string => {
        const p = e.payload as { type: string; toolUseId?: string; key?: string; data?: { names?: string[] } };
        return p.type === 'custom' ? `custom:${p.data?.names?.join(',')}` : `${p.type}:${p.toolUseId}`;
      };
      // A load row sits BETWEEN the two tool_use rows of the two-phase batch, and the
      // results still land in call order.
      expect(entries.filter((e) => ['tool_use', 'tool_result'].includes(e.payload.type)
        || (e.payload.type === 'custom' && e.payload.key === 'tool_search_loaded')).map(row))
        .toEqual(['tool_use:s1', 'custom:Alpha', 'tool_use:s2', 'custom:Beta', 'tool_result:s1', 'tool_result:s2']);

      // Live: the loaded tail of the next request IS state.order (shapeToolSearchTools appends it).
      const live = transport.wireNames[1].filter((n) => DEFERRED.has(n));
      const rows = entries
        .filter((e) => e.payload.type === 'custom' && e.payload.key === 'tool_search_loaded')
        .sort((a, b) => a.seq - b.seq)
        .flatMap((e) => (e.payload as { data: { names: string[] } }).data.names);
      // Replay: what a recycled runner rebuilds from a cold journal over the same file.
      const replayed = createToolSearchState(await readToolSearchLoaded(journalFor(Journal))).order;
      expect(live).toEqual(['Alpha', 'Beta']);
      expect(rows).toEqual(live);
      expect(replayed).toEqual(live);
    } finally {
      delete process.env.TOOL_SEARCH_V1;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
