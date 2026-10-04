import { describe, it, expect } from 'vitest';
import { validateJournalEntry, migrateEntry, CURRENT_JOURNAL_VERSION } from '../validate-entry.js';

const good = {
  uuid: 'u1', parentUuid: null, seq: 1, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'a', principal: { kind: 'system' }, timestamp: '2026-07-02T00:00:00Z',
  payload: { type: 'user', blocks: [] },
};

describe('validateJournalEntry', () => {
  it('accepts a well-formed legacy entry (no v field = v1)', () => {
    const r = validateJournalEntry(good);
    expect(r.ok).toBe(true);
  });
  it('rejects well-formed JSON with the wrong shape (the unchecked-cast hole)', () => {
    const r = validateJournalEntry({ hello: 'world' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('uuid'))).toBe(true);
  });
  it('rejects an unknown payload type', () => {
    const r = validateJournalEntry({ ...good, payload: { type: 'not_a_kind' } });
    expect(r.ok).toBe(false);
  });
  it('accepts the P5.1 teammate_def payload type (Agent Teams)', () => {
    const r = validateJournalEntry({
      ...good,
      payload: {
        type: 'teammate_def', name: 'researcher', parentTaskId: 't',
        systemPrompt: 'do research', toolset: ['WebSearch'],
      },
    });
    expect(r.ok).toBe(true);
  });
  it('accepts a teammate_def carrying the P5.2 I-7 firstPrompt (additive-optional)', () => {
    const r = validateJournalEntry({
      ...good,
      payload: {
        type: 'teammate_def', name: 'researcher', parentTaskId: 't',
        systemPrompt: 'do research', toolset: ['WebSearch'], model: 'claude-opus-4-8',
        firstPrompt: 'investigate the outage',
      },
    });
    expect(r.ok).toBe(true);
  });
  it('rejects a FUTURE version (downgrade safety)', () => {
    const r = validateJournalEntry({ ...good, v: CURRENT_JOURNAL_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/version/i);
  });
  it('migrateEntry is identity at CURRENT', () => {
    const r = validateJournalEntry(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(migrateEntry(r.entry)).toEqual(r.entry);
  });
});
