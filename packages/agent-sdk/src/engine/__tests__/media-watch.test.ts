/**
 * media-watch — the `watch` tool (VIDEO_UNDERSTANDING_V1).
 *
 * A model that cannot take a video or an audio file in directly POINTS the
 * Gemini describe lane at one attached file with a specific question and reads
 * the answer back. These tests drive the pure engine half: target resolution
 * (including the agent-made `files/` case), the one bounded side call and the
 * clip options it puts on the wire, honest failure, the install decision point,
 * and the turn's folded usage row.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaBlock } from '../../contract/blocks.js';
import type { JournalEntry } from '../../contract/journal.js';
import { blocksToGeminiInteractionsContent } from '../../transports/gemini-interactions-messages.js';
import type { NormalizedUsage, Transport } from '../transport.js';
import type { SideCallResult } from '../offloop-usage.js';
import { deterministicUsageId } from '../round-engine.js';
import { createToolSearchState, shapeToolSearchTools } from '../tool-search.js';
import {
  MEDIA_WATCH_TOOL_NAME,
  VIDEO_DESCRIBE_SYSTEM,
  WATCH_CALLS_PER_TURN,
  WATCH_CALL_TIMEOUT_MS,
  attachMediaWatch,
  makeWatchTool,
  mediaUsageEvent,
} from '../media-watch.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

function vid(filename: string, over?: Partial<MediaBlock>): MediaBlock {
  return {
    type: 'media',
    kind: 'video',
    filename,
    path: `files/${filename}`,
    url: `https://cdn/${filename}`,
    mediaType: 'video/mp4',
    sizeBytes: 9000,
    ...over,
  };
}

function aud(filename: string, over?: Partial<MediaBlock>): MediaBlock {
  return { ...vid(filename), kind: 'audio', mediaType: 'audio/mpeg', ...over };
}

function doc(filename: string, over?: Partial<MediaBlock>): MediaBlock {
  return { ...vid(filename), kind: 'document', mediaType: 'application/pdf', ...over };
}

/** A describe-lane Transport that yields one text + one done chunk (or throws). */
function fakeDescribeTransport(
  opts: { text?: string; usage?: NormalizedUsage; fail?: boolean; failReason?: string } = {},
) {
  const pushed: { text: string; images?: unknown[]; media?: MediaBlock[] }[] = [];
  const calls: { model: string; system: string; maxTokens: number }[] = [];
  const transport = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => ({ msgs: [] as unknown[] }),
    historyFromJournal: () => ({ msgs: [] as unknown[] }),
    pushAssistant: () => {},
    pushToolResult: () => {},
    pushUser: (_h: unknown, text: string, images?: unknown[], media?: MediaBlock[]) => {
      pushed.push({ text, ...(images !== undefined && { images }), ...(media !== undefined && { media }) });
    },
    buildTools: () => [],
    callModel: (p: { model: string; system: string; maxTokens: number }) => {
      calls.push({ model: p.model, system: p.system, maxTokens: p.maxTokens });
      if (opts.failReason !== undefined) {
        // The shape a strict media-resolution failure arrives in: the SHORT reason
        // rides as a typed field (StrictMediaResolutionError), never inside the message.
        throw Object.assign(new Error('clip.mp4: ' + opts.failReason), { reason: opts.failReason });
      }
      if (opts.fail) throw new Error('boom');
      return {};
    },
    readStream: async function* () {
      yield { kind: 'text', text: opts.text ?? 'a cyclist crosses the frame at 0:12' };
      yield {
        kind: 'done',
        stopReason: 'stop',
        usage: opts.usage ?? { inputTokens: 4321, outputTokens: 87 },
      };
    },
  } as unknown as Transport;
  return { transport, pushed, calls };
}

function makeTool(args: {
  media: MediaBlock[];
  fake?: ReturnType<typeof fakeDescribeTransport>;
  workspaceDir?: string;
  signal?: AbortSignal;
}) {
  const fake = args.fake ?? fakeDescribeTransport();
  const records: SideCallResult[] = [];
  const tool = makeWatchTool({
    getMedia: async () => args.media,
    transport: fake.transport,
    model: 'gemini-3.8-flash',
    records,
    workspaceDir: args.workspaceDir ?? tmpdir(),
    ...(args.signal !== undefined && { signal: args.signal }),
  });
  return { tool, records, fake };
}

/** A workspace with a real `files/` directory — the agent-made-file case. */
function workspaceWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-ws-'));
  mkdirSync(join(root, 'files'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'files', name), body);
  return root;
}

// ── The tool ─────────────────────────────────────────────────────────────────

describe('makeWatchTool', () => {
  test('is a RESIDENT tool named "watch" that asks for a question, a file and a clip', () => {
    const { tool } = makeTool({ media: [] });
    expect(tool.name).toBe(MEDIA_WATCH_TOOL_NAME);
    expect(tool.name).toBe('watch');
    // NOT deferrable: the attachment pointer line names `watch` the moment a
    // video lands, so a withheld schema would point the model at a tool it
    // cannot yet call. Its residency is proven end-to-end below.
    expect(tool.deferrable).toBe(false);
    expect(tool.description).toMatch(/video/i);
    const shape = (tool.parameters as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['question', 'file', 'start', 'end']));
  });

  test('no media attached and no file arg → says so without a provider call', async () => {
    const fake = fakeDescribeTransport();
    const { tool, records } = makeTool({ media: [], fake });

    const out = await tool.execute({ question: 'what happens?' }, {});

    expect(out).toMatch(/no video or audio is attached/i);
    expect(fake.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  test('the default target is the NEWEST media block', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [vid('old-take.mp4'), vid('final-cut.mp4')], fake });

    await tool.execute({ question: 'what happens?' }, {});

    expect(fake.pushed).toHaveLength(1);
    expect(fake.pushed[0].media?.[0]?.filename).toBe('final-cut.mp4');
  });

  test('a name matches exact first, then substring, newest wins', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({
      media: [vid('cut.mp4'), vid('rough-cut.mp4'), vid('rough-cut-v2.mp4')],
      fake,
    });

    // Exact beats the two substring candidates that also contain "cut".
    await tool.execute({ question: 'q', file: 'cut.mp4' }, {});
    expect(fake.pushed[0].media?.[0]?.filename).toBe('cut.mp4');

    // Substring, newest of the matches.
    await tool.execute({ question: 'q', file: 'rough' }, {});
    expect(fake.pushed[1].media?.[0]?.filename).toBe('rough-cut-v2.mp4');

    // The path the attachment note shows also resolves.
    await tool.execute({ question: 'q', file: 'files/cut.mp4' }, {});
    expect(fake.pushed[2].media?.[0]?.filename).toBe('cut.mp4');
  });

  test('an unknown name fails helpfully, naming what IS attached, with no provider call', async () => {
    const fake = fakeDescribeTransport();
    const { tool, records } = makeTool({ media: [vid('final-cut.mp4')], fake });

    const out = await tool.execute({ question: 'q', file: 'ghost.mp4' }, {});

    expect(out).toMatch(/ghost\.mp4/);
    expect(out).toMatch(/final-cut\.mp4/);
    expect(fake.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  test('a files/ path with no block → an ad-hoc source: kind + mime from the extension, size from stat', async () => {
    const ws = workspaceWith({ 'render.mov': 'twelve bytes', 'voice.m4a': 'audio!' });
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [], fake, workspaceDir: ws });

    await tool.execute({ question: 'what did the render produce?', file: 'files/render.mov' }, {});

    expect(fake.pushed[0].media?.[0]).toMatchObject({
      type: 'media',
      kind: 'video',
      filename: 'render.mov',
      path: 'files/render.mov',
      mediaType: 'video/quicktime',
      sizeBytes: 12,
    });

    await tool.execute({ question: 'what is said?', file: 'files/voice.m4a' }, {});
    expect(fake.pushed[1].media?.[0]).toMatchObject({
      kind: 'audio',
      mediaType: 'audio/mp4',
      sizeBytes: 6,
    });
  });

  test('a files/ path that is not video or audio, or escapes the workspace, is refused with no call', async () => {
    const ws = workspaceWith({ 'notes.txt': 'hello' });
    const fake = fakeDescribeTransport();
    const { tool, records } = makeTool({ media: [], fake, workspaceDir: ws });

    expect(await tool.execute({ question: 'q', file: 'files/notes.txt' }, {})).toMatch(/no video or audio/i);
    expect(await tool.execute({ question: 'q', file: '../../etc/hosts.mp4' }, {})).toMatch(/no video or audio/i);
    expect(fake.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  test('runs ONE bounded side call: the question, no images, the block, maxTokens 800, the watch system prompt', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [vid('clip.mp4')], fake });

    await tool.execute({ question: 'what is written on the sign?' }, {});

    expect(fake.pushed).toHaveLength(1);
    expect(fake.pushed[0].text).toBe('what is written on the sign?');
    expect(fake.pushed[0].images).toEqual([]);
    expect(fake.pushed[0].media).toHaveLength(1);
    expect(fake.calls).toEqual([
      { model: 'gemini-3.8-flash', system: VIDEO_DESCRIBE_SYSTEM, maxTokens: 800 },
    ]);
  });

  test('resolution rides low by default, and start/end become the Gemini processing offsets', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [vid('clip.mp4')], fake });

    await tool.execute({ question: 'q' }, {});
    await tool.execute({ question: 'q', start: 12, end: 40 }, {});

    // The tool sets the per-call options...
    expect((fake.pushed[0].media?.[0] as { watchOptions?: unknown }).watchOptions)
      .toEqual({ resolution: 'low', strict: true });
    expect((fake.pushed[1].media?.[0] as { watchOptions?: unknown }).watchOptions)
      .toEqual({ resolution: 'low', startSec: 12, endSec: 40, strict: true });

    // ...and the real Gemini projection turns them into the wire's offsets.
    const [content] = blocksToGeminiInteractionsContent([fake.pushed[1].media![0]]);
    expect(content).toMatchObject({
      type: 'video',
      resolution: 'low',
      processing: { start_offset: '12s', end_offset: '40s' },
    });
  });

  test('the block the tool watches is NEVER journaled — it builds its own history', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [vid('clip.mp4')], fake });
    const before = vid('clip.mp4');

    await tool.execute({ question: 'q', start: 3 }, {});

    // The caller's block is untouched — watchOptions live on the tool's copy only.
    expect(before).not.toHaveProperty('watchOptions');
    expect((fake.pushed[0].media?.[0] as { watchOptions?: unknown }).watchOptions).toBeDefined();
  });

  test('returns "[Watched <name>]\\n<answer>" and pushes an ok record with the usage', async () => {
    const fake = fakeDescribeTransport({ text: 'the sign reads PLATFORM 4', usage: { inputTokens: 4321, outputTokens: 87 } });
    const { tool, records } = makeTool({ media: [vid('clip.mp4')], fake });

    const out = await tool.execute({ question: 'what is on the sign?' }, {});

    expect(out).toBe('[Watched clip.mp4]\nthe sign reads PLATFORM 4');
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('ok');
    expect(records[0].usage).toEqual({ inputTokens: 4321, outputTokens: 87 });
    expect(records[0].model).toBe('gemini-3.8-flash');
  });

  test('a failed describe returns an honest failure naming the retry, the clip and the shell', async () => {
    const fake = fakeDescribeTransport({ fail: true });
    const { tool, records } = makeTool({ media: [vid('clip.mp4')], fake });

    const out = await tool.execute({ question: 'what happens?' }, {});

    expect(out).toMatch(/failed/i);
    expect(out).toMatch(/retry/i);
    expect(out).toMatch(/clip/i);
    expect(out).toMatch(/files\/ with the shell/);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('error');
  });

  // `low` is a FRAMES-per-second knob. Google rejects it on audio, and it says
  // nothing true about a soundtrack either way.
  test('resolution rides VIDEO only — an audio watch carries no resolution at all', async () => {
    const fake = fakeDescribeTransport();
    const { tool } = makeTool({ media: [aud('call.mp3')], fake });

    await tool.execute({ question: 'what is said?', start: 5 }, {});

    expect((fake.pushed[0].media?.[0] as { watchOptions?: unknown }).watchOptions)
      .toEqual({ startSec: 5, strict: true });
  });

  // The whole point of `strict`: without it the describe model receives a
  // placeholder note, answers "I have no video", and that lands as a SUCCESSFUL
  // metered answer. The tool must report the real reason instead.
  test('a strict resolution failure returns the REASON, not a confident wrong answer', async () => {
    const fake = fakeDescribeTransport({ failReason: 'file not found on disk' });
    const { tool, records } = makeTool({ media: [vid('clip.mp4')], fake });

    const out = await tool.execute({ question: 'what happens?' }, {});

    expect(out).toBe(
      'Video examination failed — file not found on disk. You can retry once, narrow to a clip ' +
        'with start/end, or process the file from files/ with the shell.',
    );
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('error');
  });

  test('an AUDIO failure says Audio, not Video', async () => {
    const fake = fakeDescribeTransport({ failReason: 'upload timed out' });
    const { tool } = makeTool({ media: [aud('call.mp3')], fake });

    expect(await tool.execute({ question: 'what is said?' }, {})).toMatch(
      /^Audio examination failed — upload timed out\./,
    );
  });

  test('a failure with no typed reason still fails honestly, in the tool\'s own words', async () => {
    const fake = fakeDescribeTransport({ fail: true });
    const { tool } = makeTool({ media: [vid('clip.mp4')], fake });

    expect(await tool.execute({ question: 'what happens?' }, {})).toContain(
      'the describe model did not return an answer',
    );
  });

  // A watch call is a full Gemini request over a video and does NOT reach the
  // per-turn spend ceiling (that gate counts main-loop rounds), so the count is
  // the bound.
  test(`the ${WATCH_CALLS_PER_TURN}th call is the last: past the cap, no side call and no record`, async () => {
    const fake = fakeDescribeTransport();
    const { tool, records } = makeTool({ media: [vid('clip.mp4')], fake });

    for (let i = 0; i < WATCH_CALLS_PER_TURN; i++) await tool.execute({ question: `q${i}` }, {});
    expect(fake.calls).toHaveLength(WATCH_CALLS_PER_TURN);
    expect(records).toHaveLength(WATCH_CALLS_PER_TURN);

    const capped = await tool.execute({ question: 'one more' }, {});

    expect(capped).toBe(
      `You have watched ${WATCH_CALLS_PER_TURN} times this turn — answer from what you have, ` +
        'or ask the user to narrow the question.',
    );
    // The cap is not a call that happened: nothing spent, nothing metered.
    expect(fake.calls).toHaveLength(WATCH_CALLS_PER_TURN);
    expect(records).toHaveLength(WATCH_CALLS_PER_TURN);
  });

  test('a skipped record does not count against the cap — nothing was spent', async () => {
    const fake = fakeDescribeTransport();
    const records: SideCallResult[] = Array.from({ length: WATCH_CALLS_PER_TURN }, () => ({
      text: '', status: 'skipped' as const, model: 'gemini-3.8-flash',
    }));
    const tool = makeWatchTool({
      getMedia: async () => [vid('clip.mp4')],
      transport: fake.transport,
      model: 'gemini-3.8-flash',
      records,
      workspaceDir: tmpdir(),
    });

    await tool.execute({ question: 'q' }, {});

    expect(fake.calls).toHaveLength(1);
  });

  // The materialize pass (stat + hash + a first-time Files API upload) runs INSIDE
  // callModel, so the upload is on this clock too — a 90s bound killed a large
  // first watch before the model ever saw the file.
  test('the call bound covers the upload as well as the model call', () => {
    expect(WATCH_CALL_TIMEOUT_MS).toBe(270_000);
  });

  test('an already-aborted run never calls the model, records skipped, and never throws', async () => {
    const ac = new AbortController();
    ac.abort();
    const fake = fakeDescribeTransport();
    const { tool, records } = makeTool({ media: [vid('clip.mp4')], fake, signal: ac.signal });

    const out = await tool.execute({ question: 'what happens?' }, {});

    expect(out).toMatch(/failed/i);
    expect(fake.calls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('skipped');
  });
});

// ── Injection: the one decision point ────────────────────────────────────────

describe('attachMediaWatch — the one decision point', () => {
  afterEach(() => {
    delete process.env.VIDEO_UNDERSTANDING_V1;
  });

  const video = () => ({ transport: fakeDescribeTransport().transport, model: 'gemini-3.8-flash' });
  const catalog = (): { name: string; description: string; parameters: unknown; execute: () => Promise<string> }[] => [
    { name: 'Bash', description: 'run', parameters: {}, execute: async () => '' },
  ];
  const attach = (over: Record<string, unknown>) =>
    attachMediaWatch({
      model: 'claude-opus-5',
      catalog: catalog() as never,
      journal: undefined,
      video: video(),
      records: [],
      workspaceDir: '/app/workspace',
      ...over,
    });

  test('flag off → the catalog comes back BY REFERENCE (the off wire is byte-identical)', () => {
    const base = catalog();
    expect(attach({ catalog: base as never })).toBe(base);
  });

  test('a model that takes video natively → the catalog comes back by reference', () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const base = catalog();
    expect(attach({ model: 'gemini-3.8-flash', catalog: base as never })).toBe(base);
  });

  test('no video lane injected → the catalog comes back by reference', () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const base = catalog();
    expect(attach({ catalog: base as never, video: undefined })).toBe(base);
  });

  test('flag on + a blind model + a lane → watch is appended LAST', () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const out = attach({});
    expect(out.map((t) => t.name)).toEqual(['Bash', 'watch']);
  });

  test('watch SURVIVES tool-search shaping while a deferrable neighbour is withheld', () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const base = [
      { name: 'Bash', description: 'run', parameters: {}, execute: async () => '' },
      { name: 'os_open', description: 'open an app', parameters: {}, execute: async () => '', deferrable: true },
    ];
    const shapedNames = shapeToolSearchTools({
      tools: attach({ catalog: base as never }),
      providerTools: attach({ catalog: base as never }).map((t) => t.name),
      state: createToolSearchState(),
      active: true,
    });
    // The deferrable neighbour is withheld until searched for; `watch` is not.
    expect(shapedNames).toContain('watch');
    expect(shapedNames).not.toContain('os_open');
  });

  // I1: `watch` sends the file to a describe model as video or audio, and the
  // attachment pointer line already sends every lane's PDF to the Read tool. An
  // unfiltered journal view contradicted it twice.
  test('a PDF-only task has NOTHING to watch — the document block is filtered out', async () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const fake = fakeDescribeTransport();
    const entries = [
      { payload: { type: 'user', blocks: [doc('deck.pdf')] } },
    ] as unknown as JournalEntry[];

    const watch = attachMediaWatch({
      model: 'claude-opus-5',
      catalog: [] as never,
      journal: { snapshot: async () => entries } as never,
      video: { transport: fake.transport, model: 'gemini-3.8-flash' },
      records: [],
      workspaceDir: '/app/workspace',
    }).find((t) => t.name === 'watch')!;

    expect(await watch.execute({ question: 'what does the deck say?' }, {}))
      .toBe('No video or audio is attached to this task yet — there is nothing to watch.');
    expect(fake.calls).toHaveLength(0);
  });

  test('a PDF attached AFTER a video never becomes the default target', async () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const fake = fakeDescribeTransport();
    const entries = [
      { payload: { type: 'user', blocks: [vid('demo.mp4')] } },   // turn 1
      { payload: { type: 'user', blocks: [{ type: 'text', text: 'and this' }] } },
      { payload: { type: 'user', blocks: [doc('deck.pdf')] } },   // turn 5 — newest media
    ] as unknown as JournalEntry[];

    const watch = attachMediaWatch({
      model: 'claude-opus-5',
      catalog: [] as never,
      journal: { snapshot: async () => entries } as never,
      video: { transport: fake.transport, model: 'gemini-3.8-flash' },
      records: [],
      workspaceDir: '/app/workspace',
    }).find((t) => t.name === 'watch')!;

    await watch.execute({ question: 'what happens?' }, {});

    // Newest-wins runs over the WATCHABLE blocks, so the video is still the target.
    expect(fake.pushed[0].media?.[0]?.filename).toBe('demo.mp4');
  });

  test("the attached tool reads the journal's media live, oldest→newest", async () => {
    process.env.VIDEO_UNDERSTANDING_V1 = '1';
    const fake = fakeDescribeTransport();
    const entries = [
      {
        payload: {
          type: 'user',
          blocks: [
            { type: 'text', text: 'here is the first take' },
            vid('take-1.mp4'),
          ],
        },
      },
      { payload: { type: 'user', blocks: [vid('take-2.mp4')] } },
    ] as unknown as JournalEntry[];

    const out = attachMediaWatch({
      model: 'claude-opus-5',
      catalog: [] as never,
      journal: { snapshot: async () => entries } as never,
      video: { transport: fake.transport, model: 'gemini-3.8-flash' },
      records: [],
      workspaceDir: '/app/workspace',
    });
    const watch = out.find((t) => t.name === 'watch')!;

    // No file arg → the NEWEST media block.
    await watch.execute({ question: 'what changed?' }, {});
    expect(fake.pushed[0].media?.[0]?.filename).toBe('take-2.mp4');

    // By the name the attachment note showed.
    await watch.execute({ question: 'and the first?', file: 'take-1.mp4' }, {});
    expect(fake.pushed[1].media?.[0]?.filename).toBe('take-1.mp4');
  });
});

// ── The folded usage row ─────────────────────────────────────────────────────

describe('mediaUsageEvent', () => {
  const ok = (inputTokens: number, outputTokens: number): SideCallResult => ({
    text: 'x',
    status: 'ok',
    usage: { inputTokens, outputTokens },
    model: 'gemini-3.8-flash',
  });

  test("folds a turn's watch calls into ONE vision-lane row with summed usage", () => {
    const ev = mediaUsageEvent([ok(4000, 20), ok(1000, 10)], 'task-1', 3);
    expect(ev).toMatchObject({
      kind: 'usage',
      lane: 'vision',
      laneStatus: 'ok',
      turnNumber: 3,
      model: 'gemini-3.8-flash',
      usage: { inputTokens: 5000, outputTokens: 30 },
    });
    expect((ev as { messageId: string }).messageId).toBe(deterministicUsageId('task-1', 3, 'vision'));
  });

  test('no attempted call → no row at all', () => {
    expect(mediaUsageEvent([], 'task-1', 3)).toBeUndefined();
    expect(
      mediaUsageEvent([{ text: '', status: 'skipped', model: 'gemini-3.8-flash' }], 'task-1', 3),
    ).toBeUndefined();
  });

  test('an all-failed turn reports zero tokens with laneStatus error', () => {
    const ev = mediaUsageEvent([{ text: '', status: 'error', model: 'gemini-3.8-flash' }], 'task-1', 3);
    expect(ev).toMatchObject({
      lane: 'vision',
      laneStatus: 'error',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
