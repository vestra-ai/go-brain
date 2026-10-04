/**
 * An approved tool whose own run raises a pause (ruling of 3 Oct: a company's function tool waits for the
 * customer's yes, then its call goes to the company's code and waits on the answer).
 *
 * The approval re-executes the held call once under the one-shot allow (materializeLeafReExecute). A client tool's
 * run raises a `custom` pause of renderer tool_call through the continue's real onPause, binding a FRESH interaction
 * to the same tool_use, and marks its pause. Before this, the leaf path never opted in to markPausedHalt, so the
 * pause sentinel settled as the tool's result: the model read "paused" as the call's answer, and the company's real
 * result later found the call already answered. Now only the approval settles, the continue re-suspends on the
 * fresh interaction, and the company's answer becomes the result.
 *
 * Driven through the REAL orchestrateContinue / materializeReExecute over a REAL journal; the fresh pause is
 * journaled by the real journalSubagentPause, as the continue's onPause does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalPayload, NewEntry } from '../../contract/journal.js';
import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import type { GateResult } from '../../contract/harness.js';
import type { StatePort } from '../../ports/index.js';
import { orchestrateContinue } from '../continue-orchestrator.js';
import { journalSubagentPause } from '../native-journal.js';

const dir = join(tmpdir(), `leaf-repause-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' as const }, timestamp: '' };
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
const makeJournal = (name: string) => new Journal({
  taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${name}.jsonl`)),
  mirror: new InMemorySessionStore(), clock: sequentialClock('2026-10-03T00:00:00.000Z'),
});
const state = { refreshConnectedApps: async () => {} } as unknown as StatePort;
const allowHarness = { gateTool: async () => ({ decision: 'allow' as const }) };
const INPUT = { rental_id: 'R-1042' };

async function resultEntries(j: Journal): Promise<Array<{ text: string; isError: boolean }>> {
  const out: Array<{ text: string; isError: boolean }> = [];
  for await (const e of j.read()) {
    if (e.payload.type === 'tool_result') {
      const text = (e.payload.blocks ?? []).map((b) => (b as { text?: string }).text ?? '').join('');
      out.push({ text, isError: e.payload.isError === true });
    }
  }
  return out;
}

async function results(j: Journal): Promise<string[]> {
  return (await resultEntries(j)).map((r) => r.text);
}

type Harness = { gateTool: () => Promise<GateResult> };

async function setup(name: string, opts: { raisesItsOwnPause: boolean; toolName?: string; run?: () => Promise<unknown>; harness?: Harness }) {
  const toolName = opts.toolName ?? 'extend_rental';
  const j = makeJournal(name);
  await j.append(newEntry({ type: 'tool_use', toolUseId: 'tu', name: toolName, input: INPUT }));
  // The gate asked first: the approval is the pending interaction on the call.
  await journalSubagentPause(j, 't', 'approval', 'tool_permission', 'tu', toolName);
  let runs = 0;
  const tool: RawToolOptions = {
    name: toolName, description: '', parameters: undefined,
    execute: async (_i: unknown, ctx: ToolExecuteContext) => {
      runs += 1;
      if (!opts.raisesItsOwnPause) return opts.run ? opts.run() : 'ran';
      // The client tool's run: the call goes to the company's code as a custom pause bound to the SAME tool_use.
      await journalSubagentPause(j, 't', 'tool_call', 'custom', 'tu', toolName);
      ctx.markPausedHalt?.();
      return 'PAUSED';
    },
  } as RawToolOptions;
  const deliver = (interactionId: string, kind: InteractionKind, outcome: InteractionOutcome) => orchestrateContinue({
    taskId: 't', journal: j, state,
    payload: { taskId: 't', interactionId, toolUseId: 'tu', kind, outcome },
    buildToolset: async () => ({ tools: [tool], harness: opts.harness ?? allowHarness }),
    drive: async () => {},
  });
  return { j, deliver, runs: () => runs };
}

describe('an approved call whose run raises its own pause', () => {
  it("the yes sends the call to the company and waits: the company's answer, never the pause, is the result", async () => {
    const { j, deliver, runs } = await setup('yes', { raisesItsOwnPause: true });
    const approved = await deliver('approval', 'tool_permission', { behavior: 'allow' });
    // Today's code settled "PAUSED" as the result and drove on.
    expect(approved.reSuspended).toBe(true);
    expect(approved.drove).toBe(false);
    expect(runs()).toBe(1);
    expect(await results(j)).toEqual([]);

    const answered = await deliver('tool_call', 'custom', { behavior: 'allow', updatedInput: { output: '{"ok":true}' } });
    expect(answered.drove).toBe(true);
    expect(runs()).toBe(1);
    expect(await results(j)).toEqual([JSON.stringify({ output: '{"ok":true}' })]);
  });

  it('a no never runs the call', async () => {
    const { j, deliver, runs } = await setup('no', { raisesItsOwnPause: true });
    const declined = await deliver('approval', 'tool_permission', { behavior: 'deny', reason: 'user_declined', message: 'The customer said no.' });
    expect(runs()).toBe(0);
    expect(declined.drove).toBe(true);
    const [result] = await results(j);
    expect(result).toContain('The customer said no.');
  });

  it('a tool that runs to an answer still settles it as before', async () => {
    const { j, deliver } = await setup('plain', { raisesItsOwnPause: false });
    expect((await deliver('approval', 'tool_permission', { behavior: 'allow' })).drove).toBe(true);
    expect(await results(j)).toEqual(['ran']);
  });
});

// The blast radius (the lead's review): the leaf path is every approved tool_permission on the main journal, a
// person's Bash or Composio call included. Opting it in to markPausedHalt changes nothing for a tool whose run raises
// no pause of its own: the main loop already opts every first run in, so the re-run now gets the context the tool
// always gets.
describe('an approved call whose run raises no pause of its own: unchanged', () => {
  it("a person's approved Bash call settles its real result in the one continue, and drives", async () => {
    const { j, deliver, runs } = await setup('consumer', { raisesItsOwnPause: false, toolName: 'Bash', run: async () => 'removed old-drafts' });
    const out = await deliver('approval', 'tool_permission', { behavior: 'allow' });
    expect(out).toMatchObject({ reSuspended: false, drove: true });
    expect(runs()).toBe(1);
    expect(await resultEntries(j)).toEqual([{ text: 'removed old-drafts', isError: false }]);
  });

  it('an approved call that fails settles its error, never a pause, and drives', async () => {
    const { j, deliver, runs } = await setup('fails', { raisesItsOwnPause: false, toolName: 'Bash', run: async () => { throw new Error('permission denied by the filesystem'); } });
    const out = await deliver('approval', 'tool_permission', { behavior: 'allow' });
    expect(out).toMatchObject({ reSuspended: false, drove: true });
    expect(runs()).toBe(1);
    const [result] = await resultEntries(j);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('permission denied by the filesystem');
  });

  it("the approved run never meets the continue's own gate: a harness that would ask again changes nothing (the reRaised invariant)", async () => {
    // The leaf re-runs under ONE_SHOT_ALLOW_HARNESS, never the toolset's harness, so no gate pause can pass for the tool's own.
    const asksAgain: Harness = { gateTool: async () => ({ decision: 'needs_human', interactionKind: 'tool_permission' }) };
    const { j, deliver, runs } = await setup('gate', { raisesItsOwnPause: false, toolName: 'Bash', run: async () => 'ran once', harness: asksAgain });
    expect(await deliver('approval', 'tool_permission', { behavior: 'allow' })).toMatchObject({ reSuspended: false, drove: true });
    expect(runs()).toBe(1);
    expect(await results(j)).toEqual(['ran once']);
  });

  it('an approved Composio call that meets a connect wall settles the wall as an error, as before: only a pause the tool marks re-suspends', async () => {
    const wall = { successful: false, toolkit: 'gmail', redirect_url: 'https://connect.composio.dev/link/abc123' };
    const { j, deliver } = await setup('wall', { raisesItsOwnPause: false, toolName: 'mcp__composio__GMAIL_SEND_EMAIL', run: async () => wall });
    const out = await deliver('approval', 'tool_permission', { behavior: 'allow' });
    expect(out).toMatchObject({ reSuspended: false, drove: true });
    const [result] = await resultEntries(j);
    expect(result?.isError).toBe(true);
  });
});
