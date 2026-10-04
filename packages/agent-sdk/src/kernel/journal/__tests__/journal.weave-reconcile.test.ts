/**
 * P3.3 (control-plane durable Weave pause) — reconcileInteractions routing for a
 * pause BOUND TO A `Weave` tool_use.
 *
 * The P3.1 pause records the LEAF call's name on the PENDING marker (the approval
 * card must show the real gated action, e.g. `Bash`), so the pre-P3.3 fall-through
 * routed an approved Weave-bound `tool_permission` to the LEAF re-execute — running
 * the captured Bash DETACHED at main scope and settling raw stdout as the WEAVE
 * result (fleet C1). The kernel now routes on the JOURNALED tool_use name:
 *  - ALLOW *and* DENY on a Weave-bound pause become a re_execute directive with
 *    toolName 'Weave' + the marker's `weavePending` (the one-shot contentHash) —
 *    a deny must ALSO re-dispatch the script so it completes PAST the denied node
 *    (mirroring the T11b scope-tagged-deny precedent), never materializing the
 *    deny prose as the Weave tool_result.
 *  - A non-Weave deny keeps materializing in place (control — byte-identical).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalPayload, NewEntry } from '../../../contract/journal.js';
import type { InteractionOutcome } from '../../../contract/interaction.js';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';

const dir = join(tmpdir(), `weave-reconcile-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });

const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-07-05T00:00:00.000Z'),
});

/** Seed: an unanswered Weave tool_use + its pending marker (leaf name + weavePending). */
async function seedWeavePause(j: Journal): Promise<void> {
  await j.append(newEntry({ type: 'user', blocks: [{ type: 'text', text: 'go' } as never] }));
  await j.append(newEntry({
    type: 'tool_use', toolUseId: 'weave-tu', name: 'Weave',
    input: { meta: { name: 'w', goal: 'g', phases: [] }, budget: { usd: 10 }, script: 'return 1;' },
  }));
  await j.append(newEntry({
    type: 'interaction', interactionId: 'i-weave', resolved: false,
    data: {
      kind: 'tool_permission', toolUseId: 'weave-tu', toolName: 'Bash',
      weavePending: { contentHash: 'abc123def456' },
    },
  }));
}

const allow: InteractionOutcome = { behavior: 'allow' };
const deny: InteractionOutcome = { behavior: 'deny', reason: 'user_declined' };

describe('P3.3 — reconcileInteractions routes a Weave-bound pause to a Weave re_execute directive', () => {
  it('ALLOW: directive carries toolName "Weave" (NOT the marker leaf name) + the weavePending contentHash', async () => {
    const j = make('t-allow');
    await seedWeavePause(j);
    const { reExecute } = await j.reconcileInteractions(async (id) => (id === 'i-weave' ? allow : null));
    expect(reExecute).toHaveLength(1);
    expect(reExecute[0]).toMatchObject({
      toolUseId: 'weave-tu',
      interactionId: 'i-weave',
      kind: 'tool_permission',
      toolName: 'Weave',
      weavePending: { contentHash: 'abc123def456' },
    });
    // No in-place tool_result was materialized — the sandbox re-dispatches the script.
    const results: string[] = [];
    for await (const e of j.read()) {
      if (e.payload.type === 'tool_result') results.push(e.payload.toolUseId);
    }
    expect(results).toHaveLength(0);
  });

  it('DENY: STILL a re_execute directive (the script must complete past the denied node) — never the deny prose as the Weave tool_result', async () => {
    const j = make('t-deny');
    await seedWeavePause(j);
    const { reExecute } = await j.reconcileInteractions(async (id) => (id === 'i-weave' ? deny : null));
    expect(reExecute).toHaveLength(1);
    expect(reExecute[0]).toMatchObject({
      toolUseId: 'weave-tu', toolName: 'Weave', weavePending: { contentHash: 'abc123def456' },
    });
    const results: string[] = [];
    for await (const e of j.read()) {
      if (e.payload.type === 'tool_result') results.push(e.payload.toolUseId);
    }
    expect(results).toHaveLength(0);
  });

  it('control: a NON-Weave deny keeps materializing the deny message in place (byte-identical routing)', async () => {
    const j = make('t-control');
    await j.append(newEntry({ type: 'user', blocks: [{ type: 'text', text: 'go' } as never] }));
    await j.append(newEntry({ type: 'tool_use', toolUseId: 'bash-tu', name: 'Bash', input: { command: 'x' } }));
    await j.append(newEntry({
      type: 'interaction', interactionId: 'i-bash', resolved: false,
      data: { kind: 'tool_permission', toolUseId: 'bash-tu', toolName: 'Bash' },
    }));
    const { reExecute } = await j.reconcileInteractions(async (id) => (id === 'i-bash' ? deny : null));
    expect(reExecute).toHaveLength(0);
    let denied = '';
    for await (const e of j.read()) {
      if (e.payload.type === 'tool_result' && e.payload.toolUseId === 'bash-tu') {
        denied = (e.payload.blocks?.find((b: { type?: string }) => b.type === 'text') as { text?: string })?.text ?? '';
      }
    }
    expect(denied).toContain('DECLINED');
  });
});
