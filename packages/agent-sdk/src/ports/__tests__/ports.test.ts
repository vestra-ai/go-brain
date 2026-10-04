import { describe, it, expect } from 'vitest';
import { makeRuntimeConfig } from '../runtime-config.js';
import { AllowAllPolicyPort } from '../policy-port.js';
import { InMemoryStatePort } from '../state-port.js';
import { UnconfiguredInteractionPort } from '../interaction-port.js';
import { EmptyCatalogLoader } from '../catalog-loader-port.js';
import * as sdk from '../../index.js';

describe('RuntimeConfig', () => {
  it('fills safe defaults and requires systemPrompt', () => {
    const c = makeRuntimeConfig({ systemPrompt: 'You are an agent.' });
    expect(c.workingDir).toBe('.');
    expect(c.userId).toBe('');
    // No session id: RuntimeConfig is process-wide; a run's session id is
    // HarnessContext.sessionId (a process-wide one leaked across sessions).
    expect('sessionId' in c).toBe(false);
    expect(c.mcpServerConfig).toBeUndefined();
    expect(c.systemPrompt).toBe('You are an agent.');
  });
  it('passes through provided values', () => {
    const c = makeRuntimeConfig({ workingDir: '/app/workspace', userId: 'u1', mcpServerConfig: '{}', systemPrompt: 'x' });
    expect(c).toEqual({ workingDir: '/app/workspace', userId: 'u1', mcpServerConfig: '{}', systemPrompt: 'x' });
  });
});

describe('AllowAllPolicyPort (default)', () => {
  const p = new AllowAllPolicyPort();
  it('allows every tool call', async () => {
    const r = await p.gate(
      { toolName: 'Bash', toolInput: { command: 'ls' }, toolCallId: 't1' },
      { taskId: 'k1', isTaskStopping: false, connectedApps: new Set(), grantedCapabilities: new Set() },
    );
    expect(r.decision).toBe('allow');
  });
  it('reports bypass mode and no-ops seeding', () => {
    expect(p.permissionMode('k1')).toBe('bypassPermissions');
    expect(() => p.seedModeFromEnv('k1')).not.toThrow();
  });
});

describe('InMemoryStatePort (default)', () => {
  it('defaults to not-stopping, no caps, no apps', async () => {
    const s = new InMemoryStatePort();
    expect(s.isTaskStopping('k1')).toBe(false);
    expect(s.grantedCapabilities()).toEqual([]);
    expect([...s.connectedAppsSnapshot()]).toEqual([]);
    await expect(s.refreshConnectedApps()).resolves.toBeUndefined();
  });
  it('reflects test setters and returns a defensive copy of apps', () => {
    const s = new InMemoryStatePort();
    s.setStopping('k1'); s.setCapabilities(['browser']); s.setConnectedApps(['gmail']);
    expect(s.isTaskStopping('k1')).toBe(true);
    expect(s.grantedCapabilities()).toEqual(['browser']);
    const snap = s.connectedAppsSnapshot();
    snap.add('mutated');
    expect([...s.connectedAppsSnapshot()]).toEqual(['gmail']); // not affected by caller mutation
  });
});

describe('UnconfiguredInteractionPort (default)', () => {
  const p = new UnconfiguredInteractionPort();
  it('throws a descriptive error for requestInteraction (HITL needs a host)', async () => {
    await expect(
      p.requestInteraction({ taskId: 'k1', call: { toolName: 'Bash', toolInput: {}, toolCallId: 't1' }, kind: 'tool_permission' }),
    ).rejects.toThrow(/InteractionPort not configured/);
  });
  it('throws for requestComposioAuth too', async () => {
    await expect(
      p.requestComposioAuth({ toolName: 'GMAIL_SEND', toolCallId: 't2', toolkit: 'gmail', authUrl: 'https://x' }),
    ).rejects.toThrow(/InteractionPort not configured/);
  });
});

describe('EmptyCatalogLoader (default)', () => {
  const c = new EmptyCatalogLoader();
  it('loads nothing by default (all three kinds)', async () => {
    expect(await c.loadSkills()).toEqual([]);
    expect(await c.loadAgents()).toEqual([]);
    expect(await c.loadAbilities()).toEqual([]);
  });
});

describe('ports barrel via SDK root', () => {
  it('re-exports the five default impls from the package root', () => {
    expect(typeof sdk.AllowAllPolicyPort).toBe('function');
    expect(typeof sdk.InMemoryStatePort).toBe('function');
    expect(typeof sdk.UnconfiguredInteractionPort).toBe('function');
    expect(typeof sdk.EmptyCatalogLoader).toBe('function');
    expect(typeof sdk.makeRuntimeConfig).toBe('function');
  });
});
