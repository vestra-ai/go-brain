/**
 * Media turn-settle lock (CONTENT_ENGINE_V1) — the per-TURN reset, at run() level.
 *
 * round-engine.media-turn-settle.test.ts covers arming/enforcement/detection within a
 * turn. This suite proves case (c): the lock clears at the user-turn boundary so a NEW
 * user message is a clean slate. One full run() drives two user turns through the real
 * loop:
 *   Turn 1 — the model calls `media` (queued → lock arms), then calls a tool that is
 *            DENIED (the lock engaged mid-turn), then ends its turn.
 *   Turn 2 — the model calls the same tool and it EXECUTES (the lock was reset).
 * The tool's execute spy firing exactly once (turn 2 only) is the proof.
 */
import { it, expect, vi } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import { MEDIA_TURN_SETTLED_DENIAL } from '../round-engine.js';

const QUEUED_MEDIA = JSON.stringify({ jobs: [{ job_id: 'j1', status: 'queued' }], eta_s: 30 });

function done(stop = 'end_turn'): StreamEvent {
  return { kind: 'done', stopReason: stop, usage: { inputTokens: 0, outputTokens: 0 } as NormalizedUsage };
}
function toolUse(id: string, name: string): StreamEvent {
  return { kind: 'tool_use', toolUse: { id, name, input: {} } } as StreamEvent;
}

/** Serves scripted rounds in order across the whole run (idx never resets per turn). */
class ScriptTransport extends FakeTransport {
  private idx = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(): number {
    return 0.001; // tiny positive so the billing tripwire (0-spend warn) stays quiet
  }
}

/** A ToolHost exposing `media` (returns the queued envelope) + `Bash` (spy → 'ran'). */
class MediaToolHost implements ToolHost {
  constructor(private readonly bashExecute: RawToolOptions['execute']) {}
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const media: RawToolOptions = {
      name: 'media',
      description: 'media',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: async () => QUEUED_MEDIA,
    };
    const bash: RawToolOptions = {
      name: 'Bash',
      description: 'bash',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: this.bashExecute,
    };
    return { tools: [media, bash], onAuthHalt: async () => {} };
  }
}

function buildCtx(transport: FakeTransport, toolHost: ToolHost): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost,
    mediaTurnSettle: true,
  } as unknown as NativeConfig;
  return { taskId: 'tset', sessionId: 'sset', cwd: '/tmp', model: 'fake-model', signal: new AbortController().signal, config: cfg };
}

it('(c) the lock resets at the user-turn boundary: turn 2 runs the same tool the lock denied in turn 1', async () => {
  const bashExecute = vi.fn(async () => 'ran');
  // Turn 1: media (arms) → Bash b0 (DENIED) → text end.  Turn 2: Bash b1 (RUNS) → text end.
  const transport = new ScriptTransport([
    [toolUse('m1', 'media'), done('tool_use')],
    [toolUse('b0', 'Bash'), done('tool_use')],
    [{ kind: 'text', text: 'submitted' }, done('end_turn')],
    [toolUse('b1', 'Bash'), done('tool_use')],
    [{ kind: 'text', text: 'listed' }, done('end_turn')],
  ]);
  const ctx = buildCtx(transport, new MediaToolHost(bashExecute));
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'make an image' };
    yield { text: 'now list files' };
  })();

  const toolResults: Array<{ toolUseId: string; content: string }> = [];
  for await (const ev of harness.run(input, ctx)) {
    if (ev.kind === 'block' && (ev as { block: { type: string } }).block.type === 'tool_result') {
      const b = (ev as { block: { toolUseId: string; content: string } }).block;
      toolResults.push({ toolUseId: b.toolUseId, content: b.content });
    }
  }

  // Turn 1's Bash (b0) was denied by the armed lock; turn 2's Bash (b1) executed.
  expect(bashExecute).toHaveBeenCalledTimes(1);
  const b0 = toolResults.find((r) => r.toolUseId === 'b0');
  const b1 = toolResults.find((r) => r.toolUseId === 'b1');
  expect(b0?.content).toBe(MEDIA_TURN_SETTLED_DENIAL); // locked in turn 1
  // The denial carries the end-turn + do-work-next-turn guidance the model acts on.
  const denialMsg = (JSON.parse(b0!.content) as { message: string }).message;
  expect(denialMsg).toContain('finish it next turn after the confirmation');
  expect(denialMsg).toContain('do non-media work BEFORE requesting media');
  expect(b1?.content).toBe('ran'); // reset for turn 2
  // The media call itself ran (its queued envelope, not the denial).
  expect(toolResults.find((r) => r.toolUseId === 'm1')?.content).toBe(QUEUED_MEDIA);
});
