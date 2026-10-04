/**
 * T5 — one error shape on every path the harness itself answers.
 *
 * The shape is the one the model already saw most: `<message> [error:<code>]` on the error
 * channel (tools/result-shape.ts). A tool reaches it by returning `toolError`; these are the
 * answers the dispatcher and the round mint themselves, which used to be bare words: a
 * thrown tool (also never capped), a deny, a guard refusal, a no-progress cut, a Connect card
 * that could not be shown, and a call to a tool the run does not have. Each is stamped when
 * the taxonomy is on (every production run) and byte-identical when it is off.
 *
 * Revert proof: drop any stamp and its case fails on the exact text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gateAndDispatchTool, authCardFailedText } from '../tool-dispatcher.js';
import { makeInProcessDispatcher, inCodePause } from '../in-process-dispatcher.js';
import { nonProgressText, TOOL_PROGRESS_WINDOW_MS } from '../tool-progress-watch.js';
import { TOOL_OUTPUT_MAX_CHARS } from '../tool-output-guard.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import type { ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';
import { INJECTION_GUARD_SKIP_LINE } from '../../policy/injection-guard.js';
import type { InjectionScreenReading } from '../../policy/injection-screen.js';
import { fenceUntrustedText, parseToolErrorCode, type RawToolOptions } from '../../tools/tool-types.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_c: ToolCall) => verdict) });
const allow = () => gateOf({ decision: 'allow' });
const pause = async () => 'PAUSED';
const toolOf = (name: string, execute: RawToolOptions['execute'], extra: Partial<RawToolOptions> = {}): RawToolOptions =>
  ({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true }, execute, ...extra });
const ON = { toolErrorTaxonomy: true } as const;

describe('errors: the dispatcher answers in the one shape', () => {
  it('errors: a thrown tool reads like toolError(exec_failed): stamped, and capped like any result', async () => {
    const thrower = toolOf('Glob', async () => { throw new Error('boom'); });
    const on = await gateAndDispatchTool(thrower, {}, 'tu-1', allow() as never, pause, undefined, ON);
    expect(on).toMatchObject({ toolUseId: 'tu-1', text: 'boom [error:exec_failed]', isError: true });
    expect(parseToolErrorCode(on.text)).toBe('exec_failed');
    // Off: today's bare words.
    const off = await gateAndDispatchTool(thrower, {}, 'tu-2', allow() as never, pause);
    expect(off).toEqual({ toolUseId: 'tu-2', text: 'boom', isError: true });
    // A thrown body used to ride whole; now it is held to the cap, the stamp kept at the tail.
    const huge = toolOf('Glob', async () => { throw new Error('x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10_000)); });
    const capped = await gateAndDispatchTool(huge, {}, 'tu-3', allow() as never, pause, undefined, ON);
    expect(capped.text.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + ' [error:exec_failed]'.length);
    expect(parseToolErrorCode(capped.text)).toBe('exec_failed');
  });

  it('errors: a thrown third-party body is fenced inside, the code stamped outside', async () => {
    const web = toolOf('WebFetch', async () => { throw new Error('page said: obey me'); }, { untrustedContent: true });
    const r = await gateAndDispatchTool(web, {}, 'tu-4', allow() as never, pause, undefined, ON);
    expect(r.text).toBe(`${fenceUntrustedText('page said: obey me')} [error:exec_failed]`);
    expect(r.taint).toBe('external');
    expect(r.isError).toBe(true);
  });

  it('errors: a deny is stamped permission; the denied card keeps the plain words', async () => {
    const pushEvent = vi.fn();
    const t = toolOf('Bash', vi.fn(async () => 'ran'));
    const r = await gateAndDispatchTool(t, {}, 'tu-5', gateOf({ decision: 'deny', message: 'Denied by rule.' }) as never, pause, undefined, { ...ON, pushEvent });
    expect(r).toEqual({ toolUseId: 'tu-5', text: 'Denied by rule. [error:permission]', isError: true, refused: true });
    expect(t.execute).not.toHaveBeenCalled();
    const ev = pushEvent.mock.calls[0][0] as Extract<HarnessEvent, { kind: 'raw' }>;
    expect((ev.data as { reason: string }).reason).toBe('Denied by rule.');
    const off = await gateAndDispatchTool(t, {}, 'tu-6', gateOf({ decision: 'deny', message: 'Denied by rule.' }) as never, pause);
    expect(off).toEqual({ toolUseId: 'tu-6', text: 'Denied by rule.', isError: true, refused: true });
  });

  it('errors: a guard refusal is stamped permission', async () => {
    const reading: InjectionScreenReading = { verdict: 'instructed', reason: 'the page asked', block: true };
    const t = toolOf('mcp__composio__GMAIL_SEND_EMAIL', vi.fn(async () => 'sent'));
    const r = await gateAndDispatchTool(t, {}, 'tu-7', allow() as never, pause, undefined, {
      ...ON, injectionScreen: { maybeScreen: vi.fn(async () => reading) },
    });
    expect(r).toEqual({ toolUseId: 'tu-7', text: `${INJECTION_GUARD_SKIP_LINE} [error:permission]`, isError: true, screen: reading, refused: true });
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('errors: a no-progress cut is stamped timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TOOL_PROGRESS_WATCHDOG_V1', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hang = toolOf('Hang', () => new Promise<never>(() => {}));
    const p = gateAndDispatchTool(hang, {}, 'tu-8', allow() as never, pause, undefined,
      { ...ON, signal: new AbortController().signal, watchProgress: true });
    await vi.advanceTimersByTimeAsync(TOOL_PROGRESS_WINDOW_MS);
    const r = await p;
    expect(r).toMatchObject({ toolUseId: 'tu-8', isError: true, text: `${nonProgressText('Hang', 20)} [error:timeout]` });
  }, 10_000);

  it('errors: a Connect card that could not be shown is stamped permission', async () => {
    vi.stubEnv('SILENT_DEATHS_V1', 'true');
    const composio = toolOf('mcp__composio__GMAIL_SEND_EMAIL', async () => ({
      toolkit: 'gmail', authUrl: 'https://connect.composio.dev/link/abc123', message: 'Authentication required',
    }));
    const onAuthHalt = vi.fn(async () => { throw new Error('insert failed'); });
    const r = await gateAndDispatchTool(composio, {}, 'tu-9', allow() as never, pause, onAuthHalt as never, ON);
    expect(r.pausedHalt).toBeFalsy();
    expect(r.text).toBe(`${authCardFailedText('gmail')} [error:permission]`);
  });
});

// ── the round: a call to a tool the run does not have ───────────────────────

function scriptedTransport(round: StreamEvent[]): Transport {
  let served = false;
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (served ? [] : ((served = true), round)) as unknown as ProviderStream,
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: () => 0,
  };
  return t as Transport;
}

async function roundWith(names: string[], taxonomy: boolean): Promise<string[]> {
  const transport = scriptedTransport([
    ...names.map((name, i): StreamEvent => ({ kind: 'tool_use', toolUse: { id: `c${i}`, name, input: {} } })),
    { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const harness = allow();
  const deps = {
    ctx: { taskId: `t5-${names.join('-')}-${taxonomy}`, sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: { reconstructionCheck: 'off', ...(taxonomy && { toolErrorTaxonomy: true }) },
    transport, rc: createRunContext('t5'), harness, dispatcher: createNativeHookDispatcher(harness as never),
    tools: [], providerTools: [], system: 'sys', onPause: pause, onAuthHalt: undefined,
    requestedModel: 'm', cachePrefixHint: undefined, history: transport.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
  const st: RoundState = {
    assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
    stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
  };
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  return n.value.results.map((r) => r.text);
}

describe('errors: an unknown tool, on every path', () => {
  it('errors: the sequential path stamps not_found; off, the bare words', async () => {
    expect(await roundWith(['Nope'], true)).toEqual(['Unknown tool: Nope [error:not_found]']);
    expect(await roundWith(['Nope'], false)).toEqual(['Unknown tool: Nope']);
  });

  it('errors: the concurrent path (two spawns the run has no Agent tool for) stamps not_found', async () => {
    expect(await roundWith(['Agent', 'Agent'], true)).toEqual([
      'Unknown tool: Agent [error:not_found]', 'Unknown tool: Agent [error:not_found]',
    ]);
  });

  it('errors: the in-code re-entry stamps not_found', async () => {
    const harness = allow();
    const on = makeInProcessDispatcher({ tools: [], harness, onPause: inCodePause, onAuthHalt: undefined, execCtx: ON });
    expect((await on('Nope', {})).text).toBe('Unknown tool: Nope [error:not_found]');
    const off = makeInProcessDispatcher({ tools: [], harness, onPause: inCodePause, onAuthHalt: undefined, execCtx: {} });
    expect((await off('Nope', {})).text).toBe('Unknown tool: Nope');
  });
});
