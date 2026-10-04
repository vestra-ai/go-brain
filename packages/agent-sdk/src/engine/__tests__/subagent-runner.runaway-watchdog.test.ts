/**
 * Runaway watchdog — loop integration (both nested-loop bodies).
 *
 * RED pin (pre-guard): a tool that always fails with identical args spun the
 * nested loop for the FULL maxTurns budget (30 rounds here; the 2026-08-20
 * incident ran 45+ minutes at ~5 calls/sec) — no trip, no steer, no report.
 *
 * With the guard: trip at exactly SUBAGENT_RUNAWAY_IDENTICAL_LIMIT consecutive
 * identical failures, the terminal directive is injected once as a user
 * message, every post-trip tool call is REFUSED at the gate with the same
 * terminal text (never executed), and the run force-finishes within
 * SUBAGENT_RUNAWAY_GRACE_ROUNDS extra rounds — returning a well-formed
 * SubagentRunResult through the loop's normal return path (the Agent tool's
 * existing report rail).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';
import {
  SUBAGENT_RUNAWAY_IDENTICAL_LIMIT,
  SUBAGENT_RUNAWAY_GRACE_ROUNDS,
  SUBAGENT_RUNAWAY_DIRECTIVE,
} from '../subagent-watchdog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type FakeHistoryEntry = { role: string; text?: string; blocks?: unknown; r?: unknown };

/** Scripted transport (golden-test shape) that CAPTURES pushed user text. */
function makeScriptedTransport(rounds: StreamEvent[][]): { t: Transport; calls: () => number } {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h, text) => { (h as unknown as FakeHistoryEntry[]).push({ role: 'user', text }); },
    pushAssistant: (h, blocks) => { (h as unknown as FakeHistoryEntry[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown as FakeHistoryEntry[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return { t: t as Transport, calls: () => i };
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';

/** A tool that always throws — the dispatcher maps the throw to isError:true. */
function failingTool(): { tool: RawToolOptions; executions: () => number } {
  let n = 0;
  return {
    tool: {
      name: 'web_probe',
      description: 'probe',
      parameters: z.object({ q: z.string() }),
      execute: async () => {
        n += 1;
        throw new Error('vendor says 402: payment required');
      },
    },
    executions: () => n,
  };
}

/** One model round: a single tool_use of `web_probe` with the given args. */
const toolRound = (id: string, input: unknown): StreamEvent[] => [
  { kind: 'tool_use', toolUse: { id, name: 'web_probe', input } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];

/** `count` rounds of the SAME failing call (fresh tool_use id each round, as live). */
const identicalSpinScript = (count: number): StreamEvent[][] =>
  Array.from({ length: count }, (_, k) => toolRound(`s${k}`, { q: 'x' }));

const N = SUBAGENT_RUNAWAY_IDENTICAL_LIMIT;
const GRACE = SUBAGENT_RUNAWAY_GRACE_ROUNDS;

async function runSpin(sharedLoop: boolean) {
  const { tool, executions } = failingTool();
  const { t, calls } = makeScriptedTransport(identicalSpinScript(30));
  const events: SubagentEvent[] = [];
  const result = await runSubagentLoop({
    transport: t,
    model: 'm', system: 'sys', userPrompt: 'go', tools: [tool],
    harness: allowHarness, onPause, maxTurns: 30, childId: 'c',
    onEvent: (ev) => events.push(ev),
    ...(sharedLoop ? { sharedLoop: true, retry: { maxAttempts: 1, backoffMs: 1 } } : {}),
  });
  return { result, events, executions, calls, history: undefined };
}

for (const sharedLoop of [false, true]) {
  const label = sharedLoop ? 'shared round core' : 'legacy body';

  describe(`runaway watchdog — always-failing identical call (${label})`, () => {
    it(`trips at exactly ${N} identical failures, refuses further calls, force-finishes within grace`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result, events, executions, calls } = await runSpin(sharedLoop);

      // The failing operation executed EXACTLY N times — never again after the trip.
      expect(executions()).toBe(N);

      // Force-finish within grace: trip round + at most GRACE post-directive rounds.
      expect(calls()).toBe(N + GRACE);

      // Post-trip tool calls were refused with the terminal directive text.
      const refusals = events.filter(
        (e) => e.kind === 'tool_result' && e.result === SUBAGENT_RUNAWAY_DIRECTIVE,
      );
      expect(refusals.length).toBe(GRACE);
      for (const r of refusals) expect((r as { isError: boolean }).isError).toBe(true);

      // One structured WARN fired at the trip.
      const warnLines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway'));
      expect(warnLines.length).toBe(1);
      expect(warnLines[0]).toContain('tool=web_probe');

      // The run still returns a WELL-FORMED result through the normal path.
      expect(result.pausedHalt).toBe(false);
      expect(result.childCost.childId).toBe('c');
      expect(typeof result.text).toBe('string');
    });

    it('injects the terminal directive exactly once as a user message', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { tool } = failingTool();
      const { t } = makeScriptedTransport(identicalSpinScript(30));
      const seen: FakeHistoryEntry[] = [];
      const origPushUser = t.pushUser.bind(t);
      t.pushUser = (h, text) => { seen.push({ role: 'user', text }); origPushUser(h, text); };
      await runSubagentLoop({
        transport: t,
        model: 'm', system: 'sys', userPrompt: 'go', tools: [tool],
        harness: allowHarness, onPause, maxTurns: 30, childId: 'c', onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true, retry: { maxAttempts: 1, backoffMs: 1 } } : {}),
      });
      const directives = seen.filter((e) => e.text === SUBAGENT_RUNAWAY_DIRECTIVE);
      expect(directives.length).toBe(1);
    });

    it('a success resets the window — 7 identical failures, a success, 7 more: no trip', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let n = 0;
      const flaky: RawToolOptions = {
        name: 'web_probe',
        description: 'probe',
        parameters: z.object({ q: z.string() }),
        execute: async (input) => {
          n += 1;
          if ((input as { q: string }).q === 'ok') return 'fine';
          throw new Error('still failing');
        },
      };
      const script = [
        ...Array.from({ length: N - 1 }, (_, k) => toolRound(`a${k}`, { q: 'x' })),
        toolRound('mid', { q: 'ok' }),
        ...Array.from({ length: N - 1 }, (_, k) => toolRound(`b${k}`, { q: 'x' })),
        [
          { kind: 'text', text: 'wrapped up' } as StreamEvent,
          { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent,
        ],
      ];
      const { t } = makeScriptedTransport(script);
      const result = await runSubagentLoop({
        transport: t,
        model: 'm', system: 'sys', userPrompt: 'go', tools: [flaky],
        harness: allowHarness, onPause, maxTurns: 40, childId: 'c', onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true, retry: { maxAttempts: 1, backoffMs: 1 } } : {}),
      });
      expect(n).toBe(2 * (N - 1) + 1); // every call executed — no refusals
      expect(result.text).toBe('wrapped up');
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(0);
    });

    it('identical SUCCESSFUL polling never trips', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let n = 0;
      const poll: RawToolOptions = {
        name: 'poll_status',
        description: 'poll',
        parameters: z.object({ job: z.string() }),
        execute: async () => { n += 1; return `pending (check ${n})`; },
      };
      const script = [
        ...Array.from({ length: 12 }, (_, k) => ([
          { kind: 'tool_use', toolUse: { id: `p${k}`, name: 'poll_status', input: { job: 'j1' } } },
          { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
        ] as StreamEvent[])),
        [
          { kind: 'text', text: 'job done' } as StreamEvent,
          { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent,
        ],
      ];
      const { t } = makeScriptedTransport(script);
      const result = await runSubagentLoop({
        transport: t,
        model: 'm', system: 'sys', userPrompt: 'go', tools: [poll],
        harness: allowHarness, onPause, maxTurns: 20, childId: 'c', onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true, retry: { maxAttempts: 1, backoffMs: 1 } } : {}),
      });
      expect(n).toBe(12);
      expect(result.text).toBe('job done');
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(0);
    });

    it('different-args failures do not trip the identical ceiling', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { tool, executions } = failingTool();
      // N+3 failing rounds, every one with DIFFERENT args (< the 25 total-failure budget).
      const script = [
        ...Array.from({ length: N + 3 }, (_, k) => toolRound(`d${k}`, { q: `distinct-${k}` })),
        [
          { kind: 'text', text: 'gave up cleanly' } as StreamEvent,
          { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent,
        ],
      ];
      const { t } = makeScriptedTransport(script);
      const result = await runSubagentLoop({
        transport: t,
        model: 'm', system: 'sys', userPrompt: 'go', tools: [tool],
        harness: allowHarness, onPause, maxTurns: 30, childId: 'c', onEvent: () => {},
        ...(sharedLoop ? { sharedLoop: true, retry: { maxAttempts: 1, backoffMs: 1 } } : {}),
      });
      expect(executions()).toBe(N + 3);
      expect(result.text).toBe('gave up cleanly');
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(0);
    });
  });
}

describe('runaway watchdog — instance isolation', () => {
  it('two CONCURRENT runs keep independent counters (each trips at exactly N)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = failingTool();
    const b = failingTool();
    const ta = makeScriptedTransport(identicalSpinScript(30));
    const tb = makeScriptedTransport(identicalSpinScript(30));
    const opts = (tool: RawToolOptions, t: Transport, childId: string) => ({
      transport: t,
      model: 'm', system: 'sys', userPrompt: 'go', tools: [tool],
      harness: allowHarness, onPause, maxTurns: 30, childId, onEvent: () => {},
    });
    const [ra, rb] = await Promise.all([
      runSubagentLoop(opts(a.tool, ta.t, 'child-a')),
      runSubagentLoop(opts(b.tool, tb.t, 'child-b')),
    ]);
    // Shared counters would trip one run early (< N executions) — each must reach N alone.
    expect(a.executions()).toBe(SUBAGENT_RUNAWAY_IDENTICAL_LIMIT);
    expect(b.executions()).toBe(SUBAGENT_RUNAWAY_IDENTICAL_LIMIT);
    expect(ra.childCost.childId).toBe('child-a');
    expect(rb.childCost.childId).toBe('child-b');
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('runaway')).length).toBe(2);
  });
});
