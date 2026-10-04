import { describe, it, expect } from 'vitest';
import { NoopToolDisplayPort, EmptyToolHost } from '../../index.js';
import type { ToolDisplayPort, ToolHost, ToolHostContext } from '../../index.js';

describe('ToolDisplayPort', () => {
  it('NoopToolDisplayPort.enrich returns undefined for any input', () => {
    const p: ToolDisplayPort = new NoopToolDisplayPort();
    expect(p.enrich({ toolName: 'Bash', toolUseId: 'x', toolInput: {} })).toBeUndefined();
    expect(p.enrich({ toolName: 'Skill', toolUseId: 'y', toolInput: { q: 1 } }, [])).toBeUndefined();
  });
});

describe('ToolHost', () => {
  it('EmptyToolHost.buildTools returns { tools: [], onAuthHalt }', async () => {
    const h: ToolHost = new EmptyToolHost();
    const ctx = {
      taskId: 't',
      abilities: [],
      model: 'm',
      contextPort: {
        readSnapshot: async () => '',
        onPreCompact: async () => { /* no-op */ },
      } satisfies import('../../kernel/context/context-port.js').ContextPort,
      gateTool: async () => ({ decision: 'allow' as const }),
      onPause: async () => 'PAUSED_HALT',
      onTodos: () => { /* no-op */ },
      mintId: () => 'id',
    } satisfies ToolHostContext;
    const { tools, onAuthHalt } = await h.buildTools(ctx);
    expect(tools).toEqual([]);
    expect(typeof onAuthHalt).toBe('function');
    // The default onAuthHalt is a degrade-safe no-op (resolves, never throws).
    await expect(
      onAuthHalt({ kind: 'auth_required', toolkit: 'gmail', authUrl: 'https://x' }, { toolUseId: 'tu', toolName: 'X' }),
    ).resolves.toBeUndefined();
  });
});
