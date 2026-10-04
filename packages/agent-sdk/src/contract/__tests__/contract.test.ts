import { describe, it, expect } from 'vitest';
import {
  HARNESS_IDS,
  isHarnessId,
  defaultCapabilities,
} from '../../index.js';
import type {
  HarnessId,
  HarnessCapabilities,
  PermissionMode,
  PermissionUpdate,
} from '../../index.js';

describe('harness contract (inverted into the SDK)', () => {
  it('HARNESS_IDS lists the four legacy/native arms plus the Claude Code engine', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'openai', 'native', 'openai_responses', 'claude_code']);
  });

  it('claude_code is its OWN id — the legacy claude arm is never reused', () => {
    expect(isHarnessId('claude_code')).toBe(true);
    expect(HARNESS_IDS.indexOf('claude_code')).toBeGreaterThan(HARNESS_IDS.indexOf('claude'));
  });

  it('isHarnessId narrows valid ids and rejects others', () => {
    expect(isHarnessId('native')).toBe(true);
    expect(isHarnessId('claude')).toBe(true);
    expect(isHarnessId('gemini')).toBe(false);
    expect(isHarnessId(42)).toBe(false);
  });

  it('defaultCapabilities is conservative by default', () => {
    const caps = defaultCapabilities();
    expect(caps.thinking).toBe(false);
    expect(caps.reportsCostUsd).toBe(false);
    expect(caps.maxContextTokens).toBe(0);
  });

  it('defaultCapabilities applies overrides', () => {
    const caps = defaultCapabilities({ thinking: true, maxContextTokens: 200000 });
    expect(caps.thinking).toBe(true);
    expect(caps.maxContextTokens).toBe(200000);
    expect(caps.promptCaching).toBe(false);
  });

  it('contract types are usable (compile-time check)', () => {
    const id: HarnessId = 'native';
    const caps: HarnessCapabilities = defaultCapabilities();
    const mode: PermissionMode = 'default';
    const update: PermissionUpdate = {
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    };
    expect([id, caps, mode, update.type]).toBeTruthy();
  });
});
