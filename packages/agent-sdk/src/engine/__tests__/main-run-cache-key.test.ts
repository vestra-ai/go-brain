// packages/agent-sdk/src/engine/__tests__/main-run-cache-key.test.ts
//
// mainRunCacheKey — the MAIN run's prompt-cache anchor is USER+MODEL-scoped
// (warm-shard affinity across a user's tasks), never task-scoped. The whole
// point of the change: two DIFFERENT tasks for the same user+model must derive
// the SAME key, so a new task's first message deliberately lands on the shard
// the user's previous tasks warmed instead of a fresh cold one.
import { describe, it, expect } from 'vitest';
import { mainRunCacheKey, subRunCacheKey } from '../main-run-cache-key.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';

const rt = (userId: string) => makeRuntimeConfig({ systemPrompt: '', userId });

describe('mainRunCacheKey — user+model-scoped prompt-cache anchor', () => {
  it('two DIFFERENT tasks for the same user+model derive the SAME key (warm-shard affinity)', () => {
    const a = mainRunCacheKey(rt('user-1'), 'task-aaa', 'glm-5.2');
    const b = mainRunCacheKey(rt('user-1'), 'task-bbb', 'glm-5.2');
    expect(a).toBe(b);
  });

  it('a different MODEL derives a different key (different prefix → different cache)', () => {
    const a = mainRunCacheKey(rt('user-1'), 'task-aaa', 'glm-5.2');
    const b = mainRunCacheKey(rt('user-1'), 'task-aaa', 'deepseek-v4-flash');
    expect(a).not.toBe(b);
  });

  it('a different USER derives a different key (no cross-tenant shard sharing)', () => {
    const a = mainRunCacheKey(rt('user-1'), 'task-aaa', 'glm-5.2');
    const b = mainRunCacheKey(rt('user-2'), 'task-aaa', 'glm-5.2');
    expect(a).not.toBe(b);
  });

  it('is deterministic and never leaks the raw user id onto the wire value', () => {
    const key = mainRunCacheKey(rt('user-secret-id'), 'task-aaa', 'glm-5.2');
    expect(key).toBe(mainRunCacheKey(rt('user-secret-id'), 'task-zzz', 'glm-5.2'));
    expect(key).not.toContain('user-secret-id');
    expect(key).toMatch(/^u-[0-9a-f]{16}$/);
  });

  it('userId absent → the per-task anchor: the task id, per task', () => {
    // Legacy callers / tests that set no env: userId defaults to ''. Two tasks in one
    // process get two keys — never a process-wide id shared by every task.
    expect(mainRunCacheKey(rt(''), 'task-aaa', 'glm-5.2')).toBe('task-aaa');
    expect(mainRunCacheKey(rt(''), 'task-bbb', 'glm-5.2')).toBe('task-bbb');
    expect(mainRunCacheKey(undefined, 'task-aaa', 'glm-5.2')).toBe('task-aaa');
  });
});

describe('subRunCacheKey — the Agent tool\'s per-agent-type shard anchor', () => {
  it('never exceeds OpenAI\'s 64-char prompt_cache_key cap (the gpt-5.6 400 repro)', () => {
    // The raw concatenation this replaces was exactly 70 chars for this input:
    // 36 (uuid) + ':sub:' + 'deep-researcher' + ':' + 'gpt-5.6-terra' → OpenAI 400.
    const key = subRunCacheKey(
      '619db15c-7829-4d3a-a479-e38183dfa24c',
      'deep-researcher',
      'gpt-5.6-terra',
    );
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('is stable for the same (task, slug, model) triple', () => {
    const a = subRunCacheKey('task-xyz', 'researcher', 'm');
    const b = subRunCacheKey('task-xyz', 'researcher', 'm');
    expect(a).toBe(b);
  });

  it('derives distinct keys per task, per slug, and per model (shard isolation)', () => {
    const base = subRunCacheKey('task-xyz', 'researcher', 'm');
    expect(subRunCacheKey('task-abc', 'researcher', 'm')).not.toBe(base);
    expect(subRunCacheKey('task-xyz', 'coder', 'm')).not.toBe(base);
    expect(subRunCacheKey('task-xyz', 'researcher', 'gpt-5.6-terra')).not.toBe(base);
  });

  it('never collides with a main-run key shape and leaks no raw ids', () => {
    const key = subRunCacheKey('task-secret', 'deep-researcher', 'gpt-5.6-terra');
    expect(key).toMatch(/^sub-[0-9a-f]{16}$/);
    expect(key).not.toContain('task-secret');
    expect(key).not.toContain('deep-researcher');
  });
});
