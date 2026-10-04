/**
 * The empty-completion recovery overlay must not desync the wire from the journal.
 *
 * THE DEFECT THIS PINS. A round that returns no text and no tool calls is re-called
 * with an in-memory-only seat + nudge that is DELIBERATELY never journaled (a journaled
 * placeholder replays on resume and the model parrots it — the "(no content)" incident).
 * Those items used to be PUSHED onto the round loop's `history`, which made the wire
 * permanently un-re-derivable from the journal: `checkRoundReconstruction` fired on that
 * round and on every later round of the turn.
 *
 * It is the ONE in-turn mutation on the journal path with no journal counterpart —
 * steer, PostToolBatch context, compaction and vision all append an entry and
 * re-project. All four `wire_reconstruction_desync` rows this system has ever recorded
 * are this overlay: every one has `firstDivergingIndex === projectedLength` (the extras
 * sit at the tail) and `incrementalLength − projectedLength === 3`. Three, not two,
 * because on the OpenAI-Responses arm `pushAssistant` also echoes the round's captured
 * §4.3a `reasoning` item ahead of the seat — which is why every recorded row is
 * `openai_responses` and none is Anthropic, where the same overlay is two items.
 *
 * The fix scopes the overlay to the ONE re-call it serves (`withEmptyRecoverySeat`
 * builds it onto a COPY at the request site), so the nudge still reaches the model while
 * `history` stays equal to what the journal re-derives.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { JournalEntry } from '../../contract/journal.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';
import type { NativeConfig } from '../native-config.js';
import { NativeHarness } from '../native-harness.js';
import type { ReconstructionMismatch } from '../reconstruction-invariant.js';
import { ReplayTransport } from '../replay/replay-transport.js';
import { ReplayTools } from '../replay/replay-tools.js';
import type { ProviderStream, Transport } from '../transport.js';
import {
  EMPTY_RECOVERY_NUDGE,
  EMPTY_RECOVERY_SEAT,
  withEmptyRecoverySeat,
} from '../empty-recovery.js';

const TASK = '00000000-0000-4000-8000-000000000002';
const WORKSPACE = '00000000-0000-4000-8000-000000000001';

function entry(seq: number, payload: unknown): JournalEntry {
  const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
  return {
    seq, uuid: id(seq), taskId: TASK, agentId: 'native', payload,
    principal: { kind: 'system' }, timestamp: '2026-08-23T23:59:00.000Z',
    parentUuid: seq === 1 ? null : id(seq - 1),
    rootTaskId: TASK, spawnDepth: 0, workspaceId: WORKSPACE,
  } as JournalEntry;
}

const usage = (seq: number) => entry(seq, {
  type: 'usage', actions: 0, compute: 0, intelligence: 0.001,
  raw: { model: 'gpt-5.6-luna', source: 'round', costUsd: 0.001, inputTokens: 3, outputTokens: 10 },
});

/** An assistant round. `api` picks the wire dialect the whole recording replays through. */
const assistant = (seq: number, blocks: unknown[], api: string, reasoning?: unknown[]) =>
  entry(seq, {
    type: 'assistant', api, provider: api === 'openai_responses' ? 'openai' : 'anthropic',
    model: api === 'openai_responses' ? 'gpt-5.6-luna' : 'claude', blocks,
    ...(reasoning ? { reasoning } : {}),
  });

const HEAD_REASONING = [{ id: 'rs_head', issuer: 'openai', encryptedContent: 'BLOB_HEAD' }];

/**
 * A recording whose FIRST round is empty (no text, no thinking, no tool calls) but whose
 * stream captured encrypted reasoning — what a reasoning model returns when it stalls.
 * The second round is the recovery re-call, which answers with real text.
 */
function emptyThenAnswer(api: string, reasoning?: unknown[]): JournalEntry[] {
  return [
    entry(1, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
    assistant(2, [], api, reasoning),
    usage(3),
    assistant(4, [{ type: 'text', text: 'done' }], api),
    usage(5),
  ];
}

/** Records every request the loop actually sends, so the overlay can be read off the wire. */
class RecordingTransport extends ReplayTransport {
  readonly sent: unknown[][] = [];
  override callModel(p: Parameters<Transport['callModel']>[0]): ProviderStream {
    this.sent.push([...((p as { history: unknown[] }).history ?? [])]);
    return super.callModel(p);
  }
}

interface DriveResult {
  mismatches: ReconstructionMismatch[];
  journal: JournalEntry[];
  sent: unknown[][];
}

async function drive(entries: JournalEntry[]): Promise<DriveResult> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vestra-empty-'));
  try {
    const journal = new Journal({
      taskId: TASK, workspaceId: WORKSPACE,
      jsonl: new JsonlStore(join(dir, 'journal.jsonl')),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-08-23T23:59:00.000Z'),
    });
    const transport = new RecordingTransport(entries);
    const mismatches: ReconstructionMismatch[] = [];
    const config = {
      onAttached: () => {},
      maxTurns: 20,
      systemPrompt: 'test',
      transport,
      journal,
      abilities: [],
      toolHost: {
        buildTools: async () => ({
          tools: new ReplayTools(entries).wrap(new ReplayTools(entries).stubsFor()),
          onAuthHalt: async () => {},
        }),
      },
      retry: { backoffMs: 1 },
      runtimeConfig: makeRuntimeConfig({ userId: WORKSPACE, systemPrompt: 'test' }),
      reconstructionCheck: 'warn' as const,
      onReconstructionMismatch: (m: ReconstructionMismatch) => mismatches.push(m),
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = {
      taskId: TASK, sessionId: 's', cwd: dir, model: 'gpt-5.6-luna',
      signal: new AbortController().signal, config,
    };
    const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'go' }; })();
    for await (const _ of new NativeHarness().run(input, ctx)) { /* drain */ }
    const produced: JournalEntry[] = [];
    for await (const e of journal.read()) produced.push(e);
    return { mismatches, journal: produced, sent: transport.sent };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const kinds = (items: unknown[]): string[] =>
  items.map((i) => {
    const r = i as { type?: string; role?: string };
    return r.type ?? `role:${String(r.role)}`;
  });

describe('empty-completion recovery — the wire stays journal-derivable', () => {
  it('an empty Responses round does NOT desync the wire from the journal', async () => {
    const { mismatches } = await drive(emptyThenAnswer('openai_responses', HEAD_REASONING));
    // Before the fix this was ONE mismatch: {firstDivergingIndex:1, incrementalLength:4,
    // projectedLength:1} — the +3 overlay (reasoning, seat, nudge) at the tail, the exact
    // shape of all four rows recorded in production.
    expect(mismatches).toEqual([]);
  });

  it('the empty round still triggers the re-call, and its REQUEST carries reasoning + seat + nudge', async () => {
    const { sent, journal } = await drive(emptyThenAnswer('openai_responses', HEAD_REASONING));
    expect(sent).toHaveLength(2); // the empty round, then the recovery re-call
    // Round 1 asked with the bare projection; the re-call adds exactly the overlay.
    expect(kinds(sent[0]!)).toEqual(['role:user']);
    expect(kinds(sent[1]!)).toEqual(['role:user', 'reasoning', 'role:assistant', 'role:user']);
    expect(sent[1]![1]).toMatchObject({ type: 'reasoning', encrypted_content: 'BLOB_HEAD' });
    expect(sent[1]![2]).toEqual({ role: 'assistant', content: EMPTY_RECOVERY_SEAT });
    expect(sent[1]![3]).toEqual({ role: 'user', content: EMPTY_RECOVERY_NUDGE });
    // …and none of it was journaled: the empty round writes nothing at all.
    expect(journal.map((e) => (e.payload as { type: string }).type)).toEqual(['user', 'assistant', 'usage']);
  });

  it('the SAME overlay on the Anthropic arm is two items, and also stays off the journal', async () => {
    const { mismatches, sent } = await drive(emptyThenAnswer('anthropic_messages'));
    expect(mismatches).toEqual([]);
    expect(sent).toHaveLength(2);
    // No reasoning echo on this arm — which is why no recorded desync row is Anthropic.
    expect((sent[1] as Array<{ role: string }>).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('a SECOND consecutive empty round overlays one seat+nudge, not two stacked', async () => {
    const entries = [
      entry(1, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      assistant(2, [], 'openai_responses', HEAD_REASONING),
      usage(3),
      assistant(4, [], 'openai_responses', HEAD_REASONING), // empty AGAIN
      usage(5),
      assistant(6, [{ type: 'text', text: 'done' }], 'openai_responses'),
      usage(7),
    ];
    const { mismatches, sent } = await drive(entries);
    expect(mismatches).toEqual([]);
    expect(sent).toHaveLength(3);
    // Each re-call carries ONE overlay onto a clean history — never a stacked pair.
    expect(kinds(sent[1]!)).toEqual(['role:user', 'reasoning', 'role:assistant', 'role:user']);
    expect(kinds(sent[2]!)).toEqual(['role:user', 'reasoning', 'role:assistant', 'role:user']);
  });

  it('the overlay is spent on its ONE re-call and never rides a later round', async () => {
    const entries = [
      entry(1, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      assistant(2, [], 'openai_responses', HEAD_REASONING),           // empty → arms the seat
      usage(3),
      assistant(4, [], 'openai_responses'),                            // the re-call: a TOOL round
      entry(5, { type: 'tool_use', name: 'Read', input: {}, toolUseId: 'call_read' }),
      usage(6),
      entry(7, { type: 'tool_result', blocks: [{ type: 'text', text: 'body' }], isError: false, toolUseId: 'call_read' }),
      assistant(8, [{ type: 'text', text: 'done' }], 'openai_responses'),
      usage(9),
    ];
    const { mismatches, sent } = await drive(entries);
    expect(mismatches).toEqual([]);
    expect(sent).toHaveLength(3);
    // The re-call carries the overlay…
    expect(kinds(sent[1]!)).toEqual(['role:user', 'reasoning', 'role:assistant', 'role:user']);
    // …and the round AFTER it is pure journal projection again: the tool call and its
    // result, with no seat and no nudge trailing them. A latch that is armed but never
    // consumed would re-overlay here (and on every later round of the turn).
    expect(kinds(sent[2]!)).toEqual(['role:user', 'function_call', 'function_call_output']);
  });
});

describe('withEmptyRecoverySeat', () => {
  it('never mutates the history it is given — the copy is what carries the overlay', () => {
    const t = new ReplayTransport(emptyThenAnswer('openai_responses', HEAD_REASONING));
    const history = t.emptyHistory() as unknown[];
    t.pushUser(history, 'hello');
    const before = JSON.stringify(history);
    const overlaid = withEmptyRecoverySeat(t, history) as unknown[];
    expect(JSON.stringify(history)).toBe(before); // the durable history is untouched
    expect(overlaid).not.toBe(history);
    expect(overlaid).toHaveLength(history.length + 2); // no reasoning captured → seat + nudge
    expect(kinds(overlaid)).toEqual(['role:user', 'role:assistant', 'role:user']);
  });
});
