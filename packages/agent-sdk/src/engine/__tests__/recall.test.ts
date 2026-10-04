/**
 * recall.test.ts — P5 Task 2 (Nami in the loop): the per-round read-on-relevance
 * primitives, unit-tested pure.
 *
 *  - buildRecallQuery: journal entries → a stable query string (last user text
 *    + recent tool names). Pure — the engine calls it off the SAME warm
 *    projection the cachePrefixHint read uses.
 *  - fetchRecall: the deadline race. A slow/hung/broken readRelevant NEVER
 *    stalls a round past `deadlineMs` — expiry/error/null all degrade to ''
 *    (skip), the timer never keeps the process alive, and a late rejection
 *    never surfaces as an unhandled rejection.
 *  - clampRecall / fenceRecall: bounded size + the data-not-instructions fence
 *    (`<recalled_memory authority="curated" source="nami">`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildRecallQuery,
  fetchRecall,
  clampRecall,
  fenceRecall,
  isRecallFence,
  RECALL_TRUNCATION_MARKER,
} from '../recall.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u-${seq}`,
    parentUuid: null,
    seq,
    taskId: 't-recall',
    rootTaskId: 't-recall',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

const user = (text: string): JournalEntry =>
  entry({ type: 'user', blocks: [{ type: 'text', text }] });
const toolUse = (name: string): JournalEntry =>
  entry({ type: 'tool_use', toolUseId: `tu-${seq + 1}`, name, input: {} });

afterEach(() => {
  vi.useRealTimers();
});

// ── buildRecallQuery ──────────────────────────────────────────────────────────

describe('buildRecallQuery', () => {
  it('returns the LAST user entry text', () => {
    const q = buildRecallQuery([user('first ask'), user('latest ask')]);
    expect(q).toBe('latest ask');
  });

  it('returns "" when no user entry exists (nothing to consult on)', () => {
    expect(buildRecallQuery([toolUse('Bash')])).toBe('');
    expect(buildRecallQuery([])).toBe('');
  });

  it('appends recent tool names deduped by MOST-RECENT use, in chronological order', () => {
    const q = buildRecallQuery([
      user('deploy the web app'),
      toolUse('Bash'),
      toolUse('Read'),
      toolUse('Bash'),
    ]);
    // Bash's LAST use post-dates Read's → Bash renders last (freshest at the tail).
    expect(q).toBe('deploy the web app\n[tools: Read, Bash]');
  });

  it('joins multiple text blocks of the user entry; ignores non-text blocks', () => {
    const e = entry({
      type: 'user',
      blocks: [
        { type: 'text', text: 'part one' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'x' } } as never,
        { type: 'text', text: 'part two' },
      ],
    });
    expect(buildRecallQuery([e])).toBe('part one\npart two');
  });

  it('is pure and stable: identical input → identical output, input not mutated', () => {
    const entries = [user('same ask'), toolUse('Read')];
    const snapshot = JSON.stringify(entries);
    const a = buildRecallQuery(entries);
    const b = buildRecallQuery(entries);
    expect(a).toBe(b);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

// ── fetchRecall — the deadline race ──────────────────────────────────────────

describe('fetchRecall', () => {
  it('resolves the text when readRelevant settles under the deadline', async () => {
    await expect(fetchRecall(async () => 'remembered fact', 'q', 250)).resolves.toBe(
      'remembered fact',
    );
  });

  it('maps a null (abstention) to ""', async () => {
    await expect(fetchRecall(async () => null, 'q', 250)).resolves.toBe('');
  });

  it('a HUNG readRelevant degrades to "" AT the deadline (never stalls the round)', async () => {
    vi.useFakeTimers();
    const hang = (): Promise<string | null> => new Promise<never>(() => {});
    const p = fetchRecall(hang, 'q', 250);
    await vi.advanceTimersByTimeAsync(249);
    // Not settled yet at deadline-1 — prove the race is the deadline, not sooner.
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('');
  });

  it('a rejecting readRelevant degrades to "" (never throws into the turn)', async () => {
    await expect(
      fetchRecall(async () => {
        throw new Error('recall backend down');
      }, 'q', 250),
    ).resolves.toBe('');
  });

  it('a SYNCHRONOUSLY-throwing readRelevant degrades to ""', async () => {
    const boom = (): Promise<string | null> => {
      throw new Error('sync boom');
    };
    await expect(fetchRecall(boom, 'q', 250)).resolves.toBe('');
  });

  it('a rejection AFTER the deadline is swallowed (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    let rejectLate: (e: Error) => void = () => {};
    const late = (): Promise<string | null> =>
      new Promise<string | null>((_res, rej) => {
        rejectLate = rej;
      });
    const p = fetchRecall(late, 'q', 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('');
    // Now the port fails, long after the race resolved — must be pre-handled.
    rejectLate(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    // Reaching here without vitest's unhandled-rejection interception = pass.
  });

  it('clears the deadline timer once the port settles first', async () => {
    vi.useFakeTimers();
    await fetchRecall(async () => 'fast', 'q', 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── clampRecall / fenceRecall ─────────────────────────────────────────────────

describe('clampRecall', () => {
  it('returns short text unchanged', () => {
    expect(clampRecall('short', 100)).toBe('short');
  });

  it('truncates over-limit text and appends the truncation marker', () => {
    const clamped = clampRecall('x'.repeat(120), 100);
    expect(clamped.startsWith('x'.repeat(100))).toBe(true);
    expect(clamped.endsWith(RECALL_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('fenceRecall', () => {
  it('wraps text in the authority-tagged data fence', () => {
    expect(fenceRecall('- keshav prefers: staging-only (task 2026-06-12)')).toBe(
      '<recalled_memory authority="curated" source="nami">\n' +
        '- keshav prefers: staging-only (task 2026-06-12)\n' +
        '</recalled_memory>',
    );
  });

  it('empty / whitespace-only → "" (nothing to inject)', () => {
    expect(fenceRecall('')).toBe('');
    expect(fenceRecall('  \n ')).toBe('');
  });
});

// ── fleet fix round (PR #1347) — abort race, codepoint clamp, fence skip ────

describe('fetchRecall — abort awareness (fleet item 1)', () => {
  it('an already-aborted signal returns "" WITHOUT invoking readRelevant', async () => {
    const controller = new AbortController();
    controller.abort();
    const readRelevant = vi.fn(async () => 'never');
    await expect(fetchRecall(readRelevant, 'q', 60_000, controller.signal)).resolves.toBe('');
    expect(readRelevant).not.toHaveBeenCalled();
  });

  it('an abort MID-WAIT resolves "" immediately (never sits out the deadline)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const hang = (): Promise<string | null> => new Promise<never>(() => {});
    const p = fetchRecall(hang, 'q', 60_000, controller.signal);
    controller.abort();
    await expect(p).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0); // deadline timer cleaned up
  });
});

describe('clampRecall — codepoint-safe (fleet item 2)', () => {
  it('never splits a surrogate pair at the boundary', () => {
    const emoji = '😀'.repeat(10); // each 😀 = 1 codepoint, 2 UTF-16 units
    const clamped = clampRecall(emoji, 5);
    const body = clamped.slice(0, clamped.length - RECALL_TRUNCATION_MARKER.length);
    expect(Array.from(body).length).toBe(5);
    // No lone high surrogate anywhere (the split-pair symptom).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clamped)).toBe(false);
    expect(clamped.endsWith(RECALL_TRUNCATION_MARKER)).toBe(true);
  });

  it('counts codepoints, not UTF-16 units (astral text under the limit is untouched)', () => {
    const four = '😀😀😀😀'; // .length is 8, but 4 codepoints
    expect(clampRecall(four, 4)).toBe(four);
  });
});

describe('buildRecallQuery — appended fences never feed back (journaled delivery)', () => {
  it('skips a recall-fence user entry and uses the real user text', () => {
    const fence = fenceRecall('- some remembered fact');
    const q = buildRecallQuery([user('deploy the app'), entry({ type: 'user', blocks: [{ type: 'text', text: fence }] })]);
    expect(q).toBe('deploy the app');
  });

  it('isRecallFence recognizes exactly the loop fence shape', () => {
    expect(isRecallFence(fenceRecall('x'))).toBe(true);
    expect(isRecallFence('no, use staging')).toBe(false);
  });
});
