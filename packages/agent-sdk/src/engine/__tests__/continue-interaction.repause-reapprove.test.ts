/**
 * Re-review of #4113: the re-execute intent is keyed on the tool_use AND the interaction.
 *
 * A Weave or a path-less `Agent` re-execute can RE-PAUSE by design: the re-run hits a fresh
 * gate and binds a FRESH interaction to the SAME tool_use (settleInteractionOnly). Approving
 * that fresh interaction is a new approval, so the tool must run again. Keyed on the tool_use
 * alone, the intent the FIRST approval journaled read as "this already ran", and the second
 * approval settled execution_interrupted: a Weave with two gated nodes failed at its second
 * approval. A retry of the SAME continue reuses its interactionId, so it is still refused.
 *
 * Driven through the REAL orchestrateContinue / materializeReExecute over a REAL journal; the
 * re-pause is journaled by the real journalSubagentPause, as the continue's onPause does.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import { orchestrateContinue } from '../continue-orchestrator.js';
import { REEXECUTE_STARTED_KEY } from '../continue-interaction.js';
import { journalSubagentPause } from '../native-journal.js';

const dir = join(tmpdir(), `repause-reapprove-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' as const }, timestamp: '' };
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
const makeJournal = (name: string) => new Journal({
  taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${name}.jsonl`)),
  mirror: new InMemorySessionStore(), clock: sequentialClock('2026-10-01T00:00:00.000Z'),
});
const state = { refreshConnectedApps: async () => {} } as unknown as StatePort;
const allow: InteractionOutcome = { behavior: 'allow' };
const allowHarness = { gateTool: async () => ({ decision: 'allow' as const }) };

async function results(j: Journal): Promise<string[]> {
  const out: string[] = [];
  for await (const e of j.read()) {
    if (e.payload.type === 'tool_result') out.push((e.payload.blocks?.find((b: { type?: string }) => b.type === 'text') as { text?: string })?.text ?? '');
  }
  return out;
}

describe.each(['Weave', 'Agent'] as const)('%s: approve, re-pause, approve again', (toolName) => {
  const input = toolName === 'Weave' ? { script: 'return 1;' } : { subagent_type: 'x', prompt: 'p' };
  const leaf = toolName === 'Weave' ? 'Bash' : toolName;
  const weavePending = (h: string) => (toolName === 'Weave' ? { contentHash: h } : undefined);

  async function setup(name: string) {
    const j = makeJournal(`${toolName}-${name}`);
    await j.append(newEntry({ type: 'tool_use', toolUseId: 'tu', name: toolName, input }));
    await journalSubagentPause(j, 't', 'i1', 'tool_permission', 'tu', leaf, '', undefined, weavePending('h1'));
    let runs = 0;
    const tool: RawToolOptions = {
      name: toolName, description: '', parameters: undefined,
      execute: async (_i: unknown, ctx: ToolExecuteContext) => {
        runs += 1;
        if (runs === 1) {
          // The first approved run hits a fresh gate: a NEW interaction on the SAME tool_use.
          await journalSubagentPause(j, 't', 'i2', 'tool_permission', 'tu', leaf, '', undefined, weavePending('h2'));
          ctx.markPausedHalt?.();
          return 'paused';
        }
        return 'REAL OUTPUT';
      },
    };
    const deliver = (interactionId: string) => orchestrateContinue({
      taskId: 't', journal: j, state,
      payload: { taskId: 't', interactionId, toolUseId: 'tu', kind: 'tool_permission', outcome: allow },
      buildToolset: async () => ({ tools: [tool], harness: allowHarness }),
      drive: async () => {},
    });
    return { j, deliver, runs: () => runs };
  }

  it('the second approval runs the work: once per approval, and its real output settles', async () => {
    const { j, deliver, runs } = await setup('twice');
    expect((await deliver('i1')).reSuspended).toBe(true);
    const second = await deliver('i2');
    // Mutation: key the intent on the tool_use alone -> runs 1, and the result is execution_interrupted.
    expect(runs()).toBe(2);
    expect(second.drove).toBe(true);
    expect(await results(j)).toEqual(['REAL OUTPUT']);
  });

  it('a retry of the SAME approval that found its own intent is still refused: no extra run', async () => {
    const { j, deliver, runs } = await setup('retry');
    expect((await deliver('i1')).reSuspended).toBe(true);
    // The second approval's run started (its intent is journaled) and died before it settled.
    await j.append(newEntry({ type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'tu', interactionId: 'i2' } }));
    await deliver('i2');
    expect(runs()).toBe(1);
    expect(await results(j)).toEqual([JSON.stringify({ status: 'error', reason: 'execution_interrupted' })]);
  });
});
