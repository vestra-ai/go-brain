/**
 * HARD INVARIANT — chat-completions byte-PREFIX stability across rounds.
 *
 * WHY THIS EXISTS: the OpenAI-compatible providers on this arm (OpenAI, and the
 * Fireworks open-model lane — GLM 5.2 + DeepSeek V4) do AUTOMATIC prefix caching:
 * a request only reads from cache the leading bytes it shares, byte-for-byte, with
 * an earlier request. The kernel re-derives the whole history from the journal on
 * EVERY round (`historyFromJournal(project())`), so for the cache to keep working
 * the messages a round sends MUST be an exact element-wise prefix of the next
 * round's messages — they may differ ONLY by the entries appended since.
 *
 * If a projection change ever perturbs an EARLIER message (re-stringifies tool
 * args differently, flips content null↔'', reorders/merges, drops a block), the
 * shared prefix collapses to the system+first-user turn and every later round
 * re-prefills the entire conversation — 30-70k tokens PER ROUND. That is exactly
 * the production incident (2026-07-07): glm-5.2 + deepseek-v4-flash cache-hit
 * rates pinned at 37-45%, zero calls ≥80% across 372, the cached prefix never
 * advancing past the first user message. Root cause was NOT a serialization bug
 * (the arm was already prefix-stable — this test proves and LOCKS that); this
 * guard exists so a future change can't silently reintroduce the mutation this
 * incident would have been.
 *
 * The cases pin the shapes the projection actually emits: an assistant turn that
 * is text+tool_use, a TOOL-ONLY turn (empty assistant blocks → content ''),
 * PARALLEL tool calls, an EMPTY tool result (the `(no output)` floor), and args
 * with unicode/floats/nested objects (the `JSON.stringify` round-trip). The final
 * case pins that the two history-build paths — live `pushAssistant`/`pushToolResult`
 * (no-journal) and `historyFromJournal` (journal) — agree byte-for-byte, so a task
 * can never diverge by which path built its request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import {
  appendUserEntry,
  appendAssistantEntry,
  appendToolUseEntry,
  appendToolResultEntry,
} from '../../engine/native-journal.js';
import { journalToChatCompletionsMessages } from '../chat-completions-messages.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfigLike } from '../../engine/native-config-like.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { ToolDispatchResult } from '../../tools/tool-types.js';

const CHAT = 'openai_chat_completions';
const dir = join(tmpdir(), `cc-prefix-conformance-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

let seq = 0;
function makeJournal(): Journal {
  const taskId = `t${seq++}`;
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });
}

const ctx = { taskId: 't', config: { runtimeConfig: { userId: 'u', sessionId: 's' } } } as unknown as HarnessContext<NativeConfigLike>;
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

/** The messages a round would send, built the production way (project → project-to-messages). */
async function roundMessages(j: Journal): Promise<unknown[]> {
  return journalToChatCompletionsMessages((await j.project()).messages);
}

/**
 * The first index at which two message arrays' serialized elements differ, or
 * null when the shorter is an exact element-wise PREFIX of the longer. Comparing
 * element-by-element (not the whole JSON string) avoids the trailing `]` false
 * positive a longer array would otherwise trip.
 */
function firstMessageDivergence(a: unknown[], b: unknown[]): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return null;
}

/** Assert every earlier snapshot is an exact element-wise byte-prefix of every later one. */
function expectPrefixChain(snapshots: unknown[][]): void {
  for (let i = 0; i + 1 < snapshots.length; i++) {
    expect(firstMessageDivergence(snapshots[i], snapshots[i + 1])).toBeNull();
    // and strictly growing — a later round never drops messages.
    expect(snapshots[i + 1].length).toBeGreaterThanOrEqual(snapshots[i].length);
  }
}

describe('chat-completions byte-prefix stability — conformance', () => {
  it('N-round tool loop: each round is an element-wise byte-prefix of the next', async () => {
    const j = makeJournal();
    const snapshots: unknown[][] = [];
    await appendUserEntry(j, ctx, 'Refactor the auth module and run the tests.');
    snapshots.push(await roundMessages(j)); // round 1 request

    // Round 1 output — assistant TEXT + tool_use with unicode / float / nested args.
    await appendAssistantEntry(j, ctx, text('Editing the file.'), 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, {
      id: 'call_1',
      name: 'edit',
      input: { path: '/src/authcafé.ts', edits: [{ from: 'a', to: 'b', n: 3.5 }], flags: { dryRun: false }, note: 'ünïcode ☃' },
    });
    await appendToolResultEntry(j, ctx, { toolUseId: 'call_1', text: 'ok, 1 edit applied', isError: false });
    snapshots.push(await roundMessages(j)); // round 2 request

    // Round 2 output — TOOL-ONLY assistant (no text → empty asstBlocks) + EMPTY tool result.
    await appendAssistantEntry(j, ctx, [], 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'call_2', name: 'bash', input: { cmd: 'npm test' } });
    await appendToolResultEntry(j, ctx, { toolUseId: 'call_2', text: '', isError: false });
    snapshots.push(await roundMessages(j)); // round 3 request

    // Round 3 output — PARALLEL tool calls answered in one batch.
    await appendAssistantEntry(j, ctx, text('Checking two things.'), 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'call_3a', name: 'read', input: { path: 'a.ts' } });
    await appendToolUseEntry(j, ctx, { id: 'call_3b', name: 'read', input: { path: 'b.ts' } });
    await appendToolResultEntry(j, ctx, { toolUseId: 'call_3a', text: 'A', isError: false });
    await appendToolResultEntry(j, ctx, { toolUseId: 'call_3b', text: 'B', isError: false });
    snapshots.push(await roundMessages(j)); // round 4 request

    // Round 4 output — final assistant text (turn completes).
    await appendAssistantEntry(j, ctx, text('All done.'), 'glm-5.2', CHAT, 'openai');
    snapshots.push(await roundMessages(j)); // (would be) round 5 request

    expectPrefixChain(snapshots);

    // Spot-pin the shapes the incident would have perturbed: the tool-only assistant
    // renders content '' + tool_calls, and the empty tool result gets the floor.
    // Layout of round-3 messages: [0]=user, [1]=assistant(text+call_1), [2]=tool(tr1),
    // [3]=assistant('' + call_2), [4]=tool(tr2 → floor).
    const r3 = snapshots[2];
    expect(r3[3]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 'call_2' }] });
    expect(r3[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_2', content: '(no output)' });
    // And the unicode/float/nested args survive the JSON.stringify round-trip verbatim.
    expect(JSON.stringify(snapshots[4][1])).toContain('"arguments":"{\\"path\\":\\"/src/authcafé.ts\\",\\"edits\\":[{\\"from\\":\\"a\\",\\"to\\":\\"b\\",\\"n\\":3.5}],\\"flags\\":{\\"dryRun\\":false},\\"note\\":\\"ünïcode ☃\\"}"');
  });

  it('media-refs S1 named-notes lane: image-bearing journal stays an element-wise byte-prefix across rounds', async () => {
    // The S1 flag turns omission notes into NAMED notes (derived from the image
    // url). The name derivation is pure and deterministic over the same journal,
    // so the projected messages must remain prefix-stable round to round — this
    // pins that (cache stability is a test, not a hope).
    const j = makeJournal();
    const snapshots: unknown[][] = [];
    const named = async () =>
      journalToChatCompletionsMessages((await j.project()).messages, { named: true });

    await appendUserEntry(j, ctx, 'What is in this screenshot?', [
      {
        type: 'image',
        data: '',
        mediaType: 'image/png',
        url: 'https://cdn.test/u1/shot%201.png?sig=a',
      } as never,
    ]);
    snapshots.push(await named());

    await appendAssistantEntry(j, ctx, text('Reading it.'), 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'call_s1', name: 'read', input: { path: 'files/shot 1.png' } });
    await appendToolResultEntry(j, ctx, {
      toolUseId: 'call_s1',
      text: 'here it is',
      isError: false,
      blocks: [
        { type: 'text', text: 'here it is' } as never,
        {
          type: 'image',
          data: '',
          mediaType: 'image/png',
          url: 'https://cdn.test/u1/shot%201.png?sig=a',
        } as never,
      ],
    });
    snapshots.push(await named());

    await appendAssistantEntry(j, ctx, text('Done.'), 'glm-5.2', CHAT, 'openai');
    snapshots.push(await named());

    expectPrefixChain(snapshots);
    // The tool message carries the NAMED note (decoded filename, query stripped).
    const toolMsg = (snapshots[1] as Array<{ role: string; content?: string }>).find(
      (m) => m.role === 'tool',
    );
    expect(toolMsg?.content).toBe(
      'here it is\n[Image omitted: shot 1.png — the selected model cannot view images.]',
    );
  });

  it('end-to-end callModel: system+tools+messages prefix stable across rounds (text-only image-strip lane)', async () => {
    const j = makeJournal();
    const system = 'SYSTEM PROMPT. '.repeat(50);
    const captured: unknown[][] = [];
    // Spy client: record the exact params.messages the transport puts on the wire.
    const client = {
      chat: { completions: { stream: (p: { messages: unknown[] }) => { captured.push(p.messages); return (async function* () {})(); } } },
    };
    const t = new ChatCompletionsTransport({ client: client as never });
    const send = async () => {
      const history = t.historyFromJournal((await j.project()).messages);
      // glm-5.2 is text-only → callModel runs stripImagesFromChatMessages; prove that
      // lane (plus the system prepend + tools) stays prefix-stable. (glm's cache affinity
      // rides the x-session-affinity header now, not a body field — the message prefix is
      // what this conformance test locks.)
      t.callModel({ model: 'glm-5.2', system, tools: [], history, maxTokens: 1000, cacheKey: 'u-fixed' } as never);
    };

    await appendUserEntry(j, ctx, 'Kick off the job.');
    await send();
    await appendAssistantEntry(j, ctx, text('Starting.'), 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'c1', name: 'run', input: { id: 42 } });
    await appendToolResultEntry(j, ctx, { toolUseId: 'c1', text: 'started', isError: false });
    await send();
    await appendAssistantEntry(j, ctx, [], 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'c2', name: 'status', input: {} });
    await appendToolResultEntry(j, ctx, { toolUseId: 'c2', text: 'running', isError: false });
    await send();

    expect(captured).toHaveLength(3);
    // Every wire request leads with the same system message …
    for (const msgs of captured) expect(msgs[0]).toEqual({ role: 'system', content: system });
    // … and each request's messages are an exact prefix of the next.
    expectPrefixChain(captured);
  });

  it('live push path and journal reprojection produce byte-identical messages', async () => {
    // The two ways the kernel builds history for a request MUST agree byte-for-byte,
    // or a task diverges by whether it took the journal or the in-memory path.
    const t = new ChatCompletionsTransport({ client: {} as never });

    // LIVE (no-journal round-engine path): pushUser → pushAssistant(text+tool_use) → pushToolResult.
    const live = t.emptyHistory();
    t.pushUser(live, 'Do the thing.');
    t.pushAssistant(live, [
      { type: 'text', text: 'searching' } as ContentBlock,
      { type: 'tool_use', toolUseId: 'call_1', toolName: 'search', toolInput: { query: 'x', limit: 5 } } as ContentBlock,
    ]);
    t.pushToolResult(live, { toolUseId: 'call_1', text: 'r1', isError: false } as ToolDispatchResult);

    // REPROJECTION (journal path): the same content journaled, then projected.
    const j = makeJournal();
    await appendUserEntry(j, ctx, 'Do the thing.');
    await appendAssistantEntry(j, ctx, text('searching'), 'glm-5.2', CHAT, 'openai');
    await appendToolUseEntry(j, ctx, { id: 'call_1', name: 'search', input: { query: 'x', limit: 5 } });
    await appendToolResultEntry(j, ctx, { toolUseId: 'call_1', text: 'r1', isError: false });
    const reproj = await roundMessages(j);

    expect(JSON.stringify(live)).toEqual(JSON.stringify(reproj));
  });
});
