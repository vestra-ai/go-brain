/**
 * TOOLS_MIDSTREAM_RW_V1 + NATIVE_STREAM_SEVERED_RETRY: a call that ran early is never run twice
 * by the severed-stream re-issue (the #4265 review, finding 1).
 *
 * An exclusive call starts at its `tool_ready` and runs; the stream then dies. The round's
 * teardown journals the call with its real result (round-engine journalStartedPrefix). The
 * severed-stream ladder then re-issues the round. It used to re-ask with the history the round
 * was sent with (sealSeveredRound returned it unchanged once the round was journaled), so the
 * model, seeing no result, called the same tool again and it ran a second time. The re-issue now
 * re-projects from the journal and continues after the result.
 *
 * The scripted model below answers the way a model does: it calls the tool unless the request
 * already carries that call's result. A real Journal, the real NativeHarness, the real Anthropic
 * classifier for the severance.
 *
 * Revert proof: return the unchanged history in sealSeveredRound and the tool runs twice (the
 * re-issued request has no result, so the model calls it again).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicError } from '@anthropic-ai/sdk';
import { NativeHarness } from '../native-harness.js';
import { classifyAnthropicError, ANTHROPIC_SEVERED_STREAM_MESSAGE } from '../native-termination.js';
import { FakeTransport, type StreamEvent, type ProviderStream, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const FLAGS = ['TOOLS_MIDSTREAM_V1', 'TOOLS_MIDSTREAM_RW_V1', 'NATIVE_STREAM_SEVERED_RETRY'];
const dir = join(tmpdir(), `rw-reissue-${process.pid}`);
afterEach(async () => {
  for (const f of FLAGS) delete process.env[f];
  await fs.rm(dir, { recursive: true, force: true });
});

const CALL = { id: 'w1', name: 'write_note', input: { text: 'hello' } };

/** A request "carries the result" when its projected history holds w1's tool_result. */
const carriesResult = (history: ProviderHistory): boolean =>
  (history as unknown as JournalEntry[]).some(
    (e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId?: string }).toolUseId === CALL.id,
  );

interface Scripted { events: StreamEvent[]; severAfterMs?: number }

class ModelLikeTransport extends FakeTransport {
  calls = 0;
  constructor() { super([]); }
  /** The projected journal entries, as they are (the test reads them as the request). */
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return entries as unknown as ProviderHistory;
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): ProviderStream {
    this.calls += 1;
    super.callModel(p);
    // The first request: the model calls the tool, and the stream dies after it has run.
    if (this.calls === 1) {
      return { events: [{ kind: 'text', text: 'Writing it down.' }, { kind: 'tool_ready', toolUse: CALL }], severAfterMs: 30 } as unknown as ProviderStream;
    }
    // Later requests: a model that sees no result for its call makes it again.
    const round: Scripted = carriesResult(p.history)
      ? { events: [{ kind: 'text', text: 'Done.' }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] }
      : { events: [{ kind: 'tool_ready', toolUse: CALL }, { kind: 'tool_use', toolUse: CALL }, { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }] };
    return round as unknown as ProviderStream;
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const round = stream as unknown as Scripted;
    for (const ev of round.events) yield ev;
    if (round.severAfterMs !== undefined) {
      await new Promise((r) => setTimeout(r, round.severAfterMs));
      throw new AnthropicError(ANTHROPIC_SEVERED_STREAM_MESSAGE);
    }
  }
  override classifyError(err: unknown): TurnOutcome {
    return classifyAnthropicError(err);
  }
}

describe('a call that ran early is never run twice by the severed-stream re-issue', () => {
  it('the stream dies after the call ran: the re-issued request carries its result, and the call ran once', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    let runs = 0;
    const tool: RawToolOptions = {
      name: CALL.name,
      description: 'writes a note (exclusive: it changes something)',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
      execute: () => { runs += 1; return 'written'; },
    };
    const toolHost: ToolHost = {
      buildTools: async (): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> => ({ tools: [tool], onAuthHalt: async () => {} }),
    } as unknown as ToolHost;
    const journal = new Journal({
      taskId: 'rw-reissue', workspaceId: 'w',
      jsonl: new JsonlStore(join(dir, 'rw-reissue.jsonl')),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-01-01T00:00:00.000Z'),
    });
    const transport = new ModelLikeTransport();
    const cfg = {
      onAttached: () => {}, maxTurns: 10, transport, toolHost, journal, abilities: [],
      retry: { maxAttempts: 1, backoffMs: 1 },
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = {
      taskId: 'rw-reissue', sessionId: 's-rw-reissue', cwd: '/tmp', model: 'claude-sonnet-4-6',
      signal: new AbortController().signal, config: cfg,
    };
    const events: HarnessEvent[] = [];
    const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'write it down' }; })();
    for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);

    expect(runs).toBe(1);
    expect(transport.calls).toBe(2);
    const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
    expect(ends.at(-1)?.outcome.kind).toBe('completed');
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    const of = (type: string) => entries.filter((e) => e.payload.type === type && (e.payload as { toolUseId?: string }).toolUseId === CALL.id);
    expect(of('tool_use')).toHaveLength(1);
    expect(of('tool_result')).toHaveLength(1);
  });
});
