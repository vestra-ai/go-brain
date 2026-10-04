import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { isContextEntry, type JournalEntry, type NewEntry } from '../../../contract/journal.js';
import {
  hashNodeSpec,
  findStepMemo,
  appendStepResult,
  STEP_RESULT_TRUNCATION_MARKER,
} from '../step-memo.js';

const dir = join(tmpdir(), `step-memo-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const userMsg = (text: string): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: '',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});

/** A fully-formed step_result JournalEntry, for the pure findStepMemo/isContextEntry paths. */
const memoEntry = (scope: string, specHash: string, resultText: string, seq = 0): JournalEntry => ({
  uuid: `e${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'system', principal: { kind: 'system' },
  timestamp: '2026-01-01T00:00:00.000Z',
  payload: {
    type: 'step_result', scope, specHash, status: 'ok', resultText, costUsd: 1,
    settledAt: '2026-01-01T00:00:00.000Z',
  },
});

const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
};

describe('hashNodeSpec', () => {
  it('is stable across object key order (nested)', () => {
    const a = hashNodeSpec({ a: 1, b: { c: 2, d: 3 }, e: [1, 2, 3] });
    const b = hashNodeSpec({ e: [1, 2, 3], b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order (a spec is order-sensitive in its lists)', () => {
    expect(hashNodeSpec({ xs: [1, 2] })).not.toBe(hashNodeSpec({ xs: [2, 1] }));
  });

  it('discriminates different specs', () => {
    expect(hashNodeSpec({ prompt: 'x' })).not.toBe(hashNodeSpec({ prompt: 'y' }));
  });

  it('returns a 12-char lowercase hex prefix', () => {
    expect(hashNodeSpec({ any: 'thing' })).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('findStepMemo', () => {
  it('returns the LAST matching step_result (re-run supersedes)', () => {
    const entries = [
      memoEntry('s', 'h', 'first', 0),
      memoEntry('s', 'h', 'second', 1),
    ];
    expect(findStepMemo(entries, 's', 'h')?.resultText).toBe('second');
  });

  it('discriminates on both scope and specHash', () => {
    const entries = [memoEntry('s', 'h', 'match', 0)];
    expect(findStepMemo(entries, 's', 'h')?.resultText).toBe('match');
    expect(findStepMemo(entries, 'other', 'h')).toBeUndefined();
    expect(findStepMemo(entries, 's', 'nope')).toBeUndefined();
  });

  it('ignores non-step_result entries', () => {
    const entries: JournalEntry[] = [
      { ...memoEntry('s', 'h', 'x', 0), payload: { type: 'user', blocks: [] } },
    ];
    expect(findStepMemo(entries, 's', 'h')).toBeUndefined();
  });
});

describe('appendStepResult', () => {
  it('round-trips a small result unchanged', async () => {
    const j = make();
    await appendStepResult(j, {}, {
      scope: 's', specHash: 'h', status: 'ok', resultText: 'small',
      costUsd: 0.5, settledAt: '2026-01-01T00:00:00.000Z',
    });
    const memo = findStepMemo(await readAll(j), 's', 'h');
    expect(memo?.resultText).toBe('small');
    expect(memo?.status).toBe('ok');
    expect(memo?.costUsd).toBe(0.5);
    expect(memo?.settledAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clamps a resultText over 64KB to ≤64KB and appends the truncated marker', async () => {
    const j = make();
    const big = 'x'.repeat(200_000);
    await appendStepResult(j, {}, {
      scope: 's', specHash: 'h', status: 'ok', resultText: big,
      costUsd: 0, settledAt: '2026-01-01T00:00:00.000Z',
    });
    const memo = findStepMemo(await readAll(j), 's', 'h');
    expect(memo).toBeDefined();
    expect(new TextEncoder().encode(memo!.resultText).length).toBeLessThanOrEqual(64 * 1024);
    expect(memo!.resultText.endsWith(STEP_RESULT_TRUNCATION_MARKER)).toBe(true);
  });

  it('threads ctx.agentPath onto the entry header (subagent scope) and omits it when absent', async () => {
    const j = make();
    const agentPath = [{ depth: 1, agentToolUseId: 'a1', agentSlug: 'research', agentName: 'Research Agent' }];
    await appendStepResult(j, { agentPath }, {
      scope: 'sub', specHash: 'h1', status: 'ok', resultText: 'r',
      costUsd: 0, settledAt: '2026-01-01T00:00:00.000Z',
    });
    await appendStepResult(j, {}, {
      scope: 'main', specHash: 'h2', status: 'ok', resultText: 'r',
      costUsd: 0, settledAt: '2026-01-01T00:00:00.000Z',
    });
    const [scoped, unscoped] = await readAll(j);
    expect(scoped.agentPath).toEqual(agentPath);
    expect('agentPath' in unscoped).toBe(false);
  });
});

describe('CONTEXT_POLICY — step_result is state, not transcript', () => {
  it('isContextEntry is false for a step_result entry', () => {
    expect(isContextEntry(memoEntry('s', 'h', 'r'))).toBe(false);
  });

  it('project() excludes step_result from the model context', async () => {
    const j = make();
    await j.append(userMsg('hello'));
    await appendStepResult(j, {}, {
      scope: 's', specHash: 'h', status: 'ok', resultText: 'r',
      costUsd: 0, settledAt: '2026-01-01T00:00:00.000Z',
    });
    const state = await j.project();
    expect(state.messages.map((m) => m.payload.type)).toEqual(['user']);
  });
});
