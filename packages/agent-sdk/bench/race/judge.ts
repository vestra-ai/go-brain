/**
 * The race's blind judge. A model that is not an Anthropic model (so neither engine's own
 * family grades it) reads one run's transcript and marks each rubric criterion met or not.
 * It is never told which engine ran the transcript, which model, how long it took or what it
 * cost: the transcript carries the messages, the tool calls and results and the replies, and
 * tool names are normalised (lower case, the `mcp__<server>__` prefix dropped) so the two
 * engines' spellings of the same tool do not give the engine away. What can still leak is
 * style (how each engine phrases a reply); the human spot-check list covers that.
 *
 * The run passes when every criterion is met AND every `mustSay` fact is in the last reply:
 * the mechanical check is a floor a lenient judge cannot lift. Our verdict is computed from
 * the criteria, never taken from a "pass" field the judge writes.
 */
import { resolveCapabilities } from '../../src/contract/model-capabilities.js';
import { fireworksWireId } from '../../src/contract/fireworks-wire.js';
import type { RaceRunRecord } from './record.js';
import { checkMustSay, localizeForSlot, type RaceTask } from './tasks.js';

export const DEFAULT_JUDGE_MODEL = 'deepseek-v4.1-flash';
const FIREWORKS_CHAT_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
const USER_TEXT_MAX = 4000;
const REPLY_MAX = 4000;
const TOOL_INPUT_MAX = 4000;
const TOOL_RESULT_MAX = 1500;

export interface RaceVerdict {
  /** Judge and fact check together: the run did the task. Null when the judge could not read it. */
  pass: boolean | null;
  criteria: Array<{ met: boolean; why: string }>;
  mustSay: { pass: boolean; missing: string[] };
  judgeModel: string;
  /** Why there is no judge verdict (unreadable reply, HTTP error). */
  judgeError?: string;
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)} [... ${s.length - max} more characters]` : s);

/** One tool name as the judge sees it: `mcp__mock-travel__search` and `Search` both read `search`. */
export function blindToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').toLowerCase();
}

/** The transcript the judge reads. Nothing in it names the engine, the model, a time or a cost. */
export function blindTranscript(task: RaceTask, run: RaceRunRecord): string {
  const parts: string[] = [];
  run.turns.forEach((turn, i) => {
    const asked = localizeForSlot(task.turns[i] ?? '', run.slot);
    parts.push(`### Turn ${i + 1}\nUSER:\n${cut(asked, USER_TEXT_MAX)}`);
    for (const t of turn.tools) {
      parts.push(`TOOL CALL ${blindToolName(t.name)}${t.isError ? ' (error)' : ''}\ninput: ${cut(t.input, TOOL_INPUT_MAX)}\nresult: ${cut(t.result, TOOL_RESULT_MAX)}`);
    }
    parts.push(`ASSISTANT REPLY (turn ended: ${turn.outcome}):\n${cut(turn.reply, REPLY_MAX)}`);
  });
  return parts.join('\n\n');
}

export function judgeMessages(task: RaceTask, run: RaceRunRecord): Array<{ role: 'system' | 'user'; content: string }> {
  const rubric = task.rubric.map((r, i) => `${i + 1}. ${localizeForSlot(r, run.slot)}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You grade one AI assistant transcript against a rubric written before it ran. Judge only what the transcript shows: ' +
        'a file counts as written only if a tool call wrote it, a computation counts as done with code only if a tool ran the code, ' +
        'and a fact counts only if the reply states it. Be strict and literal. ' +
        'Reply with JSON only: {"criteria": [{"met": true or false, "why": "one short sentence"}, ...]} with exactly one entry per rubric line, in order.',
    },
    { role: 'user', content: `RUBRIC:\n${rubric}\n\nTRANSCRIPT:\n${blindTranscript(task, run)}` },
  ];
}

/** Read the judge's JSON. Null when it is not the shape asked for (the run is then not judged, never guessed). */
export function parseJudgeReply(content: string, rubricLength: number): Array<{ met: boolean; why: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const criteria = (parsed as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(criteria) || criteria.length !== rubricLength) return null;
  const out: Array<{ met: boolean; why: string }> = [];
  for (const c of criteria) {
    const met = (c as { met?: unknown } | null)?.met;
    if (typeof met !== 'boolean') return null;
    const why = (c as { why?: unknown }).why;
    out.push({ met, why: typeof why === 'string' ? why : '' });
  }
  return out;
}

export interface JudgeOptions {
  model?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Refuse a judge the race cannot trust or cannot reach: an Anthropic model, or anything off the Fireworks lane. */
export function assertJudgeModel(model: string): void {
  const provider = resolveCapabilities(model).provider;
  if (provider === 'anthropic') throw new Error(`race judge: ${model} is an Anthropic model; the judge must not share a family with the engines' model`);
  if (provider !== 'fireworks') throw new Error(`race judge: ${model} is on the ${provider} lane; only Fireworks models can judge (FIREWORKS_API_KEY)`);
}

export async function judgeRun(task: RaceTask, run: RaceRunRecord, opts: JudgeOptions): Promise<RaceVerdict> {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  assertJudgeModel(model);
  const last = run.turns.at(-1)?.reply ?? '';
  const mustSay = checkMustSay(task, last);
  const base = { criteria: [], mustSay, judgeModel: model };
  let content: string;
  try {
    const res = await (opts.fetchImpl ?? fetch)(FIREWORKS_CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: fireworksWireId(model),
        messages: judgeMessages(task, run),
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 8000,
      }),
    });
    if (!res.ok) return { ...base, pass: null, judgeError: `judge HTTP ${res.status}` };
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = body.choices?.[0]?.message?.content;
    if (typeof c !== 'string') return { ...base, pass: null, judgeError: 'judge reply had no content' };
    content = c;
  } catch (err) {
    return { ...base, pass: null, judgeError: `judge request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const criteria = parseJudgeReply(content, task.rubric.length);
  if (!criteria) return { ...base, pass: null, judgeError: 'judge reply was not the rubric JSON' };
  return { ...base, criteria, pass: criteria.every((c) => c.met) && mustSay.pass };
}
