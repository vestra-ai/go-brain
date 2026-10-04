/**
 * HITL world-delta (T3) — the pure copy + threshold helpers.
 *
 * humanDuration tiers at strict boundaries (89s → moments, 90s → minutes, …); the
 * threshold predicate fires on a >10min gap OR a recycled runner; the copy never uses
 * an em dash and never names the provider.
 */
import { describe, it, expect } from 'vitest';
import {
  WORLD_DELTA_THRESHOLD_MS,
  worldDeltaMeetsThreshold,
  humanDuration,
  buildWorldDeltaResumeText,
  buildWorldDeltaChildPreamble,
} from '../world-delta.js';

describe('humanDuration — tiers flip at strict boundaries', () => {
  it('89s → "moments", 90s → the minutes tier', () => {
    expect(humanDuration(89_000)).toBe('moments');
    expect(humanDuration(90_000)).toMatch(/minute/);
  });

  it('89min stays in minutes, 90min flips to the hours tier', () => {
    expect(humanDuration(89 * 60_000)).toBe('89 minutes');
    expect(humanDuration(90 * 60_000)).toMatch(/hour/);
  });

  it('35h stays in hours, 36h flips to the days tier', () => {
    expect(humanDuration(35 * 3_600_000)).toBe('35 hours');
    expect(humanDuration(36 * 3_600_000)).toMatch(/day/);
  });

  it('a very small gap is "moments"; undefined is "some time"', () => {
    expect(humanDuration(0)).toBe('moments');
    expect(humanDuration(undefined)).toBe('some time');
  });

  it('a multi-day gap reads in days', () => {
    expect(humanDuration(32 * 3_600_000)).toBe('32 hours');
    expect(humanDuration(3 * 86_400_000)).toBe('3 days');
  });
});

describe('worldDeltaMeetsThreshold', () => {
  it('fires when elapsed exceeds 10 minutes', () => {
    expect(worldDeltaMeetsThreshold({ elapsedMs: WORLD_DELTA_THRESHOLD_MS + 1 })).toBe(true);
    expect(worldDeltaMeetsThreshold({ elapsedMs: WORLD_DELTA_THRESHOLD_MS })).toBe(false);
    expect(worldDeltaMeetsThreshold({ elapsedMs: 5_000 })).toBe(false);
  });

  it('fires when the runner was recycled, even with no measured elapsed', () => {
    expect(worldDeltaMeetsThreshold({ runnerRecycled: true })).toBe(true);
    expect(worldDeltaMeetsThreshold({ elapsedMs: 5_000, runnerRecycled: true })).toBe(true);
    expect(worldDeltaMeetsThreshold({ runnerRecycled: false })).toBe(false);
  });

  it('absent worldDelta (legacy / tests) is false — byte-identical resume', () => {
    expect(worldDeltaMeetsThreshold(undefined)).toBe(false);
    expect(worldDeltaMeetsThreshold({})).toBe(false);
  });
});

describe('copy — no em dashes, never names the provider', () => {
  it('resume text carries the re-verify instruction and is clean', () => {
    const t = buildWorldDeltaResumeText(32 * 3_600_000);
    expect(t).toContain('[System]');
    expect(t).toContain('32 hours after the pause');
    expect(t).toContain('do not infer that a previously gated action ran');
    expect(t).not.toContain('—');
    expect(t).not.toMatch(/claude/i);
  });

  it('child preamble is the same context in second person', () => {
    const t = buildWorldDeltaChildPreamble(undefined);
    expect(t).toMatch(/^Your earlier tool request paused/);
    expect(t).toContain('some time after the pause');
    expect(t).not.toContain('—');
    expect(t).not.toMatch(/claude/i);
  });
});
