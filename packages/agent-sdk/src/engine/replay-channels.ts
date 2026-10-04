/**
 * replay-channels — where a round's SEALED provider output (the `done` event's
 * `replay`) lives in the journal, and how it comes back out.
 *
 * The law (two permanent Anthropic wedges, 09-16 and 09-22, then the Gemini 3
 * "missing thought_signature" 400, 09-23): the provider's output is captured
 * verbatim on every round and sent back byte-for-byte. Each dialect's replay rides
 * its own assistant-entry field; this module is the one place that decides which,
 * so the main journal, the subagent's scoped journal and the P3.5b re-push agree.
 */
import type { ContentBlock } from '../contract/blocks.js';
import type {
  AnthropicReplayBlock,
  ChatMessageReplay,
  GeminiContentReplay,
  GeminiReplayStep,
  JournalEntry,
  ResponsesOutputReplay,
} from '../contract/journal.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import type { Journal } from '../kernel/index.js';
import type { ToolDispatchResult } from '../tools/tool-types.js';
import { appendSubagentAssistantEntry } from './native-journal.js';
import { dropGeminiCallParts, type GeminiPart } from './request-validity.js';
import type { ProviderReplay, Transport } from './transport.js';

/** A round's replay → the assistant entry's channel for its dialect. */
export function replayChannels(replay: ProviderReplay | undefined): SealedChannels & {
  anthropicBlocks?: AnthropicReplayBlock[];
} {
  if (replay === undefined) return {};
  if (Array.isArray(replay)) return { anthropicBlocks: replay };
  if (replay.dialect === 'gemini') return replay.content.parts.length ? { geminiContent: replay.content } : {};
  if (replay.dialect === 'openai_responses') return replay.output.items.length ? { responsesOutput: replay.output } : {};
  if (replay.dialect === 'openai_chat_completions') return { chatMessage: replay.message };
  return { geminiSteps: replay.steps };
}

/** The non-Anthropic channels an assistant entry (main or scoped) can carry. */
export interface SealedChannels {
  geminiContent?: GeminiContentReplay;
  geminiSteps?: GeminiReplayStep[];
  responsesOutput?: ResponsesOutputReplay;
  chatMessage?: ChatMessageReplay;
}

/**
 * The inverse for the non-Anthropic dialects: a journaled assistant entry's sealed
 * channel as the `replay` pushAssistant takes, so a round re-pushed from the journal
 * (the subagent's P3.5b pending round) goes back as sent. Undefined when the entry
 * carries no channel of its own dialect (the cross-issuer guard).
 */
export function replayFromEntry(p: JournalEntry['payload']): ProviderReplay | undefined {
  if (p.type !== 'assistant') return undefined;
  if (p.api === 'gemini' && p.geminiContent) return { dialect: 'gemini', content: p.geminiContent };
  if (p.api === 'gemini_interactions' && p.geminiSteps?.length) return { dialect: 'gemini_interactions', steps: p.geminiSteps };
  if (p.api === 'openai_responses' && p.responsesOutput?.items.length) return { dialect: 'openai_responses', output: p.responsesOutput };
  if (p.api === 'openai_chat_completions' && p.chatMessage) return { dialect: 'openai_chat_completions', message: p.chatMessage };
  return undefined;
}

/**
 * T10 — journal a subagent round's assistant entry, scope-tagged. Written when the
 * round has text (the legacy rule) OR a sealed channel: on a tool-only round the
 * channel is the only copy of the model's turn a scoped re-entry has — without it the
 * re-entry rebuilt unsigned functionCalls (Gemini 3 400s every retry) and replayed no
 * OpenAI reasoning at all. The non-Anthropic channels ride the scoped entry;
 * Anthropic's re-entry shape is left as it was.
 */
export async function appendSubagentRound(
  scoped: { j: Journal; path: SubagentPathSegment[] } | undefined,
  text: string,
  replay: ProviderReplay | undefined,
  model: string,
  transport: Pick<Transport, 'api' | 'provider'>,
): Promise<void> {
  const { anthropicBlocks: _anthropic, ...channels } = replayChannels(replay);
  if (!scoped || (!text && Object.keys(channels).length === 0)) return;
  await appendSubagentAssistantEntry(
    scoped.j,
    scoped.path,
    text ? [{ type: 'text', text } as ContentBlock] : [],
    model,
    transport.api,
    transport.provider,
    channels,
  );
}

/** The call ids a sealed replay carries, in order (a Responses/Chat call id IS the tool_use id). */
function replayCallIds(r: Exclude<ProviderReplay, AnthropicReplayBlock[]>): string[] {
  if (r.dialect === 'gemini') return r.content.callIds;
  if (r.dialect === 'openai_responses') return r.output.items.filter(isResponsesCall).map((i) => String(i.call_id));
  if (r.dialect === 'openai_chat_completions') return chatCalls(r.message).map((c) => c.id);
  return r.steps.filter((s) => s.type === 'function_call').map((s) => String((s as { id?: unknown }).id));
}

const isResponsesCall = (i: Record<string, unknown>): boolean => i.type === 'function_call';
const chatCalls = (m: ChatMessageReplay): Array<{ id: string }> => (Array.isArray(m.tool_calls) ? m.tool_calls : []) as Array<{ id: string }>;

/**
 * A sealed replay with only the calls in `keep` — every other item/part stays as sent
 * (signature-aware on generateContent). A Responses reasoning item left trailing by a
 * removed call is sendable (probed 2026-09-23), so only the calls leave.
 */
function trimReplay(r: Exclude<ProviderReplay, AnthropicReplayBlock[]>, keep: ReadonlySet<string>): ProviderReplay {
  if (r.dialect === 'gemini_interactions') {
    return { ...r, steps: r.steps.filter((s) => s.type !== 'function_call' || keep.has(String((s as { id?: unknown }).id))) };
  }
  if (r.dialect === 'openai_responses') {
    const items = r.output.items.filter((i) => !isResponsesCall(i) || keep.has(String(i.call_id)));
    return { ...r, output: { ...r.output, items } };
  }
  if (r.dialect === 'openai_chat_completions') {
    const { tool_calls: _all, ...rest } = r.message;
    const kept = chatCalls(r.message).filter((c) => keep.has(c.id));
    return { ...r, message: { ...rest, ...(kept.length > 0 ? { tool_calls: kept } : {}) } };
  }
  const { parts, callIds } = r.content;
  return {
    dialect: 'gemini',
    content: {
      parts: dropGeminiCallParts(parts as GeminiPart[], (_, i) => !keep.has(callIds[i]!)) as Array<Record<string, unknown>>,
      callIds: callIds.filter((id) => keep.has(id)),
    },
  };
}

/**
 * P3.5b for a round the model sent SEALED (a non-Anthropic channel on its assistant
 * entry): the paused round is re-pushed as ONE unit — the sealed turn, trimmed to
 * the calls that actually reached the journal, then the results already settled,
 * then (by the caller) the pending calls' dispatch. Two shapes the plain split got
 * wrong:
 *  - a sequential batch [A,B] paused at A journals only A's tool_use; the whole
 *    sealed turn re-sent B with no result → 400. The turn is trimmed to what ran.
 *  - a pause at B after A resolved ([assistant, tool_use A, tool_result A,
 *    tool_use B]) found no lead at all, and B was rebuilt without the signature
 *    Gemini 3 put on A → 400 on every retry (and, on OpenAI, without its reasoning).
 *    The walk now climbs over the round's resolved pairs to its assistant entry.
 * `stop` is where the pending walk stopped. Undefined when the round is not a
 * sealed non-Anthropic round (the caller keeps the plain split — Anthropic unchanged).
 */
export function sealedPendingRound(
  seed: JournalEntry[],
  stop: number,
  pendingIds: string[],
): { leadIdx: number; resolvedIdx: number[]; replay: ProviderReplay; resolvedResults: ToolDispatchResult[] } | undefined {
  const resolvedIdx: number[] = [];
  const ranIds = new Set(pendingIds);
  let i = stop;
  for (; i >= 0; i--) {
    const p = seed[i].payload;
    if (p.type === 'assistant' || p.type === 'user') break;
    // Kinds the history mappers ignore (the round's `usage` entry) stay in the prefix.
    if (p.type !== 'tool_use' && p.type !== 'tool_result') continue;
    if (p.type === 'tool_use') ranIds.add(p.toolUseId);
    resolvedIdx.unshift(i);
  }
  const lead = i >= 0 ? seed[i].payload : undefined;
  const replay = lead ? replayFromEntry(lead) : undefined;
  if (replay === undefined || Array.isArray(replay)) return undefined;
  const roundIds = new Set(replayCallIds(replay));
  const results = resolvedIdx.map((k) => seed[k].payload).filter((p) => p.type === 'tool_result');
  // Everything walked must belong to THIS round, or the unit is not what it seems.
  if (![...ranIds].every((id) => roundIds.has(id)) || !results.every((r) => ranIds.has(r.toolUseId))) return undefined;
  return {
    leadIdx: i,
    resolvedIdx,
    replay: trimReplay(replay, ranIds),
    resolvedResults: results.map((r) => ({
      toolUseId: r.toolUseId,
      text: r.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
      isError: r.isError ?? false,
      blocks: r.blocks,
    })),
  };
}
