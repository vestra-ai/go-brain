/**
 * Tool search is a read, in both taxonomies.
 *
 * ToolSearch returns deferred tools' schemas and marks them loaded for the session; it
 * reaches nothing outside the process, and a tool it loads is judged by its own name when
 * called. As an unnamed tool it fell to the conservative defaults: a WRITE in the plan-mode
 * taxonomy (so plan mode could not load any deferred tool, not even a read) and a
 * workspace_write in the side-effect classifier (so Careful asked "Update files in your
 * workspace" about it). Both sets name it by exact membership, and each test here fails if
 * that entry is removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decideToolGate, isWriteTool } from '../../index.js';
import { classifySideEffect } from '../side-effect-classifier.js';
import { TOOL_SEARCH_TOOL_NAME } from '../../engine/tool-search.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';

const WS = '/app/workspace';
const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const search = tool(TOOL_SEARCH_TOOL_NAME, { query: 'select:send_email' });

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  const ctx: ToolGateContext = {
    mode: 'plan',
    cwd: WS,
    connectedComposioToolkits: new Set(),
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  };
  return decideToolGate(call, ctx);
}

describe('tool search is a read', () => {
  it('is the ToolSearch tool the engine registers', () => {
    expect(TOOL_SEARCH_TOOL_NAME).toBe('ToolSearch');
  });

  it('is not a write in the plan-mode taxonomy', () => {
    expect(isWriteTool(search)).toBe(false);
  });

  it('classifies readonly, so no access level asks about it', () => {
    expect(classifySideEffect(search, { workspaceRoot: WS })).toBe('readonly');
  });
});

describe('plan mode with tool search', () => {
  it('allows ToolSearch, so a deferred tool can be loaded while planning', () => {
    expect(gate(search)).toEqual({ decision: 'allow' });
  });

  it('still refuses Write, Edit and a mutating Bash command', () => {
    const writes = [
      tool('Write', { file_path: `${WS}/a.txt`, content: 'x' }),
      tool('Edit', { file_path: `${WS}/a.txt`, old_string: 'a', new_string: 'b' }),
      tool('Bash', { command: 'echo hi > out.txt' }),
    ];
    for (const call of writes) {
      const verdict = gate(call);
      expect(verdict.decision, call.toolName).toBe('deny');
      expect(verdict, call.toolName).toMatchObject({ reasonType: 'mode' });
    }
  });
});

describe('at the Careful access level', () => {
  beforeEach(() => { process.env.ACCESS_LEVELS_V1 = '1'; });
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  it('ToolSearch runs with no permission card', () => {
    expect(gate(search, { mode: 'bypassPermissions', accessLevel: 'careful' })).toEqual({ decision: 'allow' });
  });

  it('a file write still asks', () => {
    const write = tool('Write', { file_path: `${WS}/a.txt`, content: 'x' });
    expect(gate(write, { mode: 'bypassPermissions', accessLevel: 'careful' }).decision).toBe('needs_human');
  });
});
