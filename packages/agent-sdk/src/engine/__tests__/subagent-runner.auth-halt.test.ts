import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { OnAuthHalt, RawToolOptions } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

/**
 * A Composio auth wall INSIDE a subagent fires the threaded `opts.onAuthHalt` (the
 * same deduped closure the top-level loop uses) bound to the REAL inner tool_use id,
 * then halts the nested loop via the existing pausedHalt bubble. Absent onAuthHalt
 * still halts (degrade-safe).
 */
function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => {
      (h as unknown[]).push({});
    },
    pushAssistant: (h) => {
      (h as unknown[]).push({});
    },
    pushToolResult: (h) => {
      (h as unknown[]).push({});
    },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
  };
  return t as Transport;
}

const allowHarness = {
  gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }),
};
const onPause = async (): Promise<string> => 'PAUSED';
const doneEv = (): StreamEvent => ({
  kind: 'done',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
});

/** A Composio meta-tool whose result carries an OAuth shortlink + a toolkit slug —
 *  exactly what classifyComposioToolResult flags as `auth_required`. */
const gmailAuthWall: RawToolOptions = {
  name: 'mcp__composio__GMAIL_FETCH_EMAILS',
  description: 'gmail',
  parameters: z.object({}),
  execute: async () => ({
    successful: false,
    toolkit: 'gmail',
    redirect_url: 'https://connect.composio.dev/link/abc123',
  }),
};

describe('runSubagentLoop — Composio auth wall inside a subagent', () => {
  it('fires the threaded onAuthHalt with the verdict + real tool_use id, then halts', async () => {
    const onAuthHalt = vi.fn<OnAuthHalt>(async () => {});
    const result = await runSubagentLoop({
      transport: makeScriptedTransport([
        [{ kind: 'tool_use', toolUse: { id: 'tu-auth-1', name: 'mcp__composio__GMAIL_FETCH_EMAILS', input: {} } }, doneEv()],
        [{ kind: 'text', text: 'never reached' }, doneEv()],
      ]),
      model: 'm',
      system: 's',
      userPrompt: 'check my inbox',
      tools: [gmailAuthWall],
      harness: allowHarness,
      onPause,
      onAuthHalt,
      maxTurns: 5,
      childId: 'child-auth-halt-test',
      onEvent: () => {},
    });

    expect(onAuthHalt).toHaveBeenCalledTimes(1);
    const [verdict, bind] = onAuthHalt.mock.calls[0]!;
    expect(verdict).toEqual({
      kind: 'auth_required',
      toolkit: 'gmail',
      authUrl: 'https://connect.composio.dev/link/abc123',
    });
    expect(bind).toEqual({ toolUseId: 'tu-auth-1', toolName: 'mcp__composio__GMAIL_FETCH_EMAILS' });
    // The nested loop STOPS at the wall and propagates the pause to the Agent tool.
    expect(result.pausedHalt).toBe(true);
  });

  it('still halts when no onAuthHalt is threaded (degrade-safe flag-OFF behavior)', async () => {
    const result = await runSubagentLoop({
      transport: makeScriptedTransport([
        [{ kind: 'tool_use', toolUse: { id: 'tu-auth-2', name: 'mcp__composio__GMAIL_FETCH_EMAILS', input: {} } }, doneEv()],
        [{ kind: 'text', text: 'never reached' }, doneEv()],
      ]),
      model: 'm',
      system: 's',
      userPrompt: 'check my inbox',
      tools: [gmailAuthWall],
      harness: allowHarness,
      onPause,
      maxTurns: 5,
      childId: 'child-auth-halt-absent',
      onEvent: () => {},
    });
    expect(result.pausedHalt).toBe(true);
  });
});
