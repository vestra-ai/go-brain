/**
 * WARM_CONNECTIONS_V1 (harness to nine, L4) — once the turn head's gates let a turn
 * through, it asks the transport to warm the connection to the turn's provider host,
 * BEFORE the turn's prompt and first request are built, so the TLS handshake overlaps
 * the work in between (hooks, journal, context projection, recall).
 *
 * The engine's side is one optional call: a transport without `prewarm` (the replay
 * transport, every test double) is untouched, and the flag lives in the transport's
 * HTTP layer, so the head itself is flag-free.
 */
import { describe, it, expect } from 'vitest';
import { openTurn } from '../native-run-turn.js';
import { createRunContext } from '../run-context.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { Transport } from '../transport.js';

function ctx(model: string, config: Partial<NativeConfig> = {}): HarnessContext<NativeConfig> {
  return {
    taskId: 't1', sessionId: 's1', cwd: '/tmp', model,
    signal: new AbortController().signal,
    config: config as NativeConfig,
  } as HarnessContext<NativeConfig>;
}

async function drive(c: HarnessContext<NativeConfig>, transport: Transport): Promise<string> {
  const gen = openTurn(c, c.config, transport, createRunContext('t1'), { text: 'hi' } as UserTurn, false, 0);
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value.stop;
}

const fakeTransport = (calls: string[]): Transport =>
  ({
    prewarm: (model: string) => calls.push(`prewarm:${model}`),
    buildModelUsage: () => {
      calls.push('buildModelUsage');
      return {};
    },
  }) as unknown as Transport;

describe('turn head prewarm (WARM_CONNECTIONS_V1)', () => {
  it('warm connections: the turn head prewarms the turn model\'s provider connection once', async () => {
    const calls: string[] = [];
    expect(await drive(ctx('claude-sonnet-5'), fakeTransport(calls))).toBe('proceed');
    expect(calls).toEqual(['prewarm:claude-sonnet-5']);
  });

  it('warm connections: a turn the budget gate ends opens no connection', async () => {
    const calls: string[] = [];
    const stop = await drive(ctx('gpt-5.6-luna', { maxBudgetUsd: 0 }), fakeTransport(calls));
    expect(stop).toBe('break');
    expect(calls).not.toContain('prewarm:gpt-5.6-luna');
  });

  it('warm connections: a transport without prewarm is untouched', async () => {
    const bare = { buildModelUsage: () => ({}) } as unknown as Transport;
    expect(await drive(ctx('claude-sonnet-5'), bare)).toBe('proceed');
  });
});
