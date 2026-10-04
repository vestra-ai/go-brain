import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload, NewEntry } from '../../../contract/journal.js';
import type { InteractionOutcome } from '../../../contract/interaction.js';
import { Journal, suspendPending, liveSuspendedToolUseIds, planDeferrals } from '../journal.js';
import { computeSuspendedToolUseIds, isDeferredResultContent } from '../../interaction/strategy.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';

const dir = join(tmpdir(), `hitl-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  toolUse: (id: string, name = 'GMAIL_SEND_EMAIL'): JournalPayload => ({ type: 'tool_use', toolUseId: id, name, input: {} }),
  toolResult: (id: string, isError = false): JournalPayload => ({ type: 'tool_result', toolUseId: id, blocks: [], isError }),
  interaction: (interactionId: string, resolved: boolean, data: unknown): JournalPayload => ({ type: 'interaction', interactionId, resolved, data }),
};

/** Build a full JournalEntry[] with monotonic uuid/seq (for pure-fn tests). */
function entries(...payloads: JournalPayload[]): JournalEntry[] {
  return payloads.map((payload, i) => ({ uuid: `e${i}`, parentUuid: i === 0 ? null : `e${i - 1}`, seq: i, ...base, payload }));
}

const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });

const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-06-15T00:00:00.000Z'),
});

const allow = (updatedInput?: unknown): InteractionOutcome => ({ behavior: 'allow', updatedInput });

describe('computeSuspendedToolUseIds — payload-less wire entries never crash the scan', () => {
  it('ignores an entry with NO payload (the mirror legacy oversize stub, founder-hit 2026-07-15)', () => {
    const all = entries(
      P.toolUse('tu1'),
      P.interaction('i1', false, { toolUseId: 'tu1' }),
    );
    // A hydrated legacy stub: envelope-less on the wire; after the cast it is an
    // entry whose `payload` is undefined. The scan must skip it, not throw.
    all.push({ uuid: 'stub', parentUuid: 'e1', seq: 2, ...base, payload: undefined as never });
    expect(computeSuspendedToolUseIds(all)).toEqual(new Set(['tu1']));
  });
});

describe('K5-T1: suspendPending — drops a tool_use bound to an UNRESOLVED interaction (clean suspend)', () => {
  it('drops the dangling paused tool_use so history ends on a clean boundary', () => {
    const all = entries(
      P.user('do it'),
      P.toolUse('tu1'),
      P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' }),
    );
    const out = suspendPending(all);
    expect(out.find((e) => e.payload.type === 'tool_use')).toBeUndefined(); // tu1 suspended out
    expect(out.find((e) => e.payload.type === 'user')).toBeDefined(); // user kept
  });

  it('is identity when there are no unresolved interactions', () => {
    const all = entries(P.user('hi'), P.toolUse('tu1'), P.toolResult('tu1'));
    expect(suspendPending(all)).toBe(all); // same reference — no work
  });

  it('does NOT suspend a tool_use whose interaction is RESOLVED and answered (complete pair stays)', () => {
    const all = entries(
      P.user('do it'),
      P.toolUse('tu1'),
      P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'X' }),
      P.toolResult('tu1'),
      P.interaction('i1', true, { outcome: allow(), materializedAt: 'iso' }),
    );
    const out = suspendPending(all);
    expect(out.find((e) => e.payload.type === 'tool_use')).toBeDefined(); // answered → kept
    expect(out.find((e) => e.payload.type === 'tool_result')).toBeDefined();
  });

  it('with two pending tool_uses in one batch, drops both danglers but keeps the answered one', () => {
    const all = entries(
      P.user('go'),
      P.toolUse('tuA'), P.toolResult('tuA'),         // answered
      P.toolUse('tuB'), P.interaction('iB', false, { kind: 'ask_question', toolUseId: 'tuB', toolName: 'AskUserQuestion' }),
      P.toolUse('tuC'), P.interaction('iC', false, { kind: 'composio_auth', toolUseId: 'tuC', toolName: 'X' }),
    );
    const out = suspendPending(all);
    const useIds = out.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(useIds).toEqual(['tuA']); // B and C suspended; A kept
  });
});

describe('K5-T1: project() suspends a paused tool_use (the model never sees an orphan tool_use)', () => {
  it('omits the dangling paused tool_use from the projected messages', async () => {
    const j = make();
    await j.append(newEntry(P.user('send the email')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    const { messages } = await j.project();
    expect(messages.some((m) => m.payload.type === 'tool_use')).toBe(false); // suspended out
    expect(messages.some((m) => m.payload.type === 'user')).toBe(true);
  });
});

describe('K5-T1: healOrphanedToolUse SKIPS interaction-bound orphans (suspended, not crashed)', () => {
  it('does NOT synthesize an error stub for a tool_use bound to an unresolved interaction', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'X' })));
    await j.healOrphanedToolUse();
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect(raw.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0); // no stub appended
  });

  it('DOES synthesize an error stub for a TRUE orphan (no interaction → real crash)', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.toolUse('tu_crash')));
    await j.healOrphanedToolUse();
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    const stub = raw.find((e) => e.payload.type === 'tool_result');
    expect(stub).toBeDefined();
    expect((stub!.payload as { isError: boolean }).isError).toBe(true);
  });
});

describe('K5-T1: reconcileInteractions(getResolution) — materialize in place / re_execute / re-suspend', () => {
  it('resolution_is_result kind → appends the tool_result from the outcome + a resolved interaction entry', async () => {
    const j = make();
    await j.append(newEntry(P.user('pick one')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));
    const out = await j.reconcileInteractions(async () => allow({ answers: ['B'] }));
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    const result = raw.find((e) => e.payload.type === 'tool_result') as JournalEntry;
    expect(result).toBeDefined();
    expect((result.payload as { toolUseId: string }).toolUseId).toBe('tu1');
    expect(raw.filter((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean }).resolved)).toHaveLength(1);
    // now the model sees a complete, non-suspended pair
    const { messages } = await j.project();
    expect(messages.some((m) => m.payload.type === 'tool_use' && (m.payload as { toolUseId: string }).toolUseId === 'tu1')).toBe(true);
    expect(messages.some((m) => m.payload.type === 'tool_result' && (m.payload as { toolUseId: string }).toolUseId === 'tu1')).toBe(true);
  });

  it('composio_auth allow → collects a re_execute directive, appends NO tool_result (T3 dispatches)', async () => {
    const j = make();
    await j.append(newEntry(P.user('email me')));
    await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    const out = await j.reconcileInteractions(async () => allow());
    expect(out.reExecute).toEqual([{ toolUseId: 'tu1', interactionId: 'i1', kind: 'composio_auth', toolName: 'GMAIL_SEND_EMAIL' }]);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect(raw.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0); // no result yet
  });

  it('still-pending (getResolution → null) → leaves the orphan suspended, no stub, no result', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'X' })));
    const out = await j.reconcileInteractions(async () => null);
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect(raw.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0);
  });

  it('true orphan (no interaction) → synthesizes an error stub (subsumes heal)', async () => {
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append(newEntry(P.toolUse('tu_crash')));
    const out = await j.reconcileInteractions(async () => null);
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    const stub = raw.find((e) => e.payload.type === 'tool_result');
    expect((stub!.payload as { isError: boolean }).isError).toBe(true);
  });

  it('SCOPE-TAGGED orphan (a subagent inner tool_use) → NO main-scope stub (lives in the subagent scope, not a main crash orphan)', async () => {
    // Live task 1067a95b: the weave node ran a subagent whose inner Bash is journaled
    // SCOPE-TAGGED (agentPath). The pause bound to the PARENT Weave tool_use, so the inner
    // Bash has no interaction of its own — but it is NOT a main-scope crash orphan. reconcile
    // must not synthesize a MAIN-scope tool_result for it (that planted a reverse-orphan the
    // projection then had to strip). The subagent scope owns the inner call's settle.
    const agentPath = [{ depth: 1, agentToolUseId: 'node-1', agentSlug: 'general-purpose', agentName: 'general-purpose' }];
    const j = make();
    await j.append(newEntry(P.user('go')));
    await j.append({ ...base, agentPath, payload: P.toolUse('inner-bash', 'Bash') } as NewEntry);
    const out = await j.reconcileInteractions(async () => null);
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    // No MAIN-scope tool_result was synthesized for the scope-tagged inner tool_use.
    const mainResults = raw.filter((e) => e.payload.type === 'tool_result' && !(e.agentPath && e.agentPath.length));
    expect(mainResults).toHaveLength(0);
  });

  it('COMPACTED-BEFORE-RESOLUTION → NO-OP (assertCompactedBeforeResolutionNoOp): no orphan tool_result, but the row settles', async () => {
    // A paused tool_use that compaction has already summarized away (seq < firstKept).
    // reconcile must NOT materialize a tool_result for a tool_use that no longer
    // survives the projection (that would orphan the result) — it appends only the
    // resolved interaction entry to settle the row (§7).
    const j = make('compacted');
    await j.append(newEntry(P.user('old turn')));                                   // e0
    await j.append(newEntry(P.toolUse('tuGone', 'AskUserQuestion')));               // e1 (will be compacted away)
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tuGone', toolName: 'AskUserQuestion' }))); // e2
    const summary = await j.append(newEntry(P.user('SUMMARY of old history')));     // e3 (summary)
    const recent = await j.append(newEntry(P.user('recent turn')));                 // e4 (firstKept)
    await j.compact({ summaryUuid: summary.uuid, firstKeptId: recent.uuid, preservedUuids: [], trigger: 'manual', preTokens: 0, postTokens: 0, base });

    const out = await j.reconcileInteractions(async () => allow({ answers: ['B'] }));
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    // NO tool_result materialized (the tool_use is gone from the projection)
    expect(raw.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0);
    // but the resolved interaction entry IS appended → row settled → idempotent
    expect(raw.filter((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean }).resolved)).toHaveLength(1);
    // and the projection has NO orphan tool_result
    const { messages } = await j.project();
    expect(messages.some((m) => m.payload.type === 'tool_result')).toBe(false);
  });

  it('COMPACTED-BEFORE-RESOLUTION composio_auth → NO re_execute (no SECOND side-effect), row settles', async () => {
    // The DANGEROUS case (F1): a composio tool_use is a REAL side-effect (sends an email).
    // If it was compacted away before the OAuth resolved, the re_execute branch must NOT
    // re-dispatch it — that re-sends the email — and must NOT orphan a tool_result for a
    // tool_use the projection no longer contains. It only settles the interaction row (§8.7).
    const j = make('composio-compacted');
    await j.append(newEntry(P.user('email keshav')));                                 // e0
    await j.append(newEntry(P.toolUse('tuGone', 'GMAIL_SEND_EMAIL')));                // e1 (compacted away)
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tuGone', toolName: 'GMAIL_SEND_EMAIL' }))); // e2
    const summary = await j.append(newEntry(P.user('SUMMARY of old history')));       // e3
    const recent = await j.append(newEntry(P.user('recent turn')));                   // e4 (firstKept)
    await j.compact({ summaryUuid: summary.uuid, firstKeptId: recent.uuid, preservedUuids: [], trigger: 'manual', preTokens: 0, postTokens: 0, base });

    const out = await j.reconcileInteractions(async () => allow());
    // NO re_execute directive → T3 never re-dispatches → the email is NOT re-sent.
    expect(out.reExecute).toHaveLength(0);
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect(raw.filter((e) => e.payload.type === 'tool_result')).toHaveLength(0); // no orphan result
    // but the row IS settled (resolved interaction entry) → the continue is idempotent.
    expect(raw.filter((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean }).resolved)).toHaveLength(1);
    const { messages } = await j.project();
    expect(messages.some((m) => m.payload.type === 'tool_result')).toBe(false);
  });

  it('COMPACTION + SUSPEND precedence (§8.7): a KEPT paused tool_use resolves to a complete pair the model sees', async () => {
    // The paused tool_use is on the KEPT side of a compaction. While unresolved,
    // suspendPending drops it from the projection (clean). After resolution, reconcile
    // materializes its result and the projection shows the complete pair.
    const j = make('kept');
    const summary = await j.append(newEntry(P.user('SUMMARY')));                    // e0 (summary)
    const recent = await j.append(newEntry(P.user('do the thing')));               // e1 (firstKept)
    await j.append(newEntry(P.toolUse('tuKept', 'AskUserQuestion')));              // e2 (kept, paused)
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tuKept', toolName: 'AskUserQuestion' }))); // e3
    await j.compact({ summaryUuid: summary.uuid, firstKeptId: recent.uuid, preservedUuids: [], trigger: 'manual', preTokens: 0, postTokens: 0, base });

    // while unresolved: suspendPending drops the kept-but-paused tool_use (no orphan to the API)
    expect((await j.project()).messages.some((m) => m.payload.type === 'tool_use')).toBe(false);

    await j.reconcileInteractions(async () => allow({ answers: ['yes'] }));
    const { messages } = await j.project();
    const has = (t: string, id: string) => messages.some((m) => m.payload.type === t && (m.payload as { toolUseId?: string }).toolUseId === id);
    expect(has('tool_use', 'tuKept')).toBe(true);   // now visible
    expect(has('tool_result', 'tuKept')).toBe(true); // complete pair
  });

  it('alive == recycled: reconcile against a COLD-hydrated journal == warm (byte-identical projection)', async () => {
    const path = join(dir, 'recycle.jsonl');
    const mk = () => new Journal({ taskId: 'recycle', workspaceId: 'w', jsonl: new JsonlStore(path), mirror: new InMemorySessionStore(), clock: sequentialClock('2026-06-15T00:00:00.000Z') });
    const warm = mk();
    await warm.append(newEntry(P.user('pick')));
    await warm.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await warm.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));
    // COLD: a fresh Journal over the same file rebuilds from disk, then reconciles.
    const cold = mk();
    await cold.reconcileInteractions(async () => allow({ answers: ['B'] }));
    const coldMsgs = (await cold.project()).messages.map((m) => m.payload.type);
    expect(coldMsgs).toContain('tool_use');
    expect(coldMsgs).toContain('tool_result');
  });
});

describe('K5-FIX-D: liveSuspendedToolUseIds — only LIVE (post-compaction) suspended tool_uses block a continue', () => {
  it('a LIVE partial-batch sibling counts (the continue must re-suspend)', () => {
    const all = entries(
      P.user('two questions'),
      P.toolUse('tuA', 'AskUserQuestion'),
      P.toolUse('tuB', 'AskUserQuestion'),
      P.interaction('iA', false, { kind: 'ask_question', toolUseId: 'tuA', toolName: 'AskUserQuestion' }),
      P.interaction('iB', false, { kind: 'ask_question', toolUseId: 'tuB', toolName: 'AskUserQuestion' }),
      P.toolResult('tuA'), // iA materialized; tuB still suspended AND live
    );
    expect(liveSuspendedToolUseIds(all)).toEqual(new Set(['tuB']));
  });

  it('a suspended tool_use COMPACTED AWAY does NOT count (an abandoned/capped interaction never strands future continues)', async () => {
    const j = make('fixd');
    await j.append(newEntry(P.user('old')));
    await j.append(newEntry(P.toolUse('tuGone', 'GMAIL_SEND_EMAIL')));
    // iOld is abandoned — resolved:false forever (e.g. a prior continue that hit the cap).
    await j.append(newEntry(P.interaction('iOld', false, { kind: 'composio_auth', toolUseId: 'tuGone', toolName: 'GMAIL_SEND_EMAIL' })));
    const summary = await j.append(newEntry(P.user('SUMMARY of old')));
    const recent = await j.append(newEntry(P.user('recent')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry(P.toolResult('tu1'))); // tu1 live + answered
    await j.compact({ summaryUuid: summary.uuid, firstKeptId: recent.uuid, preservedUuids: [], trigger: 'manual', preTokens: 0, postTokens: 0, base });

    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    // The RAW scan flags the abandoned-compacted tuGone (resolved:false survives forever)…
    expect(computeSuspendedToolUseIds(all)).toEqual(new Set(['tuGone']));
    // …but the LIVE gate excludes it (it's gone from the post-compaction view) → the
    // continue is NOT stranded; nothing live is suspended → it can drive.
    expect(liveSuspendedToolUseIds(all)).toEqual(new Set());
  });
});

describe('deferSuspended — continue-alongside', () => {
  it('planDeferrals yields one deferred result per LIVE-suspended tool_use', () => {
    const all = entries(
      P.user('send the invite'),
      P.toolUse('tu1', 'GMAIL_SEND_EMAIL'),
      P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' }),
    );
    const deferrals = planDeferrals(all);
    expect(deferrals).toHaveLength(1);
    expect(deferrals[0].toolUseId).toBe('tu1');
    expect(isDeferredResultContent(deferrals[0].content)).toBe(true);
  });

  it('Journal.deferSuspended makes the tool_use show in the projection (no longer dropped) while the interaction stays pending', async () => {
    const j = make();
    await j.append(newEntry(P.user('send the invite')));
    await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));

    // before: suspendPending drops the paused tool_use
    expect((await j.project()).messages.some((m) => m.payload.type === 'tool_use')).toBe(false);

    const deferred = await j.deferSuspended('still awaiting the connection; will auto-resume when resolved');
    expect(deferred).toEqual(['tu1']);

    // after: the tool_use + its deferred tool_result are now in the projection
    const msgs = (await j.project()).messages;
    expect(msgs.some((m) => m.payload.type === 'tool_use' && m.payload.toolUseId === 'tu1')).toBe(true);
    const tr = msgs.find((m) => m.payload.type === 'tool_result' && m.payload.toolUseId === 'tu1');
    const trText = (tr?.payload as { blocks?: Array<{ text?: string }> })?.blocks?.[0]?.text ?? '';
    expect(isDeferredResultContent(trText)).toBe(true);

    // the interaction is STILL pending (resolvable later)
    const raw: JournalEntry[] = [];
    for await (const e of j.read()) raw.push(e);
    expect(raw.some((e) => e.payload.type === 'interaction' && e.payload.interactionId === 'i1' && e.payload.resolved === false)).toBe(true);
  });
});

describe('reconcileInteractions — forward-resume of a deferred pause', () => {
  it('a deferred-then-resolved interaction settles + emits forwardResume, with no second tool_result', async () => {
    const j = make();
    await j.append(newEntry(P.user('invite Bob for Tuesday')));
    await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    await j.deferSuspended();                       // user continued: slot deferred, interaction still pending
    await j.append(newEntry(P.user('actually move it to Friday')));

    const before: JournalEntry[] = []; for await (const e of j.read()) before.push(e);
    const toolResultsBefore = before.filter((e) => e.payload.type === 'tool_result' && e.payload.toolUseId === 'tu1').length;
    expect(toolResultsBefore).toBe(1);             // only the deferred result

    // the connection is made later:
    const result = await j.reconcileInteractions(async (id) => (id === 'i1' ? allow() : null));

    expect(result.forwardResume).toHaveLength(1);
    expect(result.forwardResume[0]).toMatchObject({ toolUseId: 'tu1', interactionId: 'i1', kind: 'composio_auth' });
    expect(result.reExecute).toHaveLength(0);      // NOT a re_execute (slot already answered)

    const after: JournalEntry[] = []; for await (const e of j.read()) after.push(e);
    // no SECOND tool_result spliced in place (A6: forward, immutable history)
    expect(after.filter((e) => e.payload.type === 'tool_result' && e.payload.toolUseId === 'tu1').length).toBe(1);
    // the interaction row is now settled (a resolved:true entry was appended; the pending one is untouched)
    expect(after.some((e) => e.payload.type === 'interaction' && e.payload.interactionId === 'i1' && e.payload.resolved === true)).toBe(true);
  });

  it('a still-pending deferred interaction yields no forwardResume (getResolution null)', async () => {
    const j = make();
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    await j.deferSuspended();
    const result = await j.reconcileInteractions(async () => null);
    expect(result.forwardResume).toHaveLength(0);
  });

  // ── D4 headline proof: Tuesday → Friday late-resume takes in-between context ──
  // This is the END-TO-END proof of the whole feature at the journal projection
  // level, layered on top of the wire-level forwardResume test above. The model
  // proposed sending an invite for "Tuesday", the connection was missing, the user
  // continued ("move it to Friday"), and the connection arrived LATER. The proof:
  // the projection the next drive re-decides on contains BOTH the original deferred
  // turn AND the "Friday" correction, and the ONLY result for the original tool_use
  // is the deferred placeholder (the stale "Tuesday" args are never replayed as a
  // real result). A regression that re-materialized the Tuesday tool_result in place
  // (the pre-fix retroactive-edit behavior) would surface a SECOND, non-deferred
  // result here, and the model would re-decide off stale args — this test catches it.
  it('Tuesday→Friday: after a late resolution the next-drive projection holds BOTH the deferred turn and the Friday message, and the only result for the original tool is the deferred one (no stale "Tuesday" replay)', async () => {
    const j = make('tue-fri');
    await j.append(newEntry(P.user('invite Bob for Tuesday')));
    await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL'))); // input referenced "Tuesday"
    await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    await j.deferSuspended();                                       // user continued: slot deferred, interaction pending
    await j.append(newEntry(P.user('actually move it to Friday'))); // the in-between correction

    // The deferred result is the SOLE result for tu1, and it reads as deferred.
    const deferredResultText = (msgs: { payload: { type: string; toolUseId?: string; blocks?: Array<{ text?: string }> } }[]) => {
      const trs = msgs.filter((m) => m.payload.type === 'tool_result' && m.payload.toolUseId === 'tu1');
      return trs.map((m) => m.payload.blocks?.[0]?.text ?? '');
    };
    const beforeMsgs = (await j.project()).messages as never as { payload: { type: string; toolUseId?: string; blocks?: Array<{ text?: string }> } }[];
    const beforeResults = deferredResultText(beforeMsgs);
    expect(beforeResults).toHaveLength(1);
    expect(isDeferredResultContent(beforeResults[0])).toBe(true);

    // The connection arrives LATER → the deferred pause resolves.
    const result = await j.reconcileInteractions(async (id) => (id === 'i1' ? allow() : null));
    expect(result.forwardResume).toHaveLength(1);

    // (c) The projection the next drive re-decides on holds BOTH messages, in order:
    //     the original "Tuesday" turn (deferred, NOT dropped) AND the "Friday" correction.
    const after = (await j.project()).messages as never as { payload: { type: string; toolUseId?: string; blocks?: Array<{ text?: string }> } }[];
    const userTexts = after.filter((m) => m.payload.type === 'user').map((m) => m.payload.blocks?.[0]?.text ?? '');
    expect(userTexts).toContain('invite Bob for Tuesday');
    expect(userTexts).toContain('actually move it to Friday');
    const tuesdayIdx = userTexts.indexOf('invite Bob for Tuesday');
    const fridayIdx = userTexts.indexOf('actually move it to Friday');
    expect(tuesdayIdx).toBeLessThan(fridayIdx); // chronological: Tuesday before the Friday correction

    // The deferred tool_use itself is still visible to the model (not re-orphaned)…
    expect(after.some((m) => m.payload.type === 'tool_use' && m.payload.toolUseId === 'tu1')).toBe(true);
    // …and its ONLY result is STILL the single deferred placeholder. No second
    // "Tuesday" result was materialized in place (A6 immutable history + D4 no-stale-replay).
    const afterResults = deferredResultText(after);
    expect(afterResults).toHaveLength(1);
    expect(isDeferredResultContent(afterResults[0])).toBe(true);
  });
});

describe('K5-T5b: assertPartialResolutionReSuspends — a partial batch resolution leaves siblings suspended', () => {
  it('two paused tools, resolve ONE → only that tool_use is answered; the sibling stays suspended', async () => {
    const j = make('partial');
    // ONE assistant turn paused on TWO tools (a batch).
    await j.append(newEntry(P.user('two questions')));
    await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
    await j.append(newEntry(P.toolUse('tu2', 'AskUserQuestion')));
    await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));
    await j.append(newEntry(P.interaction('i2', false, { kind: 'ask_question', toolUseId: 'tu2', toolName: 'AskUserQuestion' })));

    const before: JournalEntry[] = [];
    for await (const e of j.read()) before.push(e);
    expect(computeSuspendedToolUseIds(before)).toEqual(new Set(['tu1', 'tu2']));

    // Resolve ONLY i1 (the sibling i2 returns null → left pending).
    await j.reconcileInteractions(async (id) => (id === 'i1' ? allow({ answers: ['A'] }) : null));

    const after: JournalEntry[] = [];
    for await (const e of j.read()) after.push(e);
    // tu1 materialized → drops out of the suspended set; tu2 remains suspended →
    // the continue RE-SUSPENDS (the model can't proceed with a half-answered batch).
    expect(computeSuspendedToolUseIds(after)).toEqual(new Set(['tu2']));
    expect(after.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'tu1')).toBe(true);
    expect(after.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'tu2')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W4-2 — the two breadcrumbs take a user-ROLE slot (the only slot a provider
// accepts as the latest message) while attributing themselves to the SYSTEM
// principal, "so [they are] never mistaken for a user message". The injection
// screen's boundary set now READS that principal as its retroactive arm
// (policy/injection-screen.ts). Nothing pinned the mint, so a well-meaning
// "these are user entries, stamp them as such" would have re-opened the hole in
// silence. This is that pin.
// ─────────────────────────────────────────────────────────────────────────────
describe('HITL breadcrumbs are user-ROLE but SYSTEM-principal', () => {
  it('appendForwardResumeBreadcrumb writes type:user with principal.kind system', async () => {
    const j = make('bc-forward');
    const e = await j.appendForwardResumeBreadcrumb([{ kind: 'composio_auth', toolName: 'GMAIL_SEND_EMAIL', outcome: { behavior: 'allow' } }]);
    expect(e.payload.type).toBe('user');
    expect(e.principal.kind).toBe('system');
    // and no other discriminator — the principal is the ONLY signal it carries.
    expect((e.payload as { control?: unknown }).control).toBeUndefined();
    expect((e.payload as { injected?: unknown }).injected).toBeUndefined();
  });

  it('appendWorldDeltaBreadcrumb is the same shape', async () => {
    const j = make('bc-world');
    const e = await j.appendWorldDeltaBreadcrumb('[System] About 3 hours passed while paused.');
    expect(e.payload.type).toBe('user');
    expect(e.principal.kind).toBe('system');
    expect((e.payload as { injected?: unknown }).injected).toBeUndefined();
  });

  it('CONTRAST — appendUserEntry-minted entries are user-principal, which is why they need the field', async () => {
    // The two arms cover disjoint populations, and this is the line between them:
    // a breadcrumb is caught by its principal; anything the loop appends through
    // appendUserEntry is NOT, because a person's words come down the same path.
    const j = make('bc-contrast');
    const e = await j.append({
      ...base,
      principal: { kind: 'user', userId: 'w' },
      payload: { type: 'user', blocks: [{ type: 'text', text: 'a real ask' }] },
    });
    expect(e.principal.kind).toBe('user');
  });
});
