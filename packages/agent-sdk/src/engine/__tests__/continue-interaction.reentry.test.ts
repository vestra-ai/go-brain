/**
 * T11b (durable subagent deep-HITL, Phase B) — `materializeReExecute` ROUTES a
 * scope-tagged (agentPath) re_execute directive to a subagent RE-ENTRY: re-execute the
 * paused LEAF tool once, journal its result scope-tagged, then re-dispatch the `Agent`
 * tool SEEDED from the journal projection (so prior model rounds are not replayed), and
 * settle the PARENT `Agent` tool_use (A1) with the real subagent output.
 *
 * The discriminator is the bound tool_use's `agentPath`: present ⇒ RE-ENTRY (this task);
 * absent ⇒ the historic leaf re-dispatch / `Agent` collapse-replay (untouched).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { InteractionOutcome } from '../../contract/interaction.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import { Journal, liveSuspendedToolUseIds } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { InMemoryStatePort } from '../../ports/state-port.js';
import { buildDeferredResultContent } from '../../kernel/interaction/strategy.js';
import { materializeReExecute, REEXECUTE_STARTED_KEY, type ReExecuteDirective } from '../continue-interaction.js';
import { journalSubagentPause } from '../native-journal.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { ensureValidAnthropicRequest, type GeminiContent } from '../request-validity.js';
import { journalToChatCompletionsMessages } from '../../transports/chat-completions-messages.js';
import { journalToOpenAIResponsesInput } from '../../transports/openai-responses-messages.js';
import { journalToGeminiContents } from '../../transports/gemini-messages.js';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

const dir = join(tmpdir(), `t11b-mat-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const path1: SubagentPathSegment[] = [{ depth: 1, agentToolUseId: 'A1', agentSlug: 's', agentName: 's' }];
const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const allow = (): InteractionOutcome => ({ behavior: 'allow' });
const deny = (): InteractionOutcome => ({ behavior: 'deny', reason: 'user_declined' });

const make = () => new Journal({
  taskId: 't', workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `t-${Math.random()}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-06-29T00:00:00.000Z'),
});
function ap(j: Journal, payload: JournalPayload, agentPath?: SubagentPathSegment[]): Promise<JournalEntry> {
  return j.append({ ...base, ...(agentPath ? { agentPath } : {}), payload });
}
async function readAll(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}
const resultText = (e: JournalEntry | undefined): string =>
  e ? ((e.payload as { blocks?: Array<{ text?: string }> }).blocks ?? []).map((b) => b.text ?? '').join('') : '';
// The LAST main-scope A1 tool_result = the settled answer (the deferred placeholder is earlier).
const a1Result = (es: JournalEntry[]) =>
  es.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1' && !e.agentPath).at(-1);
const c1Result = (es: JournalEntry[]) =>
  es.find((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1' && !!e.agentPath);

/** Seed the journal exactly as a depth-1 flag-ON subagent inner pause leaves it. */
async function seedPausedJournal(j: Journal): Promise<void> {
  await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
  await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'research X' } });
  await ap(j, { type: 'tool_use', toolUseId: 'C1', name: 'Bash', input: { cmd: 'ls' } }, path1);
  await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C1', toolName: 'Bash', subagentPath: path1, subagentId: 'A1' } });
  await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false }); // deferred placeholder
}

/** A leaf Bash tool that records its run. */
function makeBash(ran: { input?: unknown }): RawToolOptions {
  return { name: 'Bash', description: 'bash', parameters: {}, execute: async (input) => { ran.input = input; return 'bash ran'; } };
}
type Cap = { resume?: { seedEntries: JournalEntry[] } | undefined; toolCallId?: string | undefined };
/** A fake Agent tool that captures its resume/toolCallId and (optionally) re-pauses. */
function makeAgent(capture: Cap, opts: { repause?: boolean } = {}): RawToolOptions {
  return {
    name: 'Agent', description: 'agent', parameters: {},
    execute: async (_args, ctx: ToolExecuteContext) => {
      capture.resume = ctx.resume;
      capture.toolCallId = ctx.toolCallId;
      if (opts.repause) { ctx.markPausedHalt?.(); return 'Subagent paused awaiting human approval.'; }
      return 'REAL SUBAGENT OUTPUT';
    },
  };
}

describe('materializeReExecute — depth-1 subagent RE-ENTRY (agentPath-routed)', () => {
  const directive: ReExecuteDirective = { toolUseId: 'C1', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path1 };

  it('COMPLETION: re-executes the leaf once, seeds the Agent re-dispatch from the projection, settles A1 with the REAL output, resolves the interaction', async () => {
    const j = make();
    await seedPausedJournal(j);
    const ran: { input?: unknown } = {};
    const cap: Cap = {};

    await materializeReExecute({
      directive, tools: [makeAgent(cap), makeBash(ran)], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // 1. The leaf tool RAN once (approve => the paused Bash executes), with its journaled input.
    expect(ran.input).toEqual({ cmd: 'ls' });
    // 2. The leaf's resolved result is journaled SCOPE-TAGGED (durable + re-projectable).
    const after = await readAll(j);
    expect(resultText(c1Result(after))).toBe('bash ran');
    // 3. The Agent re-dispatch was SEEDED from the scope projection (RE-ENTRY, not replay):
    //    it received the subagent's scoped rounds, ending with the leaf's real result.
    expect(cap.toolCallId).toBe('A1');
    expect(cap.resume).toBeDefined();
    expect(cap.resume!.seedEntries.some(
      (e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1',
    )).toBe(true);
    // 4. A1 (the parent Agent tool_use) is settled with the REAL subagent output...
    expect(resultText(a1Result(after))).toBe('REAL SUBAGENT OUTPUT');
    // 5. ...and the interaction is resolved.
    expect(after.some((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean; interactionId: string }).resolved === true && (e.payload as { interactionId: string }).interactionId === 'i1')).toBe(true);
    // 6. project() shows ONE A1 result (the deferred placeholder superseded by the real one).
    const { messages } = await j.project();
    const projectedA1 = messages.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1');
    expect(projectedA1).toHaveLength(1);
    expect(resultText(projectedA1[0])).toBe('REAL SUBAGENT OUTPUT');
  });

  it('the approved leaf pays its action fee once, as the subagent\'s, when it runs here; a declined one pays nothing', async () => {
    // The pause sent no frame (a held call is billed only when it runs). Before, the Agent tool
    // billed C1 at tool_use, so a held call was charged whether the person said yes or no.
    const fees = (events: HarnessEvent[]) =>
      events.flatMap((e) => (e.kind === 'raw' && e.event === 'agent:tool_billing' ? [e.data] : []));
    const approved = make();
    await seedPausedJournal(approved);
    const events: HarnessEvent[] = [];
    await materializeReExecute({
      directive, tools: [makeAgent({}), makeBash({})], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: approved, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
      pushEvent: (ev) => events.push(ev),
    });
    expect(fees(events)).toEqual([{ taskId: 't', toolName: 'Bash', toolUseId: 'C1', isSubagent: true }]);

    const declined = make();
    await seedPausedJournal(declined);
    const after: HarnessEvent[] = [];
    const ran: { input?: unknown } = {};
    await materializeReExecute({
      directive, tools: [makeAgent({}), makeBash(ran)], originalInput: { cmd: 'ls' },
      outcome: deny(), journal: declined, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
      pushEvent: (ev) => after.push(ev),
    });
    expect(ran.input).toBeUndefined();
    expect(fees(after)).toEqual([]);
  });

  it('RE-PAUSE: when the re-entered subagent hits a NEW gate, settle ONLY the interaction — A1 stays unanswered (no hollow result) so the continue re-suspends', async () => {
    const j = make();
    await seedPausedJournal(j);
    const cap: Cap = {};

    await materializeReExecute({
      directive, tools: [makeAgent(cap, { repause: true }), makeBash({})], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    const after = await readAll(j);
    // The OLD interaction is settled...
    expect(after.some((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean; interactionId: string }).resolved === true && (e.payload as { interactionId: string }).interactionId === 'i1')).toBe(true);
    // ...but A1 got NO real tool_result (only the original deferred placeholder remains),
    // so liveSuspendedToolUseIds re-suspends rather than driving a hollow turn.
    const a1Reals = after.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1' && resultText(e) === 'REAL SUBAGENT OUTPUT');
    expect(a1Reals).toHaveLength(0);
  });

  it('DENY: re-enters the subagent with a SCOPE-TAGGED declined leaf result (leaf NOT run), seeds the Agent re-dispatch, settles A1 with the REAL output, resolves the interaction', async () => {
    const j = make();
    await seedPausedJournal(j);
    const ran: { input?: unknown } = {};
    const cap: Cap = {};

    await materializeReExecute({
      directive, tools: [makeAgent(cap), makeBash(ran)], originalInput: { cmd: 'ls' },
      // The user DENIED the subagent's leaf permission.
      outcome: deny(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // 1. The leaf tool did NOT run — a deny never executes the tool.
    expect(ran.input).toBeUndefined();
    // 2. The leaf's DECLINED result is journaled SCOPE-TAGGED (so the subagent's scope
    //    record is complete and it re-enters seeing a clear refusal), NOT unscoped in main.
    const after = await readAll(j);
    const c1 = c1Result(after);
    expect(c1).toBeDefined();
    expect(resultText(c1)).toContain('DECLINED');
    // No UNSCOPED (main-projection) declined C1 result leaked in.
    expect(after.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1' && !e.agentPath)).toBe(false);
    // 3. The Agent re-dispatch was SEEDED from the scope projection, ending with the
    //    leaf's declined result (RE-ENTRY, not replay).
    expect(cap.toolCallId).toBe('A1');
    expect(cap.resume).toBeDefined();
    expect(cap.resume!.seedEntries.some(
      (e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1',
    )).toBe(true);
    // 4. A1 (the parent Agent tool_use) settles with the subagent's REAL reaction output...
    expect(resultText(a1Result(after))).toBe('REAL SUBAGENT OUTPUT');
    // 5. ...and the interaction is resolved (the parent is no longer stranded).
    expect(after.some((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean; interactionId: string }).resolved === true && (e.payload as { interactionId: string }).interactionId === 'i1')).toBe(true);
    // 6. project() shows ONE A1 result (the deferred placeholder superseded by the real one).
    const { messages } = await j.project();
    const projectedA1 = messages.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1');
    expect(projectedA1).toHaveLength(1);
    expect(resultText(projectedA1[0])).toBe('REAL SUBAGENT OUTPUT');
  });

  it('FALLBACK: an empty scope (no journaled subagent rounds) re-dispatches the Agent FRESH (no resume) and still settles A1', async () => {
    const j = make();
    // Pause state WITHOUT the scope-tagged leaf tool_use → projectScope(all, A1) is empty.
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'research X' } });
    await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C1', toolName: 'Bash', subagentPath: path1, subagentId: 'A1' } });
    const cap: Cap = {};

    await materializeReExecute({
      directive, tools: [makeAgent(cap), makeBash({})], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // Fresh replay: the Agent ran with NO resume seed, and A1 is still settled.
    expect(cap.resume).toBeUndefined();
    expect(cap.toolCallId).toBe('A1');
    expect(resultText(a1Result(await readAll(j)))).toBe('REAL SUBAGENT OUTPUT');
  });
});

// ── T3: HITL world-delta — the re-spawned CHILD's prompt preamble ──────────────
//
// When a resume lands long after the pause (or on a recycled runner), the re-dispatched
// subagent gets a second-person world-delta preamble PREPENDED to its `Agent` prompt so
// it re-verifies state instead of trusting pre-pause /tmp. Below threshold / no worldDelta
// → the child prompt is byte-identical (the original `research X`).

/** A fake Agent tool that records the (possibly preamble-prepended) input it was dispatched with. */
function makeAgentCapturingInput(cap: { input?: unknown }): RawToolOptions {
  return {
    name: 'Agent', description: 'agent', parameters: {},
    execute: async (args: unknown) => { cap.input = args; return 'REAL SUBAGENT OUTPUT'; },
  };
}

describe('materializeReExecute — T3 world-delta child preamble', () => {
  const directive: ReExecuteDirective = { toolUseId: 'C1', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path1 };
  const childPrompt = (cap: { input?: unknown }): string => (cap.input as { prompt: string }).prompt;

  async function reExecuteWith(worldDelta?: { elapsedMs?: number; runnerRecycled?: boolean }): Promise<{ input?: unknown }> {
    const j = make();
    await seedPausedJournal(j);
    const cap: { input?: unknown } = {};
    await materializeReExecute({
      directive, tools: [makeAgentCapturingInput(cap), makeBash({})], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
      ...(worldDelta !== undefined && { worldDelta }),
    });
    return cap;
  }

  it('a large elapsed gap prepends the second-person preamble, preserving the original prompt after it', async () => {
    const cap = await reExecuteWith({ elapsedMs: 32 * 3_600_000 });
    const prompt = childPrompt(cap);
    expect(prompt.startsWith('Your earlier tool request paused for user input.')).toBe(true);
    expect(prompt).toContain('32 hours after the pause');
    expect(prompt.endsWith('research X')).toBe(true); // original prompt preserved verbatim
    expect(prompt).not.toContain('—');
    expect(prompt).not.toMatch(/claude/i);
  });

  it('a recycled runner with no measured elapsed still injects the preamble ("some time")', async () => {
    const prompt = childPrompt(await reExecuteWith({ runnerRecycled: true }));
    expect(prompt.startsWith('Your earlier tool request paused for user input.')).toBe(true);
    expect(prompt).toContain('some time after the pause');
    expect(prompt.endsWith('research X')).toBe(true);
  });

  it('no worldDelta → the child prompt is byte-identical to the original (no preamble)', async () => {
    expect(childPrompt(await reExecuteWith(undefined))).toBe('research X');
  });

  it('below threshold (short gap, warm runner) → the child prompt is byte-identical', async () => {
    expect(childPrompt(await reExecuteWith({ elapsedMs: 5_000, runnerRecycled: false }))).toBe('research X');
  });
});

// ── T12: depth-2/3 recursive forward-resume (bubble the resolution up the chain) ──

const path2: SubagentPathSegment[] = [
  { depth: 1, agentToolUseId: 'A1', agentSlug: 's', agentName: 's' },
  { depth: 2, agentToolUseId: 'A2', agentSlug: 's', agentName: 's' },
];
const path3: SubagentPathSegment[] = [
  ...path2,
  { depth: 3, agentToolUseId: 'A3', agentSlug: 's', agentName: 's' },
];

/** One re-entry invocation the fake Agent records (scope id + the resume seed it got). */
interface AgentCall { toolCallId?: string | undefined; resume?: { seedEntries: JournalEntry[] } | undefined }
/**
 * A fake Agent tool that, per scope (its `toolCallId`), returns a DISTINCT real output
 * (so each settled ancestor is identifiable). Records EVERY invocation so the test can
 * prove one re-entry per level (no ancestor replay) + the per-level seed. A scope listed
 * in `repause` re-pauses instead of completing.
 */
function makeRecordingAgent(
  calls: AgentCall[],
  outputByScope: Record<string, string>,
  repause: Set<string> = new Set(),
): RawToolOptions {
  return {
    name: 'Agent', description: 'agent', parameters: {},
    execute: async (_args, ctx: ToolExecuteContext) => {
      const scope = ctx.toolCallId ?? '';
      calls.push({ toolCallId: ctx.toolCallId, resume: ctx.resume });
      if (repause.has(scope)) { ctx.markPausedHalt?.(); return 'Subagent paused awaiting human approval.'; }
      return outputByScope[scope] ?? `OUTPUT ${scope}`;
    },
  };
}

/** The LAST scope-tagged tool_result for `id` within scope `leaf` (the settled answer). */
const scopedResult = (es: JournalEntry[], id: string, leaf: string) =>
  es.filter((e) => e.payload.type === 'tool_result'
    && (e.payload as { toolUseId: string }).toolUseId === id
    && subagentIdFromPathSeg(e.agentPath) === leaf).at(-1);
function subagentIdFromPathSeg(p: SubagentPathSegment[] | undefined): string | undefined {
  return p && p.length ? p[p.length - 1].agentToolUseId : undefined;
}
const resolvedCount = (es: JournalEntry[], interactionId: string) =>
  es.filter((e) => e.payload.type === 'interaction'
    && (e.payload as { resolved: boolean; interactionId: string }).resolved === true
    && (e.payload as { interactionId: string }).interactionId === interactionId).length;

/**
 * Seed a depth-3 flag-ON pause: main → A1 → S1 → A2 → S2 → A3 → S3 → C3 (paused). Each
 * subagent's rounds are scope-tagged by its own path.
 *
 * NOTE: this fixture deliberately hand-rolls the ancestor `{status:'deferred'}` placeholders
 * UNSCOPED (all in main) — the PRE-FIX shape. Production `journalSubagentPause` now co-scopes
 * each ancestor placeholder with its tool_use (A1→main, A2→[A1], A3→[A1,A2]) so the main
 * projection is reverse-orphan-free. The recursion tolerates either shape identically, so the
 * T12 mechanics tests below are unaffected; the orphan-free + cross-transport guarantees are
 * proven separately by the `journalSubagentPause`-seeded tests (which use the real writer).
 */
async function seedDepth3(j: Journal): Promise<void> {
  await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
  await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'P1' } });
  await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S1 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path1);
  await ap(j, { type: 'tool_use', toolUseId: 'A2', name: 'Agent', input: { subagent_type: 's', prompt: 'P2' } }, path1);
  await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S2 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path2);
  await ap(j, { type: 'tool_use', toolUseId: 'A3', name: 'Agent', input: { subagent_type: 's', prompt: 'P3' } }, path2);
  await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S3 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path3);
  await ap(j, { type: 'tool_use', toolUseId: 'C3', name: 'Bash', input: { cmd: 'ls' } }, path3);
  await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C3', toolName: 'Bash', subagentPath: path3, subagentId: 'A3' } });
  // Three ancestor deferred placeholders — hand-rolled UNSCOPED (pre-fix shape; see fn docstring).
  await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });
  await ap(j, { type: 'tool_result', toolUseId: 'A2', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });
  await ap(j, { type: 'tool_result', toolUseId: 'A3', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });
}

describe('materializeReExecute — T12 depth-2/3 recursive forward-resume', () => {
  const directive3: ReExecuteDirective = { toolUseId: 'C3', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path3 };

  it('DEPTH-3 billing-minimal: re-enters EACH scope ONCE from its own projection (no ancestor replay), bubbles each child output into its parent, resolves the row ONCE', async () => {
    const j = make();
    await seedDepth3(j);
    const ran: { input?: unknown } = {};
    const calls: AgentCall[] = [];
    const agent = makeRecordingAgent(calls, { A3: 'S3 OUTPUT', A2: 'S2 OUTPUT', A1: 'S1 OUTPUT' });

    await materializeReExecute({
      directive: directive3, tools: [agent, makeBash(ran)], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // 1. The deepest paused leaf (C3) ran ONCE; its result is journaled in the DEEPEST scope.
    expect(ran.input).toEqual({ cmd: 'ls' });
    const after = await readAll(j);
    expect(resultText(scopedResult(after, 'C3', 'A3'))).toBe('bash ran');

    // 2. EXACTLY ONE re-entry per level — A3, then A2, then A1 (ancestors NOT replayed
    //    from the top: three dispatches, one per scope, in deepest-first order).
    expect(calls.map((c) => c.toolCallId)).toEqual(['A3', 'A2', 'A1']);

    // 3. Each level re-entered SEEDED from its OWN scope projection (zero replay): the
    //    seed carries that scope's prior rounds, and each parent's seed carries the
    //    just-settled child's REAL output (not a regenerated round).
    const seedHas = (c: AgentCall, id: string, text?: string) =>
      (c.resume?.seedEntries ?? []).some((e) => e.payload.type === 'tool_result'
        && (e.payload as { toolUseId: string }).toolUseId === id
        && (text === undefined || resultText(e).includes(text)));
    // A3's seed ends with C3's real (re-executed) leaf result.
    expect(calls[0].resume).toBeDefined();
    expect(seedHas(calls[0], 'C3', 'bash ran')).toBe(true);
    // A2's seed carries A3's REAL output (the bubbled child result), NOT C3's inner round.
    expect(seedHas(calls[1], 'A3', 'S3 OUTPUT')).toBe(true);
    expect(seedHas(calls[1], 'C3')).toBe(false);
    // A1's seed carries A2's REAL output.
    expect(seedHas(calls[2], 'A2', 'S2 OUTPUT')).toBe(true);

    // 4. Each ancestor's deferred placeholder is SUPERSEDED by the real child result in
    //    its parent's scope: A3→scope[A2], A2→scope[A1], A1→main.
    expect(resultText(scopedResult(after, 'A3', 'A2'))).toBe('S3 OUTPUT');
    expect(resultText(scopedResult(after, 'A2', 'A1'))).toBe('S2 OUTPUT');
    expect(resultText(a1Result(after))).toBe('S1 OUTPUT'); // A1 settled in MAIN

    // 5. The interaction is resolved EXACTLY once (no double-settle across the bubble).
    expect(resolvedCount(after, 'i1')).toBe(1);

    // 6. Each scope projection shows ONE result for the just-settled child id (the
    //    deferred placeholder is superseded, not duplicated) — the keep-last invariant
    //    holds at depth. The main projection shows ONE A1 result = the real output.
    const { messages } = await j.project();
    const projectedA1 = messages.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1');
    expect(projectedA1).toHaveLength(1);
    expect(resultText(projectedA1[0])).toBe('S1 OUTPUT');
    expect(after.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A2' && subagentIdFromPathSeg(e.agentPath) === 'A1')).toHaveLength(1);
  });

  it('SIBLING GATE: a sibling pending at the intermediate level RE-SUSPENDS the bubble (does not drive up) until it resolves; then the chain completes', async () => {
    const j = make();
    await seedDepth3(j);
    // A SECOND, independent pause at the SHALLOW level: a leaf C1 inside S1 (scope [A1])
    // bound to its OWN pending interaction i2, with its own (path-[A1]) deferred A1 placeholder.
    await ap(j, { type: 'tool_use', toolUseId: 'C1', name: 'Bash', input: { cmd: 'whoami' } }, path1);
    await ap(j, { type: 'interaction', interactionId: 'i2', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C1', toolName: 'Bash', subagentPath: path1, subagentId: 'A1' } });
    await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });

    // ── Resolve the DEEP one (i1) first ──
    const calls1: AgentCall[] = [];
    await materializeReExecute({
      directive: directive3, tools: [makeRecordingAgent(calls1, { A3: 'S3 OUTPUT', A2: 'S2 OUTPUT', A1: 'S1 OUTPUT' }), makeBash({})],
      originalInput: { cmd: 'ls' }, outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // The bubble re-enters S3 then S2, settles A3→scope[A2] and A2→scope[A1], resolves i1
    // — then STOPS: S1 still owes C1 (i2 pending), so liveSuspendedToolUseIds blocks the
    // re-entry of S1. A1 is NOT settled in main; the main turn cannot drive.
    const mid = await readAll(j);
    expect(calls1.map((c) => c.toolCallId)).toEqual(['A3', 'A2']); // S1 NOT re-entered
    expect(resultText(scopedResult(mid, 'A2', 'A1'))).toBe('S2 OUTPUT');
    expect(resolvedCount(mid, 'i1')).toBe(1);
    expect(mid.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1' && !e.agentPath && resultText(e) === 'S1 OUTPUT')).toBe(false);
    expect(liveSuspendedToolUseIds(mid).has('C1')).toBe(true);

    // ── Now resolve the SHALLOW one (i2) ──
    const ran1: { input?: unknown } = {};
    const calls2: AgentCall[] = [];
    const directive1: ReExecuteDirective = { toolUseId: 'C1', interactionId: 'i2', kind: 'tool_permission', toolName: 'Bash', agentPath: path1 };
    await materializeReExecute({
      directive: directive1, tools: [makeRecordingAgent(calls2, { A1: 'S1 OUTPUT' }), makeBash(ran1)],
      originalInput: { cmd: 'whoami' }, outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // C1 ran once; S1 re-entered ONCE (seeded with BOTH children's settled results),
    // A1 settled in main, i2 resolved. The whole tree is now slot-complete.
    expect(ran1.input).toEqual({ cmd: 'whoami' });
    expect(calls2.map((c) => c.toolCallId)).toEqual(['A1']);
    const seedA1 = calls2[0].resume?.seedEntries ?? [];
    expect(seedA1.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A2' && resultText(e) === 'S2 OUTPUT')).toBe(true);
    expect(seedA1.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1' && resultText(e) === 'bash ran')).toBe(true);
    const fin = await readAll(j);
    expect(resultText(a1Result(fin))).toBe('S1 OUTPUT');
    expect(resolvedCount(fin, 'i2')).toBe(1);
    expect(liveSuspendedToolUseIds(fin).size).toBe(0); // nothing left suspended → main can drive
  });

  it('INDEPENDENT SIBLING keeps its result: a COMPLETED sibling subagent at the intermediate level is NOT re-run when the paused chain resolves', async () => {
    const j = make();
    await seedDepth3(j);
    // S1 also spawned a SIBLING subagent A2b that already COMPLETED (its real result is
    // journaled in scope [A1]); it has no pending interaction. Resolving the paused chain
    // must not touch it.
    await ap(j, { type: 'tool_use', toolUseId: 'A2b', name: 'Agent', input: { subagent_type: 's', prompt: 'P2b' } }, path1);
    await ap(j, { type: 'tool_result', toolUseId: 'A2b', blocks: [{ type: 'text', text: 'SIBLING DONE' } as never], isError: false }, path1);

    const calls: AgentCall[] = [];
    await materializeReExecute({
      directive: directive3, tools: [makeRecordingAgent(calls, { A3: 'S3 OUTPUT', A2: 'S2 OUTPUT', A1: 'S1 OUTPUT' }), makeBash({})],
      originalInput: { cmd: 'ls' }, outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // Only the paused chain re-entered (A3, A2, A1) — the completed sibling A2b is never re-dispatched.
    expect(calls.map((c) => c.toolCallId)).toEqual(['A3', 'A2', 'A1']);
    expect(calls.some((c) => c.toolCallId === 'A2b')).toBe(false);
    const after = await readAll(j);
    // The sibling's real result is untouched (still exactly its original output).
    expect(resultText(scopedResult(after, 'A2b', 'A1'))).toBe('SIBLING DONE');
    // S1's re-entry seed carried the sibling's done result (full context for the continue).
    const seedA1 = calls[2].resume?.seedEntries ?? [];
    expect(seedA1.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A2b' && resultText(e) === 'SIBLING DONE')).toBe(true);
    expect(resultText(a1Result(after))).toBe('S1 OUTPUT');
  });

  it('FAIL-LOUD guard: a SCOPE-TAGGED leaf whose kind !== tool_permission does NOT re-run the leaf — it settles an explicit unsupported-kind error and still completes the resume', async () => {
    const j = make();
    await seedPausedJournal(j); // depth-1 scope-tagged pause (path [A1], leaf C1)
    const ran: { input?: unknown } = {};
    const cap: Cap = {};
    // A future composio_auth subagent leaf — NOT supported by the re-entry path today.
    const directiveAuth: ReExecuteDirective = { toolUseId: 'C1', interactionId: 'i1', kind: 'composio_auth', toolName: 'Bash', agentPath: path1 };

    await materializeReExecute({
      directive: directiveAuth, tools: [makeAgent(cap), makeBash(ran)], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });

    // The leaf tool was NOT re-run (the guard refused to mis-execute a non-tool_permission kind).
    expect(ran.input).toBeUndefined();
    const after = await readAll(j);
    // An explicit, scope-tagged unsupported-kind error is journaled for the leaf (fail-loud).
    const c1 = c1Result(after);
    expect(c1).toBeDefined();
    expect(resultText(c1)).toContain('deep_hitl_reentry_unsupported_kind');
    // The resume did NOT hang: the subagent re-entered, A1 settled, the row resolved.
    expect(cap.resume).toBeDefined();
    expect(resultText(a1Result(after))).toBe('REAL SUBAGENT OUTPUT');
    expect(resolvedCount(after, 'i1')).toBe(1);
  });

  // Drill 5c67e1bb review: a re-delivered continue must never run the approved leaf twice.
  it('the leaf re-run journals its intent as the last write before the leaf runs', async () => {
    const j = make();
    await seedPausedJournal(j);
    let last: JournalPayload | undefined;
    const bash: RawToolOptions = {
      name: 'Bash', description: 'bash', parameters: {},
      execute: async () => { last = (await readAll(j)).at(-1)?.payload; return 'bash ran'; },
    };
    await materializeReExecute({
      directive: { toolUseId: 'C1', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path1 },
      tools: [makeAgent({}), bash], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });
    expect(last).toEqual({ type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'C1', interactionId: 'i1' } });
  });

  it('INTERRUPTED: the intent is journaled and no leaf result landed → the leaf is NOT re-run; execution_interrupted settles IN THE SUBAGENT SCOPE and the subagent re-enters', async () => {
    const j = make();
    await seedPausedJournal(j);
    await ap(j, { type: 'custom', key: REEXECUTE_STARTED_KEY, data: { toolUseId: 'C1', interactionId: 'i1' } });
    const ran: { input?: unknown } = {};
    const cap: Cap = {};
    await materializeReExecute({
      directive: { toolUseId: 'C1', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path1 },
      tools: [makeAgent(cap), makeBash(ran)], originalInput: { cmd: 'ls' },
      outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });
    // Mutation: drop the intent check -> the leaf runs a second time.
    expect(ran.input).toBeUndefined();
    const after = await readAll(j);
    // Scope-tagged, so the subagent's own history stays valid (never a main-scope orphan).
    expect(resultText(c1Result(after))).toContain('execution_interrupted');
    expect(after.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1' && !e.agentPath)).toBe(false);
    // The subagent re-decides: it re-entered seeded, A1 settled with its output, the row resolved once.
    expect(cap.resume).toBeDefined();
    expect(resultText(a1Result(after))).toBe('REAL SUBAGENT OUTPUT');
    expect(resolvedCount(after, 'i1')).toBe(1);
  });
});

// ── T12-fix: reverse-orphan elimination across ALL transports ──────────────────
//
// The Phase-B whole-branch review (3/3 skeptics) flagged: on a flag-ON depth≥2 deep
// resume the MAIN projection retained the ancestor `Agent` tool_uses' {status:'deferred'}
// placeholders as REVERSE-ORPHANS — `journalSubagentPause` wrote them UNSCOPED (main),
// but A2/A3's tool_uses are scope-tagged AWAY from main, so main carried tool_results
// with no matching tool_use. Anthropic's `stripOrphanedToolBlocks` hid the bug; the
// Chat-Completions / OpenAI-Responses / Gemini validity floors do NOT strip reverse-
// orphans, so a GLM/OpenAI/Gemini main task's post-resume continue request carried orphan
// tool outputs → provider 400 → wedged task. The fix co-scopes each ancestor placeholder
// with its tool_use, and keep-lasts the re-entry seed (the in-scope deferred+real dup the
// co-scoping now creates collapses to the real result).

/** Every tool_use_id a request's tool_results reference (the Anthropic wire). */
function anthropicToolResultIds(msgs: Anthropic.MessageParam[]): string[] {
  const ids: string[] = [];
  for (const m of msgs) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_result') ids.push(b.tool_use_id);
  }
  return ids;
}
/** Anthropic reverse-orphans = tool_results with no matching tool_use anywhere. */
function anthropicOrphanToolResults(msgs: Anthropic.MessageParam[]): string[] {
  const uses = new Set<string>();
  for (const m of msgs) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') uses.add(b.id);
  }
  return anthropicToolResultIds(msgs).filter((id) => !uses.has(id));
}
/** Chat-Completions reverse-orphans = tool messages with no matching assistant tool_call. */
function chatOrphanToolMessages(msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): string[] {
  const calls = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) calls.add(tc.id);
  }
  return msgs
    .filter((m): m is OpenAI.Chat.Completions.ChatCompletionToolMessageParam => m.role === 'tool')
    .map((m) => m.tool_call_id)
    .filter((id) => !calls.has(id));
}
/** OpenAI-Responses reverse-orphans = function_call_outputs with no matching function_call. */
function responsesOrphanOutputs(items: OpenAI.Responses.ResponseInputItem[]): string[] {
  const calls = new Set<string>();
  for (const it of items) if ((it as { type?: string }).type === 'function_call') calls.add((it as { call_id: string }).call_id);
  return items
    .filter((it) => (it as { type?: string }).type === 'function_call_output')
    .map((it) => (it as { call_id: string }).call_id)
    .filter((id) => !calls.has(id));
}
/** Gemini reverse-orphans = functionResponses with no matching functionCall (matched by name). */
function geminiOrphanResponses(contents: GeminiContent[]): string[] {
  const calls = new Set<string>();
  for (const c of contents) for (const part of c.parts) if (part.functionCall) calls.add(part.functionCall.name);
  const orphans: string[] = [];
  for (const c of contents) for (const part of c.parts) if (part.functionResponse && !calls.has(part.functionResponse.name)) orphans.push(part.functionResponse.name);
  return orphans;
}

describe('materializeReExecute — T12-fix: reverse-orphan elimination on a depth-3 deep resume', () => {
  const directive3: ReExecuteDirective = { toolUseId: 'C3', interactionId: 'i1', kind: 'tool_permission', toolName: 'Bash', agentPath: path3 };

  /**
   * Seed a depth-3 paused journal using the PRODUCTION pause writer
   * (`journalSubagentPause`) so the three ancestor deferred placeholders land in the EXACT
   * scopes production writes them — the behavior under test. Pre-pause rounds are seeded
   * manually (main → A1 → S1 → A2 → S2 → A3 → S3 → C3); journalSubagentPause then binds the
   * leaf interaction + writes the ancestor placeholders.
   */
  async function seedDepth3ViaPause(j: Journal): Promise<void> {
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'P1' } });
    await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S1 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path1);
    await ap(j, { type: 'tool_use', toolUseId: 'A2', name: 'Agent', input: { subagent_type: 's', prompt: 'P2' } }, path1);
    await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S2 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path2);
    await ap(j, { type: 'tool_use', toolUseId: 'A3', name: 'Agent', input: { subagent_type: 's', prompt: 'P3' } }, path2);
    await ap(j, { type: 'assistant', blocks: [{ type: 'text', text: 'S3 reasoning' } as never], api: 'a', provider: 'a', model: 'm' }, path3);
    await ap(j, { type: 'tool_use', toolUseId: 'C3', name: 'Bash', input: { cmd: 'ls' } }, path3);
    // PRODUCTION pause writer: binds the leaf interaction + writes the three ancestor
    // deferred placeholders (A1 unscoped/main, A2→scope[A1], A3→scope[A2] after the fix).
    await journalSubagentPause(j, 't', 'i1', 'tool_permission', 'C3', 'Bash', 'w', path3);
  }

  /** Resolve the deep pause (allow) through the real recursive driver; returns the recording. */
  async function resolveDepth3(j: Journal): Promise<AgentCall[]> {
    const calls: AgentCall[] = [];
    await materializeReExecute({
      directive: directive3, tools: [makeRecordingAgent(calls, { A3: 'S3 OUTPUT', A2: 'S2 OUTPUT', A1: 'S1 OUTPUT' }), makeBash({})],
      originalInput: { cmd: 'ls' }, outcome: allow(), journal: j, taskId: 't', harness: allowHarness, state: new InMemoryStatePort(),
    });
    return calls;
  }

  it('the MAIN projection is ORPHAN-FREE after the resume: every tool_result has a matching tool_use in the main scope (no reverse-orphans)', async () => {
    const j = make();
    await seedDepth3ViaPause(j);
    await resolveDepth3(j);

    const { messages } = await j.project();
    const toolUseIds = new Set(messages.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId));
    const resultIds = messages.filter((e) => e.payload.type === 'tool_result').map((e) => (e.payload as { toolUseId: string }).toolUseId);
    // A1 (the only main-scope Agent tool_use) is present with its real result; the A2/A3
    // ancestor placeholders are NO LONGER in main (co-scoped to their own scopes).
    expect(toolUseIds.has('A1')).toBe(true);
    expect(resultIds).toEqual(['A1']);
    // No reverse-orphan: every projected tool_result resolves to a tool_use in this scope.
    expect(resultIds.filter((id) => !toolUseIds.has(id))).toEqual([]);
  });

  it('the post-resume continue request is VALID on ALL FOUR transports (no orphan tool output) — Anthropic, Chat-Completions, OpenAI-Responses, Gemini', async () => {
    const j = make();
    await seedDepth3ViaPause(j);
    await resolveDepth3(j);
    const { messages } = await j.project();

    // Anthropic — its floor strips reverse-orphans, so this is the control (always valid).
    const anth = ensureValidAnthropicRequest(journalToAnthropicMessages(messages));
    expect(anthropicOrphanToolResults(anth)).toEqual([]);
    expect(anthropicToolResultIds(anth)).toContain('A1'); // not vacuous — A1's pair survives

    // Chat-Completions (GLM / every OpenAI-compatible provider) — floor does NOT strip.
    expect(chatOrphanToolMessages(journalToChatCompletionsMessages(messages))).toEqual([]);

    // OpenAI-Responses — floor does NOT strip.
    expect(responsesOrphanOutputs(journalToOpenAIResponsesInput(messages))).toEqual([]);

    // Gemini (matched by name) — floor does NOT strip.
    expect(geminiOrphanResponses(journalToGeminiContents(messages))).toEqual([]);
  });

  it('the re-entry SEED is dedup-clean: S1’s seed carries exactly ONE A2 result (the real one supersedes the now co-scoped deferred placeholder)', async () => {
    const j = make();
    await seedDepth3ViaPause(j);
    const calls = await resolveDepth3(j);

    // calls = [A3, A2, A1] re-entries; A1's seed (calls[2]) is S1's scope projection.
    expect(calls.map((c) => c.toolCallId)).toEqual(['A3', 'A2', 'A1']);
    const seedA1 = calls[2].resume?.seedEntries ?? [];
    const a2Results = seedA1.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A2');
    expect(a2Results).toHaveLength(1);
    expect(resultText(a2Results[0])).toBe('S2 OUTPUT'); // the REAL output, not the deferred placeholder
  });
});
