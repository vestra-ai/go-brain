/**
 * journal-to-stream-events.ts — a recorded assistant round → the normalized
 * `StreamEvent[]` the kernel loop consumes (round-engine.ts runOneRound's stream
 * switch), i.e. exactly what a real transport's `readStream` yields.
 *
 * The journal splits one model round across entries: the `assistant` entry (signed
 * thinking + text), the settlement-ordered `usage` entry right after it, then one
 * `tool_use` entry per call — so a round is grouped here before it is replayed.
 * Emission order mirrors AnthropicMessagesTransport.readStream: live thinking /
 * text in block order, then the completed `thinking_block`s, then the `tool_use`s,
 * then ONE `done` carrying the recorded token counts. `stop_reason` is not journaled;
 * it is re-derived from the only thing the loop reads it for (tool calls → 'tool_use').
 */
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { StreamEvent } from '../transport.js';
import type { PlacedFault, ReplayFault } from './fixture.js';

type AssistantEntry = JournalEntry & { payload: Extract<JournalPayload, { type: 'assistant' }> };
type ToolUseEntry = JournalEntry & { payload: Extract<JournalPayload, { type: 'tool_use' }> };

export interface RecordedRound {
  assistant: AssistantEntry;
  /** The round's tool calls, in journal order. */
  toolUses: ToolUseEntry[];
  /** The round's `source:'round'` usage entry (token counts for the `done` event). */
  usage?: JournalEntry;
  /** Provider faults to throw, one per model call, BEFORE this round is served. */
  faults: ReplayFault[];
}

/** Group a journal into model rounds; attach each directive to the next assistant round. */
export function groupRounds(entries: JournalEntry[], directives: PlacedFault[]): RecordedRound[] {
  const rounds: RecordedRound[] = [];
  const pending = [...directives].sort((a, b) => a.beforeEntryIndex - b.beforeEntryIndex);
  let cur: RecordedRound | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.agentPath && e.agentPath.length) {
      throw new Error(`replay: entry seq=${e.seq} is subagent-scoped (agentPath); nested rounds are not replayable yet`);
    }
    const p = e.payload;
    if (p.type === 'assistant') {
      const faults: ReplayFault[] = [];
      while (pending.length && pending[0].beforeEntryIndex <= i) faults.push(pending.shift()!.fault);
      cur = { assistant: e as AssistantEntry, toolUses: [], faults };
      rounds.push(cur);
    } else if (p.type === 'tool_use') {
      if (!cur) throw new Error(`replay: tool_use seq=${e.seq} precedes any assistant round`);
      cur.toolUses.push(e as ToolUseEntry);
    } else if (p.type === 'usage' && cur && cur.usage === undefined) {
      const source = (p.raw as { source?: unknown } | undefined)?.source;
      if (source === 'round') cur.usage = e;
    }
  }
  if (pending.length) {
    throw new Error(`replay: ${pending.length} directive(s) sit after the last assistant round and can never fire`);
  }
  return rounds;
}

export function journalToStreamEvents(round: RecordedRound): StreamEvent[] {
  const events: StreamEvent[] = [];
  const thinking: Array<{ thinking: string; signature?: string }> = [];
  for (const b of round.assistant.payload.blocks) {
    if (b.type === 'thinking') {
      events.push({ kind: 'thinking_start' });
      if (b.thinking) events.push({ kind: 'thinking', text: b.thinking });
      thinking.push(b);
    } else if (b.type === 'text') {
      if (b.text) events.push({ kind: 'text', text: b.text });
    }
    // No other block kind is ever written on an assistant entry by this engine.
  }
  for (const t of thinking) {
    events.push({
      kind: 'thinking_block',
      thinking: t.thinking,
      ...(t.signature !== undefined ? { signature: t.signature } : {}),
    });
  }
  for (const tu of round.toolUses) {
    const p = tu.payload;
    events.push({
      kind: 'tool_use',
      toolUse: {
        id: p.toolUseId,
        name: p.name,
        input: p.input,
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      },
    });
  }
  const raw = (round.usage?.payload as { raw?: { inputTokens?: number; outputTokens?: number } } | undefined)?.raw;
  events.push({
    kind: 'done',
    stopReason: round.toolUses.length ? 'tool_use' : 'end_turn',
    usage: { inputTokens: raw?.inputTokens ?? 0, outputTokens: raw?.outputTokens ?? 0 },
  });
  return events;
}
