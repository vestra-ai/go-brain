/**
 * Past-session search is a read, in both taxonomies.
 *
 * session_search only reads the user's past sessions: the server answers it with SELECTs and
 * a STABLE RPC, and the fallback is a local transcript grep. As an unnamed tool it fell to the
 * conservative defaults: a WRITE in the plan-mode taxonomy (the 30 Sep staging drill: plan mode
 * refused "search my past sessions" with the read-only notice) and a workspace_write in the
 * side-effect classifier (so Careful asked "Update files in your workspace" about it). Both
 * sets name it by exact membership, and each test here fails if that entry is removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decideToolGate, isWriteTool } from '../../index.js';
import { classifySideEffect } from '../side-effect-classifier.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';

const WS = '/app/workspace';
const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const search = tool('session_search', { query: 'bakery name tagline' });

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

describe('session_search is a read', () => {
  it('is not a write in the plan-mode taxonomy, in any of its shapes', () => {
    for (const input of [{ query: 'q' }, { task_id: 't1', around_seq: 4 }, { task_id: 't1' }, {}]) {
      expect(isWriteTool(tool('session_search', input)), JSON.stringify(input)).toBe(false);
    }
  });

  it('classifies readonly, so no access level asks about it', () => {
    expect(classifySideEffect(search, { workspaceRoot: WS })).toBe('readonly');
  });

  it('is an exact entry: its sibling session_create and a look-alike stay writes', () => {
    for (const name of ['session_create', 'session_search_and_delete', 'Session_search']) {
      expect(isWriteTool(tool(name)), name).toBe(true);
      expect(classifySideEffect(tool(name), { workspaceRoot: WS }), name).not.toBe('readonly');
    }
  });
});

describe('plan mode with session_search', () => {
  it('allows session_search, so a plan can draw on past sessions', () => {
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

  it('session_search runs with no permission card', () => {
    expect(gate(search, { mode: 'bypassPermissions', accessLevel: 'careful' })).toEqual({ decision: 'allow' });
  });

  it('a file write still asks', () => {
    const write = tool('Write', { file_path: `${WS}/a.txt`, content: 'x' });
    expect(gate(write, { mode: 'bypassPermissions', accessLevel: 'careful' }).decision).toBe('needs_human');
  });
});
