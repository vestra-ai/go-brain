import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Budget, Reservation } from '../budget.js';
import type { AnthropicLike } from './anthropic.js';
import { computeAnthropicCostUsd, estimateCostUsd, normalizeAnthropicUsage, resolveCapabilities, type AnthropicUsage } from './anthropic-helpers.js';
import type { TextBlock } from './context.js';
import { withoutRefused, type Refusals } from './sanitize.js';
import { undoneNote } from './next-step.js';
import { SAY_NOTHING, STAY_SILENT, type QuickTool, type TurnCtx } from './tools.js';

export const MAX_ROUNDS = 4;
/** The stop reason of a turn that ended on its cards: every call in the last reply was a card tool that put its card up. */
export const CARDS_UP = 'cards_up';
/** A round's output cap. Thinking counts toward it, so it leaves room for a short think before a reply. */
export const MAX_TOKENS = 2_048;
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
  onFirstToken?: () => void;
  toolTimeoutMs?: number;
  /** The daily model budget: each round holds its estimate first, and settles to what it really cost. */
  budget?: Pick<Budget, 'reserve'>;
}

/** One model round's timing, for the turn's log line: no text, only what was called and how long it took. */
export interface RoundTiming {
  /** The tools the round asked for, in order. */
  tools: string[];
  /** From the round's request to its first streamed delta (text, thinking or a tool's input); null when none came. */
  firstTokenMs: number | null;
  /** From the round's request to its whole reply. */
  modelMs: number;
  /** Running the round's tools. */
  toolMs: number;
  output: number;
  stop: string | null;
}

export interface LoopResult {
  /**
   * What to post: the last round's text, or the latest text an earlier round wrote. Empty when silent. A turn that ended
   * on its cards posts only that reply's own text, which may be none: the cards carry their own words.
   */
  text: string;
  silent: boolean;
  rounds: number;
  usage: Usage;
  /** The whole exchange so far, ending with the model's last message or the last tool results. */
  messages: Anthropic.MessageParam[];
  stopReason: string | null;
  /** Every round's timing, in order. */
  timings: RoundTiming[];
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

/** The tallies for a reply's calls: one line for each summary that two or more of its calls share (see summarizeRound). */
export function roundNotes(
  calls: Anthropic.ToolUseBlock[],
  results: Anthropic.ToolResultBlockParam[],
  byName: ReadonlyMap<string, QuickTool<any>>,
): Anthropic.TextBlockParam[] {
  const groups = new Map<NonNullable<QuickTool['summarizeRound']>, Array<{ content: string; isError: boolean }>>();
  calls.forEach((c, k) => {
    const summarize = byName.get(c.name)?.summarizeRound;
    const r = results[k];
    if (!summarize || !r) return;
    groups.set(summarize, [...(groups.get(summarize) ?? []), { content: typeof r.content === 'string' ? r.content : '', isError: r.is_error === true }]);
  });
  const notes: Anthropic.TextBlockParam[] = [];
  for (const [summarize, rs] of groups) {
    const line = rs.length > 1 ? summarize(rs) : null;
    if (line) notes.push({ type: 'text', text: line });
  }
  return notes;
}

/** Whether a tool's answer says it did nothing: an error, or an answer that refused ("refused", "error", ok: false). */
function refusedResult(r: Anthropic.ToolResultBlockParam): boolean {
  if (r.is_error) return true;
  if (typeof r.content !== 'string') return false;
  try {
    const o = JSON.parse(r.content) as unknown;
    return typeof o === 'object' && o !== null && ('refused' in o || 'error' in o || (o as { ok?: unknown }).ok === false);
  } catch {
    return false;
  }
}

/**
 * What the turn's calls so far rule out of its reply (sanitize.ts withoutRefused): the tools that refused quietly, and the
 * claims of a tool that was called this turn and refused every time. A tool not called this turn rules nothing out: a
 * plain "Noted, Priya" with no record call stands.
 */
function refusalsOf(seen: ReadonlyArray<{ name: string; refused: boolean; quiet: boolean }>, byName: ReadonlyMap<string, QuickTool<any>>): Refusals {
  const went = new Set(seen.filter((s) => !s.refused).map((s) => s.name));
  const refused = [...new Set(seen.filter((s) => s.refused && !went.has(s.name)).map((s) => s.name))];
  return {
    names: [...new Set(seen.filter((s) => s.quiet).map((s) => s.name))],
    claims: refused.flatMap((n) => byName.get(n)?.claims ?? []),
  };
}

/** A note to the model after the last message: into the user turn there is (tool results), or as one of its own. */
function addNote(messages: Anthropic.MessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text });
  else messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

async function runTool(tool: QuickTool<any> | undefined, call: Anthropic.ToolUseBlock, i: LoopInput): Promise<Anthropic.ToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  if (!tool) return result(i.tools.map((t) => t.misnamed?.(call.name)).find((hint) => hint !== undefined) ?? `There is no tool named ${call.name}.`, true);
  // A turn with limits (P6's proactive bar): any other tool is refused before it runs. The definitions sent never change.
  const allowed = i.ctx.allowedTools;
  if (allowed && call.name !== STAY_SILENT && !allowed.includes(call.name)) {
    const can = [...new Set([...allowed, STAY_SILENT])].join(', ');
    return result(`${call.name} is not allowed this turn. You can use: ${can}. ${SAY_NOTHING}`, true);
  }
  const args = tool.input.safeParse(call.input);
  if (!args.success) return result(`Invalid arguments for ${call.name}: ${z.prettifyError(args.error)}. Fix them and call it again.`, true);
  try {
    const out = await withTimeout(tool.run(args.data, i.ctx), tool.timeoutMs ?? i.toolTimeoutMs ?? 8_000, i.signal);
    return result(typeof out === 'string' ? out : JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    return result((e instanceof Error ? e.message : String(e)).slice(0, 500), true);
  }
}

/**
 * One model call under a budget hold, settled to what Anthropic billed whether it finished or not: the final usage,
 * else what message_start and message_delta said before the stream stopped, else (nothing arrived) the hold itself.
 */
async function underHold<T>(hold: Reservation | null, model: string, call: (billed: { usage: Anthropic.Usage | null }) => Promise<T>): Promise<T> {
  const billed: { usage: Anthropic.Usage | null } = { usage: null };
  try {
    return await call(billed);
  } finally {
    await hold?.settle(billed.usage ? usageOf(billed.usage, model).costUsd : null);
  }
}

/**
 * One composer turn's model rounds: a direct Messages tool loop. At most 4 rounds; the tools of a round
 * run together; stay_silent ends the turn with no extra call, and so does a reply whose calls are all card tools that
 * put their cards up; every round's usage is summed.
 */
export async function runLoop(i: LoopInput): Promise<LoopResult> {
  const maxRounds = Math.min(i.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS);
  const tools = toolDefs(i.tools);
  const byName = new Map(i.tools.map((t) => [t.name, t]));
  const caps = resolveCapabilities(i.model);
  // Thinking on, at low effort, on Sonnet 5.5: the model's working goes to thinking, so its text is only ever words for
  // the room. With thinking off ('between_tools') it wrote its working as text before every tool call ("Priya asked for
  // a villa search, so I'll run it", 12 of 12 probe turns, 10 Oct); with it on, none did, and at low it mostly skips
  // thinking, so turns were no slower. No thinking field on other models.
  const thinking = caps.id === 'claude-sonnet-5-5' ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } : {};
  // Without thinking, the words a tool round writes are its working, so they never become the reply: not when the last
  // round writes nothing, not with a card that has no line, not when the budget stops the turn (the Server team saw them
  // in the room on the 7 Oct build, GO-TEAM-FINAL §8). With thinking they are words for the room ("Opening a vote now!").
  const toolWordsSpeak = 'thinking' in thinking;
  const messages = [...i.messages];
  const usage = noUsage();
  const timings: RoundTiming[] = [];
  let firstToken = false;
  let latestText = '';
  // Every call this turn and whether it was refused, quietly or not: the reply never narrates a quiet refusal, and never
  // claims the work of a tool that did nothing (8 Oct: "The record call was refused, so I'll… Noted, …").
  const seen: Array<{ name: string; refused: boolean; quiet: boolean }> = [];
  // The one extra round a promised next step or an undone check gets (next-step.ts undoneNote).
  let nudged = false;
  const clean = (t: string): string => withoutRefused(t, refusalsOf(seen, byName));
  // One round past the limit closes a turn whose last round still called tools: that round's words were written before
  // its calls (its working, "The message ID format is…", staging drill 10 Oct), never an answer. The closing round may
  // call no tool, so it writes the reply from what the tools said.
  for (let round = 1; round <= maxRounds + 1; round++) {
    const closing = round > maxRounds;
    // Every round marks its newest block, the first too: a round after it reads the whole prompt so far from the cache.
    let outgoing = withRollingMarker(messages);
    if (countMarkers(i.system, tools, outgoing) > 4) outgoing = messages;
    const body = {
      model: i.model,
      max_tokens: Math.min(MAX_TOKENS, caps.maxOutputTokens),
      system: i.system,
      tools,
      tool_choice: { type: closing ? 'none' : 'auto' },
      messages: outgoing,
      ...thinking,
    };
    // The budget holds this round's upper-bound cost before the call; over today's cap there is no call, and the
    // turn keeps what it has.
    const hold = i.budget ? i.budget.reserve({ purpose: 'composer', model: i.model, usd: estimateCostUsd(i.model, body, body.max_tokens) }) : null;
    if (i.budget && !hold) {
      return { text: clean(latestText), silent: i.ctx.outcome.silent, rounds: round - 1, usage, messages, stopReason: 'over_budget', timings };
    }
    const asked = Date.now();
    let firstDelta: number | null = null;
    const reply = await underHold(hold, i.model, async (billed) => {
      // The body's literal fields (tool_choice's type) widen to string, so it is cast.
      const stream = i.client.messages.stream(body as unknown as Anthropic.MessageStreamParams, { signal: i.signal });
      for await (const ev of stream) {
        if (ev.type === 'message_start') billed.usage = ev.message.usage;
        else if (ev.type === 'message_delta' && billed.usage) billed.usage = { ...billed.usage, output_tokens: ev.usage.output_tokens };
        if (firstDelta === null && ev.type === 'content_block_delta') firstDelta = Date.now() - asked;
        if (!firstToken && ev.type === 'content_block_delta') {
          firstToken = true;
          i.onFirstToken?.();
        }
      }
      const final = await stream.finalMessage();
      billed.usage = final.usage;
      return final;
    });
    addUsage(usage, usageOf(reply.usage, i.model));
    const timing: RoundTiming = { tools: [], firstTokenMs: firstDelta, modelMs: Date.now() - asked, toolMs: 0, output: reply.usage.output_tokens, stop: reply.stop_reason };
    timings.push(timing);
    const text = reply.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text && toolWordsSpeak) latestText = text;
    // The API refuses an empty assistant message in an exchange that goes on (the pre-post check continues this one): a
    // round that wrote nothing stands for the answer the turn will post, the latest text an earlier round wrote.
    const said = toParams(reply.content);
    messages.push({ role: 'assistant', content: said.length || !latestText ? said : [{ type: 'text', text: latestText }] });
    const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    // The closing round's words are the reply, whatever it ended on: it runs no tool.
    if (closing) return { text: clean(text), silent: i.ctx.outcome.silent, rounds: round, usage, messages, stopReason: 'max_rounds', timings };
    if (reply.stop_reason !== 'tool_use' || calls.length === 0) {
      const out = clean(text || latestText);
      // A next step promised and not taken (EXAM #18), or a check left undone (the re-run's #11, #20): one more round,
      // once, to take it or ask instead.
      const undone = !nudged && reply.stop_reason === 'end_turn' ? undoneNote(out) : null;
      if (undone) {
        nudged = true;
        addNote(messages, undone);
        continue;
      }
      return { text: out, silent: i.ctx.outcome.silent, rounds: round, usage, messages, stopReason: reply.stop_reason, timings };
    }
    timing.tools = calls.map((c) => c.name);
    const toolsFrom = Date.now();
    // A reply of card tools only: they run one by one, so each one's card is counted, and once every card is up the
    // turn ends with this reply's words. A card tool that failed (no card) goes back to the model as any result does.
    i.ctx.roundTools = calls.map((c) => c.name);
    const cardsOnly = calls.every((c) => byName.get(c.name)?.endsTurn === true);
    let allUp = cardsOnly;
    const results: Anthropic.ToolResultBlockParam[] = [];
    const linesBefore = i.ctx.lines.length;
    if (cardsOnly) {
      for (const c of calls) {
        const before = i.ctx.cards.length;
        const r = await runTool(byName.get(c.name), c, i);
        if (r.is_error || i.ctx.cards.length === before) allUp = false;
        results.push(r);
      }
    } else {
      results.push(...(await Promise.all(calls.map((c) => runTool(byName.get(c.name), c, i)))));
    }
    timing.toolMs = Date.now() - toolsFrom;
    calls.forEach((c, k) => {
      const r = results[k];
      if (!r) return;
      const s = { name: c.name, refused: refusedResult(r), quiet: typeof r.content === 'string' && r.content.includes(SAY_NOTHING) };
      seen.push(s);
      // A tool that answers in the room by itself (a live card that posts its own result): the turn may end silent.
      if (s.quiet && !s.refused) i.ctx.toolAnswers = true;
    });
    messages.push({ role: 'user', content: [...results, ...roundNotes(calls, results, byName)] });
    // stay_silent ends the turn, unless it was refused (someone asked Go directly and has no answer yet): the turn goes on.
    const silenced = calls.findIndex((c) => c.name === STAY_SILENT);
    if (silenced >= 0 && !results[silenced]?.is_error) {
      i.ctx.outcome.silent = true;
      return { text: '', silent: true, rounds: round, usage, messages, stopReason: STAY_SILENT, timings };
    }
    // A card that went up with its line: the line is this reply's words. The reply's free text was written before the
    // card was up ("I'll show the best three…"), so it never goes out.
    const lines = [...new Set(i.ctx.lines.slice(linesBefore).map((l) => l.trim()).filter((l) => l !== ''))];
    const words = lines.length > 0 ? lines.join('\n') : toolWordsSpeak ? clean(text) : '';
    if (lines.length > 0) latestText = words;
    // A tool that answered itself (a finished plain search put up its card and line): the turn ends on its card too.
    if (allUp || (i.ctx.answered && lines.length > 0)) {
      // A card's line that promises a next step not taken (EXAM #18, "I'll search the Mon 9 Nov return next"): the card
      // stays up, and one more round takes the step or asks instead.
      const undone = nudged ? null : undoneNote(words);
      if (undone) {
        nudged = true;
        addNote(messages, undone);
        continue;
      }
      return { text: words, silent: false, rounds: round, usage, messages, stopReason: CARDS_UP, timings };
    }
  }
  // Not reached: the closing round returns.
  return { text: '', silent: i.ctx.outcome.silent, rounds: maxRounds + 1, usage, messages, stopReason: 'max_rounds', timings };
}
