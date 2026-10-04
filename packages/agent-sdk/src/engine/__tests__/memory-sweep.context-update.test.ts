/**
 * CONTEXT_APPEND_V1 — the memory sweep never harvests the engine's re-told standing context.
 *
 * A `<context_update>` entry carries the memory block itself, as user-ROLE text. A sweep that read
 * it as the person speaking could store the person's own memory back as things they "said". Off
 * the parity path the sweep drops it from its history by its `injected` field; on the parity path
 * it must keep it (the sweep rides the loop's request byte for byte), so the prompt names it.
 *
 * Revert-proof: drop the filter and the first case finds the update in the sweep's history; drop
 * the note and the second finds the prompt unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '../../contract/journal.js';
import type { Journal } from '../../kernel/journal/journal.js';
import type { Transport } from '../transport.js';
import type { LoopRequest } from '../round-engine.js';
import { runOffloopSweep, MEMORY_SWEEP_PROMPT, MEMORY_SWEEP_PROMPT_PARITY, SWEEP_CONTEXT_UPDATE_NOTE } from '../memory-sweep.js';

const entry = (uuid: string, text: string, injected?: 'context_update'): JournalEntry => ({
  uuid, parentUuid: null, seq: 0, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: injected ? { kind: 'system' } : { kind: 'user', userId: 'u' }, timestamp: 'T',
  payload: { type: 'user', blocks: [{ type: 'text', text }], ...(injected ? { injected } : {}) },
});

const ASK = entry('ask', 'Draft the update for Priya.');
const UPDATE = entry('upd', '<context_update>\n<part name="memory">\nLives in Lisbon.\n</part>\n</context_update>', 'context_update');

async function sweepWith(messages: JournalEntry[], loopRequest?: LoopRequest) {
  const sent: { history: unknown[]; prompt: string }[] = [];
  const transport = {
    historyFromJournal: (entries: JournalEntry[]) => entries.map((e) => e.uuid),
    pushUser: (h: unknown[], text: string) => {
      h.push({ prompt: text });
    },
    callModel: (p: { history: unknown[] }) => {
      const history = p.history.slice(0, -1);
      const tail = p.history[p.history.length - 1] as { prompt: string };
      sent.push({ history, prompt: tail.prompt });
      return {};
    },
    readStream: async function* () {
      yield { kind: 'text', text: 'NONE' };
      yield { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } };
    },
  } as unknown as Transport;
  const journal = { project: async () => ({ messages, leaf: null }) } as unknown as Journal;
  await runOffloopSweep({
    transport, journal, model: 'deepseek-v4.1-flash', system: 'sys', providerTools: [], elision: null,
    ...(loopRequest !== undefined && { loopRequest }),
  });
  return sent[0]!;
}

describe('the memory sweep and the context update', () => {
  it('off the parity path: the update is dropped from the sweep\'s history by its field, the prompt unchanged', async () => {
    const sent = await sweepWith([ASK, UPDATE]);
    expect(sent.history).toEqual(['ask']);
    expect(sent.prompt).toBe(MEMORY_SWEEP_PROMPT);
  });

  it('on the parity path: the update stays (the loop\'s prefix) and the prompt says it is never the person\'s words', async () => {
    const loopRequest = { model: 'deepseek-v4.1-flash', system: 'sys', tools: [] } as unknown as LoopRequest;
    const sent = await sweepWith([ASK, UPDATE], loopRequest);
    expect(sent.history).toEqual(['ask', 'upd']);
    expect(sent.prompt).toBe(MEMORY_SWEEP_PROMPT_PARITY + SWEEP_CONTEXT_UPDATE_NOTE);
  });

  it('no update in view: the parity prompt is byte-identical', async () => {
    const loopRequest = { model: 'deepseek-v4.1-flash', system: 'sys', tools: [] } as unknown as LoopRequest;
    expect((await sweepWith([ASK], loopRequest)).prompt).toBe(MEMORY_SWEEP_PROMPT_PARITY);
  });
});
