import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Budget } from '../budget.js';
import type { AnthropicLike } from './anthropic.js';
import { computeAnthropicCostUsd, normalizeAnthropicUsage, resolveCapabilities, type AnthropicUsage } from './anthropic-helpers.js';
import type { TextBlock } from './context.js';
import { STAY_SILENT, type QuickTool, type TurnCtx } from './tools.js';

export const MAX_ROUNDS = 4;
export const MAX_TOKENS = 1_024;
const ROLLING = { type: 'ephemeral' } as const; // 5 minutes: it only has to last the turn

export interface Usage {
  /** Input not read from or written to the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd: number;
}
export const noUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 });
export function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  into.output += u.output;
  into.costUsd += u.costUsd;
}

export interface LoopInput {
  client: AnthropicLike;
  model: string;
  system: TextBlock[];
  messages: Anthropic.MessageParam[];
  tools: QuickTool<any>[];
  ctx: TurnCtx;
  signal: AbortSignal;
  maxRounds?: number;
  /** True when this call continues an exchange (the pre-post check): its first round already carries the rolling marker. */
  continuing?: boolean;
  onFirstToken?: () => void;
  toolTimeoutMs?: number;
  /** The daily model budget: checked before each round, and given each round's cost. */
  budget?: Pick<Budget, 'allows' | 'spend'>;
}

export interface LoopResult {
  /** What to post: the last round's text, or the latest text an earlier round wrote. Empty when silent. */
  text: string;
  silent: boolean;
  rounds: number;
  usage: Usage;
  /** The whole exchange so far, ending with the model's last message or the last tool results. */
  messages: Anthropic.MessageParam[];
  stopReason: string | null;
}

/** Tool definitions from the zod inputs. */
export function toolDefs(tools: QuickTool<any>[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.input, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool['input_schema'] };
  });
}

type Marked = { cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } | null };
const isRolling = (b: Anthropic.ContentBlockParam): boolean => {
  const cc = (b as Marked).cache_control;
  return cc != null && cc.ttl !== '1h';
};
function unmark(b: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam {
  const copy = { ...b } as Record<string, unknown>;
  delete copy.cache_control;
  return copy as unknown as Anthropic.ContentBlockParam;
}

/** Keeps the chat's one-hour marker and moves the one rolling marker to the newest block. */
export function withRollingMarker(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = messages.map((m) =>
    typeof m.content === 'string' ? m : { ...m, content: m.content.map((b) => (isRolling(b) ? unmark(b) : b)) },
  );
  const last = out[out.length - 1];
  if (!last || typeof last.content === 'string') return out;
  const tail = last.content[last.content.length - 1];
  if (!tail || (tail.type !== 'text' && tail.type !== 'tool_result')) return out;
  out[out.length - 1] = { ...last, content: [...last.content.slice(0, -1), { ...tail, cache_control: ROLLING } as Anthropic.ContentBlockParam] };
  return out;
}

/** Cache markers in a request; the API allows 4. */
export function countMarkers(system: unknown, tools: unknown, messages: unknown): number {
  return (JSON.stringify([system, tools, messages]).match(/"cache_control":\{/g) ?? []).length;
}

/** The assistant's content as request blocks: text, tool calls and any thinking, verbatim. */
function toParams(content: Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    else if (b.type === 'redacted_thinking') out.push({ type: 'redacted_thinking', data: b.data });
  }
  return out;
}

function usageOf(u: Anthropic.Usage, model: string): Usage {
  const wire: AnthropicUsage = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    ...(u.cache_creation
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens,
            ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens,
          },
        }
      : {}),
  };
  const n = normalizeAnthropicUsage(wire);
  return {
    input: n.inputTokens,
    cacheRead: n.cacheReadInputTokens ?? 0,
    cacheWrite: n.cacheCreationInputTokens ?? 0,
    output: n.outputTokens,
    costUsd: computeAnthropicCostUsd(wire, model),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the tool took longer than ${ms} ms`)), ms);
    const onAbort = (): void => reject(new Error('the turn ran out of time'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function runTool(tool: QuickTool<any> | undefined, call: Anthropic.ToolUseBlock, i: LoopInput): Promise<Anthropic.ToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  if (!tool) return result(`There is no tool named ${call.name}.`, true);
  // A turn with limits (P6's proactive bar): any other tool is refused before it runs. The definitions sent never change.
  const allowed = i.ctx.allowedTools;
  if (allowed && call.name !== STAY_SILENT && !allowed.includes(call.name)) {
    const can = [...new Set([...allowed, STAY_SILENT])].join(', ');
    return result(`${call.name} is not allowed this turn. You can use: ${can}.`, true);
  }
  const args = tool.input.safeParse(call.input);
  if (!args.success) return result(`Invalid arguments for ${call.name}: ${z.prettifyError(args.error)}. Fix them and call it again.`, true);
  try {
    const out = await withTimeout(tool.run(args.data, i.ctx), i.toolTimeoutMs ?? 8_000, i.signal);
    return result(typeof out === 'string' ? out : JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    return result((e instanceof Error ? e.message : String(e)).slice(0, 500), true);
  }
}

/**
 * One composer turn's model rounds: a direct Messages tool loop. At most 4 rounds; the tools of a round
 * run together; stay_silent ends the turn with no extra call; every round's usage is summed.
 */
export async function runLoop(i: LoopInput): Promise<LoopResult> {
  const maxRounds = Math.min(i.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS);
  const tools = toolDefs(i.tools);
  const byName = new Map(i.tools.map((t) => [t.name, t]));
  const caps = resolveCapabilities(i.model);
  // Thinking off: 'between_tools' on Sonnet 5.5 (which cannot omit it); no thinking field on other models.
  const thinking = caps.id === 'claude-sonnet-5-5' ? { type: 'between_tools' } : undefined;
  const messages = [...i.messages];
  const usage = noUsage();
  let firstToken = false;
  let latestText = '';
  for (let round = 1; round <= maxRounds; round++) {
    // Over today's model budget: no more model calls; the turn keeps what it has.
    if (i.budget && !i.budget.allows()) {
      return { text: latestText, silent: i.ctx.outcome.silent, rounds: round - 1, usage, messages, stopReason: 'over_budget' };
    }
    let outgoing = round > 1 || i.continuing ? withRollingMarker(messages) : messages;
    if (countMarkers(i.system, tools, outgoing) > 4) outgoing = messages;
    const body = {
      model: i.model,
      max_tokens: Math.min(MAX_TOKENS, caps.maxOutputTokens),
      system: i.system,
      tools,
      tool_choice: { type: 'auto' },
      messages: outgoing,
      ...(thinking ? { thinking } : {}),
    };
    // 'between_tools' is not in the SDK's types yet, so the body is cast.
    const stream = i.client.messages.stream(body as unknown as Anthropic.MessageStreamParams, { signal: i.signal });
    for await (const ev of stream) {
      if (!firstToken && ev.type === 'content_block_delta') {
        firstToken = true;
        i.onFirstToken?.();
      }
    }
    const reply = await stream.finalMessage();
    const spent = usageOf(reply.usage, i.model);
    addUsage(usage, spent);
    await i.budget?.spend({ purpose: 'composer', model: i.model, usd: spent.costUsd });
    const text = reply.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text) latestText = text;
    // The API refuses an empty assistant message in an exchange that goes on (the pre-post check continues this one): a
    // round that wrote nothing stands for the answer the turn will post, the latest text an earlier round wrote.
    const said = toParams(reply.content);
    messages.push({ role: 'assistant', content: said.length || !latestText ? said : [{ type: 'text', text: latestText }] });
    const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || calls.length === 0) {
      return { text: text || latestText, silent: i.ctx.outcome.silent, rounds: round, usage, messages, stopReason: reply.stop_reason };
    }
    const results = await Promise.all(calls.map((c) => runTool(byName.get(c.name), c, i)));
    messages.push({ role: 'user', content: results });
    if (calls.some((c) => c.name === STAY_SILENT)) {
      i.ctx.outcome.silent = true;
      return { text: '', silent: true, rounds: round, usage, messages, stopReason: STAY_SILENT };
    }
  }
  return { text: latestText, silent: i.ctx.outcome.silent, rounds: maxRounds, usage, messages, stopReason: 'max_rounds' };
}
