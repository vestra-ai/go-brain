import { describe, it, expect } from 'vitest';
import type { InteractionKind, InteractionOutcome } from '../../../contract/interaction.js';
import type { JournalPayload } from '../../../contract/journal.js';
import {
  MATERIALIZE_STRATEGY,
  REEXECUTE_BOUND_TOOLS,
  resolveMaterializeStrategy,
  planMaterialization,
  buildPendingInteractionData,
  buildResolvedInteractionData,
  buildDeferredResultContent,
  isDeferredResultContent,
  DEFERRED_STATUS,
  buildDelegatedResultContent,
  isDelegatedResultContent,
  parseDelegatedResultContent,
  DELEGATED_STATUS,
  type MaterializationPlan,
} from '../strategy.js';

// The single source of truth for the real enum (contract/interaction.ts InteractionKind).
const ALL_KINDS: InteractionKind[] = [
  'ask_question', 'composio_auth', 'tool_permission', 'credit_approval', 'exit_plan', 'custom',
  'hands_approval', 'plan_limit',
];

const allow = (updatedInput?: unknown): InteractionOutcome => ({ behavior: 'allow', updatedInput });
const deny = (reason: Extract<InteractionOutcome, { behavior: 'deny' }>['reason'], message?: string): InteractionOutcome =>
  ({ behavior: 'deny', reason, ...(message !== undefined ? { message } : {}) });

describe('K5-T0: MATERIALIZE_STRATEGY — exhaustive over the REAL InteractionKind enum', () => {
  it('covers exactly the real kinds and nothing else', () => {
    expect(Object.keys(MATERIALIZE_STRATEGY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('composio_auth AND tool_permission are the re_execute kinds; the answer-IS-result kinds are resolution_is_result', () => {
    // native-perm-reexec: a tool_permission ALLOW must RE-EXECUTE the approved tool
    // (run the paused Bash/Write/Composio once), NOT materialize {"status":"allowed"}
    // as its result. composio_auth was already re_execute.
    expect(MATERIALIZE_STRATEGY.composio_auth).toBe('re_execute');
    expect(MATERIALIZE_STRATEGY.tool_permission).toBe('re_execute');
    // ask_question / exit_plan / custom / credit_approval: the answer IS the result.
    for (const k of ALL_KINDS.filter((k) => k !== 'composio_auth' && k !== 'tool_permission')) {
      expect(MATERIALIZE_STRATEGY[k]).toBe('resolution_is_result');
    }
  });

  it('credit_approval + hands_approval are resolution_is_result — type-exhaustive ONLY (server_gate-driven, never K5-continued, §5C)', () => {
    // Pin the intent so a future editor does not "fix" these to re_execute: both
    // resolve via their gate's own held HTTP response and never enter driveContinue.
    expect(MATERIALIZE_STRATEGY.credit_approval).toBe('resolution_is_result');
    expect(MATERIALIZE_STRATEGY.hands_approval).toBe('resolution_is_result');
    // Engines T5: plan_limit is server-minted and server-resumed the same way.
    expect(MATERIALIZE_STRATEGY.plan_limit).toBe('resolution_is_result');
  });
});

describe('K5-T0: planMaterialization — the pure resolution→plan decision (§7)', () => {
  it('ALLOW on a resolution_is_result kind → a non-error tool_result carrying the updatedInput', () => {
    const plan = planMaterialization('ask_question', allow({ questions: ['Q'], answers: ['A'] }));
    expect(plan.action).toBe('result');
    const r = plan as Extract<MaterializationPlan, { action: 'result' }>;
    expect(r.isError).toBe(false);
    expect(r.content).toContain('answers');
    expect(r.content).toContain('A');
  });

  it('ALLOW on composio_auth → re_execute the original tool (NOT a canned result)', () => {
    expect(planMaterialization('composio_auth', allow()).action).toBe('re_execute');
  });

  it('native-perm-reexec: ALLOW on a tool_permission → re_execute the approved tool (run it once), NOT a canned {status:"allowed"} result', () => {
    // The bug this fixes: a user who approved a paused Bash/Write/Composio tool got
    // {"status":"allowed"} materialized AS the tool_result, so the tool never ran.
    // The approval must RE-EXECUTE the bound tool and surface its REAL output.
    expect(planMaterialization('tool_permission', allow()).action).toBe('re_execute');
  });

  it('ALLOW on an answer-IS-result kind with NO updatedInput → a {status:"allowed"} result (e.g. exit_plan grant)', () => {
    const plan = planMaterialization('exit_plan', allow()) as Extract<MaterializationPlan, { action: 'result' }>;
    expect(plan.action).toBe('result');
    expect(plan.isError).toBe(false);
    expect(JSON.parse(plan.content)).toEqual({ status: 'allowed' });
  });

  it('DENY on ANY kind → a deterministic non-error tool_result in PLAIN LANGUAGE (never re_execute, never bare JSON)', () => {
    for (const k of ALL_KINDS) {
      const plan = planMaterialization(k, deny('user_declined', 'no thanks'));
      expect(plan.action).toBe('result'); // composio_auth deny does NOT re-execute
      const r = plan as Extract<MaterializationPlan, { action: 'result' }>;
      expect(r.isError).toBe(false); // a refusal, not a tool error
      // Plain prose the model reads as a refusal + a no-retry instruction. NOT a bare JSON
      // status blob — the live bug (task 0046b07f) was the model reading {"status":"declined"}
      // as the command's stdout and RE-RUNNING the refused action.
      expect(r.content).toMatch(/declined/i);
      expect(r.content).toMatch(/not run|do not attempt it again|not retry/i);
      expect(r.content).toContain('no thanks'); // the caller's message is appended
      expect(() => JSON.parse(r.content)).toThrow(); // prose, not JSON
    }
  });

  it('maps each terminal deny reason to a CLEAR plain-language refusal (no JSON the model mistakes for stdout)', () => {
    const content = (reason: Parameters<typeof deny>[0]) =>
      (planMaterialization('tool_permission', deny(reason)) as Extract<MaterializationPlan, { action: 'result' }>).content;
    for (const reason of ['user_declined', 'user_skipped', 'timed_out', 'aborted', 'user_redirected'] as const) {
      const c = content(reason);
      expect(c).toMatch(/not run|do not run|do not attempt/i); // every refusal says the tool did NOT run
      expect(() => JSON.parse(c)).toThrow();                   // prose, never a JSON status blob
    }
    expect(content('user_declined')).toMatch(/declined/i);
    expect(content('user_skipped')).toMatch(/skipped/i);
    expect(content('timed_out')).toMatch(/no response/i);
    expect(content('aborted')).toMatch(/aborted/i);
    expect(content('user_redirected')).toMatch(/new instruction/i);
  });

  it('THROWS on the awaiting_user_input sentinel — that is the PAUSE halt, never a resolution (invariant guard)', () => {
    expect(() => planMaterialization('composio_auth', deny('awaiting_user_input'))).toThrow(/awaiting|pending|resolution/i);
  });
});

describe('native-perm-reexec: a tool_permission ALLOW RE-EXECUTES the approved tool (the general rule); Agent is a subset', () => {
  it('REEXECUTE_BOUND_TOOLS still tags the Agent subagent tool (the re-spawn subset)', () => {
    // After the general rule (tool_permission → re_execute), this set no longer
    // CHANGES the strategy — it now tags which re_execute is a SUBAGENT re-spawn vs a
    // leaf-tool re-run in the sandbox dispatcher. Agent must stay tagged.
    expect(REEXECUTE_BOUND_TOOLS.has('Agent')).toBe(true);
  });

  it('resolveMaterializeStrategy: a tool_permission ALLOW is re_execute for EVERY bound tool (Bash/Write/Composio AND Agent)', () => {
    // The bug: a leaf tool (Bash/Write) paused on tool_permission used to materialize
    // `{"status":"allowed"}` and never run. Now EVERY tool_permission re-executes.
    expect(resolveMaterializeStrategy('tool_permission', 'Agent')).toBe('re_execute');
    expect(resolveMaterializeStrategy('tool_permission', 'Bash')).toBe('re_execute');
    expect(resolveMaterializeStrategy('tool_permission', 'Write')).toBe('re_execute');
    expect(resolveMaterializeStrategy('tool_permission', undefined)).toBe('re_execute');
    // composio_auth stays re_execute regardless of tool.
    expect(resolveMaterializeStrategy('composio_auth', 'GMAIL_SEND_EMAIL')).toBe('re_execute');
    // The answer-IS-result kinds stay resolution_is_result regardless of tool.
    expect(resolveMaterializeStrategy('ask_question', 'AskUserQuestion')).toBe('resolution_is_result');
    expect(resolveMaterializeStrategy('exit_plan', 'ExitPlanMode')).toBe('resolution_is_result');
    expect(resolveMaterializeStrategy('custom', 'connect_mcp')).toBe('resolution_is_result');
  });

  it('planMaterialization: ALLOW on a tool_permission bound to a LEAF tool (Bash) → re_execute (NOT a canned {status:"allowed"})', () => {
    // The exact live-fire bug: a paused Bash curl approved must RUN the curl, not
    // materialize {"status":"allowed"} as its result.
    expect(planMaterialization('tool_permission', allow(), 'Bash').action).toBe('re_execute');
    expect(planMaterialization('tool_permission', allow(), 'Write').action).toBe('re_execute');
    // The Agent subset keeps re_execute too (re-spawn).
    expect(planMaterialization('tool_permission', allow(), 'Agent').action).toBe('re_execute');
  });

  it('planMaterialization: a DENY on a tool_permission (leaf OR Agent) does NOT re-execute (a declined permission settles a result, tool never runs)', () => {
    // A user who DENIES must NOT trigger a run/re-spawn — the denial is the result.
    // The deny branch runs before the tool-aware strategy for every bound tool.
    for (const toolName of ['Bash', 'Write', 'Agent'] as const) {
      const plan = planMaterialization('tool_permission', deny('user_declined'), toolName) as Extract<MaterializationPlan, { action: 'result' }>;
      expect(plan.action).toBe('result');
      expect(plan.content).toMatch(/declined/i);
    }
  });
});

describe('deferred tool_result (continue-alongside placeholder)', () => {
  it('builds a non-error deferred result the model can branch on', () => {
    const content = buildDeferredResultContent();
    const parsed = JSON.parse(content);
    expect(parsed.status).toBe('deferred');
    expect(DEFERRED_STATUS).toBe('deferred');
  });
  it('carries an optional note without em dashes or "Claude"', () => {
    const content = buildDeferredResultContent('still awaiting the connection; will auto-resume when resolved');
    expect(JSON.parse(content).note).toContain('auto-resume');
    expect(content).not.toMatch(/—/);
    expect(content).not.toMatch(/Claude/);
  });
  it('detects its own output and rejects a real result / declined result', () => {
    expect(isDeferredResultContent(buildDeferredResultContent())).toBe(true);
    expect(isDeferredResultContent(JSON.stringify({ status: 'allowed' }))).toBe(false);
    expect(isDeferredResultContent('plain string')).toBe(false); // non-JSON → false, never throws
  });
});

describe('delegated tool_result (Agent Teams settle marker — final answer + live lane)', () => {
  it('builds a structured delegated result carrying name + teammateTaskId', () => {
    const content = buildDelegatedResultContent('researcher', 't-child-1');
    const parsed = JSON.parse(content);
    expect(DELEGATED_STATUS).toBe('delegated');
    expect(parsed.status).toBe('delegated');
    expect(parsed.name).toBe('researcher');
    expect(parsed.teammateTaskId).toBe('t-child-1');
  });
  it('round-trips build → parse', () => {
    const content = buildDelegatedResultContent('writer', 't-child-2');
    expect(parseDelegatedResultContent(content)).toEqual({ name: 'writer', teammateTaskId: 't-child-2' });
  });
  it('detects its own output; rejects non-delegated / malformed JSON', () => {
    expect(isDelegatedResultContent(buildDelegatedResultContent('a', 'b'))).toBe(true);
    expect(isDelegatedResultContent(JSON.stringify({ status: 'allowed' }))).toBe(false);
    expect(isDelegatedResultContent('plain string')).toBe(false); // non-JSON → false, never throws
    expect(isDelegatedResultContent(42)).toBe(false); // non-string unknown → false, never throws
    expect(parseDelegatedResultContent('not json')).toBe(null);
    expect(parseDelegatedResultContent(JSON.stringify({ status: 'delegated' }))).toBe(null); // missing fields
  });
  it('cross-exclusion: deferred and delegated never mistake each other', () => {
    // Load-bearing: downstream treats them OPPOSITELY — deferred = not-a-real-answer,
    // delegated = final answer with a live teammate lane.
    expect(isDelegatedResultContent(buildDeferredResultContent())).toBe(false);
    expect(isDeferredResultContent(buildDelegatedResultContent('r', 't'))).toBe(false);
  });
});

describe('K5-T0: journal data builders ride the FROZEN interaction payload (zero schema change)', () => {
  it('buildPendingInteractionData yields {kind,toolUseId,toolName}', () => {
    expect(buildPendingInteractionData('composio_auth', 'tu_1', 'GMAIL_SEND_EMAIL')).toEqual({
      kind: 'composio_auth', toolUseId: 'tu_1', toolName: 'GMAIL_SEND_EMAIL',
    });
  });

  it('T3: OMITS subagentPath/subagentId when absent (byte-identical to today)', () => {
    // The optional subagent identity is inert until a later task populates it —
    // the absent-path object must deep-equal the pre-T3 shape with NO subagent keys.
    expect(buildPendingInteractionData('ask_question', 'tu_x', 'AskUserQuestion')).toEqual({
      kind: 'ask_question', toolUseId: 'tu_x', toolName: 'AskUserQuestion',
    });
  });

  it('T3: stamps subagentPath + subagentId when present', () => {
    const path = [{ depth: 1, agentToolUseId: 'agent_tu_1', agentSlug: 'scraper', agentName: 'Scraper' }];
    expect(buildPendingInteractionData('tool_permission', 'tu_leaf', 'Bash', path, 'agent_tu_1')).toEqual({
      kind: 'tool_permission', toolUseId: 'tu_leaf', toolName: 'Bash',
      subagentPath: path, subagentId: 'agent_tu_1',
    });
  });

  it('buildResolvedInteractionData yields {outcome,materializedAt} (clock injected, never read here)', () => {
    const out = allow({ x: 1 });
    expect(buildResolvedInteractionData(out, '2026-06-15T00:00:00.000Z')).toEqual({
      outcome: out, materializedAt: '2026-06-15T00:00:00.000Z',
    });
  });

  it('both builders fit the frozen { type:"interaction"; interactionId; resolved; data } payload', () => {
    const pending: JournalPayload = {
      type: 'interaction', interactionId: 'i1', resolved: false,
      data: buildPendingInteractionData('ask_question', 'tu_2', 'AskUserQuestion'),
    };
    const resolved: JournalPayload = {
      type: 'interaction', interactionId: 'i1', resolved: true,
      data: buildResolvedInteractionData(allow({ answers: ['yes'] }), '2026-06-15T00:00:00.000Z'),
    };
    expect(pending.type).toBe('interaction');
    expect((pending.data as { kind: string }).kind).toBe('ask_question');
    expect(resolved.resolved).toBe(true);
  });
});
