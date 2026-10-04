/**
 * SCREENSHOT_PRUNE_CACHE_V1, proved on the wire (prod incident 10-03, task 28edef30, Opus 5.5).
 *
 * A SYNTHETIC journal reproduces the incident's pattern end to end through the real pipeline:
 * Journal.project() (the screenshot prune, the media rail), the Anthropic history projection,
 * and the transport's own breakpoint placement under CACHE_TIERING_V1 (system split in two,
 * tools tail, so ONE message breakpoint is left: the amplifier). Each round's request is
 * captured; a round "rebuilds" when an earlier message of the previous request changed, since
 * the one rolling breakpoint's 20-block lookback cannot reach behind that edit and the cache
 * read falls back to the system end (the incident read 58,463 / 58,522 and rewrote 99K to 110K).
 *
 *   - 8 image Reads of large images: the legacy prune rebuilds at Reads 3 to 8 (the incident's
 *     exact rounds 25, 28, 30, 36, 39, 41); with the policy, zero rebuilds and every image kept.
 *   - a browser-screenshot run of 12: the legacy prune rebuilds at every step from the 3rd; with
 *     the policy, once (at the 10th), and the history is still bounded.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { pruneScreenshots, SCREENSHOT_PRUNE_BATCH, type ScreenshotPrunePolicy } from '../../kernel/compaction/prune-screenshots.js';
import { applyMediaRail, RAIL_BATCH, RAIL_INLINE_SAFE_BYTES } from '../../kernel/compaction/media-rail.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { GeminiTransport } from '../gemini-transport.js';
import type { Transport } from '../../engine/transport.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';

const MODEL = 'claude-opus-5-5';
const SCREENSHOT = 'mcp__browser-control__computer_screenshot';
const POLICY: ScreenshotPrunePolicy = { tools: new Set([SCREENSHOT]), batch: SCREENSHOT_PRUNE_BATCH };
/** The whole flag-on policy, as the sandbox builds it: the prune, plus the rail's cap-safe batched policy. */
const FULL: ScreenshotPrunePolicy = { ...POLICY, rail: { maxBytes: RAIL_INLINE_SAFE_BYTES, batch: RAIL_BATCH } };
// A system whose fleet slice clears the cacheable floor, so the transport splits it (tiering).
const FLEET = 'FLEET-STATIC '.repeat(800);
const SYSTEM = FLEET + '\n\nSESSION-TAIL ' + 'user/session layers '.repeat(200);
const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }];

const dir = join(tmpdir(), `screenshot-prune-cache-${process.pid}-${Math.random().toString(36).slice(2)}`);
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capturingTransport(): { transport: AnthropicMessagesTransport; requests: Anthropic.MessageCreateParams[] } {
  const requests: Anthropic.MessageCreateParams[] = [];
  const fakeStream = {
    async *[Symbol.asyncIterator]() {},
    async finalMessage() {
      return { stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Message;
    },
  };
  const client = { messages: { stream: (params: Anthropic.MessageCreateParams) => (requests.push(params), fakeStream) } } as unknown as Anthropic;
  return { transport: new AnthropicMessagesTransport({ client }), requests };
}

const meta = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});

/** Strip cache_control so two requests compare on what the model reads. */
const bare = (m: Anthropic.MessageParam): string => JSON.stringify(m, (k, v) => (k === 'cache_control' ? undefined : v));
const breakpointsOn = (ms: Anthropic.MessageParam[]) =>
  ms.filter((m) => Array.isArray(m.content) && (m.content as Array<{ cache_control?: unknown }>).some((b) => b.cache_control)).length;
const imagesIn = (ms: Anthropic.MessageParam[]): number => (JSON.stringify(ms).match(/"type":"image"/g) ?? []).length;

/**
 * Run `rounds` tool rounds, each an assistant line, a call to `tool` and a result carrying one
 * ~600 KB image (a large sheet), with a plain Bash round between; send a request after each.
 * Returns the 1-based image rounds that rebuilt the message cache, and the last request.
 */
async function drive(taskId: string, tool: string, rounds: number, policy?: ScreenshotPrunePolicy, imageChars = 600_000) {
  const journal = new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)), mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-01T00:00:00.000Z'), ...(policy ? { screenshotPrune: policy } : {}),
  });
  const { transport, requests } = capturingTransport();
  const send = async () => {
    const state = await journal.project();
    transport.callModel({
      model: MODEL, system: SYSTEM, tools: TOOLS, maxTokens: 8192, systemFleetPrefixChars: FLEET.length,
      history: transport.historyFromJournal(state.messages),
    });
  };
  const call = async (name: string, id: string, input: unknown, blocks: ContentBlock[]) => {
    await journal.append({ ...meta(taskId), payload: { type: 'assistant', blocks: [{ type: 'text', text: `step ${id}` }] } });
    await journal.append({ ...meta(taskId), payload: { type: 'tool_use', toolUseId: id, name, input } });
    await journal.append({ ...meta(taskId), payload: { type: 'tool_result', toolUseId: id, blocks } });
  };
  await journal.append({ ...meta(taskId), principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text: 'Make the showreel.' }] } });
  await send();
  const rebuilt: number[] = [];
  for (let r = 1; r <= rounds; r++) {
    await call('Bash', `bash-${r}`, { command: `ls ${r}` }, [{ type: 'text', text: `out ${r}` }]);
    await send();
    const image: ContentBlock = { type: 'image', data: `${r}`.padEnd(imageChars, 'A'), mediaType: 'image/jpeg' };
    await call(tool, `img-${r}`, { file_path: `/work/sheet-${r}.jpg` }, [{ type: 'text', text: `image ${r}` }, image]);
    const before = requests.at(-1)!.messages as Anthropic.MessageParam[];
    await send();
    const now = requests.at(-1)!.messages as Anthropic.MessageParam[];
    if (before.some((m, i) => bare(m) !== bare(now[i]!))) rebuilt.push(r);
  }
  return { rebuilt, last: requests.at(-1)! };
}

describe('SCREENSHOT_PRUNE_CACHE_V1 on the wire, under CACHE_TIERING_V1', () => {
  it('the amplifier: a tiered request with tools keeps ONE message breakpoint', async () => {
    const { last } = await drive('amp', 'Read', 1);
    expect((last.system as unknown[]).length).toBe(2);
    expect(breakpointsOn(last.messages as Anthropic.MessageParam[])).toBe(1);
  });

  it('8 image Reads: the legacy prune rebuilds the message cache at Reads 3 to 8 (the incident)', async () => {
    const { rebuilt, last } = await drive('legacy-reads', 'Read', 8);
    expect(rebuilt).toEqual([3, 4, 5, 6, 7, 8]);
    expect(imagesIn(last.messages as Anthropic.MessageParam[])).toBe(2);
  });

  it('8 image Reads with the policy: zero rebuilds, all 8 images still on the wire', async () => {
    // Mutation: drop the name check in pruneScreenshots → the legacy rebuilds above return.
    const { rebuilt, last } = await drive('policy-reads', 'Read', 8, POLICY);
    expect(rebuilt).toEqual([]);
    expect(imagesIn(last.messages as Anthropic.MessageParam[])).toBe(8);
  });

  it('a browser run of 12 screenshots: legacy rebuilds every step from the 3rd; the policy once, still bounded', async () => {
    const legacy = await drive('legacy-browser', SCREENSHOT, 12);
    expect(legacy.rebuilt).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Mutation: batch of 1 → the policy run rebuilds like the legacy one.
    const batched = await drive('policy-browser', SCREENSHOT, 12, POLICY);
    expect(batched.rebuilt).toEqual([10]);
    expect(imagesIn(batched.last.messages as Anthropic.MessageParam[])).toBe(4);
  });
});

describe('SCREENSHOT_PRUNE_CACHE_V1 past 20 image Reads: the media rail\'s real cadence, end to end', () => {
  it('30 Reads of fitted images (~300 KB): the whole flag-on policy rebuilds at the 21st and 27th Read only', async () => {
    // Read images are no longer pruned; the rail's batched policy is what bounds them. Mutation:
    // the legacy rail (pure "keep the newest 15") rebuilds at every Read from the 21st.
    const { rebuilt, last } = await drive('policy-many-reads', 'Read', 30, FULL, 400_000);
    expect(rebuilt).toEqual([21, 27]);
    expect(imagesIn(last.messages as Anthropic.MessageParam[])).toBe(18); // 30 - 12 evicted, two batches
  });

  it('the same 30 Reads with the prune policy but the legacy rail: a rebuild at every Read past the 20th', async () => {
    const { rebuilt } = await drive('legacy-rail-many-reads', 'Read', 30, POLICY, 400_000);
    expect(rebuilt).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });
});

describe('SCREENSHOT_PRUNE_CACHE_V1: ten 5 MB image Reads stay under every lane\'s inline cap', () => {
  const FIVE_MB_B64 = Math.ceil((5 * 1024 * 1024) / 3) * 4;
  const CAPS = { anthropic: 32_000_000, openai: 50_000_000, gemini: 20_000_000 } as const;
  /** A projection of ten Reads of 5 MB originals (what a Read returned before the fit, or when ffmpeg is missing). */
  function tenBigReads(): JournalEntry[] {
    const out: JournalEntry[] = [];
    let seq = 0;
    const entry = (payload: JournalEntry['payload']): JournalEntry =>
      ({ uuid: `e${seq}`, parentUuid: seq ? `e${seq - 1}` : null, seq: seq++, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-10-01T00:00:00.000Z', payload }) as JournalEntry;
    out.push(entry({ type: 'user', blocks: [{ type: 'text', text: 'Grade these ten photos.' }] }));
    for (let i = 1; i <= 10; i++) {
      out.push(entry({ type: 'assistant', blocks: [{ type: 'text', text: `photo ${i}` }] }));
      out.push(entry({ type: 'tool_use', toolUseId: `r${i}`, name: 'Read', input: { file_path: `/work/p${i}.png` } }));
      out.push(entry({ type: 'tool_result', toolUseId: `r${i}`, blocks: [{ type: 'text', text: `Image file /work/p${i}.png` }, { type: 'image', data: `${i}`.padEnd(FIVE_MB_B64, 'A'), mediaType: 'image/png' }] }));
    }
    return out;
  }
  /** Ten 5 MB images uploaded by the person: user turns ride inline on EVERY lane, Gemini's included. */
  function tenBigUploads(): JournalEntry[] {
    let seq = 0;
    const entry = (payload: JournalEntry['payload']): JournalEntry =>
      ({ uuid: `u${seq}`, parentUuid: seq ? `u${seq - 1}` : null, seq: seq++, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'user', userId: 'u' }, timestamp: '2026-10-01T00:00:00.000Z', payload }) as JournalEntry;
    const out: JournalEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      out.push(entry({ type: 'user', blocks: [{ type: 'image', data: `${i}`.padEnd(FIVE_MB_B64, 'A'), mediaType: 'image/png' }, { type: 'text', text: `Photo ${i}.` }] }));
      out.push(entry({ type: 'assistant', blocks: [{ type: 'text', text: `Got photo ${i}.` }] }));
    }
    return out;
  }
  const project = (es: JournalEntry[], p?: ScreenshotPrunePolicy) => applyMediaRail(pruneScreenshots(es, p), p?.rail);

  /** The request body each lane would send for this projection, in bytes. */
  async function bodyBytes(lane: keyof typeof CAPS, entries: JournalEntry[]): Promise<number> {
    let body: unknown;
    const empty = () => (async function* () {})();
    const t: Transport =
      lane === 'anthropic'
        ? new AnthropicMessagesTransport({ client: { messages: { stream: (b: unknown) => ((body = b), { async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }) }) } } as never })
        : lane === 'openai'
          ? new OpenAIResponsesTransport({ client: { baseURL: 'https://capture.invalid/v1', responses: { stream: (b: unknown) => ((body = b), empty()) } } as never })
          : new GeminiTransport({ streamFactory: (_m, b) => ((body = b), empty() as never) });
    const model = { anthropic: MODEL, openai: 'gpt-6.1-sol', gemini: 'gemini-3.8-flash' }[lane];
    const stream = t.callModel({ model, system: SYSTEM, tools: [], maxTokens: 8192, history: t.historyFromJournal(entries) });
    try {
      for await (const _ of t.readStream(stream)) { /* drain: the Gemini factory runs on iteration */ }
    } catch {
      /* an empty stream may end in a protocol error; the body is captured */
    }
    expect(body).toBeDefined();
    return Buffer.byteLength(JSON.stringify(body));
  }

  it.each(['anthropic', 'openai', 'gemini'] as const)('%s: the flag-on projection is under the cap', async (lane) => {
    expect(await bodyBytes(lane, project(tenBigReads(), FULL))).toBeLessThanOrEqual(CAPS[lane]);
  });

  it.each(['anthropic', 'openai', 'gemini'] as const)('%s: ten 5 MB uploads under the flag-on policy are under the cap', async (lane) => {
    expect(await bodyBytes(lane, project(tenBigUploads(), FULL))).toBeLessThanOrEqual(CAPS[lane]);
  });

  it('gemini: without the rail policy the legacy rail sends the newest three, over its 20 MB cap (the review H1)', async () => {
    // Gemini's generateContent sends a tool result as text only (gemini-messages.ts), so its exposure
    // is images the person uploads. Mutation: drop the rail policy → the request is rejected.
    expect(await bodyBytes('gemini', project(tenBigUploads(), POLICY))).toBeGreaterThan(CAPS.gemini);
  });
});

