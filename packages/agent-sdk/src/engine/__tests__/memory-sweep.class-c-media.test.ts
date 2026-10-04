/**
 * The 10-03 incident's Class C (prod task 28edef30, Opus 5.5): sweeps read only 49-59K tokens and
 * rewrote 115K to 125K right after a fully warm main round. Was that Class A (the screenshot prune
 * editing the history the sweep re-sends) or a difference in the sweep's own request?
 *
 * A real turn through the NativeHarness on a media history (four image Reads, so the legacy prune
 * is stubbing), on the Anthropic wire with the tiered system, then its memory sweep:
 *   - only the final reply lands between the main round's request and the sweep's: the sweep's
 *     messages are the main request's, byte for byte, stubs and images included, plus that reply
 *     and the sweep prompt. Flag on or off. So it is NOT Class A;
 *   - flag off (today), the sweep's REQUEST differs: one unsplit system block where the loop sent
 *     two, and reasoning effort 'low' where the loop sent its own. That is the read that stopped at
 *     the system end;
 *   - SWEEP_PREFIX_PARITY_V1 on: the sweep sends the loop's own system, tools and effort, so its
 *     request is the loop's last request plus a tail.
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
import { SCREENSHOT_PRUNE_PLACEHOLDER } from '../../kernel/compaction/prune-screenshots.js';
import type { JournalPayload, NewEntry } from '../../contract/journal.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const FLAG = 'SWEEP_PREFIX_PARITY_V1';
const MODEL = 'claude-opus-5-5';
const FLEET = 'FLEET-STATIC '.repeat(800);
const SYSTEM = FLEET + '\n\nSESSION-TAIL ' + 'user/session layers '.repeat(200);
const dir = join(tmpdir(), `sweep-class-c-${process.pid}-${Math.random().toString(36).slice(2)}`);
afterEach(async () => {
  delete process.env[FLAG];
  await rm(dir, { recursive: true, force: true });
});

function answer(text: string) {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'look' } },
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
        content: [{ type: 'thinking', thinking: 'look', signature: `sig-${text.length}` }, { type: 'text', text }],
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

/** A media history (four image Reads), then one real turn and its sweep. Returns [main request, sweep request]. */
async function turnAndSweep(taskId: string): Promise<[Anthropic.MessageCreateParams, Anthropic.MessageCreateParams]> {
  const journal = new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)), mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-09-29T12:00:00.000Z'),
  });
  const append = (payload: JournalPayload, user = false) =>
    journal.append({ ...meta(taskId), ...(user && { principal: { kind: 'user', userId: 'user-1' } as const }), payload });
  await append({ type: 'user', blocks: [{ type: 'text', text: 'Make the contact sheet for the showreel.' }] }, true);
  for (let i = 1; i <= 4; i++) {
    await append({ type: 'assistant', blocks: [{ type: 'text', text: `Checking sheet ${i}.` }] });
    await append({ type: 'tool_use', toolUseId: `read-${i}`, name: 'Read', input: { file_path: `/work/sheet-${i}.jpg` } });
    await append({ type: 'tool_result', toolUseId: `read-${i}`, blocks: [{ type: 'text', text: `Image file /work/sheet-${i}.jpg` }, { type: 'image', data: `${i}`.padEnd(4000, 'A'), mediaType: 'image/jpeg' }] });
  }
  const requests: Anthropic.MessageCreateParams[] = [];
  const transport = new AnthropicMessagesTransport({
    client: { messages: { stream: (p: Anthropic.MessageCreateParams) => (requests.push(JSON.parse(JSON.stringify(p))), answer(requests.length === 1 ? 'Sheet 3 is the sharpest.' : 'FACT: prefers sheet 3')) } } as never,
  });
  const cfg = {
    onAttached: () => {}, maxTurns: 4, transport, journal,
    systemPrompt: SYSTEM, systemFleetPrefixChars: FLEET.length,
    runtimeConfig: { userId: 'user-1' }, namiOffloopSweep: true,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = { taskId, sessionId: taskId, cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run((async function* () { yield { text: 'Which sheet is the sharpest, and why?' }; })(), ctx)) events.push(ev);
  expect(events.some((e) => e.kind === 'turn_end')).toBe(true);
  expect(requests).toHaveLength(2); // the main round, then the sweep
  return [requests[0]!, requests[1]!];
}

const messagesOf = (p: Anthropic.MessageCreateParams) => p.messages as Anthropic.MessageParam[];
const effortOf = (p: Anthropic.MessageCreateParams) => (p as { output_config?: { effort?: string } }).output_config?.effort;

/** The history half of the claim: the sweep re-sends the main request's messages unchanged, plus the reply and its prompt. */
function expectSameHistory(main: Anthropic.MessageCreateParams, sweep: Anthropic.MessageCreateParams): void {
  const m = messagesOf(main);
  const s = messagesOf(sweep);
  expect(s.slice(0, m.length).map(bare)).toEqual(m.map(bare));
  // The legacy prune is stubbing in both, identically (4 image Reads, the oldest two stubbed).
  expect(JSON.stringify(m).split(SCREENSHOT_PRUNE_PLACEHOLDER).length - 1).toBe(2);
  expect(JSON.stringify(s.slice(0, m.length)).split(SCREENSHOT_PRUNE_PLACEHOLDER).length - 1).toBe(2);
  // Only the final reply lands between them, then the sweep's own prompt.
  expect(s.slice(m.length).map((x) => x.role)).toEqual(['assistant', 'user']);
  expect(bare(s[m.length])).toContain('Sheet 3 is the sharpest.');
}

describe('the 10-03 Class C sweeps are not Class A: a real turn and its sweep on a media history', () => {
  it('flag off (today): the same history, but the sweep\'s request differs (one system block, effort low)', async () => {
    const [main, sweep] = await turnAndSweep('class-c-off');
    expectSameHistory(main, sweep);
    expect((main.system as unknown[]).length).toBe(2); // the loop: fleet and session halves
    expect((sweep.system as unknown[]).length).toBe(1); // the sweep: unsplit
    expect(effortOf(sweep)).toBe('low');
    expect(effortOf(main)).not.toBe('low');
  });

  it('SWEEP_PREFIX_PARITY_V1 on: the sweep is the loop\'s last request plus a tail (system, tools, effort, history)', async () => {
    process.env[FLAG] = 'true';
    const [main, sweep] = await turnAndSweep('class-c-on');
    expectSameHistory(main, sweep);
    // Mutation: the floored request (no parity) → the system and effort assertions fail.
    expect(bare(sweep.system)).toBe(bare(main.system));
    expect(bare(sweep.tools ?? [])).toBe(bare(main.tools ?? []));
    expect(effortOf(sweep)).toBe(effortOf(main));
  });
});
