/**
 * T9c fix round 2 — the continuation marker must be INVISIBLE to every consumer that
 * means "what the person said".
 *
 * The T9c marker is the fifth engine-minted `user`-role door. It was registered in
 * `isEngineInjectedUserText`, but four consumers in this package answer "which entry is
 * the user's latest message?" with their OWN local rule — `isRecallFence(text)` by name,
 * or a bare `payload.type === 'user'`. None of them were swept, and after a split-turn
 * compaction the marker IS the last user entry for the rest of the turn (the mint happens
 * inside `compactTurnHead`; every later consult runs after it). So each of them silently
 * switched to reading engine boilerplate as the user's intent.
 *
 * That is precisely the failure `contract/injected-user-text.ts`'s header exists to
 * prevent — "each [consumer] used to carry its own copy of the answer" — re-created for
 * the door this change added. The fix is one predicate, `isRealUserTurn`, at each site:
 * it subsumes the fence rule (a fence is engine-minted) and keeps the load-bearing
 * negative control (a STEER is the person speaking and stays visible).
 *
 * Every leg here drives the REAL consumer function over the real post-compaction
 * projection shape. Nothing is re-implemented in the test.
 */
import { describe, it, expect } from 'vitest';
import { buildRecallQuery, fenceRecall } from '../recall.js';
import { assessTurnSurprise, shouldCapture } from '../capture-signal.js';
import { suggestionHistoryFromProjection } from '../offloop-usage.js';
import { computeJournalStats } from '../../kernel/journal/journal-stats.js';
import {
  COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
  STEER_MARKER_PREFIX,
} from '../../contract/injected-user-text.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';

/** The summary a split-turn compaction leaves leading the projection. */
const SUMMARY_TEXT =
  '## Latest request — read every file under apps/server/src/routes and report which ones ' +
  'still import the legacy withAuth helper\n## Next step — continue at file 24 of 30';

let seq = 0;
function entry(
  payload: Record<string, unknown>,
  opts: { minutes?: number } = {},
): JournalEntry {
  const n = seq++;
  return {
    uuid: `e-${n}`,
    seq: n,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal:
      payload.type === 'user' ? { kind: 'user', userId: 'u' } : { kind: 'agent', agentId: 'native' },
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, opts.minutes ?? n)).toISOString(),
    payload,
  } as unknown as JournalEntry;
}

const userEntry = (text: string, injected?: 'engine' | 'hook'): JournalEntry =>
  entry({ type: 'user', blocks: [{ type: 'text', text }], ...(injected && { injected }) });

/**
 * The projection a split-turn compaction leaves behind, in order:
 * summary(user) → the retained round → the T9c marker. Exactly what the drill's journal
 * showed, and exactly what every consult from the compaction onward now walks.
 */
function postCompactionProjection(markerInjected: 'engine' | undefined = 'engine'): JournalEntry[] {
  seq = 0;
  return [
    userEntry(SUMMARY_TEXT),
    entry({ type: 'assistant', blocks: [{ type: 'text', text: 'checking file 24' }] }),
    entry({ type: 'tool_use', toolUseId: 'tu-24', name: 'Bash', input: { command: 'cat x.ts' } }),
    entry({ type: 'tool_result', toolUseId: 'tu-24', blocks: [{ type: 'text', text: 'ok' }] }),
    userEntry(COMPACTION_SPLIT_TURN_CONTINUE_MARKER, markerInjected),
  ];
}

const completedOutcome = { kind: 'completed' } as unknown as TurnOutcome;

describe('BLOCKING-1 — the recall query never becomes the marker', () => {
  it('queries on the summary, not on the marker, after a split-turn compaction', () => {
    // Pre-fix this returned "[The context was compacted while this turn was still in
    // progress. …]" — a real Nami lookup on boilerplate, EVERY round for the rest of a
    // long agentic task, at exactly the moment recall matters most (the ask was just
    // summarized away) and on a metered cost surface.
    const query = buildRecallQuery(postCompactionProjection());
    expect(query).toContain('read every file under apps/server/src/routes');
    expect(query).not.toContain('The context was compacted');
    // The tool tail still rides, so the fix did not shorten the query to the text alone.
    expect(query).toContain('[tools: Bash]');
  });

  it('holds when the marker predates `payload.injected` (byte fallback)', () => {
    const query = buildRecallQuery(postCompactionProjection(undefined));
    expect(query).toContain('read every file under apps/server/src/routes');
    expect(query).not.toContain('The context was compacted');
  });

  it('still skips a recall fence — the rule it subsumes', () => {
    seq = 0;
    const entries = [userEntry('what did stripe send?'), userEntry(fenceRecall('a hit'), 'engine')];
    expect(buildRecallQuery(entries)).toBe('what did stripe send?');
  });

  it('a mid-turn STEER is still the query — the negative control', () => {
    // The load-bearing exclusion. A steer is the PERSON speaking; a predicate that
    // swept it in would query on a stale ask while the user is mid-correction.
    seq = 0;
    const entries = [
      userEntry('read the routes'),
      userEntry(`${STEER_MARKER_PREFIX}actually only check billing.ts`),
    ];
    expect(buildRecallQuery(entries)).toContain('only check billing.ts');
  });
});

describe('BLOCKING-2 — the marker never false-fires the correction detector', () => {
  it('a bland completed turn ending in the marker does not report a user correction', () => {
    // `detectConvoCorrection` fires on the marker's own words (it matches "not" in "do
    // not restate it"), so pre-fix EVERY split-turn-compacted turn reported "the user
    // corrected the agent" to Nami's memory pipeline: a durable `nami_capture` entry and
    // a NAMI_CAPTURE_SIGNAL. Dark today only because the flag defaults false.
    const surprise = assessTurnSurprise(postCompactionProjection(), completedOutcome, false);
    expect(surprise.correction).toBe(false);
    expect(surprise.forcing).toBe(false);
    expect(shouldCapture(surprise)).toBe(false);
  });

  it('holds for an unstamped marker (byte fallback)', () => {
    const surprise = assessTurnSurprise(postCompactionProjection(undefined), completedOutcome, false);
    expect(surprise.correction).toBe(false);
    expect(shouldCapture(surprise)).toBe(false);
  });

  it('a REAL user correction still fires — the negative control', () => {
    // If the sweep over-claimed, write-on-surprise would go deaf to actual corrections.
    seq = 0;
    const entries = [
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'I sent the email.' }] }),
      userEntry('no, that is not what I asked for — undo it'),
    ];
    expect(assessTurnSurprise(entries, completedOutcome, false).correction).toBe(true);
  });
});

describe('SHOULD-1 — the suggestion side-call reads the real last message', () => {
  it('builds its history from the summary, not the marker', () => {
    // "What is my single most likely next message?" asked against engine boilerplate.
    const history = suggestionHistoryFromProjection(postCompactionProjection());
    const userTexts = history
      .filter((e) => e.payload.type === 'user')
      .map((e) => (e.payload as { blocks: Array<{ text?: string }> }).blocks.map((b) => b.text ?? '').join(''));
    expect(userTexts.some((t) => t.includes('read every file under apps/server/src/routes'))).toBe(true);
    expect(userTexts.some((t) => t.includes('The context was compacted'))).toBe(false);
  });
});

describe('NOTE-1 — journal stats do not see a phantom turn boundary', () => {
  /** [summary, 2 rounds, marker, 2 more rounds] — a compacted turn that CONTINUES,
   *  which is the shape the marker exists to produce. `withMarker: false` is the same
   *  span with the marker removed: the honest reference. */
  function continuedTurn(withMarker: boolean): JournalEntry[] {
    seq = 0;
    const out: JournalEntry[] = [userEntry(SUMMARY_TEXT)];
    const round = (i: number): JournalEntry[] => [
      entry({ type: 'assistant', blocks: [{ type: 'text', text: `step ${i}` }] }),
      entry({ type: 'tool_use', toolUseId: `tu-${i}`, name: 'Bash', input: {} }),
      entry({ type: 'tool_result', toolUseId: `tu-${i}`, blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    out.push(...round(0), ...round(1));
    if (withMarker) out.push(userEntry(COMPACTION_SPLIT_TURN_CONTINUE_MARKER, 'engine'));
    out.push(...round(2), ...round(3));
    return out;
  }

  it('measures tool-calls-per-turn over the WHOLE turn, marker or no marker', () => {
    // Observability only, same root cause: `journal-stats` opens a new turn on any
    // `user` entry, so the marker cut one 4-tool turn into two 2-tool halves.
    expect(computeJournalStats(continuedTurn(false)).medianToolCallsPerTurn).toBe(4);
    expect(computeJournalStats(continuedTurn(true)).medianToolCallsPerTurn).toBe(4);
  });

  it('a REAL user entry mid-span still opens a new turn — the negative control', () => {
    seq = 0;
    const withRealUser = continuedTurn(false);
    withRealUser.splice(7, 0, userEntry('actually, also check billing.ts'));
    expect(computeJournalStats(withRealUser).medianToolCallsPerTurn).toBe(2);
  });
});
