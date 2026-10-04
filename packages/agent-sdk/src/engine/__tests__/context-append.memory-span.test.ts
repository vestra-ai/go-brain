/**
 * A held context-append base cuts the same memory span on every run of a session.
 *
 * CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1 move the memory out of the system prompt
 * at a span run open measures once (native-run-open.ts → RunContext.systemMemorySpan). A held
 * session serves its FIRST run's prompt on later runs while the live layers move on (a newer
 * tool index, an aged memory line), so the span must come from the layers the served prompt was
 * rendered from: holdSession hands them back. Measured from the live layers instead, a later run
 * would find no span, send the prompt whole, and change shape mid-session: a cache miss on the
 * very rail that exists to keep the prefix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Journal } from '../../kernel/journal/journal.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import { assembleInstructionStack, cutMemorySpan, memorySpan, type InstructionLayer } from '../../contract/instruction-stack.js';
import { holdSession, holdSessionPrefix } from '../context-append.js';
import { buildRoundRequest } from '../round-stream.js';
import type { RoundDeps } from '../round-engine.js';

const FLAG = 'CONTEXT_APPEND_V1';
const LANE_FLAG = 'RESPONSES_MEMORY_INPUT_V1';
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[LANE_FLAG];
});

function fakeJournal(): Journal {
  const entries: JournalEntry[] = [];
  return {
    async snapshot() { return entries; },
    async project() { return { messages: entries.filter((e) => e.payload.type === 'user'), leaf: null }; },
    async append(e: NewEntry) {
      const full = { ...e, uuid: `u${entries.length + 1}`, seq: entries.length + 1, parentUuid: null, timestamp: 't' } as JournalEntry;
      entries.push(full);
      return full;
    },
  } as unknown as Journal;
}

const layersOf = (toolSearch: string, nami: string): InstructionLayer[] => [
  { id: 'soul', text: 'You are a careful assistant.', static: true },
  { id: 'tool_search', text: toolSearch, static: true },
  { id: 'operational', text: 'Keep files tidy.', static: true },
  { id: 'agent_mode', text: 'You book travel for the company.', static: false },
  { id: 'nami', text: nami, static: false },
];
const INDEX = 'Tools you can load: calendar_find';
const sys = (layers: InstructionLayer[]) => `${assembleInstructionStack(layers, 'native')}\n\n${INDEX}`;
const ctxOf = (j: Journal, layers: InstructionLayer[]): HarnessContext<NativeConfig> => ({
  taskId: 'task-memory-span', sessionId: 's', cwd: '/tmp', model: 'm', signal: new AbortController().signal,
  config: { journal: j, instructionLayers: layers, runtimeConfig: { userId: 'u' } } as unknown as NativeConfig,
});
const runOpen = (j: Journal, layers: InstructionLayer[]) =>
  holdSession(ctxOf(j, layers), { system: sys(layers), toolIndex: INDEX, sessionStart: '' });

describe('holdSession — the served prompt and the layers it was rendered from', () => {
  it('a later run with moved live layers cuts the same span from the held prompt', async () => {
    process.env[FLAG] = 'true';
    const j = fakeJournal();
    const first = layersOf('[tool_search] calendar_find', '<user_memory>\nrefreshed 1 hour ago\n</user_memory>');
    const one = (await runOpen(j, first))!;
    expect(one.system).toBe(sys(first));
    const spanOne = memorySpan(one.system, one.layers)!;
    expect(spanOne).toBeDefined();

    // The next run: the tool index grew and the memory aged. Both are APPEND parts, told as an
    // update; the served prompt is the first run's, byte for byte.
    const later = layersOf('[tool_search] calendar_find, mail_send', '<user_memory>\nrefreshed 3 hours ago\n</user_memory>');
    const two = (await runOpen(j, later))!;
    expect(two.system).toBe(one.system);
    expect(memorySpan(two.system, two.layers)).toEqual(spanOne);
    expect(cutMemorySpan(two.system, memorySpan(two.system, two.layers))).toEqual(cutMemorySpan(one.system, spanOne));
    // The live layers cannot cut the held prompt: the reason run open uses these.
    expect(memorySpan(two.system, later)).toBeUndefined();
  });

  it('agent_mode stays outside the cut, the memory is what moves', async () => {
    process.env[FLAG] = 'true';
    const held = (await runOpen(fakeJournal(), layersOf('[tool_search] x', '<user_memory>\nM\n</user_memory>')))!;
    const cut = cutMemorySpan(held.system, memorySpan(held.system, held.layers))!;
    expect(cut.memory).toBe('<user_memory>\nM\n</user_memory>');
    expect(cut.rest).toContain('You book travel for the company.');
    expect(cut.rest.endsWith(INDEX)).toBe(true);
  });

  it('holdSessionPrefix still answers the served prompt alone; the flag off and never frozen answers nothing', async () => {
    const layers = layersOf('[tool_search] x', '<user_memory>\nM\n</user_memory>');
    expect(await holdSessionPrefix(ctxOf(fakeJournal(), layers), { system: sys(layers), toolIndex: INDEX, sessionStart: '' })).toBeUndefined();
    expect(await runOpen(fakeJournal(), layers)).toBeUndefined();
    process.env[FLAG] = 'true';
    expect(await holdSessionPrefix(ctxOf(fakeJournal(), layers), { system: sys(layers), toolIndex: INDEX, sessionStart: '' })).toBe(sys(layers));
  });
});

describe('mid-run: a warm refresh moves the config, never the cut', () => {
  /** One round's request on GPT-6.1 Sol, with whatever layers the config holds by then. */
  const round = (system: string, cfgLayers: InstructionLayer[], rc: unknown) =>
    buildRoundRequest({
      ctx: { taskId: 'task-memory-span', config: { runtimeConfig: { userId: 'u' } } },
      cfg: { instructionLayers: cfgLayers },
      rc,
      providerTools: [],
      system,
      requestedModel: 'gpt-6.1-sol',
      cachePrefixHint: undefined,
      history: [],
    } as unknown as RoundDeps);

  it('every round carries the span measured at open, even after fresh layers land on the config', async () => {
    process.env[FLAG] = 'true';
    process.env[LANE_FLAG] = 'true';
    const first = layersOf('[tool_search] calendar_find', '<user_memory>\nrefreshed 1 hour ago\n</user_memory>');
    const held = (await runOpen(fakeJournal(), first))!;
    const rc = { systemMemorySpan: { span: memorySpan(held.system, held.layers)!, system: held.system } };
    // CONTEXT_APPEND_WARM re-renders the layers at a turn start (an app connected, the memory
    // moved, the date turned); the served prompt is unchanged and the change is told, not rendered.
    const refreshed = layersOf('[tool_search] calendar_find, mail_send', '<user_memory>\nrefreshed just now\n</user_memory>');
    expect(round(held.system, first, rc).systemMemorySpan).toEqual(rc.systemMemorySpan.span);
    expect(round(held.system, refreshed, rc).systemMemorySpan).toEqual(rc.systemMemorySpan.span);
  });

  it('a round whose prompt is not the one measured carries no span: never a cut at stale offsets', async () => {
    process.env[FLAG] = 'true';
    process.env[LANE_FLAG] = 'true';
    const layers = layersOf('[tool_search] x', '<user_memory>\nM\n</user_memory>');
    const held = (await runOpen(fakeJournal(), layers))!;
    const rc = { systemMemorySpan: { span: memorySpan(held.system, held.layers)!, system: held.system } };
    expect('systemMemorySpan' in round(`${held.system} and a rebuilt tail`, layers, rc)).toBe(false);
  });
});
