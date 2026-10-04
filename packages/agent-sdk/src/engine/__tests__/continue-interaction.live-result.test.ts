/**
 * B6b — an approved call's real result reaches the browser.
 *
 * #4183's scenario D found it: after the person clicked Allow, the continue ran the held
 * call and settled its real output in the journal (the model read it), but streamed
 * nothing, so the browser kept the paused placeholder from before the ask. The card read
 * "paused" over a command that had run, and the story's step never settled.
 *
 * Pinned here: every settle of a held call on the continue path streams ONE `tool_result`
 * block on the held call's toolUseId through `pushEvent` (the host's core sink turns it
 * into AGENT_TOOL_RESULT), carrying exactly what the journal holds; a continue that settles
 * nothing streams nothing.
 *
 * Revert-proof: drop the `streamSettledResult` call from `settle()` and the first four
 * cases fail (no block reaches the sink).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { InteractionKind } from '../../contract/interaction.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { InMemoryStatePort } from '../../ports/state-port.js';
import { materializeReExecute, REEXECUTE_STARTED_KEY, type ReExecuteDirective } from '../continue-interaction.js';

const dir = join(tmpdir(), `resume-live-result-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const fast = { baseDelayMs: 0 };

const make = () => new Journal({
  taskId: 't', workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${Math.random()}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-10-02T00:00:00.000Z'),
});
const ap = (j: Journal, payload: JournalPayload) => j.append({ ...base, payload });
async function readAll(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}
async function seedHeld(j: Journal, kind: InteractionKind, toolName: string, input: unknown): Promise<void> {
  await ap(j, { type: 'tool_use', toolUseId: 'tu1', name: toolName, input });
  await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind, toolUseId: 'tu1', toolName } });
}
const directive = (kind: InteractionKind, toolName: string): ReExecuteDirective => ({ toolUseId: 'tu1', interactionId: 'i1', kind, toolName });
function tool(name: string, run: () => Promise<string>): RawToolOptions & { calls: number } {
  const t = { calls: 0, name, description: 'd', parameters: {}, execute: async () => { t.calls++; return run(); } };
  return t as unknown as RawToolOptions & { calls: number };
}
function journalResult(es: JournalEntry[], id: string): { text: string; isError: boolean } | undefined {
  const p = es.map((e) => e.payload).find((x) => x.type === 'tool_result' && x.toolUseId === id) as
    { blocks?: Array<{ text?: string }>; isError: boolean } | undefined;
  if (!p) return undefined;
  return { text: p.blocks?.map((b) => b.text ?? '').join('') ?? '', isError: p.isError };
}
const streamed = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.kind === 'block' && e.block.type === 'tool_result' ? [e.block] : []));

describe('a held call settled on the continue path streams its real result', () => {
  it('an approved leaf call: the result the model gets is the result the browser gets, same toolUseId', async () => {
    const j = make();
    const input = { command: 'rm -rf old-drafts' };
    await seedHeld(j, 'tool_permission', 'Bash', input);
    const bash = tool('Bash', async () => 'removed old-drafts');
    const events: HarnessEvent[] = [];

    await materializeReExecute({
      directive: directive('tool_permission', 'Bash'), tools: [bash], originalInput: input, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });

    expect(bash.calls).toBe(1);
    const inJournal = journalResult(await readAll(j), 'tu1');
    expect(inJournal).toEqual({ text: 'removed old-drafts', isError: false });
    // Exactly one block, on the held call's id, never marked paused.
    expect(streamed(events)).toEqual([
      { type: 'tool_result', toolUseId: 'tu1', content: 'removed old-drafts', isError: false, toolName: 'Bash' },
    ]);
  });

  it('a call that fails after approval streams the error, so the card leaves "paused" for an error, not a tick', async () => {
    const j = make();
    await seedHeld(j, 'tool_permission', 'Bash', { command: 'rm -rf /nope' });
    const bash = tool('Bash', async () => { throw new Error('permission denied by the filesystem'); });
    const events: HarnessEvent[] = [];

    await materializeReExecute({
      directive: directive('tool_permission', 'Bash'), tools: [bash], originalInput: { command: 'rm -rf /nope' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });

    const inJournal = journalResult(await readAll(j), 'tu1');
    expect(inJournal?.isError).toBe(true);
    const blocks = streamed(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ toolUseId: 'tu1', isError: true, content: inJournal!.text });
  });

  it('a connector re-execute (composio_auth) streams the re-run output too', async () => {
    const j = make();
    const SEND = 'mcp__composio__GMAIL_SEND_EMAIL';
    await seedHeld(j, 'composio_auth', SEND, { to: 'x' });
    const events: HarnessEvent[] = [];

    await materializeReExecute({
      directive: directive('composio_auth', SEND), tools: [tool(SEND, async () => 'sent')], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });

    expect(streamed(events)).toEqual([{ type: 'tool_result', toolUseId: 'tu1', content: 'sent', isError: false, toolName: SEND }]);
  });

  it('a re-execute that may already have run settles execution_interrupted, and that is what streams', async () => {
    const j = make();
    await seedHeld(j, 'tool_permission', 'Bash', { command: 'echo hi' });
    await ap(j, { type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'tu1', interactionId: 'i1' } });
    const bash = tool('Bash', async () => 'hi');
    const events: HarnessEvent[] = [];

    await materializeReExecute({
      directive: directive('tool_permission', 'Bash'), tools: [bash], originalInput: { command: 'echo hi' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });

    expect(bash.calls).toBe(0);
    const blocks = streamed(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isError).toBe(true);
    expect(JSON.parse(String(blocks[0].content))).toMatchObject({ status: 'error', reason: 'execution_interrupted' });
  });

  it('an already-answered call streams nothing (a duplicate delivery repaints no card)', async () => {
    const j = make();
    await seedHeld(j, 'tool_permission', 'Bash', { command: 'echo hi' });
    await ap(j, { type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text', text: 'hi' }], isError: false });
    const events: HarnessEvent[] = [];

    await materializeReExecute({
      directive: directive('tool_permission', 'Bash'), tools: [tool('Bash', async () => 'hi')], originalInput: { command: 'echo hi' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });

    expect(streamed(events)).toEqual([]);
  });
});

/**
 * A held call pays its action fee when it RUNS, which on the continue path is here: the pause
 * sent no frame (toolBillingEvent skips a paused call). Before, an approved or re-connected call
 * was never charged on native, and a subagent's held call was charged at tool_use, run or not.
 */
describe('a held call settled on the continue path pays its fee once, when it runs', () => {
  const fees = (events: HarnessEvent[]) =>
    events.flatMap((e) => (e.kind === 'raw' && e.event === 'agent:tool_billing' ? [e.data] : []));
  const SEND = 'mcp__composio__GMAIL_SEND_EMAIL';

  it('an approved call: one frame, on its own tool_use id, as the main turn\'s', async () => {
    const j = make();
    await seedHeld(j, 'tool_permission', SEND, { to: 'x' });
    const events: HarnessEvent[] = [];
    await materializeReExecute({
      directive: directive('tool_permission', SEND), tools: [tool(SEND, async () => 'sent')], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });
    expect(fees(events)).toEqual([{ taskId: 't', toolName: SEND, toolUseId: 'tu1', isSubagent: false }]);
  });

  it('a call re-run after its connector connected (composio_auth): one frame', async () => {
    const j = make();
    await seedHeld(j, 'composio_auth', SEND, { to: 'x' });
    const events: HarnessEvent[] = [];
    await materializeReExecute({
      directive: directive('composio_auth', SEND), tools: [tool(SEND, async () => 'sent')], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });
    expect(fees(events)).toEqual([{ taskId: 't', toolName: SEND, toolUseId: 'tu1', isSubagent: false }]);
  });

  it('a re-execute interrupted mid-continue (it may already have run) is not re-run and pays nothing more', async () => {
    const j = make();
    await seedHeld(j, 'tool_permission', SEND, { to: 'x' });
    await ap(j, { type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'tu1', interactionId: 'i1' } });
    const send = tool(SEND, async () => 'sent');
    const events: HarnessEvent[] = [];
    await materializeReExecute({
      directive: directive('tool_permission', SEND), tools: [send], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });
    expect(send.calls).toBe(0);
    expect(fees(events)).toEqual([]);
  });

  it('a declined call runs nothing and pays nothing; an already-answered one pays nothing again', async () => {
    const declined = make();
    await seedHeld(declined, 'tool_permission', SEND, { to: 'x' });
    const send = tool(SEND, async () => 'sent');
    const events: HarnessEvent[] = [];
    await materializeReExecute({
      directive: directive('tool_permission', SEND), tools: [send], originalInput: { to: 'x' }, outcome: { behavior: 'deny', reason: 'user_declined' },
      journal: declined, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });
    expect(send.calls).toBe(0);

    const answered = make();
    await seedHeld(answered, 'tool_permission', SEND, { to: 'x' });
    await ap(answered, { type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text', text: 'sent' }], isError: false });
    await materializeReExecute({
      directive: directive('tool_permission', SEND), tools: [tool(SEND, async () => 'sent')], originalInput: { to: 'x' }, outcome: { behavior: 'allow' },
      journal: answered, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(), retryOpts: fast,
      pushEvent: (ev) => events.push(ev),
    });
    expect(fees(events)).toEqual([]);
  });
});
