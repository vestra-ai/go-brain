/**
 * T9b — THE WIRE, on all four dialects.
 *
 * The boundary rule lets the cut land on an `assistant` entry, and that changes two
 * request shapes that used to be exotic. Both are pinned here per transport, against
 * the REAL projection code (no network: only `historyFromJournal` / `pushUser` run).
 *
 *  1. THE SUMMARIZE REQUEST. The to-summarize span now routinely ENDS on a
 *     `tool_result`, which every dialect projects as a USER-role message — and the
 *     summarize appends its own instruction turn after it. A bare `pushUser` there
 *     would ship TWO consecutive user-role messages; Gemini's own validity floor
 *     exists to prevent exactly that ("Gemini wants those in a SINGLE content",
 *     request-validity.ts:749-767) and `gemini-transport.ts:305` sends the history
 *     verbatim, so `pushUser` would bypass the guarantee. `buildSummarizeHistory`
 *     therefore routes the instruction through the projection as a synthetic trailing
 *     `user` entry whenever the span already ends user-side, and keeps `pushUser` —
 *     byte-identical — when it ends on an assistant entry.
 *
 *  2. THE POST-COMPACTION HISTORY whose FIRST KEPT entry is an `assistant` entry:
 *     summary `user` → the assistant turn carrying its tool calls → their results.
 *     Anthropic / Chat Completions / Gemini fold the calls INTO the assistant message;
 *     OpenAI Responses emits them as sibling `function_call` items immediately after
 *     it (the Responses convention). Both orders are valid, and neither orphans.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { buildSummarizeHistory, summarizeSpan, type CompactionDeps } from '../compaction-run.js';
import { COMPACTION_USER, COMPACTION_SPLIT_TURN_SECTION } from '../../contract/compaction-prompt.js';
import type { JournalEntry } from '../../contract/journal.js';

let seq = 0;
function e(payload: JournalEntry['payload']): JournalEntry {
  const s = seq++;
  return {
    uuid: `e-${s}`,
    parentUuid: s === 0 ? null : `e-${s - 1}`,
    seq: s,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** A to-summarize span that ENDS ON A `tool_result` — the T9b split-turn shape. */
function spanEndingOnToolResult(): JournalEntry[] {
  seq = 0;
  return [
    e({ type: 'user', blocks: [{ type: 'text', text: 'the one ask' }] }),
    e({ type: 'assistant', blocks: [{ type: 'text', text: 'working' }] }),
    e({ type: 'tool_use', toolUseId: 'tu-1', name: 'Read', input: { path: '/x' } }),
    e({ type: 'tool_result', toolUseId: 'tu-1', blocks: [{ type: 'text', text: 'body' }] }),
  ];
}

/** The pre-T9b shape: a span ending on an `assistant` entry. */
function spanEndingOnAssistant(): JournalEntry[] {
  seq = 0;
  return [
    e({ type: 'user', blocks: [{ type: 'text', text: 'the one ask' }] }),
    e({ type: 'assistant', blocks: [{ type: 'text', text: 'working' }] }),
  ];
}

/** A post-compaction projection whose FIRST KEPT entry is an `assistant` entry. */
function postCompactionProjection(): JournalEntry[] {
  seq = 100;
  return [
    e({ type: 'user', blocks: [{ type: 'text', text: 'SUMMARY' }] }),
    e({ type: 'assistant', blocks: [{ type: 'text', text: 'continuing' }] }),
    e({ type: 'tool_use', toolUseId: 'tu-2', name: 'Read', input: { path: '/y' } }),
    e({ type: 'tool_result', toolUseId: 'tu-2', blocks: [{ type: 'text', text: 'more' }] }),
  ];
}

const anthropic = () => new AnthropicMessagesTransport({ client: {} as never });

type Msg = { role?: string; content?: unknown; type?: string; parts?: unknown[] };

/** No two consecutive USER-role messages — the invariant every dialect's floor wants. */
function noConsecutiveUserTurns(history: Msg[]): boolean {
  for (let i = 1; i < history.length; i++) {
    if (history[i].role === 'user' && history[i - 1].role === 'user') return false;
  }
  return true;
}

describe('the summarize request for a span that ends on a tool_result', () => {
  it('anthropic: the instruction JOINS the tool_result user message — never a second user turn', () => {
    const h = buildSummarizeHistory(anthropic(), spanEndingOnToolResult()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const last = h[h.length - 1];
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(blocks[1].text).toBe(COMPACTION_USER);
  });

  it('chat-completions: a `tool` message then a `user` instruction (distinct roles, accepted)', () => {
    const h = buildSummarizeHistory(new ChatCompletionsTransport(), spanEndingOnToolResult()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    expect(h[h.length - 2].role).toBe('tool');
    expect(h[h.length - 1]).toEqual({ role: 'user', content: COMPACTION_USER });
  });

  it('gemini: ONE user content carrying [functionResponse, text] — the floor\'s own guarantee', () => {
    const h = buildSummarizeHistory(new GeminiTransport(), spanEndingOnToolResult()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const last = h[h.length - 1];
    expect(last.role).toBe('user');
    const parts = last.parts as Array<{ functionResponse?: unknown; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].functionResponse).toBeDefined();
    expect(parts[1].text).toBe(COMPACTION_USER);
  });

  it('openai-responses: a `function_call_output` item then a `user` item (a flat item list)', () => {
    const h = buildSummarizeHistory(new OpenAIResponsesTransport(), spanEndingOnToolResult()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    expect(h[h.length - 2].type).toBe('function_call_output');
    expect(h[h.length - 1]).toEqual({ role: 'user', content: COMPACTION_USER });
  });

  it('an EMPTY span is total — the request is just the instruction, on all four', () => {
    // Deleting the entry-type branch exposed this: the synthetic-entry path reads the span's
    // last entry, and an empty span has none. `planCompaction` never produces one (the cut is
    // always > 0), but `summarizeSpan` is exported and a crash here is worse than a request.
    for (const t of [anthropic(), new ChatCompletionsTransport(), new OpenAIResponsesTransport()]) {
      const h = buildSummarizeHistory(t, []) as Msg[];
      expect(h).toEqual([{ role: 'user', content: COMPACTION_USER }]);
    }
    expect(buildSummarizeHistory(new GeminiTransport(), []) as Msg[]).toEqual([
      { role: 'user', parts: [{ text: COMPACTION_USER }] },
    ]);
  });

  it('a span ending on an ASSISTANT entry keeps the pre-T9b request byte-for-byte, on all four', () => {
    // The control, and the reason the `pushUser` branch could be DELETED outright: routing
    // the instruction through the projection produces the identical trailing message that
    // `pushUser` did, on every arm — so the branch bought nothing and kept a hole open.
    for (const t of [anthropic(), new ChatCompletionsTransport(), new OpenAIResponsesTransport()]) {
      const h = buildSummarizeHistory(t, spanEndingOnAssistant()) as Msg[];
      expect(h[h.length - 1]).toEqual({ role: 'user', content: COMPACTION_USER });
    }
    const g = buildSummarizeHistory(new GeminiTransport(), spanEndingOnAssistant()) as Msg[];
    expect(g[g.length - 1]).toEqual({ role: 'user', parts: [{ text: COMPACTION_USER }] });
  });
});

describe('the post-compaction history whose first kept entry is an assistant entry', () => {
  it('anthropic: summary user → assistant with its tool_use folded in → the tool_result', () => {
    const h = anthropic().historyFromJournal(postCompactionProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((h[1].content as Array<{ type: string }>).map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect((h[2].content as Array<{ type: string }>)[0].type).toBe('tool_result');
  });

  it('chat-completions: summary user → assistant with tool_calls → the `tool` message', () => {
    const h = new ChatCompletionsTransport().historyFromJournal(postCompactionProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((h[1] as { tool_calls: Array<{ id: string }> }).tool_calls[0].id).toBe('tu-2');
  });

  it('gemini: summary user → model with its functionCall → the functionResponse user content', () => {
    const h = new GeminiTransport().historyFromJournal(postCompactionProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    const modelParts = h[1].parts as Array<{ functionCall?: { name: string } }>;
    expect(modelParts[1].functionCall?.name).toBe('Read');
  });

  it('openai-responses: summary user → assistant → its function_call → the function_call_output', () => {
    const h = new OpenAIResponsesTransport().historyFromJournal(postCompactionProjection()) as Msg[];
    expect(h.map((m) => m.role ?? m.type)).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
    ]);
  });
});

describe('the split-turn instruction reaches the summarize request', () => {
  /** A transport that records the system prompt and answers with one text chunk. */
  function recordingTransport() {
    const systems: string[] = [];
    return {
      systems,
      transport: {
        defaultModel: () => 'm',
        historyFromJournal: () => [] as unknown,
        pushUser: () => undefined,
        callModel: (p: { system: string }) => {
          systems.push(p.system);
          return [];
        },
        readStream: async function* () {
          yield { kind: 'text', text: 'SUMMARY' } as never;
        },
        computeCostUsd: () => 0,
      },
    };
  }

  const deps = (transport: unknown): CompactionDeps =>
    ({
      ctx: { taskId: 't', model: 'm', config: {} },
      transport,
    }) as unknown as CompactionDeps;

  it('appends the split-turn section when the cut split a turn', async () => {
    const r = recordingTransport();
    await summarizeSpan(deps(r.transport), spanEndingOnToolResult(), undefined, undefined, true);
    expect(r.systems[0]).toContain(COMPACTION_SPLIT_TURN_SECTION);
  });

  it('leaves the system prompt untouched when the cut did NOT split a turn', async () => {
    const r = recordingTransport();
    await summarizeSpan(deps(r.transport), spanEndingOnAssistant(), undefined, undefined, false);
    expect(r.systems[0]).not.toContain(COMPACTION_SPLIT_TURN_SECTION);
  });
});

// ─── Fix round 1: the branch is chosen from the last PROJECTING entry ─────────────

describe('the trailing instruction ALWAYS rides the projection (no branch to get wrong)', () => {
  /** A span ending on a `system` entry whose PREDECESSOR is a tool_result.
   *  Every projection DROPS `system` (native-messages.ts:130, gemini-messages.ts,
   *  chat-completions-messages.ts:117, openai-responses-messages.ts:143), so the wire
   *  still ends user-side and `pushUser` would ship two consecutive user contents. */
  function spanEndingOnSystem(): JournalEntry[] {
    const span = spanEndingOnToolResult();
    seq = 50;
    return [...span, e({ type: 'system', event: 'note', data: { k: 1 } })];
  }

  it('gemini: a span ending on a dropped `system` entry still merges into ONE user content', () => {
    const h = buildSummarizeHistory(new GeminiTransport(), spanEndingOnSystem()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const parts = h[h.length - 1].parts as Array<{ functionResponse?: unknown; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].functionResponse).toBeDefined();
    expect(parts[1].text).toBe(COMPACTION_USER);
  });

  it('anthropic: the same span keeps the instruction inside the tool_result message', () => {
    const h = buildSummarizeHistory(anthropic(), spanEndingOnSystem()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const blocks = h[h.length - 1].content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'text']);
  });
});

// ─── Fix round 1: the span-ends-on-`user` case, stated rather than left silent ────

describe('a span ending on a `user` entry (the instruction now MERGES into it)', () => {
  function spanEndingOnUser(): JournalEntry[] {
    seq = 0;
    return [
      e({ type: 'assistant', blocks: [{ type: 'text', text: 'earlier' }] }),
      e({ type: 'user', blocks: [{ type: 'text', text: 'the ask' }] }),
    ];
  }

  it('anthropic: ONE user message carrying the ask and the instruction (pre-T9b: two messages)', () => {
    const h = buildSummarizeHistory(anthropic(), spanEndingOnUser()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const blocks = h[h.length - 1].content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.text)).toEqual(['the ask', COMPACTION_USER]);
  });

  it('gemini: ONE user content carrying both texts', () => {
    const h = buildSummarizeHistory(new GeminiTransport(), spanEndingOnUser()) as Msg[];
    expect(noConsecutiveUserTurns(h)).toBe(true);
    const parts = h[h.length - 1].parts as Array<{ text?: string }>;
    expect(parts.map((p) => p.text)).toEqual(['the ask', COMPACTION_USER]);
  });

  it('chat-completions and openai-responses: ONE user message, not two (their floors do not merge)', () => {
    // THE S-R4 GATE. T9b makes "the span ends on the user's message" the ordinary chat
    // split-turn shape, and these two dialects have no merge rule — a separate trailing
    // entry shipped `assistant > user > user`, which DeepSeek's first-party reasoner
    // documents a 400 for. Every mid-turn chat compaction on such a lane would have become
    // `summarize_failed` at every round head.
    for (const t of [new ChatCompletionsTransport(), new OpenAIResponsesTransport()]) {
      const h = buildSummarizeHistory(t, spanEndingOnUser()) as Msg[];
      expect(noConsecutiveUserTurns(h)).toBe(true);
      expect(h.filter((m) => m.role === 'user')).toHaveLength(1);
      // Both texts ride that single message. Compared in ESCAPED form: these two
      // dialects carry content as a string, and COMPACTION_USER is multi-line since
      // T9c, so the raw constant never appears verbatim inside a JSON rendering.
      const escaped = JSON.stringify(COMPACTION_USER).slice(1, -1);
      expect(JSON.stringify(h[h.length - 1])).toContain(escaped);
      expect(JSON.stringify(h[h.length - 1])).toContain('the ask');
    }
  });
});

// ─── Fix round 1: the DOMINANT agentic first-kept entry is a TOOL-ONLY assistant ──
//
// The cut lands on the assistant entry that opened a round, and in an agentic loop that
// entry usually carries NO text — just the tool calls, which are separate entries.
// OpenAI Responses projects a text-empty assistant to NOTHING; Anthropic to `content: []`
// before its tool_use folds in. Both are valid; neither was pinned.

describe('the post-compaction history when the first kept entry is a TEXT-EMPTY assistant', () => {
  function toolOnlyProjection(): JournalEntry[] {
    seq = 200;
    return [
      e({ type: 'user', blocks: [{ type: 'text', text: 'SUMMARY' }] }),
      e({ type: 'assistant', blocks: [] }),
      e({ type: 'tool_use', toolUseId: 'tu-9', name: 'Read', input: { path: '/z' } }),
      e({ type: 'tool_result', toolUseId: 'tu-9', blocks: [{ type: 'text', text: 'z' }] }),
    ];
  }

  it('anthropic: the tool_use still folds into the assistant message', () => {
    const h = anthropic().historyFromJournal(toolOnlyProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((h[1].content as Array<{ type: string }>).map((b) => b.type)).toEqual(['tool_use']);
  });

  it('chat-completions: the assistant message carries tool_calls with no text', () => {
    const h = new ChatCompletionsTransport().historyFromJournal(toolOnlyProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((h[1] as { tool_calls: Array<{ id: string }> }).tool_calls[0].id).toBe('tu-9');
  });

  it('gemini: the model turn carries the functionCall', () => {
    const h = new GeminiTransport().historyFromJournal(toolOnlyProjection()) as Msg[];
    expect(h.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    const parts = h[1].parts as Array<{ functionCall?: { name: string } }>;
    expect(parts.some((p) => p.functionCall?.name === 'Read')).toBe(true);
  });

  it('openai-responses: the empty assistant projects to NOTHING, the function_call still lands', () => {
    const h = new OpenAIResponsesTransport().historyFromJournal(toolOnlyProjection()) as Msg[];
    expect(h.map((m) => m.role ?? m.type)).toEqual(['user', 'function_call', 'function_call_output']);
  });
});
