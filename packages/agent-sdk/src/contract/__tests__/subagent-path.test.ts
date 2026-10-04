import { describe, it, expect } from 'vitest';
import { subagentIdFromPath, type SubagentPathSegment } from '../subagent-path.js';

const seg = (depth: number, id: string): SubagentPathSegment => ({
  depth,
  agentToolUseId: id,
  agentSlug: `agent-${depth}`,
  agentName: `Agent ${depth}`,
});

describe('subagentIdFromPath', () => {
  it('returns the deepest (leaf) segment agentToolUseId for a multi-level path', () => {
    const path = [seg(1, 'tu-a'), seg(2, 'tu-b'), seg(3, 'tu-c')];
    expect(subagentIdFromPath(path)).toBe('tu-c');
  });

  it('returns the single segment id for a depth-1 path', () => {
    expect(subagentIdFromPath([seg(1, 'tu-x')])).toBe('tu-x');
  });

  it('returns undefined for an empty path (main agent — no subagent)', () => {
    expect(subagentIdFromPath([])).toBeUndefined();
  });
});
