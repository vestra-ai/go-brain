// X5b (MCP_RESOURCES_V1): mcp_resources only lists or reads a connected MCP server's resources,
// so the gate treats it as a read: it never asks at any access level, plan mode allows it, and
// the injection screen never screens it. Revert-proof: drop the literal from READONLY_BUILTINS or
// READ_TOOLS and it falls back to an unknown builtin (a workspace write), and this goes red.
import { describe, it, expect } from 'vitest';
import { classifySideEffect, isSideEffectingFamily, isWriteTool } from '../../index.js';

const call = { toolName: 'mcp_resources', toolInput: { server: 'docs', uri: 'docs://handbook' }, toolCallId: 't' };

describe('mcp_resources is a read', () => {
  it('classifies readonly, so no level asks and the screen skips it', () => {
    const family = classifySideEffect(call, { workspaceRoot: '/app/workspace' });
    expect(family).toBe('readonly');
    expect(isSideEffectingFamily(family)).toBe(false);
  });

  it('is not a write, so plan mode allows it', () => {
    expect(isWriteTool(call)).toBe(false);
  });
});
