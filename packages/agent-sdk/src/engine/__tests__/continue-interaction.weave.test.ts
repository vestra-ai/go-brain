/**
 * P3.3 (control-plane durable Weave pause) — materializeReExecute's `Weave` branch.
 *
 * An approved Weave-bound `tool_permission` must re-dispatch the WEAVE TOOL (the
 * whole script, with the one-shot leaf decision threaded as `execCtx.weaveResume`)
 * — NEVER the captured leaf detached at main scope (the fleet-C1 fall-through this
 * branch fixes). A DENY re-dispatches too (decision 'deny'), so the script
 * completes past the denied node. A residual re-pause settles ONLY the old row
 * (no tool_result), and a double-delivered continue is idempotent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalPayload, NewEntry } from '../../contract/journal.js';
import type { InteractionOutcome } from '../../contract/interaction.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import type { StatePort } from '../../ports/index.js';
import { materializeReExecute, REEXECUTE_STARTED_KEY } from '../continue-interaction.js';

const dir = join(tmpdir(), `weave-materialize-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });

const makeJournal = (name: string) => new Journal({
  taskId: 't', workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${name}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-07-05T00:00:00.000Z'),
});

const state: StatePort = {
  refreshConnectedApps: vi.fn(async () => {
    throw new Error('the Weave branch must never refresh the connector cache');
  }),
} as unknown as StatePort;

const WEAVE_INPUT = { meta: { name: 'w', goal: 'g', phases: [] }, budget: { usd: 10 }, script: 'return 1;' };

function directive(over: Record<string, unknown> = {}) {
  return {
    toolUseId: 'weave-tu',
    interactionId: 'i-weave',
    kind: 'tool_permission' as const,
    toolName: 'Weave',
    weavePending: { contentHash: 'abc123def456' },
    ...over,
  };
}

/** A scripted Weave RawToolOptions capturing every execute() invocation + its ctx. */
function scriptedWeaveTool(respond: (ctx: ToolExecuteContext) => string | Promise<string>) {
  const calls: Array<{ input: unknown; ctx: ToolExecuteContext }> = [];
  const tool: RawToolOptions = {
    name: 'Weave', description: '', parameters: undefined,
    execute: async (input: unknown, ctx: ToolExecuteContext) => {
      calls.push({ input, ctx });
      return respond(ctx);
    },
  };
  return { tool, calls };
}

async function readResults(journal: Journal): Promise<Array<{ toolUseId: string; text: string }>> {
  const out: Array<{ toolUseId: string; text: string }> = [];
  for await (const e of journal.read()) {
    if (e.payload.type === 'tool_result') {
      out.push({
        toolUseId: e.payload.toolUseId,
        text: (e.payload.blocks?.find((b: { type?: string }) => b.type === 'text') as { text?: string })?.text ?? '',
      });
    }
  }
  return out;
}

const allow: InteractionOutcome = { behavior: 'allow' };
const deny: InteractionOutcome = { behavior: 'deny', reason: 'user_declined' };
const allowHarness = { gateTool: async () => ({ decision: 'allow' as const }) };

function opts(journal: Journal, tool: RawToolOptions, outcome: InteractionOutcome, over: Record<string, unknown> = {}) {
  return {
    directive: directive(),
    tools: [tool],
    originalInput: WEAVE_INPUT,
    outcome,
    journal,
    taskId: 't',
    harness: allowHarness,
    state,
    ...over,
  } as never;
}

describe('P3.3 — materializeReExecute routes a Weave directive to the SCRIPT re-dispatch', () => {
  it('ALLOW: re-dispatches the Weave tool with the ORIGINAL script input + weaveResume {contentHash, allow}; settles its real output', async () => {
    const journal = makeJournal('allow');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => '{"value":[1,2],"spentUsd":0.02}');

    await materializeReExecute(opts(journal, tool, allow));

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(WEAVE_INPUT); // the SCRIPT, never the leaf
    expect(calls[0].ctx.weaveResume).toEqual({ contentHash: 'abc123def456', decision: 'allow' });
    expect(calls[0].ctx.toolCallId).toBe('weave-tu'); // bound to the WEAVE tool_use id
    const results = await readResults(journal);
    expect(results).toEqual([{ toolUseId: 'weave-tu', text: '{"value":[1,2],"spentUsd":0.02}' }]);
    expect(state.refreshConnectedApps).not.toHaveBeenCalled();
  });

  it('P3.5b: a marker carrying the paused-node identity threads nodeSpecHash + scopeId into weaveResume (the byte-stable re-entry seed key)', async () => {
    const journal = makeJournal('allow-seeded');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => '{"value":1,"spentUsd":0.01}');

    await materializeReExecute(opts(journal, tool, allow, {
      directive: directive({
        weavePending: { contentHash: 'abc123def456', nodeSpecHash: 'spec-hash-1', scopeId: 'node-scope-1' },
      }),
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.weaveResume).toEqual({
      contentHash: 'abc123def456', decision: 'allow',
      nodeSpecHash: 'spec-hash-1', scopeId: 'node-scope-1',
    });
  });

  it('P3.5b: an OLD marker (contentHash only) threads exactly the pre-P3.5b weaveResume — no phantom keys', async () => {
    const journal = makeJournal('allow-old-marker');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => '{"value":1,"spentUsd":0.01}');

    await materializeReExecute(opts(journal, tool, allow));

    expect(calls[0].ctx.weaveResume).toEqual({ contentHash: 'abc123def456', decision: 'allow' });
  });

  it('DENY: STILL re-dispatches the script, with weaveResume decision "deny" (the run completes past the denied node)', async () => {
    const journal = makeJournal('deny');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => '{"value":null,"dropped":[{"reason":"permission_denied"}]}');

    await materializeReExecute(opts(journal, tool, deny));

    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.weaveResume).toEqual({ contentHash: 'abc123def456', decision: 'deny' });
    const results = await readResults(journal);
    expect(results[0].text).toContain('permission_denied');
  });

  it('DENY without a weavePending hash (defensive): settles the structured deny prose, tool NOT dispatched', async () => {
    const journal = makeJournal('deny-nohash');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => 'unreachable');

    await materializeReExecute(opts(journal, tool, deny, { directive: directive({ weavePending: undefined }) }));

    expect(calls).toHaveLength(0);
    const results = await readResults(journal);
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain('DECLINED');
  });

  it('RE-PAUSE (hash mismatch on the fresh run): settles ONLY the old row — the Weave tool_use stays UNANSWERED', async () => {
    const journal = makeJournal('repause');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    // The re-dispatched tool re-paused: it marks pausedHalt through the substituted closure.
    const { tool } = scriptedWeaveTool((ctx) => {
      ctx.markPausedHalt?.();
      return '{"paused":true}';
    });

    await materializeReExecute(opts(journal, tool, allow));

    expect(await readResults(journal)).toHaveLength(0); // NO tool_result — re-suspend
    let resolved = 0;
    for await (const e of journal.read()) {
      if (e.payload.type === 'interaction' && e.payload.resolved === true) resolved += 1;
    }
    expect(resolved).toBe(1); // the OLD row settled exactly once
  });

  it('double-delivery is idempotent: a second materialize is a no-op (no second execution, no double bill)', async () => {
    const journal = makeJournal('idempotent');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    const { tool, calls } = scriptedWeaveTool(() => '{"value":1}');

    await materializeReExecute(opts(journal, tool, allow));
    await materializeReExecute(opts(journal, tool, allow));

    expect(calls).toHaveLength(1);
    expect(await readResults(journal)).toHaveLength(1);
  });
});

// Drill 5c67e1bb review: a re-execute that dispatched and then failed to settle is re-delivered;
// the intent journaled as the last write before the dispatch is what stops a second run.
describe('the Weave re-dispatch journals its intent, and never runs twice', () => {
  it('the intent is the last journal write before the script runs', async () => {
    const journal = makeJournal('intent');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    let last: JournalPayload | undefined;
    const { tool } = scriptedWeaveTool(async () => {
      for await (const e of journal.read()) last = e.payload;
      return '{"value":1,"spentUsd":0.01}';
    });
    await materializeReExecute(opts(journal, tool, allow));
    // Mutation: drop markReExecuteStarted in materializeWeaveReExecute -> the last write is the tool_use.
    expect(last).toEqual({ type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'weave-tu', interactionId: 'i-weave' } });
  });

  it('a delivery that finds the intent and no result settles execution_interrupted and does not re-run the script', async () => {
    const journal = makeJournal('interrupted');
    await journal.append(newEntry({ type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave', input: WEAVE_INPUT }));
    await journal.append(newEntry({ type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'weave-tu', interactionId: 'i-weave' } }));
    const { tool, calls } = scriptedWeaveTool(() => 'ran again (must not happen)');
    await materializeReExecute(opts(journal, tool, allow));
    expect(calls).toHaveLength(0);
    expect(await readResults(journal)).toEqual([{ toolUseId: 'weave-tu', text: JSON.stringify({ status: 'error', reason: 'execution_interrupted' }) }]);
  });
});
