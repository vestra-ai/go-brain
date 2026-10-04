/**
 * CHAT_TAIL_AFTER_TOOLS_V1 — a user's new task reads the tools from cache on Fireworks.
 *
 * Speed race item D (staging tasks 3d34d448 / cfd73d1d, the same user): every journaled
 * instruction layer hash matched except `nami`, whose week view first differs at char 5219
 * (the task before joins "Past few days"). DeepSeek V4.1 Flash's chat template renders the
 * tools AFTER the system message, so a new task's cached prefix stopped ~10.4k tokens in, in
 * front of the tools (measured on staging: 38% cached before, 90% after). The run measures
 * where its memory sits once at open (instruction-stack.ts memorySpan) and, on the builds that
 * render tools after the system message, the memory rides as a second system message behind
 * them. These pins hold the span, the cut, the byte-identity everywhere else, and the
 * cross-task cache shape end to end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { ChatCompletionsTransport, splitSystem } from '../chat-completions-transport.js';
import {
  assembleInstructionStack,
  cutMemorySpan,
  INSTRUCTION_LAYER_ORDER,
  MEMORY_TAIL_LAYER_IDS,
  memorySpan,
  SESSION_FROZEN_LAYER_IDS,
  type InstructionLayer,
  type InstructionLayerId,
} from '../../contract/instruction-stack.js';
import { rendersToolsAfterSystem, TOOLS_AFTER_SYSTEM_WIRE_IDS, fireworksWireId } from '../../contract/fireworks-wire.js';
import { buildRoundRequest } from '../../engine/round-stream.js';
import type { RoundDeps } from '../../engine/round-engine.js';
import type { ProviderHistory, ProviderTool } from '../../engine/transport.js';

const FLAG = 'CHAT_TAIL_AFTER_TOOLS_V1';
afterEach(() => { delete process.env[FLAG]; });

const layer = (id: InstructionLayerId, text: string): InstructionLayer => ({
  id, text, static: !SESSION_FROZEN_LAYER_IDS.includes(id),
});

/** A full stack for one user; only the memory block changes between their tasks. */
function stack(nami: string, overrides: Partial<Record<InstructionLayerId, string>> = {}): InstructionLayer[] {
  return INSTRUCTION_LAYER_ORDER.map((id) =>
    layer(id, id === 'nami' ? nami : overrides[id] ?? `[${id}] the ${id} rules for this user`),
  );
}

const TOOL_INDEX = 'Tools you can load: calendar_find, mail_send, sheet_write';
/** The system prompt the prologue builds: the stack, then the deferred-tool index. */
const systemOf = (layers: InstructionLayer[]): string => `${assembleInstructionStack(layers, 'native')}\n\n${TOOL_INDEX}`;
const head = (layers: InstructionLayer[]): string =>
  assembleInstructionStack(layers.filter((l) => !MEMORY_TAIL_LAYER_IDS.includes(l.id)), 'native');
const memoryOf = (layers: InstructionLayer[]): string =>
  assembleInstructionStack(layers.filter((l) => MEMORY_TAIL_LAYER_IDS.includes(l.id)), 'native');

const TASK_A = '<this_week>\n## Past few days\n- ev:task:1 booked the Lisbon flights\n</this_week>';
const TASK_B = '<this_week>\n## Past few days\n- ev:task:2 the Lisbon hotel\n- ev:task:1 booked the Lisbon flights\n</this_week>';

describe('memorySpan — where the memory sits in what the run serves', () => {
  it('starts after everything a user\'s tasks share and ends before the tool index, the same for two tasks', () => {
    const a = stack(TASK_A), b = stack(TASK_B);
    const sa = memorySpan(systemOf(a), a)!, sb = memorySpan(systemOf(b), b)!;
    expect(sa.start).toBe(head(a).length);
    expect(sb.start).toBe(sa.start);
    expect(systemOf(a).slice(sa.start + 2, sa.end)).toBe(memoryOf(a));
    expect(systemOf(a).slice(sa.end)).toBe(`\n\n${TOOL_INDEX}`);
    expect(cutMemorySpan(systemOf(a), sa)!.rest).toBe(cutMemorySpan(systemOf(b), sb)!.rest);
  });

  it('keeps agent_mode and connected_accounts in front: instructions, shared by same-agent tasks', () => {
    const a = stack(TASK_A);
    const { rest, memory } = cutMemorySpan(systemOf(a), memorySpan(systemOf(a), a))!;
    expect(rest).toContain('[agent_mode]');
    expect(rest).toContain('[connected_accounts]');
    expect(rest.endsWith(TOOL_INDEX)).toBe(true);
    expect(memory.startsWith('[situation]')).toBe(true);
    expect(memory).toContain(TASK_A);
  });

  it('is undefined when the prompt was not rendered from these layers, or holds no memory', () => {
    const a = stack(TASK_A);
    expect(memorySpan(`SessionStart context\n\n${systemOf(a)}`, a)).toBeUndefined();
    // A held base measured with the LIVE layers after a head layer moved: why run open measures
    // with the layers the prompt was rendered from (context-append.memory-span.test.ts).
    expect(memorySpan(systemOf(a), stack(TASK_A, { tool_search: '[tool_search] a newer index' }))).toBeUndefined();
    const noMemory = a.filter((l) => !MEMORY_TAIL_LAYER_IDS.includes(l.id));
    expect(memorySpan(assembleInstructionStack(noMemory, 'native'), noMemory)).toBeUndefined();
    expect(memorySpan('', [])).toBeUndefined();
  });
});

describe('rendersToolsAfterSystem — a property of the served build', () => {
  it('holds for V4.1 Flash and the retired V4 Flash id that rides its slug, nothing unprobed', () => {
    expect(TOOLS_AFTER_SYSTEM_WIRE_IDS).toEqual(['accounts/fireworks/models/deepseek-v4p1-flash']);
    expect(rendersToolsAfterSystem('deepseek-v4.1-flash')).toBe(true);
    expect(rendersToolsAfterSystem('deepseek-v4-flash')).toBe(true);
    expect(fireworksWireId('deepseek-v4-flash')).toBe(fireworksWireId('deepseek-v4.1-flash'));
    for (const id of ['glm-5.2', 'deepseek-v4-pro', 'gpt-5.6-sol', 'kimi-k3']) expect(rendersToolsAfterSystem(id), id).toBe(false);
  });
});

describe('splitSystem', () => {
  const sys = 'shared rules\n\nper-task memory\n\ntool index';
  const span = { start: 'shared rules'.length, end: 'shared rules\n\nper-task memory'.length };
  it('is one system message without a usable span', () => {
    for (const s of [undefined, { start: 0, end: 5 }, { start: 3, end: 99 }, { start: 3, end: 4 }, { start: 2, end: 9 }]) {
      expect(splitSystem(sys, s), JSON.stringify(s)).toEqual([{ role: 'system', content: sys }]);
    }
  });

  it('is two system messages: the prompt without the memory, then the memory', () => {
    expect(splitSystem(sys, span)).toEqual([
      { role: 'system', content: 'shared rules\n\ntool index' },
      { role: 'system', content: 'per-task memory' },
    ]);
  });
});

/** Capture the request body the transport sends. */
function bodyOf(p: Parameters<ChatCompletionsTransport['callModel']>[0]): { model: string; messages: Array<{ role: string; content: unknown }>; tools: unknown } {
  const stream = vi.fn().mockReturnValue((async function* () { /* body only */ })());
  const client = { chat: { completions: { create: vi.fn(), stream } } } as unknown as OpenAI;
  new ChatCompletionsTransport({ client }).callModel(p);
  return stream.mock.calls[0][0];
}

const TOOLS = [{ type: 'function', function: { name: 'mail_send', description: 'Send a mail.', parameters: { type: 'object', properties: {} } } }] as unknown as ProviderTool[];
const HISTORY = [{ role: 'user', content: 'plan my Lisbon week' }] as unknown as ProviderHistory;

describe('ChatCompletionsTransport — the memory behind the tools', () => {
  const a = stack(TASK_A);
  const system = systemOf(a);
  const span = memorySpan(system, a)!;
  const base = { system, tools: TOOLS, history: HISTORY, maxTokens: 1024 };

  it('sends the memory as a second system message on V4.1 Flash, the history after it', () => {
    const { messages } = bodyOf({ ...base, model: 'deepseek-v4.1-flash', systemMemorySpan: span });
    expect(messages[0]).toEqual({ role: 'system', content: `${head(a)}\n\n${TOOL_INDEX}` });
    expect(messages[1]).toEqual({ role: 'system', content: memoryOf(a) });
    expect(messages[2]).toEqual({ role: 'user', content: 'plan my Lisbon week' });
  });

  it('is byte-identical on every other build and without a span', () => {
    const today = JSON.stringify(bodyOf({ ...base, model: 'deepseek-v4.1-flash' }));
    expect(JSON.parse(today).messages[0]).toEqual({ role: 'system', content: system });
    for (const model of ['glm-5.2', 'deepseek-v4-pro']) {
      expect(JSON.stringify(bodyOf({ ...base, model, systemMemorySpan: span })), model)
        .toBe(JSON.stringify(bodyOf({ ...base, model })));
    }
  });
});

describe('two new tasks of one user — the cache shape end to end (layers → run span → round request → body)', () => {
  /** The first-round body a new task sends: the span as run open measures it, then the round request. */
  function firstRequest(taskId: string, layers: InstructionLayer[], withRun = true) {
    const system = systemOf(layers);
    const deps = {
      ctx: { taskId, config: { runtimeConfig: { userId: 'u-1' } } },
      cfg: {},
      providerTools: TOOLS,
      system,
      requestedModel: 'deepseek-v4.1-flash',
      cachePrefixHint: undefined,
      history: HISTORY,
      ...(withRun && { rc: { systemMemorySpan: { span: memorySpan(system, layers), system } } }),
    } as unknown as RoundDeps;
    const params = buildRoundRequest(deps);
    return { params, body: bodyOf(params) };
  }

  it('flag ON: the first system message and the tools are identical, the tasks differ only from messages[1]', () => {
    process.env[FLAG] = 'true';
    const a = firstRequest('task-a', stack(TASK_A));
    const b = firstRequest('task-b', stack(TASK_B));
    expect(a.params.systemMemorySpan).toEqual(memorySpan(systemOf(stack(TASK_A)), stack(TASK_A)));
    expect(a.body.model).toBe(b.body.model);
    expect(JSON.stringify(a.body.tools)).toBe(JSON.stringify(b.body.tools));
    expect(a.body.messages[0]).toEqual(b.body.messages[0]);
    expect(a.body.messages[1]).not.toEqual(b.body.messages[1]);
    expect(a.body.messages.slice(2)).toEqual(b.body.messages.slice(2));
  });

  it('flag OFF: no field on the request, and the first message already differs (the measured miss)', () => {
    const a = firstRequest('task-a', stack(TASK_A));
    const b = firstRequest('task-b', stack(TASK_B));
    expect('systemMemorySpan' in a.params).toBe(false);
    expect(a.body.messages[0]).not.toEqual(b.body.messages[0]);
    expect(a.body.messages[1]).toEqual({ role: 'user', content: 'plan my Lisbon week' });
  });

  it('flag ON but a round with no run context (a subagent\'s) carries no field', () => {
    process.env[FLAG] = 'true';
    expect('systemMemorySpan' in firstRequest('t', stack(TASK_A), false).params).toBe(false);
  });
});
