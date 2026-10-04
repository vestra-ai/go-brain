/**
 * The structured-output epilogue sends the SAME system prompt as the turn's rounds.
 *
 * Under TOOL_DEFER_WIDE_V1 the engine appends the deferred-tool index to the prologue's
 * system prompt (tool-search-session.ts). Every call of the turn must send that one
 * string: the rounds, compaction and the memory sweep already did, and the epilogue used
 * to re-read `cfg.systemPrompt`, so every outputFormat task sent a second prompt (a
 * prefix-cache miss and a [CACHE_PROMPT_MUTATED] warning). With the flag off the two
 * strings are the same, so the epilogue's bytes are unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type NormalizedUsage, type ProviderStream, type StreamEvent } from '../transport.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { OutputFormat } from '../../contract/output-format.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { OnAuthHalt, RawToolOptions } from '../../tools/tool-types.js';

const SYSTEM = 'You are the agent.';
const SCHEMA: OutputFormat = {
  type: 'json_schema',
  name: 'ans',
  schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] },
};

const done = (): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } as NormalizedUsage });

/** Serves the main round, then the epilogue's constrained call; FakeTransport records each `system`. */
class ScriptTransport extends FakeTransport {
  private idx = 0;
  private readonly rounds: StreamEvent[][] = [
    [{ kind: 'text', text: 'answer' }, done()],
    [{ kind: 'text', text: '{"answer":"hi"}' }, done()],
  ];
  constructor() {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): ProviderStream {
    super.callModel(p);
    return this.rounds[Math.min(this.idx++, this.rounds.length - 1)];
  }
}

/** One resident tool and one the wide policy defers, so the index is non-empty. */
class WideToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool = (name: string, extra: Partial<RawToolOptions> = {}): RawToolOptions => ({
      name,
      description: `${name} does one thing.`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'ok',
      ...extra,
    });
    return { tools: [tool('Bash'), tool('Weave', { deferrableWide: true })], onAuthHalt: async () => {} };
  }
}

async function systemsSent(): Promise<string[]> {
  const transport = new ScriptTransport();
  const cfg = {
    onAttached: () => {},
    maxTurns: 5,
    transport,
    toolHost: new WideToolHost(),
    abilities: [],
    systemPrompt: SYSTEM,
    outputFormat: SCHEMA,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 't1', sessionId: 's1', cwd: '/tmp', model: 'deepseek-v4-flash', signal: new AbortController().signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'go' }; })();
  for await (const _ of new NativeHarness().run(input, ctx)) { /* drain */ }
  return transport.systems;
}

const FLAGS = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'] as const;
const saved = new Map(FLAGS.map((f) => [f, process.env[f]]));
afterEach(() => {
  for (const [f, v] of saved) {
    if (v === undefined) delete process.env[f];
    else process.env[f] = v;
  }
});

describe('structured-output epilogue: one system prompt for every call of the turn', () => {
  it('wide on: the epilogue sends the prologue system, index included, so the turn has one distinct prompt', async () => {
    process.env.TOOL_SEARCH_V1 = 'true';
    process.env.TOOL_DEFER_WIDE_V1 = 'true';
    const systems = await systemsSent();
    expect(systems).toHaveLength(2); // the round, then the constrained call
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('# Additional tools (load before use)');
  });

  it('wide off: every call sends the configured system prompt byte for byte, as before', async () => {
    for (const on of [[], ['TOOL_SEARCH_V1'], ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1']] as const) {
      for (const f of FLAGS) delete process.env[f];
      for (const f of on) process.env[f] = 'true';
      const systems = await systemsSent();
      expect(systems, `[${on.join(', ')}]`).toEqual([SYSTEM, SYSTEM]);
    }
  });
});
