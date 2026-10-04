import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { InteractionOutcome } from '../../contract/interaction.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { unansweredToolUseIds } from '../request-validity.js';
import { journalToChatCompletionsMessages } from '../../transports/chat-completions-messages.js';
import { journalToGeminiContents } from '../../transports/gemini-messages.js';

/**
 * Live prod task 28edef30 (2026-09-28, "Bash is stuck / The AI service had an issue").
 * A Bash step paused on an approval card (#1); the person typed a new message instead,
 * which deferred #1. The next turn paused on a second card (#3). While #3 was open the
 * person approved the stale #1: its continue wrote the forward-resume breadcrumb (a
 * user-role entry) straight after #3's open tool_use. Approving #3 then appended #3's
 * tool_result AFTER the breadcrumb. The wire request became
 *   assistant[tool_use #3] → user[breadcrumb text, tool_result #3]
 * which Anthropic rejects ("tool_use ids were found without tool_result blocks
 * immediately after"), and every later turn replayed the same journal: the task was dead.
 */

const dir = join(tmpdir(), `fwd-resume-adjacency-${process.pid}`);
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  assistant: (text: string): JournalPayload => ({ type: 'assistant', blocks: [{ type: 'text', text } as never] }),
  toolUse: (id: string): JournalPayload => ({ type: 'tool_use', toolUseId: id, name: 'Bash', input: { command: 'rm x' } }),
  toolResult: (id: string, text: string): JournalPayload => ({ type: 'tool_result', toolUseId: id, blocks: [{ type: 'text', text } as never], isError: false }),
  pause: (interactionId: string, toolUseId: string): JournalPayload => ({
    type: 'interaction', interactionId, resolved: false, data: { kind: 'tool_permission', toolUseId, toolName: 'Bash' },
  }),
  settled: (interactionId: string): JournalPayload => ({ type: 'interaction', interactionId, resolved: true, data: {} }),
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
const allow: InteractionOutcome = { behavior: 'allow' };

const make = () => new Journal({
  taskId: 't', workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, 't.jsonl')),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-09-28T04:41:00.000Z'),
});

/** The ids a user turn answers the way the Messages API reads it: its LEADING tool_result blocks. */
function leadingResultIds(m: Anthropic.MessageParam | undefined): string[] {
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return [];
  const ids: string[] = [];
  for (const b of m.content) {
    if (b.type !== 'tool_result') break;
    ids.push(b.tool_use_id);
  }
  return ids;
}

/** Every assistant tool_use answered by the leading tool_result blocks of the very next turn. */
function everyCallAnsweredFirst(msgs: Anthropic.MessageParam[]): boolean {
  return msgs.every((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return true;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id);
    const answered = new Set(leadingResultIds(msgs[i + 1]));
    return ids.every((id) => answered.has(id));
  });
}

/** Replays task 28edef30's journal sequence through the real kernel. */
async function adarshJournal(): Promise<Journal> {
  const j = make();
  await j.append(newEntry(P.user('make a showreel from these shots')));
  await j.append(newEntry(P.assistant('downloading the shots')));
  await j.append(newEntry(P.toolUse('tu1')));
  await j.append(newEntry(P.pause('i1', 'tu1')));
  await j.deferSuspended(); // the person typed instead of answering card #1
  await j.append(newEntry(P.user('make a showreel from these shots')));
  await j.append(newEntry(P.assistant('checking the music')));
  await j.append(newEntry(P.toolUse('tu3')));
  await j.append(newEntry(P.pause('i3', 'tu3')));
  // The stale card #1 is approved while #3 is open: the continue settles #1 and writes
  // the forward-resume breadcrumb (continue-orchestrator step 2b), then re-suspends on #3.
  const r1 = await j.reconcileInteractions(async (id) => (id === 'i1' ? allow : null));
  expect(r1.forwardResume.map((d) => d.toolUseId)).toEqual(['tu1']);
  await j.appendForwardResumeBreadcrumb(r1.forwardResume);
  // Card #3 is approved: the re-executed Bash step appends its result and settles the row.
  await j.append(newEntry(P.toolResult('tu3', 'bands printed')));
  await j.append(newEntry(P.settled('i3')));
  return j;
}

describe('forward-resume breadcrumb during a sibling pause (live 28edef30)', () => {
  it('project() keeps the late tool_result next to its call, ahead of the breadcrumb', async () => {
    const j = await adarshJournal();
    const kinds = (await j.project()).messages.map((m) =>
      m.payload.type === 'tool_use' || m.payload.type === 'tool_result' ? `${m.payload.type}:${m.payload.toolUseId}` : m.payload.type,
    );
    const call = kinds.indexOf('tool_use:tu3');
    expect(kinds[call + 1]).toBe('tool_result:tu3');
    // The breadcrumb is not lost: it follows the result as the latest turn.
    expect(kinds[kinds.length - 1]).toBe('user');
  });

  it('the wire request answers every call first, so the resume no longer 400s', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const j = await adarshJournal();
    const msgs = journalToAnthropicMessages((await j.project()).messages);
    expect(everyCallAnsweredFirst(msgs)).toBe(true);
    // project() produced the adjacent shape itself: neither the tripwire nor the floor had to act.
    expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes('tool_use'))).toBe(false);
    const flat = JSON.stringify(msgs);
    expect(flat).toContain('bands printed');
    // Card #1 was an approval, so the breadcrumb says so (not "the connection is available").
    expect(flat).toContain('[System] The person approved the earlier Bash step.');
  });

  it('the Chat Completions lane gets the tool reply right after its call too', async () => {
    const j = await adarshJournal();
    const msgs = journalToChatCompletionsMessages((await j.project()).messages) as Array<{
      role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string;
    }>;
    const call = msgs.findIndex((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'tu3'));
    expect(call).toBeGreaterThan(-1);
    expect(msgs[call + 1]).toMatchObject({ role: 'tool', tool_call_id: 'tu3' });
  });

  it('the second trigger: typing while #3 is open defers it AFTER the breadcrumb, and it still reads back beside its call', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const j = make();
    await j.append(newEntry(P.user('make a showreel')));
    await j.append(newEntry(P.assistant('downloading')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.pause('i1', 'tu1')));
    await j.deferSuspended();
    await j.append(newEntry(P.user('make a showreel')));
    await j.append(newEntry(P.assistant('checking the music')));
    await j.append(newEntry(P.toolUse('tu3')));
    await j.append(newEntry(P.pause('i3', 'tu3')));
    const r1 = await j.reconcileInteractions(async (id) => (id === 'i1' ? allow : null));
    await j.appendForwardResumeBreadcrumb(r1.forwardResume);
    // The person types instead of answering #3: the deferred result for tu3 lands after the breadcrumb.
    expect(await j.deferSuspended()).toEqual(['tu3']);
    await j.append(newEntry(P.user('just use the first track')));
    const msgs = journalToAnthropicMessages((await j.project()).messages);
    expect(everyCallAnsweredFirst(msgs)).toBe(true);
    expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes('tool_use'))).toBe(false);
  });

  it('a well-formed parallel batch trips neither the tripwire nor the floor', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.assistant('three calls')));
    await j.append(newEntry(P.toolUse('a')));
    await j.append(newEntry(P.toolUse('b')));
    await j.append(newEntry(P.toolUse('c')));
    await j.append(newEntry(P.toolResult('b', 'B'))); // completion order
    await j.append(newEntry(P.toolResult('a', 'A')));
    await j.append(newEntry(P.toolResult('c', 'C')));
    const msgs = journalToAnthropicMessages((await j.project()).messages);
    expect(everyCallAnsweredFirst(msgs)).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('an already-adjacent journal projects byte-identically (same order, same entries)', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.assistant('two calls')));
    await j.append(newEntry(P.toolUse('a')));
    await j.append(newEntry(P.toolUse('b')));
    await j.append(newEntry(P.toolResult('a', 'A')));
    await j.append(newEntry(P.toolResult('b', 'B')));
    await j.append(newEntry(P.user('next')));
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect((await j.project()).messages.map((m) => m.uuid)).toEqual(raw.map((e) => e.uuid));
  });

  it('a batch keeps its results together and in order when one lands after a user entry', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.assistant('two calls')));
    await j.append(newEntry(P.toolUse('a')));
    await j.append(newEntry(P.toolUse('b')));
    await j.append(newEntry(P.toolResult('a', 'A')));
    await j.append(newEntry(P.user('[System] notice')));
    await j.append(newEntry(P.toolResult('b', 'B')));
    const kinds = (await j.project()).messages.map((m) =>
      m.payload.type === 'tool_use' || m.payload.type === 'tool_result' ? `${m.payload.type}:${m.payload.toolUseId}` : m.payload.type,
    );
    expect(kinds).toEqual(['user', 'assistant', 'tool_use:a', 'tool_use:b', 'tool_result:a', 'tool_result:b', 'user']);
  });
});

/**
 * The same late result, landing after LATER CALLS of its own batch. A paused Bash step
 * followed by sequential siblings journals [use a, use b, result b, use c, result c]; a's
 * result comes last (the approval's re-run, or the defer when the person types instead).
 * Without the round's sealed message (an older journal, or a model switch) the Anthropic
 * and Gemini projections open a new assistant turn at `use c`, so a's result answered the
 * wrong turn: the Anthropic floor repaired it loudly, Gemini's orphan strip dropped the call
 * and its result silently. Found by history-pairing.property.test.ts (seed 1).
 */
describe('a late result after later calls of its own batch', () => {
  async function sequentialPause(late: (j: Journal) => Promise<void>): Promise<Journal> {
    const j = make();
    await j.append(newEntry(P.user('tidy the renders folder')));
    await j.append(newEntry(P.assistant('three steps')));
    await j.append(newEntry(P.toolUse('a')));
    await j.append(newEntry(P.pause('ia', 'a')));
    await j.append(newEntry(P.toolUse('b')));
    await j.append(newEntry(P.toolResult('b', 'B')));
    await j.append(newEntry(P.toolUse('c')));
    await j.append(newEntry(P.toolResult('c', 'C')));
    await late(j);
    return j;
  }

  for (const [name, late] of [
    ['approved (the re-run appends its result)', async (j: Journal) => {
      await j.append(newEntry(P.toolResult('a', 'A')));
      await j.append(newEntry(P.settled('ia')));
    }],
    ['deferred (the person typed instead)', async (j: Journal) => {
      expect(await j.deferSuspended()).toEqual(['a']);
      await j.append(newEntry(P.user('never mind, keep them')));
    }],
  ] as const) {
    it(`${name}: the result answers its own turn on Anthropic and Gemini keeps every call`, async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const j = await sequentialPause(late);
      const { messages } = await j.project();
      expect(everyCallAnsweredFirst(journalToAnthropicMessages(messages))).toBe(true);
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes('[hitl-'))).toBe(false);
      const gemini = journalToGeminiContents(messages);
      expect(gemini.flatMap((c) => c.parts).filter((p) => p.functionCall)).toHaveLength(3);
      expect(gemini.flatMap((c) => c.parts).filter((p) => p.functionResponse)).toHaveLength(3);
    });
  }

  it('a sequential batch whose results all arrived in place projects byte-identically', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.assistant('two steps')));
    await j.append(newEntry(P.toolUse('a')));
    await j.append(newEntry(P.toolResult('a', 'A')));
    await j.append(newEntry(P.toolUse('b')));
    await j.append(newEntry(P.toolResult('b', 'B')));
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect((await j.project()).messages.map((m) => m.uuid)).toEqual(raw.map((e) => e.uuid));
  });
});

describe('Anthropic validity floor — a result behind text is not an answer', () => {
  const e = (seq: number, payload: JournalPayload): JournalEntry =>
    ({ uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, ...base, payload }) as unknown as JournalEntry;

  it('unansweredToolUseIds counts a tool_result that follows text in the next turn as unanswered', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: '[System] notice' }, { type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ];
    expect(unansweredToolUseIds(msgs)).toEqual(['x']);
  });

  it('a raw misordered history (not from project()) is repaired loudly to results-first', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msgs = journalToAnthropicMessages([
      e(0, P.user('go')),
      e(1, P.assistant('checking')),
      e(2, P.toolUse('x')),
      e(3, P.user('[System] notice')),
      e(4, P.toolResult('x', 'out')),
    ]);
    expect(everyCallAnsweredFirst(msgs)).toBe(true);
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[hitl-adjacency-floor-repair]') && l.includes('x'))).toBe(true);
    const flat = JSON.stringify(msgs);
    expect(flat).toContain('out');
    expect(flat).toContain('[System] notice');
  });
});
