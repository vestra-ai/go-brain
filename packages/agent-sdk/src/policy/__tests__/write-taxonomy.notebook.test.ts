/**
 * The notebook verbs in the plan-mode taxonomy (agents first, train 1c).
 *
 * Plan mode is read-only, and an unrecognized tool name is a WRITE by design, so a new tool
 * is blocked there until it is named. An agent must be able to CONSULT its own notebook while
 * it plans; it must not be able to change it. So exactly one of the three is a read, and the
 * split is pinned here rather than left to the conservative default.
 */
import { describe, it, expect } from 'vitest';
import { isWriteTool } from '../../index.js';

const call = (toolName: string) => ({ toolName, toolInput: {}, toolCallId: 't1' });

describe('the notebook verbs in the plan-mode taxonomy', () => {
  it('NotebookRead is a pure read, so plan mode lets an agent consult its notebook', () => {
    expect(isWriteTool(call('NotebookRead'))).toBe(false);
  });

  it('NotebookAppend and NotebookCompact change the file, so they stay writes', () => {
    expect(isWriteTool(call('NotebookAppend'))).toBe(true);
    expect(isWriteTool(call('NotebookCompact'))).toBe(true);
  });
});
