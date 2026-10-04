import { describe, it, expect } from 'vitest';
import { sequentialClock, systemClock, type Clock } from '../clock.js';

describe('sequentialClock', () => {
  it('produces deterministic ids and timestamps for tests', () => {
    const c: Clock = sequentialClock('2026-01-01T00:00:00.000Z');
    expect(c.uuid()).toBe('entry-0');
    expect(c.uuid()).toBe('entry-1');
    expect(c.now()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('systemClock', () => {
  it('returns an ISO-parseable timestamp from now()', () => {
    const c = systemClock();
    const ts = c.now();
    expect(typeof ts).toBe('string');
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });

  it('returns distinct non-empty UUIDs across calls', () => {
    const c = systemClock();
    const a = c.uuid();
    const b = c.uuid();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
