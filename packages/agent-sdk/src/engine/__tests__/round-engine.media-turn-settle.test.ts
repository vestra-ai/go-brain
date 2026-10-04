/**
 * Media turn-settle lock (CONTENT_ENGINE_V1) — round-engine enforcement + detection.
 *
 * The hard layer above the #1751 soft directive: once a `media` tool call returns a
 * queued job, the round engine arms a per-turn lock (on RunContext) and DENIES every
 * further tool call for the rest of that turn with a fixed settled-denial result. This
 * suite drives `runOneRound` directly (the round-engine.core.test.ts pattern), sharing
 * one RunContext across rounds to model a multi-round turn, and covers:
 *   (a) queued media → the NEXT tool call is denied, not executed
 *   (b) all-ready media (no queued job) → NO lock; the next tool runs
 *   (d) two `media` calls in ONE block both execute (round-grained arming)
 *   (e) flag OFF → the flag is never armed and no tool is denied (byte-identical)
 *   (f) session B is NOT locked by session A's settle (per-session isolation)
 * (c) the per-turn RESET lives in run() and is covered in native-harness.media-turn-settle.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { createRunContext, type RunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, MEDIA_TURN_SETTLED_DENIAL, type RoundDeps, type RoundState } from '../round-engine.js';

function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';

const freshState = (): RoundState => ({
  assistantText: '',
  thinkingBlocks: [],
  toolUses: [],
  roundAppended: false,
  inToolBatch: false,
  stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 },
  lastUsageModel: 'm',
});

/** Main-caller deps (rc + dispatcher = the main union branch), with overridable pieces. */
function mainDeps(transport: Transport, over: Partial<RoundDeps> = {}): RoundDeps {
  return {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: {},
    transport,
    rc: createRunContext('t'),
    harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness),
    tools: [],
    providerTools: [],
    system: 'sys',
    onPause,
    onAuthHalt: undefined,
    requestedModel: 'm',
    cachePrefixHint: undefined,
    history: transport.emptyHistory(),
    turnBlocks: [],
    pendingTodoBlocks: [],
    ...over,
  } as RoundDeps;
}

async function drive(deps: RoundDeps, st: RoundState) {
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) {
    events.push(n.value);
    n = await gen.next();
  }
  return { events, round: n.value };
}

const doneEv = (stop = 'end_turn'): StreamEvent =>
  ({ kind: 'done', stopReason: stop, usage: { inputTokens: 1, outputTokens: 1 } });

const toolUseEv = (id: string, name: string, input: unknown = {}): StreamEvent =>
  ({ kind: 'tool_use', toolUse: { id, name, input } } as StreamEvent);

const QUEUED_MEDIA = JSON.stringify({
  jobs: [{ job_id: 'j1', status: 'queued', request_id: 'r1' }],
  eta_s: 30,
  model: 'flux',
});
const READY_MEDIA = JSON.stringify({
  jobs: [{ job_id: 'j1', status: 'ready', artifact: { url: 'https://x/y.png' } }],
  eta_s: 0,
  model: 'flux',
});

/** A `media` tool whose execute returns a scripted result string; execute is a spy. */
function mediaTool(resultText: string): RawToolOptions & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => resultText);
  return { name: 'media', description: 'media', parameters: z.object({}), execute } as never;
}
/** A generic tool (default Bash) whose execute returns 'ran'; execute is a spy. */
function ranTool(name = 'Bash'): RawToolOptions & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => 'ran');
  return { name, description: name, parameters: z.object({}), execute } as never;
}

describe('media turn-settle lock — round engine', () => {
  it('(a) a queued media result locks the turn: the NEXT tool call is denied, not executed', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), doneEv('tool_use')],
      [toolUseEv('b1', 'Bash'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool(QUEUED_MEDIA);
    const bash = ranTool();
    const cfg = { mediaTurnSettle: true };

    // Round 1 — media runs; the result is the real queued envelope; the lock arms.
    const r1 = await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(media.execute).toHaveBeenCalledTimes(1);
    expect(r1.round.results[0]).toMatchObject({ toolUseId: 'm1', text: QUEUED_MEDIA });
    expect(rc.mediaTurnSettled).toBe(true);

    // Round 2 — Bash is DENIED with the settled string, never dispatched.
    const r2 = await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(bash.execute).not.toHaveBeenCalled();
    expect(r2.round.results[0]).toEqual({ toolUseId: 'b1', text: MEDIA_TURN_SETTLED_DENIAL, isError: false });
    // The denial is a valid answered tool_result block (isError:false → not a red chip).
    const resultBlock = r2.events.find(
      (e) => e.kind === 'block' && (e as { block: { type: string } }).block.type === 'tool_result',
    ) as { block: { content: string; isError?: boolean } } | undefined;
    expect(resultBlock?.block.content).toBe(MEDIA_TURN_SETTLED_DENIAL);
    expect(resultBlock?.block.isError).toBe(false);
    // The exact bytes the model reads: the settled verdict + the end-turn / do-work-next-turn
    // guidance (the model is told to finish remaining work AFTER the confirmation, and to do
    // non-media work BEFORE requesting media in future turns).
    const parsed = JSON.parse(r2.round.results[0].text) as { denied: string; message: string };
    expect(parsed.denied).toBe('media_turn_settled');
    expect(parsed.message).toContain('end your turn');
    expect(parsed.message).toContain('finish it next turn after the confirmation');
    expect(parsed.message).toContain('do non-media work BEFORE requesting media');
  });

  it('(b) an all-ready media result does NOT lock: the next tool runs normally', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), doneEv('tool_use')],
      [toolUseEv('b1', 'Bash'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool(READY_MEDIA);
    const bash = ranTool();
    const cfg = { mediaTurnSettle: true };

    await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(rc.mediaTurnSettled).toBe(false);

    const r2 = await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect(r2.round.results[0]).toMatchObject({ toolUseId: 'b1', text: 'ran' });
  });

  it('(d) two media calls in the SAME block both execute (the lock is round-grained)', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), toolUseEv('m2', 'media'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool(QUEUED_MEDIA);
    const cfg = { mediaTurnSettle: true };

    const r1 = await drive(mainDeps(transport, { rc, cfg, tools: [media] }), freshState());
    // BOTH media calls dispatched (2 executes) and returned their real envelope — neither denied.
    expect(media.execute).toHaveBeenCalledTimes(2);
    expect(r1.round.results.map((r) => r.text)).toEqual([QUEUED_MEDIA, QUEUED_MEDIA]);
    // Only AFTER the batch does the lock arm (so a THIRD-round call would be denied).
    expect(rc.mediaTurnSettled).toBe(true);
  });

  it('(e) flag OFF → the lock is never armed and no tool is denied (byte-identical)', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), doneEv('tool_use')],
      [toolUseEv('b1', 'Bash'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool(QUEUED_MEDIA);
    const bash = ranTool();
    const cfg = {}; // mediaTurnSettle absent

    await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    // Detection is gated on the flag → the queued result never arms the lock.
    expect(rc.mediaTurnSettled).toBe(false);

    const r2 = await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect(r2.round.results[0]).toMatchObject({ toolUseId: 'b1', text: 'ran' });
  });

  it('(f) session B is not locked by session A settling (per-session isolation)', async () => {
    const cfg = { mediaTurnSettle: true };
    // Session A settles.
    const transportA = makeScriptedTransport([[toolUseEv('m1', 'media'), doneEv('tool_use')]]);
    const rcA = createRunContext('a');
    await drive(mainDeps(transportA, { rc: rcA, cfg, tools: [mediaTool(QUEUED_MEDIA)] }), freshState());
    expect(rcA.mediaTurnSettled).toBe(true);

    // Session B — a DIFFERENT RunContext — is unaffected: its Bash runs.
    const transportB = makeScriptedTransport([[toolUseEv('b1', 'Bash'), doneEv('tool_use')]]);
    const rcB: RunContext = createRunContext('b');
    const bash = ranTool();
    const rB = await drive(mainDeps(transportB, { rc: rcB, cfg, tools: [bash] }), freshState());
    expect(rcB.mediaTurnSettled).toBe(false);
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect(rB.round.results[0]).toMatchObject({ toolUseId: 'b1', text: 'ran' });
  });

  it('a non-JSON / non-queued media result fails open: no lock, the next tool runs', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), doneEv('tool_use')],
      [toolUseEv('b1', 'Bash'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool('provider unavailable — not json'); // parse throws → false
    const bash = ranTool();
    const cfg = { mediaTurnSettle: true };

    await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(rc.mediaTurnSettled).toBe(false);

    const r2 = await drive(mainDeps(transport, { rc, cfg, tools: [media, bash] }), freshState());
    expect(bash.execute).toHaveBeenCalledTimes(1);
    expect(r2.round.results[0]).toMatchObject({ toolUseId: 'b1', text: 'ran' });
  });

  it('once locked, a further media call is ALSO denied (no re-arming, no dispatch)', async () => {
    const transport = makeScriptedTransport([
      [toolUseEv('m1', 'media'), doneEv('tool_use')],
      [toolUseEv('m2', 'media'), doneEv('tool_use')],
    ]);
    const rc = createRunContext('t');
    const media = mediaTool(QUEUED_MEDIA);
    const cfg = { mediaTurnSettle: true };

    await drive(mainDeps(transport, { rc, cfg, tools: [media] }), freshState());
    expect(media.execute).toHaveBeenCalledTimes(1); // round 1 only

    const r2 = await drive(mainDeps(transport, { rc, cfg, tools: [media] }), freshState());
    expect(media.execute).toHaveBeenCalledTimes(1); // round 2 media denied — not dispatched
    expect(r2.round.results[0]).toEqual({ toolUseId: 'm2', text: MEDIA_TURN_SETTLED_DENIAL, isError: false });
  });
});
