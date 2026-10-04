/**
 * CONTEXT_APPEND_V1 on the exact path of the 10-03 incident's Class B (prod task 28edef30, Opus 5.5):
 * a permission approval. The tool call pauses, the pause ENDS the run, the person presses Allow,
 * and the continuation opens a NEW run on the same journal with a `continueInteraction` turn,
 * re-rendering the instruction stack from the live world.
 *
 * In the incident the first round after four of seven Allows read only 48,611 tokens (the tools and
 * the fleet half of the system prompt) and rewrote 114K to 130K: the session half came out
 * different. The memory block alone does that (an hour count, and the capture rewrites it).
 *
 * Driven through the REAL NativeHarness both times (run 1 a normal turn, run 2 the continuation
 * turn), over a real Journal and the real Anthropic transport under CACHE_TIERING_V1, with the
 * layers handed in as the product's continue path hands them (apps/sandbox run-driver.ts
 * `_buildContinuation`, pinned on the host side by its own test):
 *   - flag off: the continuation's system prompt differs in its session block (the incident);
 *   - flag on: the continuation serves the session's first system prompt byte for byte, and its
 *     request is the last one before the pause plus an appended tail, with a real memory change
 *     carried IN that tail.
 * Revert-proof: drop native-run-open.ts's `holdSessionPrefix` call and the flag-on cases fail on
 * the system block (run 2 then serves the prompt as built).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { NativeHarness } from '../native-harness.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { assembleInstructionStack, splitInstructionStack, type InstructionLayer } from '../../contract/instruction-stack.js';
import type { JournalPayload, NewEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const FLAG = 'CONTEXT_APPEND_V1';
const MODEL = 'claude-opus-5-5';
const dir = join(tmpdir(), `context-append-approval-${process.pid}-${Math.random().toString(36).slice(2)}`);
afterEach(async () => {
  delete process.env[FLAG];
  await rm(dir, { recursive: true, force: true });
});

// The fleet half (static, clears the cacheable floor) and a memory block with an hour count.
const SOUL = 'You are a careful assistant who finishes the work. '.repeat(160);
const memory = (body: string, hours: number): InstructionLayer => ({
  id: 'nami', static: false,
  text: `<user_memory>\nrefreshed ${hours} hours ago\n${body}\n</user_memory>`,
  stableText: `<user_memory>\n${body}\n</user_memory>`,
});
const stack = (nami: InstructionLayer): InstructionLayer[] => [
  { id: 'soul', text: SOUL, static: true },
  { id: 'operational', text: 'Keep files tidy.', static: true },
  nami,
];

/** What the model answers on every call: signed thinking, then a line of text. */
function answer(text: string) {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${text.length}` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
  ];
  return {
    async *[Symbol.asyncIterator]() { yield* events; },
    async finalMessage() {
      return {
        stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 40 },
        content: [{ type: 'thinking', thinking: 'plan', signature: `sig-${text.length}` }, { type: 'text', text }],
      };
    },
  };
}

const meta = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});
/** What the model reads: no cache_control, and a bare-string content as the one text block it renders as. */
const bare = (v: unknown): string =>
  JSON.stringify(v, (k, x) => {
    if (k === 'cache_control') return undefined;
    if (k === 'content' && typeof x === 'string') return [{ type: 'text', text: x }];
    return x;
  });

/**
 * One approval through the real harness: run 1 answers the ask; the approval-held call and the
 * person's Allow land (the call, the interaction opened and resolved, the result, as the product's
 * continue orchestrator writes them); run 2 is the continuation turn on a stack whose memory is
 * `after`. Returns the last request of run 1 and the first request of run 2.
 */
async function approval(taskId: string, before: InstructionLayer, after: InstructionLayer) {
  const journal = new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)), mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-09-30T10:00:00.000Z'),
  });
  const requests: Anthropic.MessageCreateParams[] = [];
  const transport = new AnthropicMessagesTransport({
    client: { messages: { stream: (p: Anthropic.MessageCreateParams) => (requests.push(JSON.parse(JSON.stringify(p))), answer(`reply ${requests.length}`)) } } as never,
  });
  const run = async (layers: InstructionLayer[], turn: UserTurn) => {
    const cfg = {
      onAttached: () => {}, maxTurns: 4, transport, journal,
      systemPrompt: assembleInstructionStack(layers, 'native'),
      systemFleetPrefixChars: splitInstructionStack(layers, 'native').fleet.length,
      instructionLayers: layers,
      runtimeConfig: { userId: 'user-1' },
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = { taskId, sessionId: taskId, cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
    const events: HarnessEvent[] = [];
    for await (const ev of new NativeHarness().run((async function* () { yield turn; })(), ctx)) events.push(ev);
    expect(events.some((e) => e.kind === 'turn_end')).toBe(true);
  };
  const append = (payload: JournalPayload) => journal.append({ ...meta(taskId), payload });

  await run(stack(before), { text: 'Render the showreel.' });
  const lastBeforePause = requests.at(-1)!;
  // The approval-held call and its resolution, as the continue path writes them.
  await append({ type: 'assistant', blocks: [{ type: 'text', text: 'Rendering it now.' }] });
  await append({ type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: { command: 'ffmpeg -i a.mp4 out.mp4' } });
  await append({ type: 'interaction', interactionId: 'i-1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'bash-1', toolName: 'Bash' } });
  await append({ type: 'interaction', interactionId: 'i-1', resolved: true, data: { kind: 'tool_permission', toolUseId: 'bash-1', toolName: 'Bash' } });
  await append({ type: 'tool_result', toolUseId: 'bash-1', blocks: [{ type: 'text', text: 'done' }] });
  // The continuation: a NEW run, opened through native-run-open on the re-rendered stack.
  await run(stack(after), { text: '', continueInteraction: true });
  return { lastBeforePause, resumed: requests.at(-1)! };
}

const systemOf = (p: Anthropic.MessageCreateParams) => p.system as Anthropic.TextBlockParam[];
const isPrefix = (a: Anthropic.MessageCreateParams, b: Anthropic.MessageCreateParams) =>
  (a.messages as unknown[]).every((m, i) => bare(m) === bare((b.messages as unknown[])[i]));

describe('CONTEXT_APPEND_V1 on a permission approval (the incident Class B path), real harness, Anthropic wire, tiered', () => {
  it('flag off: only the hour count moved, and the continuation\'s system prompt differs in its session block', async () => {
    const { lastBeforePause, resumed } = await approval('off-clock', memory('Likes short replies.', 1), memory('Likes short replies.', 2));
    expect(systemOf(resumed)).toHaveLength(2);
    expect(systemOf(resumed)[0]!.text).toBe(systemOf(lastBeforePause)[0]!.text); // the fleet half still reads
    expect(systemOf(resumed)[1]!.text).not.toBe(systemOf(lastBeforePause)[1]!.text); // the session half rewrites, and all history behind it
  });

  it('flag on, the hour count moved: the same system prompt byte for byte, and the request is the last one plus a tail', async () => {
    process.env[FLAG] = 'true';
    const { lastBeforePause, resumed } = await approval('on-clock', memory('Likes short replies.', 1), memory('Likes short replies.', 2));
    expect(bare(systemOf(resumed))).toBe(bare(systemOf(lastBeforePause)));
    expect(isPrefix(lastBeforePause, resumed)).toBe(true);
    expect(JSON.stringify(resumed.messages)).not.toContain('refreshed 2 hours ago');
  });

  it('flag on, the memory itself changed during the pause: held prompt, the change in the tail', async () => {
    process.env[FLAG] = 'true';
    const { lastBeforePause, resumed } = await approval('on-memory', memory('Likes short replies.', 1), memory('Likes short replies. Wants a PDF too.', 1));
    expect(bare(systemOf(resumed))).toBe(bare(systemOf(lastBeforePause)));
    expect(isPrefix(lastBeforePause, resumed)).toBe(true);
    const tail = JSON.stringify((resumed.messages as unknown[]).slice((lastBeforePause.messages as unknown[]).length));
    expect(tail).toContain('Wants a PDF too.');
  });
});
