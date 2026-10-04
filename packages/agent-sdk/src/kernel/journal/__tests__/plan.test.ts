import { describe, it, expect } from 'vitest';
import { projectPlan } from '../plan.js';
import type { JournalEntry } from '../../../contract/journal.js';

const entry = (payload: JournalEntry['payload'], seq: number, agentPath?: JournalEntry['agentPath']): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: seq ? `u${seq - 1}` : null, seq, taskId: 't', rootTaskId: 't',
  spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  ...(agentPath ? { agentPath } : {}),
  payload,
});

describe('projectPlan', () => {
  it('folds create/update/delete in seq order, first-create insertion order', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending' }, 0),
      entry({ type: 'plan', op: 'create', id: 'b', content: 'Bravo', status: 'pending' }, 1),
      entry({ type: 'plan', op: 'update', id: 'a', status: 'completed' }, 2),
    ];
    expect(projectPlan(entries)).toEqual([
      { id: 'a', content: 'Alpha', status: 'completed' },
      { id: 'b', content: 'Bravo', status: 'pending' },
    ]);
  });

  it('op:delete removes the id from the projection', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending' }, 0),
      entry({ type: 'plan', op: 'delete', id: 'a' }, 1),
    ];
    expect(projectPlan(entries)).toEqual([]);
  });

  it('an update/delete against an unknown id is silently skipped, never throws', () => {
    const entries = [
      entry({ type: 'plan', op: 'update', id: 'ghost', status: 'completed' }, 0),
      entry({ type: 'plan', op: 'delete', id: 'phantom' }, 1),
    ];
    expect(() => projectPlan(entries)).not.toThrow();
    expect(projectPlan(entries)).toEqual([]);
  });

  it('an id reused after delete (create -> delete -> create, same id) keeps its ORIGINAL insertion position, not appended at the end', () => {
    // Documents the intentional (if unlikely — ids are randomUUID-minted, never
    // reused by the model in practice) behavior: `order` records the FIRST
    // `create`'s index; a later re-create of the same id does not move it.
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending' }, 0),
      entry({ type: 'plan', op: 'create', id: 'b', content: 'Bravo', status: 'pending' }, 1),
      entry({ type: 'plan', op: 'delete', id: 'a' }, 2),
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha again', status: 'pending' }, 3),
    ];
    expect(projectPlan(entries).map((t) => t.id)).toEqual(['a', 'b']);
    expect(projectPlan(entries)[0]).toEqual({ id: 'a', content: 'Alpha again', status: 'pending' });
  });

  it('preserves activeForm and omits it when never set', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending', activeForm: 'Doing alpha' }, 0),
      entry({ type: 'plan', op: 'create', id: 'b', content: 'Bravo', status: 'pending' }, 1),
    ];
    const result = projectPlan(entries);
    expect(result[0]).toEqual({ id: 'a', content: 'Alpha', status: 'pending', activeForm: 'Doing alpha' });
    expect(result[1]).toEqual({ id: 'b', content: 'Bravo', status: 'pending' });
    expect('activeForm' in result[1]).toBe(false);
  });

  // ── §4.7 the board: an `owner` handle rides every plan item ────────────────

  it('create carries `owner` when the payload names one, and leaves NO key when it does not', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending', owner: 'pricing' }, 0),
      entry({ type: 'plan', op: 'create', id: 'b', content: 'Bravo', status: 'pending' }, 1),
    ];
    const result = projectPlan(entries);
    expect(result[0]).toEqual({ id: 'a', content: 'Alpha', status: 'pending', owner: 'pricing' });
    expect(result[1]).toEqual({ id: 'b', content: 'Bravo', status: 'pending' });
    expect('owner' in result[1]!).toBe(false);
  });

  it('update with a string `owner` assigns (and reassigns) the item', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending' }, 0),
      entry({ type: 'plan', op: 'update', id: 'a', owner: 'pricing' }, 1),
      entry({ type: 'plan', op: 'update', id: 'a', owner: 'research' }, 2),
    ];
    expect(projectPlan(entries)).toEqual([{ id: 'a', content: 'Alpha', status: 'pending', owner: 'research' }]);
  });

  it('update with `owner: null` UNASSIGNS — the key is deleted, never stored as null', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending', owner: 'pricing' }, 0),
      entry({ type: 'plan', op: 'update', id: 'a', owner: null }, 1),
    ];
    const result = projectPlan(entries);
    expect(result).toEqual([{ id: 'a', content: 'Alpha', status: 'pending' }]);
    expect('owner' in result[0]!).toBe(false);
  });

  it('an update that omits `owner` leaves the existing holder untouched', () => {
    const entries = [
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending', owner: 'pricing' }, 0),
      entry({ type: 'plan', op: 'update', id: 'a', status: 'in_progress' }, 1),
    ];
    expect(projectPlan(entries)).toEqual([
      { id: 'a', content: 'Alpha', status: 'in_progress', owner: 'pricing' },
    ]);
  });

  it('non-plan entries are ignored (identity for a mixed entry list)', () => {
    const entries = [
      entry({ type: 'user', blocks: [] }, 0),
      entry({ type: 'plan', op: 'create', id: 'a', content: 'Alpha', status: 'pending' }, 1),
      entry({ type: 'tool_use', toolUseId: 'x', name: 'Bash', input: {} }, 2),
    ];
    expect(projectPlan(entries)).toEqual([{ id: 'a', content: 'Alpha', status: 'pending' }]);
  });

  it('AC-P2 (quarantine primitive): the caller controls scope — feeding only main-scope entries excludes a subagent-scoped plan entry', () => {
    const childPath = [{ depth: 1, agentToolUseId: 'a1', agentSlug: 'r', agentName: 'R' }];
    const all = [
      entry({ type: 'plan', op: 'create', id: 'main', content: 'Main', status: 'pending' }, 0),
      entry({ type: 'plan', op: 'create', id: 'child', content: 'Child', status: 'pending' }, 1, childPath),
    ];
    const mainScope = all.filter((e) => !e.agentPath);
    const childScope = all.filter((e) => e.agentPath);
    expect(projectPlan(mainScope)).toEqual([{ id: 'main', content: 'Main', status: 'pending' }]);
    expect(projectPlan(childScope)).toEqual([{ id: 'child', content: 'Child', status: 'pending' }]);
  });
});
