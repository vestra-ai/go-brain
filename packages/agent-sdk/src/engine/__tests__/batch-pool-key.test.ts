import { describe, it, expect } from 'vitest';
import { batchPoolKey } from '../round-engine.js';

describe('batchPoolKey', () => {
  it('is derived from taskId only — never the process-global runtimeConfig.sessionId', () => {
    expect(batchPoolKey('task-A')).toBe('task-A:turnbatch');
    expect(batchPoolKey('task-B')).toBe('task-B:turnbatch');
  });

  it('two tasks in one process never share a batch pool key', () => {
    // The trap this kills: runtimeConfig.sessionId === process.env.SESSION_ID is
    // process-global, so the old key merged parallel tasks into one 12-slot pool.
    expect(batchPoolKey('task-A')).not.toBe(batchPoolKey('task-B'));
  });
});
