/**
 * capture-signal.test.ts — P5 Task 3: the in-loop write-on-surprise signal.
 *
 * assessTurnSurprise is PURE and COMPOSES the kernel salience machinery
 * (SalienceVector → prefilterScore → passesPrefilter + detectConvoCorrection)
 * — never a parallel scoring stack. It reads the turn off the journal
 * projection: correction = a repair marker in THIS turn's user entry after
 * substantive prior agent work; structural failures (tool hard errors,
 * failed/aborted/declined/paused outcomes) feed the score; unknown signals
 * stay null (never 0 — the kernel's UNKNOWN discipline).
 */
import { describe, it, expect } from 'vitest';
import { assessTurnSurprise, shouldCapture, NAMI_CAPTURE_SIGNAL_EVENT } from '../capture-signal.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u-${seq}`,
    parentUuid: null,
    seq,
    taskId: 't-cap',
    rootTaskId: 't-cap',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}
const user = (text: string): JournalEntry => entry({ type: 'user', blocks: [{ type: 'text', text }] });
const assistant = (text: string): JournalEntry => entry({ type: 'assistant', blocks: [{ type: 'text', text }] });
const toolUse = (name: string): JournalEntry => entry({ type: 'tool_use', toolUseId: `tu-${seq + 1}`, name, input: {} });
const toolResult = (text: string, isError?: boolean): JournalEntry =>
  entry({ type: 'tool_result', toolUseId: `tu-${seq}`, blocks: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

const completed: TurnOutcome = {
  kind: 'completed', summary: 'ok', costUsd: 0.01, numTurns: 1, durationMs: 5,
  modelUsage: {}, raw: { subtype: 'success', errors: [] },
};
const refused = { kind: 'refused', raw: { subtype: 'refusal', errors: [] } } as unknown as TurnOutcome;
const aborted = { kind: 'user_aborted', raw: { subtype: 'user_aborted', errors: [] } } as unknown as TurnOutcome;

describe('assessTurnSurprise (pure, composes kernel salience)', () => {
  it('a user correction after substantive agent work → forcing capture', () => {
    const entries = [user('deploy it'), toolUse('Bash'), toolResult('done'), assistant('deployed to prod'), user('no, that should be staging')];
    const s = assessTurnSurprise(entries, completed, false);
    expect(s.correction).toBe(true);
    expect(s.forcing).toBe(true);
    expect(shouldCapture(s)).toBe(true);
  });

  it('a bland completed turn → no capture', () => {
    const entries = [user('deploy it'), toolUse('Bash'), toolResult('done'), assistant('deployed')];
    const s = assessTurnSurprise(entries, completed, false);
    expect(s.correction).toBe(false);
    expect(s.forcing).toBe(false);
    expect(s.score).toBe(0);
    expect(shouldCapture(s)).toBe(false);
  });

  it('a repair marker in the FIRST user message (no prior agent work) does NOT fire', () => {
    const entries = [user('no thanks, just list the files'), toolUse('Bash'), toolResult('ok')];
    const s = assessTurnSurprise(entries, completed, false);
    expect(s.correction).toBe(false);
    expect(shouldCapture(s)).toBe(false);
  });

  it('a refused outcome → forcing (userDeclined), captures', () => {
    const s = assessTurnSurprise([user('do the thing')], refused, false);
    expect(s.outcomeKind).toBe('refused');
    expect(s.forcing).toBe(true);
    expect(shouldCapture(s)).toBe(true);
  });

  it('a user abort scores (userAbort weight 1) and captures at the default theta', () => {
    const s = assessTurnSurprise([user('do the thing')], aborted, false);
    expect(s.score).toBeGreaterThanOrEqual(1);
    expect(shouldCapture(s)).toBe(true);
  });

  it("tool hard errors in THIS turn's span score; a PRIOR turn's errors do not", () => {
    const thisTurn = [user('old ask'), toolUse('Bash'), toolResult('boom', true), user('new ask'), toolUse('Bash'), toolResult('ok')];
    const s = assessTurnSurprise(thisTurn, completed, false);
    expect(s.score).toBe(0); // the error belongs to the PREVIOUS turn's span
    const withError = [user('ask'), toolUse('Bash'), toolResult('boom', true)];
    const s2 = assessTurnSurprise(withError, completed, false);
    expect(s2.score).toBeGreaterThanOrEqual(1);
    expect(shouldCapture(s2)).toBe(true);
  });

  it('the wire event name matches the shared EVENTS constant by value (conformance)', () => {
    expect(NAMI_CAPTURE_SIGNAL_EVENT).toBe('nami:capture_signal');
  });
});

// ── P5 Task 2 interaction (fleet follow-up, PR #1347): journaled recall
// fences ride user entries — the correction detector must never read them as
// user intent (a remembered fact containing "no"/"not" would false-fire).
describe('recall-fence interaction (both dark flags on)', () => {
  const fence = (): JournalEntry =>
    entry({
      type: 'user',
      blocks: [
        {
          type: 'text',
          text: '<recalled_memory authority="curated" source="nami">\n- keshav prefers: not deploying on fridays\n</recalled_memory>',
        },
      ],
    });

  it('a journaled recall fence with repair markers does NOT fire the correction detector', () => {
    const entries = [user('deploy it'), toolUse('Bash'), toolResult('done'), assistant('deployed'), fence()];
    const s = assessTurnSurprise(entries, completed, false);
    expect(s.correction).toBe(false);
    expect(shouldCapture(s)).toBe(false);
  });

  it('a REAL user correction still fires when a fence sits between them', () => {
    const entries = [
      user('deploy it'),
      toolUse('Bash'),
      toolResult('done'),
      assistant('deployed to prod'),
      fence(),
      user('no, that should be staging'),
    ];
    const s = assessTurnSurprise(entries, completed, false);
    expect(s.correction).toBe(true);
    expect(shouldCapture(s)).toBe(true);
  });
});
