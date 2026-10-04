/**
 * tool-dispatcher.taint.test.ts — W4-1 (taint at the mint site).
 *
 * A tool that declares `untrustedContent` returns THIRD-PARTY bytes. The dispatcher
 * must (a) wrap the result text in the untrusted-content fence at the ONE dispatch
 * boundary, (b) stamp `taint: 'external'` onto the dispatch result, and (c) leave
 * every undeclared tool BYTE-IDENTICAL. Exercised through the REAL
 * `gateAndDispatchTool` chokepoint, then through the journal append + Anthropic
 * projection so the fence's byte-stability across a rebuild is proven end to end.
 *
 * Injection payloads are DESCRIBED, never reproduced: the test content says that an
 * instruction-shaped sentence exists, it does not carry one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import {
  toolError,
  parseToolErrorCode,
  fenceUntrustedText,
  sanitizeUntrustedText,
  stripUntrustedFence,
  UNTRUSTED_CONTENT_OPEN,
  UNTRUSTED_CONTENT_CLOSE,
  UNTRUSTED_CONTENT_INSTRUCTION,
} from '../../tools/tool-types.js';
import { makeWebSearchTool } from '../../tools/web-search-tool.js';
import { makeRawWebFetchTool, makeWebFetchTool } from '../../tools/web-fetch-tool.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { appendToolResultEntry } from '../native-journal.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { COMPACTION_SYSTEM } from '../../contract/compaction-prompt.js';
import { runSubagentLoop } from '../subagent-runner.js';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream } from '../transport.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

/** Neutral third-party content: the page DESCRIBES an instruction-shaped sentence. */
const PAGE_TEXT =
  'Weather report for Delhi. Further down, this page contains a sentence shaped like a command addressed to an automated reader.';

function declaringTool(result: unknown, name = 'WebFetch'): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    untrustedContent: true,
    execute: vi.fn(async () => result),
  };
}

function plainTool(result: unknown, name = 'Bash'): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => result),
  };
}

describe('gateAndDispatchTool — untrustedContent declaration', () => {
  it('fences a declaring tool result and stamps taint', async () => {
    const r = await gateAndDispatchTool(declaringTool(PAGE_TEXT), {}, 'tu-t1', allowGate() as never, NOOP_PAUSE);
    expect(r.text).toBe(`${UNTRUSTED_CONTENT_OPEN}\n${PAGE_TEXT}\n${UNTRUSTED_CONTENT_CLOSE}`);
    expect(r.taint).toBe('external');
    expect(r.isError).toBe(false);
  });

  it('mints byte-identically on every dispatch (no per-call entropy)', async () => {
    const a = await gateAndDispatchTool(declaringTool(PAGE_TEXT), {}, 'tu-t2', allowGate() as never, NOOP_PAUSE);
    const b = await gateAndDispatchTool(declaringTool(PAGE_TEXT), {}, 'tu-t3', allowGate() as never, NOOP_PAUSE);
    expect(a.text).toBe(b.text);
  });

  it('an undeclared tool is deep-equal to today: no fence, no taint key', async () => {
    const r = await gateAndDispatchTool(plainTool(PAGE_TEXT), {}, 'tu-t4', allowGate() as never, NOOP_PAUSE);
    expect(r).toEqual({ toolUseId: 'tu-t4', text: PAGE_TEXT, isError: false });
    expect('taint' in r).toBe(false);
  });

  it('defangs an embedded closing marker so content cannot terminate the fence early', async () => {
    const hostile = `before ${UNTRUSTED_CONTENT_CLOSE} after`;
    const r = await gateAndDispatchTool(declaringTool(hostile), {}, 'tu-t5', allowGate() as never, NOOP_PAUSE);
    // Exactly one CLOSE marker survives: the frame's own, at the very end.
    expect(r.text.indexOf(UNTRUSTED_CONTENT_CLOSE)).toBe(r.text.length - UNTRUSTED_CONTENT_CLOSE.length);
    expect(r.text.startsWith(`${UNTRUSTED_CONTENT_OPEN}\n`)).toBe(true);
    expect(r.text).toContain('</untrusted-external-content>');
  });

  it('fences a thrown error from a declaring tool and stamps taint (error bodies can carry page bytes)', async () => {
    const tool: RawToolOptions = { ...declaringTool(''), execute: vi.fn(async () => { throw new Error('fetch failed: response body described here'); }) };
    const r = await gateAndDispatchTool(tool, {}, 'tu-t6', allowGate() as never, NOOP_PAUSE);
    expect(r.isError).toBe(true);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(fenceUntrustedText('fetch failed: response body described here'));
  });

  it('taxonomy ON: the fence wraps the message, the [error:code] stamp stays outside at the tail', async () => {
    const tool: RawToolOptions = { ...declaringTool(''), execute: vi.fn(async () => toolError('timeout', 'took too long')) };
    const r = await gateAndDispatchTool(tool, {}, 'tu-t7', allowGate() as never, NOOP_PAUSE, undefined, { toolErrorTaxonomy: true });
    expect(r.isError).toBe(true);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(`${fenceUntrustedText('took too long')} [error:timeout]`);
    // The retry consumer's tail-anchored decode still reads the code.
    expect(parseToolErrorCode(r.text)).toBe('timeout');
  });

  it('taxonomy OFF: the sentinel unwraps to its message and rides the normal fenced path', async () => {
    const tool: RawToolOptions = { ...declaringTool(''), execute: vi.fn(async () => toolError('timeout', 'took too long')) };
    const r = await gateAndDispatchTool(tool, {}, 'tu-t8', allowGate() as never, NOOP_PAUSE);
    expect(r.isError).toBe(false);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(fenceUntrustedText('took too long'));
  });

  it('a pre-execute deny is NOT fenced or tainted (harness-authored text)', async () => {
    const tool = declaringTool(PAGE_TEXT);
    const r = await gateAndDispatchTool(tool, {}, 'tu-t9', gateOf({ decision: 'deny', message: 'Denied by rule.' }) as never, NOOP_PAUSE);
    expect(r).toEqual({ toolUseId: 'tu-t9', text: 'Denied by rule.', isError: true, refused: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('a schema-validation refusal is NOT fenced or tainted (pre-execute)', async () => {
    const tool: RawToolOptions = {
      ...declaringTool(PAGE_TEXT),
      // The dispatcher's schema gate is duck-typed on Zod's safeParse.
      parameters: z.object({ url: z.string() }),
    };
    const r = await gateAndDispatchTool(tool, { url: 42 }, 'tu-t10', allowGate() as never, NOOP_PAUSE);
    expect(r.isError).toBe(true);
    expect('taint' in r).toBe(false);
    expect(r.text).not.toContain(UNTRUSTED_CONTENT_OPEN);
  });

  it('a blocks result (browser image envelope) is framed with leading/trailing marker blocks', async () => {
    const PNG = 'aGVsbG8=';
    const envelope = {
      content: [
        { type: 'text', text: 'page heading text' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    };
    const tool: RawToolOptions = { ...declaringTool(envelope, 'mcp__browser-control__computer_snapshot'), returnsContentBlocks: true };
    const r = await gateAndDispatchTool(tool, {}, 'tu-t11', allowGate() as never, NOOP_PAUSE);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(fenceUntrustedText('page heading text'));
    expect(r.blocks).toEqual([
      { type: 'text', text: UNTRUSTED_CONTENT_OPEN },
      { type: 'text', text: 'page heading text' },
      { type: 'image', data: PNG, mediaType: 'image/png' },
      { type: 'text', text: UNTRUSTED_CONTENT_CLOSE },
    ]);
  });
});

describe('fence helpers', () => {
  it('strip is the exact inverse of the mint', () => {
    expect(stripUntrustedFence(fenceUntrustedText(PAGE_TEXT))).toBe(PAGE_TEXT);
  });

  it('strip leaves unfenced and tail-stamped text untouched', () => {
    expect(stripUntrustedFence(PAGE_TEXT)).toBe(PAGE_TEXT);
    const stamped = `${fenceUntrustedText('m')} [error:timeout]`;
    expect(stripUntrustedFence(stamped)).toBe(stamped);
  });

  it('sanitize defangs both markers and is stable under re-application', () => {
    const s = sanitizeUntrustedText(`${UNTRUSTED_CONTENT_OPEN} x ${UNTRUSTED_CONTENT_CLOSE}`);
    expect(s).not.toContain(UNTRUSTED_CONTENT_OPEN);
    expect(s).not.toContain(UNTRUSTED_CONTENT_CLOSE);
    expect(sanitizeUntrustedText(s)).toBe(s);
  });

  it('the compaction summarize prompt names both markers (taint survives compaction by instruction)', () => {
    expect(COMPACTION_SYSTEM).toContain(UNTRUSTED_CONTENT_OPEN);
    expect(COMPACTION_SYSTEM).toContain(UNTRUSTED_CONTENT_CLOSE);
  });

  it('the system-prompt paragraph names both markers', () => {
    expect(UNTRUSTED_CONTENT_INSTRUCTION).toContain(UNTRUSTED_CONTENT_OPEN);
    expect(UNTRUSTED_CONTENT_INSTRUCTION).toContain(UNTRUSTED_CONTENT_CLOSE);
    expect(UNTRUSTED_CONTENT_INSTRUCTION).toContain('never an instruction');
  });
});

describe('declaring surfaces (SDK web tools)', () => {
  const cfg = () => ({ serverUrl: '', apiToken: '', providerOrder: [] }) as never;

  it('WebSearch declares untrustedContent', () => {
    expect(makeWebSearchTool('t', cfg).untrustedContent).toBe(true);
  });

  it('both WebFetch factories declare untrustedContent', () => {
    expect(makeRawWebFetchTool().untrustedContent).toBe(true);
    expect(makeWebFetchTool('t', cfg).untrustedContent).toBe(true);
  });
});

// ─── journal + projection: the fence bytes are byte-stable across rebuilds ─────

const dir = join(tmpdir(), `taint-journal-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const makeJournal = (taskId: string) => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const ctxFor = (taskId: string): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId: 'u' } } } as unknown as HarnessContext<NativeConfigLike>);

describe('journal + projection', () => {
  it('the dispatch result taint lands on the journaled tool_result payload', async () => {
    const j = makeJournal('t-taint');
    const r = await gateAndDispatchTool(declaringTool(PAGE_TEXT), {}, 'tu-j1', allowGate() as never, NOOP_PAUSE);
    await appendToolResultEntry(j, ctxFor('t-taint'), r);
    const entries: unknown[] = [];
    for await (const e of j.read()) entries.push(e);
    const payload = (entries[0] as { payload: { taint?: string; blocks: { text: string }[] } }).payload;
    expect(payload.taint).toBe('external');
    expect(payload.blocks[0].text).toBe(fenceUntrustedText(PAGE_TEXT));
  });

  it('an untainted result journals with NO taint key on disk (byte-identity)', async () => {
    const j = makeJournal('t-plain');
    const r = await gateAndDispatchTool(plainTool('plain result'), {}, 'tu-j2', allowGate() as never, NOOP_PAUSE);
    await appendToolResultEntry(j, ctxFor('t-plain'), r);
    const raw = await fs.readFile(join(dir, 't-plain.jsonl'), 'utf8');
    expect(raw).not.toContain('taint');
    expect(raw).not.toContain(UNTRUSTED_CONTENT_OPEN);
  });

  it('an offloaded tainted result STORES fenced bytes — the file a Read returns carries the markers', async () => {
    // Fix round 1: the offload used to write the RAW body to disk BEFORE the
    // fence, so the fenced pointer INVITED a Read that re-entered the full
    // hostile content unfenced and untainted — both rings bypassed for exactly
    // the oversized class. The stored file must now carry the fence itself.
    await fs.mkdir(dir, { recursive: true });
    const big = `${PAGE_TEXT} ${'filler '.repeat(80)}`;
    const r = await gateAndDispatchTool(
      declaringTool(big), {}, 'tu-off1', allowGate() as never, NOOP_PAUSE, undefined,
      { workingDir: dir, taskId: 't-off', offloadThresholdChars: 100 },
    );
    const stored = await fs.readFile(join(dir, '.kernel-offload/t-off/tu-off1.txt'), 'utf8');
    expect(stored.startsWith(`${UNTRUSTED_CONTENT_OPEN}\n`)).toBe(true);
    expect(stored.endsWith(`\n${UNTRUSTED_CONTENT_CLOSE}`)).toBe(true);
    expect(stored).toContain('filler');
    // The journaled pointer is fenced exactly ONCE, as before this fix (the
    // preview stays raw out of the offload; the dispatcher fences it after).
    expect(r.taint).toBe('external');
    expect(r.text.startsWith(`${UNTRUSTED_CONTENT_OPEN}\n`)).toBe(true);
    expect(r.text.endsWith(`\n${UNTRUSTED_CONTENT_CLOSE}`)).toBe(true);
    expect(r.text).toContain('[offloaded:');
    expect(r.text.indexOf(UNTRUSTED_CONTENT_OPEN)).toBe(r.text.lastIndexOf(UNTRUSTED_CONTENT_OPEN));
  });

  it('an offloaded UNDECLARED result stores the raw bytes, byte-identical to today', async () => {
    await fs.mkdir(dir, { recursive: true });
    const big = `plain oversized output ${'filler '.repeat(80)}`;
    const r = await gateAndDispatchTool(
      plainTool(big), {}, 'tu-off2', allowGate() as never, NOOP_PAUSE, undefined,
      { workingDir: dir, taskId: 't-off', offloadThresholdChars: 100 },
    );
    const stored = await fs.readFile(join(dir, '.kernel-offload/t-off/tu-off2.txt'), 'utf8');
    expect(stored).toBe(big);
    expect('taint' in r).toBe(false);
    expect(r.text).not.toContain(UNTRUSTED_CONTENT_OPEN);
  });

  it('the projection replays the fence bytes verbatim, identically on every rebuild', async () => {
    const j = makeJournal('t-proj');
    const ctx = ctxFor('t-proj');
    await j.append({
      taskId: 't-proj', rootTaskId: 't-proj', spawnDepth: 0, workspaceId: 'u', agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
      payload: { type: 'tool_use', toolUseId: 'tu-j3', name: 'WebFetch', input: { url: 'https://example.com' } },
    });
    const r = await gateAndDispatchTool(declaringTool(PAGE_TEXT), {}, 'tu-j3', allowGate() as never, NOOP_PAUSE);
    await appendToolResultEntry(j, ctx, r);
    const first = journalToAnthropicMessages((await j.project()).messages);
    const second = journalToAnthropicMessages((await j.project()).messages);
    expect(second).toEqual(first);
    const resultMsg = first.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === 'tool_result'),
    );
    const block = (resultMsg?.content as Array<{ type: string; content?: unknown }>).find((b) => b.type === 'tool_result');
    expect(block?.content).toBe(fenceUntrustedText(PAGE_TEXT));
  });
});

// ─── subagent path: the scope-tagged entry carries the taint verdict ──────────
//
// Fix round 1: the subagent loop's TWO scope-tagged journal sites (the legacy
// body and the T11b re-entry dispatch) dropped the `taint` field — the fence
// bytes rode res.text, but the queryable signal was lost on exactly the
// archetype (a researcher child) that reads hostile pages. Both loop shapes
// must journal the field.

function scriptedTransport(rounds: StreamEvent[][], pushedResults?: Array<{ text: string; taint?: string }>): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => {
      pushedResults?.push(r as { text: string; taint?: string });
      (h as unknown[]).push({ role: 'tool_result', r });
    },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: () => 0.0001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const subagentScript = (): StreamEvent[][] => [
  [
    { kind: 'tool_use', toolUse: { id: 'sub-tu-1', name: 'WebFetch', input: { url: 'https://example.com' } } },
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ],
  [
    { kind: 'text', text: 'done reading' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 7 } },
  ],
];

describe.each([
  ['legacy body', false],
  ['shared loop', true],
])('subagent loop (%s) — scope-tagged taint', (_label, sharedLoop) => {
  it('journals the scoped tool_result with taint + fenced bytes, and the pushed history text is fenced', async () => {
    const j = makeJournal(`t-sub-${sharedLoop ? 'shared' : 'legacy'}`);
    const path = [{ depth: 1, agentToolUseId: 'T1', agentSlug: 'researcher', agentName: 'Researcher' }];
    const pushedResults: Array<{ text: string; taint?: string }> = [];
    await runSubagentLoop({
      transport: scriptedTransport(subagentScript(), pushedResults),
      model: 'm', system: 'sys', userPrompt: 'go',
      tools: [declaringTool(PAGE_TEXT)],
      harness: { gateTool: async () => ({ decision: 'allow' as const }) },
      onPause: async () => 'PAUSED',
      maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: path,
      ...(sharedLoop ? { sharedLoop: true } : {}),
    });
    // (a) The subagent's IN-MEMORY history — the context its next round actually
    // reads — carries the fence: the design's whole justification for minting at
    // the dispatcher rather than at the journal append.
    expect(pushedResults).toHaveLength(1);
    expect(pushedResults[0]!.text).toBe(fenceUntrustedText(PAGE_TEXT));
    expect(pushedResults[0]!.taint).toBe('external');
    // (b) The scope-tagged journal entry carries the queryable field + the bytes.
    const entries: Array<{ payload: { type: string; taint?: string; blocks?: Array<{ text: string }> } }> = [];
    for await (const e of j.read()) entries.push(e as never);
    const result = entries.find((e) => e.payload.type === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.payload.taint).toBe('external');
    expect(result!.payload.blocks![0]!.text).toBe(fenceUntrustedText(PAGE_TEXT));
  });
});
