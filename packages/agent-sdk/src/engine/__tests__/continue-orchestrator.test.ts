/**
 * HITL Task 5 — orchestrateContinue: forward-resume drive.
 *
 * When a DEFERRED pause (Task 2: its tool_use already answered by a
 * `{status:'deferred'}` tool_result while the interaction stayed resolved:false)
 * later RESOLVES, `reconcileInteractions` returns a `forwardResume` directive
 * (Task 3): it settles the row but does NOT splice a second tool_result and does
 * NOT re_execute. This suite locks the engine's reaction — it must append ONE
 * forward-resume breadcrumb (a user-role entry framed as a SYSTEM notification,
 * attributed to the system) and then drive ONE fresh, full-context continuation
 * turn. The original tool's stale args are never re-dispatched.
 *
 * The breadcrumb + drive path is ADDITIVE: a non-deferred continue
 * (resolution_is_result / re_execute) keeps its prior outcome and appends no
 * breadcrumb.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { InteractionOutcome, ContinueInteractionPayload } from '../../contract/interaction.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { InMemoryStatePort } from '../../ports/state-port.js';
import { orchestrateContinue, type OrchestrateContinueDeps } from '../continue-orchestrator.js';

const dir = join(tmpdir(), `hitl-orch-test-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const baseEntry = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  toolUse: (id: string, name = 'GMAIL_SEND_EMAIL'): JournalPayload => ({ type: 'tool_use', toolUseId: id, name, input: {} }),
  interaction: (interactionId: string, resolved: boolean, data: unknown): JournalPayload => ({ type: 'interaction', interactionId, resolved, data }),
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...baseEntry, payload });
const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-06-15T00:00:00.000Z'),
});
const allow = (updatedInput?: unknown): InteractionOutcome => ({ behavior: 'allow', updatedInput });

async function readAll(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}

/** Minimal deps; per-test overrides win. drive/buildToolset are spies by default. */
function deps(journal: Journal, payload: ContinueInteractionPayload, over: Partial<OrchestrateContinueDeps> = {}): OrchestrateContinueDeps {
  return {
    taskId: 't',
    payload,
    journal,
    state: new InMemoryStatePort(),
    buildToolset: vi.fn(async () => ({ tools: [], harness: { gateTool: vi.fn() } as never })),
    drive: vi.fn(async () => {}),
    ...over,
  };
}

describe('orchestrateContinue — forward-resume of a deferred pause', () => {
  it('a resolved deferred pause drives a forward continuation (no re_execute, no second result), with a forward-resume breadcrumb appended', async () => {
    const j = make();
    await j.append(newEntry(P.user('invite Bob for Tuesday')));
    await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    await j.deferSuspended();                              // slot deferred, interaction still pending
    await j.append(newEntry(P.user('actually move it to Friday')));

    const before = await readAll(j);
    const userBefore = before.filter((e) => e.payload.type === 'user').length;
    const drove = vi.fn(async () => {});
    const buildToolset = vi.fn(async () => ({ tools: [], harness: { gateTool: vi.fn() } as never }));

    const payload: ContinueInteractionPayload = {
      taskId: 't', interactionId: 'i1', toolUseId: 'tu1', kind: 'composio_auth', outcome: allow(),
    };
    const out = await orchestrateContinue(deps(j, payload, { drive: drove, buildToolset }));

    // drove exactly once; re_execute path NOT taken (buildToolset never called).
    expect(drove).toHaveBeenCalledTimes(1);
    expect(buildToolset).not.toHaveBeenCalled();
    expect(out.drove).toBe(true);
    expect(out.reSuspended).toBe(false);
    expect(out.alreadyAnswered).toBe(false);

    const after = await readAll(j);
    // EXACTLY one new user-role entry (the breadcrumb), and it reads as a SYSTEM notification.
    const usersAfter = after.filter((e) => e.payload.type === 'user');
    expect(usersAfter.length).toBe(userBefore + 1);
    const breadcrumb = usersAfter[usersAfter.length - 1].payload as { blocks: Array<{ text?: string }> };
    const text = breadcrumb.blocks[0]?.text ?? '';
    expect(text).toContain('[System]');
    expect(text).toContain('GMAIL_SEND_EMAIL'); // names the deferred tool
    expect(text).not.toContain('—');            // no em dashes
    expect(text).not.toMatch(/claude/i);        // no "Claude"

    // attributed to the system, NOT the human user.
    expect((usersAfter[usersAfter.length - 1].payload as JournalPayload).type).toBe('user');
    expect(usersAfter[usersAfter.length - 1].principal.kind).toBe('system');

    // NO second tool_result spliced for the deferred slot (A6: forward, immutable).
    expect(after.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'tu1').length).toBe(1);
  });

  it('resolving ONE of two deferred pauses still drives once (the other deferred slot is answered, never strands) and the breadcrumb names the resolved tool', async () => {
    const j = make();
    await j.append(newEntry(P.user('send invite + draft the memo')));
    await j.append(newEntry(P.toolUse('tuA', 'GMAIL_SEND_EMAIL')));
    await j.append(newEntry(P.interaction('iA', false, { kind: 'composio_auth', toolUseId: 'tuA', toolName: 'GMAIL_SEND_EMAIL' })));
    await j.append(newEntry(P.toolUse('tuB', 'NOTION_CREATE_PAGE')));
    await j.append(newEntry(P.interaction('iB', false, { kind: 'composio_auth', toolUseId: 'tuB', toolName: 'NOTION_CREATE_PAGE' })));
    await j.deferSuspended();                              // BOTH slots deferred-answered, both interactions pending

    const drove = vi.fn(async () => {});
    const payload: ContinueInteractionPayload = {
      taskId: 't', interactionId: 'iA', toolUseId: 'tuA', kind: 'composio_auth', outcome: allow(),
    };
    const out = await orchestrateContinue(deps(j, payload, { drive: drove }));

    // tuB stays deferred-but-answered → NOT live-suspended → does not strand the drive.
    expect(out.reSuspended).toBe(false);
    expect(drove).toHaveBeenCalledTimes(1);

    const after = await readAll(j);
    const lastUser = after.filter((e) => e.payload.type === 'user').slice(-1)[0]?.payload as { blocks: Array<{ text?: string }> };
    const text = lastUser?.blocks[0]?.text ?? '';
    expect(text).toContain('GMAIL_SEND_EMAIL'); // the resolved tool is named
    expect(text).toContain('[System]');
  });

  it('a stale APPROVAL card is worded as an approval, a declined one as a decline (live 28edef30)', async () => {
    const lastUserText = async (j: Journal): Promise<string> => {
      const users = (await readAll(j)).filter((e) => e.payload.type === 'user');
      return (users[users.length - 1].payload as { blocks: Array<{ text?: string }> }).blocks[0]?.text ?? '';
    };
    for (const [outcome, want] of [
      [allow(), '[System] The person approved the earlier Bash step. Continue that request'],
      [{ behavior: 'deny', reason: 'user_declined' } as InteractionOutcome, '[System] The earlier Bash request was declined, so do not run it.'],
    ] as const) {
      const j = make(`t-${outcome.behavior}`);
      await j.append(newEntry(P.user('clean up the old renders')));
      await j.append(newEntry(P.toolUse('tu1', 'Bash')));
      await j.append(newEntry(P.interaction('i1', false, { kind: 'tool_permission', toolUseId: 'tu1', toolName: 'Bash' })));
      await j.deferSuspended(); // the person typed instead of answering the card
      await j.append(newEntry(P.user('actually keep them')));
      const payload: ContinueInteractionPayload = { taskId: 't', interactionId: 'i1', toolUseId: 'tu1', kind: 'tool_permission', outcome };
      await orchestrateContinue(deps(j, payload));
      const text = await lastUserText(j);
      expect(text.startsWith(want)).toBe(true);
      expect(text).not.toContain('connection');
    }
  });
});

describe('orchestrateContinue — forward-resume is ADDITIVE (existing outcomes unchanged)', () => {
  it('a resolution_is_result continue (ask_question) still drives once and appends NO breadcrumb', async () => {
    const j = make();
    await j.append(newEntry(P.user('what colour?')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));

    const before = await readAll(j);
    const userBefore = before.filter((e) => e.payload.type === 'user').length;
    const drove = vi.fn(async () => {});
    const payload: ContinueInteractionPayload = {
      taskId: 't', interactionId: 'i1', toolUseId: 'tu1', kind: 'ask_question', outcome: allow({ answer: 'blue' }),
    };
    const out = await orchestrateContinue(deps(j, payload, { drive: drove }));

    expect(drove).toHaveBeenCalledTimes(1);
    expect(out.drove).toBe(true);

    const after = await readAll(j);
    // NO breadcrumb: the resolution materialized IN PLACE as the tool_result.
    expect(after.filter((e) => e.payload.type === 'user').length).toBe(userBefore);
    // the materialized tool_result IS present (resolution_is_result path).
    expect(after.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'tu1')).toBe(true);
  });

  it('an already-answered tool_use is a no-op (no drive, no breadcrumb)', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry({ type: 'tool_result', toolUseId: 'tu1', blocks: [], isError: false }));

    const before = await readAll(j);
    const userBefore = before.filter((e) => e.payload.type === 'user').length;
    const drove = vi.fn(async () => {});
    const payload: ContinueInteractionPayload = {
      taskId: 't', interactionId: 'i1', toolUseId: 'tu1', kind: 'ask_question', outcome: allow(),
    };
    const out = await orchestrateContinue(deps(j, payload, { drive: drove }));

    expect(out.alreadyAnswered).toBe(true);
    expect(drove).not.toHaveBeenCalled();
    const after = await readAll(j);
    expect(after.filter((e) => e.payload.type === 'user').length).toBe(userBefore);
  });
});

// ── T3: HITL world-delta breadcrumb, appended IMMEDIATELY before the drive ──────
//
// A resume that lands long after the pause (or on a recycled runner) gets a system-
// principal breadcrumb so the re-projected turn tells the model that time passed and
// ephemeral state may be gone. It must be journaled BEFORE the drive runs (the drive
// re-projects the journal); below threshold / no worldDelta → nothing appended.
describe('orchestrateContinue — T3 world-delta breadcrumb before the drive', () => {
  async function driveWith(worldDelta?: { elapsedMs?: number; runnerRecycled?: boolean }) {
    const j = make();
    await j.append(newEntry(P.user('what colour?')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));
    const userBefore = (await readAll(j)).filter((e) => e.payload.type === 'user').length;

    let userCountAtDrive = -1;
    const drove = vi.fn(async () => { userCountAtDrive = (await readAll(j)).filter((e) => e.payload.type === 'user').length; });
    const payload: ContinueInteractionPayload = { taskId: 't', interactionId: 'i1', toolUseId: 'tu1', kind: 'ask_question', outcome: allow({ answer: 'blue' }) };
    const out = await orchestrateContinue(deps(j, payload, { drive: drove, ...(worldDelta !== undefined && { worldDelta }) }));
    return { j, out, drove, userBefore, userCountAtDrive };
  }
  const lastUserText = (es: JournalEntry[]): string => {
    const u = es.filter((e) => e.payload.type === 'user').slice(-1)[0];
    return u ? ((u.payload as { blocks: Array<{ text?: string }> }).blocks[0]?.text ?? '') : '';
  };

  it('a >10min gap appends ONE system-principal breadcrumb, BEFORE the drive', async () => {
    const { j, out, drove, userBefore, userCountAtDrive } = await driveWith({ elapsedMs: 32 * 3_600_000 });
    expect(out.drove).toBe(true);
    expect(drove).toHaveBeenCalledTimes(1);
    const after = await readAll(j);
    expect(after.filter((e) => e.payload.type === 'user').length).toBe(userBefore + 1);
    expect(after.filter((e) => e.payload.type === 'user').slice(-1)[0].principal.kind).toBe('system');
    const text = lastUserText(after);
    expect(text).toContain('[System]');
    expect(text).toContain('32 hours after the pause');
    expect(text).toContain('do not infer that a previously gated action ran');
    expect(text).not.toContain('—');
    // Ordering: the breadcrumb was already journaled when the drive ran.
    expect(userCountAtDrive).toBe(userBefore + 1);
  });

  it('a recycled runner (no measured elapsed) also appends the breadcrumb ("some time")', async () => {
    const { j, userBefore } = await driveWith({ runnerRecycled: true });
    const after = await readAll(j);
    expect(after.filter((e) => e.payload.type === 'user').length).toBe(userBefore + 1);
    expect(lastUserText(after)).toContain('some time after the pause');
  });

  it('below threshold (short gap, warm runner) → NO breadcrumb', async () => {
    const { j, drove, userBefore } = await driveWith({ elapsedMs: 5_000, runnerRecycled: false });
    expect(drove).toHaveBeenCalledTimes(1);
    expect((await readAll(j)).filter((e) => e.payload.type === 'user').length).toBe(userBefore);
  });

  it('no worldDelta → NO breadcrumb (byte-identical to today)', async () => {
    const { j, drove, userBefore } = await driveWith(undefined);
    expect(drove).toHaveBeenCalledTimes(1);
    expect((await readAll(j)).filter((e) => e.payload.type === 'user').length).toBe(userBefore);
  });
});
