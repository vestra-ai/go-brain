/**
 * spawn-lane — the ONE rule that decides which slug a single `Agent` spawn runs
 * under. Two call sites read it (agent-tool mints the lane's real start,
 * round-engine synthesizes the up-front one for a concurrent batch); a
 * disagreement relabels the lane, so the rule is pinned here rather than twice
 * in prose.
 */
import { describe, it, expect } from 'vitest';
import { isInlineLane, spawnLaneSlug, requestedLaneType, INLINE_LANE_SENTINEL } from '../spawn-lane.js';

describe('isInlineLane — roster has the final say', () => {
  it('no requested type is always the inline lane', () => {
    expect(isInlineLane('', false)).toBe(true);
    expect(isInlineLane('', true)).toBe(true);
  });

  it("the 'custom' sentinel is inline ONLY when no roster entry claims it", () => {
    expect(isInlineLane(INLINE_LANE_SENTINEL, false)).toBe(true);
    // An installed ability slugged "custom" wins — resolution order is roster first.
    expect(isInlineLane(INLINE_LANE_SENTINEL, true)).toBe(false);
  });

  it('a named type is never the inline lane', () => {
    expect(isInlineLane('researcher', true)).toBe(false);
    // Unknown-but-named is still NOT inline — agent-tool errors loudly instead of
    // silently materializing an on-the-fly agent.
    expect(isInlineLane('researcher', false)).toBe(false);
  });
});

describe('spawnLaneSlug — the slug the engine announces up-front', () => {
  it('a named type is the slug', () => {
    expect(spawnLaneSlug({ subagent_type: 'researcher', prompt: 'p' })).toBe('researcher');
  });

  it('an inline spawn is slugged by its name — agent-tool mints `{ slug: spec.name }`', () => {
    expect(spawnLaneSlug({ name: 'italy-essay-writer', prompt: 'p' })).toBe('italy-essay-writer');
  });

  it("the 'custom' sentinel resolves to the name, not the sentinel", () => {
    expect(spawnLaneSlug({ subagent_type: 'custom', name: 'spain-essay-writer' })).toBe('spain-essay-writer');
  });

  it('a named type OVERRIDDEN by a display name keeps the type as its slug', () => {
    // `name` overrides the DISPLAY name of a known type; the slug stays the type,
    // which is what the server enriches from its slug-keyed cache.
    expect(spawnLaneSlug({ subagent_type: 'researcher', name: 'Deep Reader' })).toBe('researcher');
  });

  it('a children[] batch has no lane slug — it keeps its natural per-child timing', () => {
    expect(spawnLaneSlug({ children: [{ subagent_type: 'researcher', prompt: 'p', description: 'd' }] })).toBeUndefined();
    // Even if a stray top-level name rides along, the batch stays out of scope.
    expect(spawnLaneSlug({ children: [], name: 'x' })).toBeUndefined();
  });

  it('an inline spawn with no usable name has no slug to announce', () => {
    expect(spawnLaneSlug({ prompt: 'p' })).toBeUndefined();
    expect(spawnLaneSlug({ name: '' })).toBeUndefined();
    expect(spawnLaneSlug({ name: 42 })).toBeUndefined();
  });

  it('tolerates absent / non-object input', () => {
    expect(spawnLaneSlug(undefined)).toBeUndefined();
    expect(spawnLaneSlug(null)).toBeUndefined();
  });
});

describe('requestedLaneType', () => {
  it("normalizes a missing or non-string subagent_type to ''", () => {
    expect(requestedLaneType({})).toBe('');
    expect(requestedLaneType({ subagent_type: 7 })).toBe('');
    expect(requestedLaneType({ subagent_type: 'researcher' })).toBe('researcher');
  });
});
