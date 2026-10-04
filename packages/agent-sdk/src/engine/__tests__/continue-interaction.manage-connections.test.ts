/**
 * Founder trace 2026-08-26 (prod task 2d8debb0, Reddit): the model called
 * COMPOSIO_MANAGE_CONNECTIONS, the result carried a connect link, an auth ask was
 * minted, the user connected — and the continue RE-EXECUTED the connect tool. Composio
 * minted a fresh link, the post-scan read it as a new wall, this path settled
 * connector_not_ready, the model re-called, and the now-active roster turned the third
 * link into an "add another account" ask. Two cards, one connection, a furious user.
 *
 * Contract pinned here: after an ALLOW resolve, the connection-management tool is
 * NEVER re-executed — the resolve is the result. Every other Composio tool still
 * re-executes exactly as before (that generality is what the F3 roster test relies on).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { InteractionOutcome } from '../../contract/interaction.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { InMemoryStatePort } from '../../ports/state-port.js';
import { COMPOSIO_MANAGE_CONNECTIONS_TOOL } from '../../policy/engine-constants.js';
import { materializeReExecute, type ReExecuteDirective } from '../continue-interaction.js';

const dir = join(tmpdir(), `resume-manage-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const fast = { baseDelayMs: 0 };
const SEND_TOOL = 'mcp__composio__GMAIL_SEND_EMAIL';
const CONNECT_INPUT = { toolkits: [{ name: 'reddit', action: 'add' }], session_id: 'sink' };
const SHORTLINK_RESULT = JSON.stringify({ toolkit: 'reddit', auth_url: 'https://connect.composio.dev/link/lk_again' });

const make = () => new Journal({
  taskId: 't', workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${Math.random()}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-08-26T00:00:00.000Z'),
});
const ap = (j: Journal, payload: JournalPayload) => j.append({ ...base, payload });
async function readAll(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}
async function seedPaused(j: Journal, toolName: string, input: unknown): Promise<void> {
  await ap(j, { type: 'tool_use', toolUseId: 'tu1', name: toolName, input });
  await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'composio_auth', toolUseId: 'tu1', toolName } });
}
const directive = (toolName: string): ReExecuteDirective => ({ toolUseId: 'tu1', interactionId: 'i1', kind: 'composio_auth', toolName });
function recordingTool(name: string, out: string): RawToolOptions & { calls: number } {
  const t = { calls: 0, name, description: 'd', parameters: {}, execute: async () => { t.calls++; return out; } };
  return t as unknown as RawToolOptions & { calls: number };
}
/** The settled tool_result for `id`, flattened: journal results carry `blocks`, not `text`. */
function toolResultFor(es: JournalEntry[], id: string): { text: string; isError: boolean } | undefined {
  const p = es.map((e) => e.payload).find((x) => x.type === 'tool_result' && x.toolUseId === id) as
    { blocks?: Array<{ text?: string }>; isError: boolean } | undefined;
  if (!p) return undefined;
  return { text: p.blocks?.map((b) => b.text ?? '').join('') ?? '', isError: p.isError };
}

describe('resume path — the connection-management tool is settled, never re-executed', () => {
  it('ALLOW on COMPOSIO_MANAGE_CONNECTIONS settles a structured success and does not call the tool', async () => {
    const j = make();
    await seedPaused(j, COMPOSIO_MANAGE_CONNECTIONS_TOOL, CONNECT_INPUT);
    const tool = recordingTool(COMPOSIO_MANAGE_CONNECTIONS_TOOL, SHORTLINK_RESULT);
    const allow: InteractionOutcome = { behavior: 'allow', updatedInput: { toolkit: 'reddit', connected: true } };

    await materializeReExecute({
      directive: directive(COMPOSIO_MANAGE_CONNECTIONS_TOOL), tools: [tool], originalInput: CONNECT_INPUT, outcome: allow,
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
    });

    expect(tool.calls).toBe(0);
    const res = toolResultFor(await readAll(j), 'tu1');
    expect(res?.isError).toBe(false);
    expect(JSON.parse(res!.text)).toMatchObject({ status: 'ok', toolkit: 'reddit', connected: true });
    // The interaction is settled too — nothing left pending for a sweep to re-resolve.
    const resolved = (await readAll(j)).some((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean }).resolved);
    expect(resolved).toBe(true);
  });

  it('names the connector from the tool input when the resolve carries no stamp', async () => {
    const j = make();
    await seedPaused(j, COMPOSIO_MANAGE_CONNECTIONS_TOOL, CONNECT_INPUT);
    await materializeReExecute({
      directive: directive(COMPOSIO_MANAGE_CONNECTIONS_TOOL), tools: [recordingTool(COMPOSIO_MANAGE_CONNECTIONS_TOOL, SHORTLINK_RESULT)],
      originalInput: CONNECT_INPUT, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
    });
    expect(JSON.parse(toolResultFor(await readAll(j), 'tu1')!.text)).toMatchObject({ toolkit: 'reddit', connected: true });
  });

  it('every other Composio tool still re-executes after the resolve (the action IS the result)', async () => {
    const j = make();
    await seedPaused(j, SEND_TOOL, { to: 'x' });
    const tool = recordingTool(SEND_TOOL, 'sent');
    await materializeReExecute({
      directive: directive(SEND_TOOL), tools: [tool], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
    });
    expect(tool.calls).toBe(1);
    expect(toolResultFor(await readAll(j), 'tu1')).toMatchObject({ text: 'sent', isError: false });
  });
});
