import { describe, it, expect } from 'vitest';
import { renderArchiveMarkdown } from '../archive.js';
import type { JournalEntry } from '../../../contract/journal.js';

const entry = (payload: JournalEntry['payload'], seq = 0): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't',
  spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload,
});

describe('renderArchiveMarkdown', () => {
  it('renders user/assistant text turns as readable sections', () => {
    const md = renderArchiveMarkdown([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'hello' }] }, 0),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'hi there' }], model: 'm' }, 1),
    ]);
    expect(md).toContain('## User');
    expect(md).toContain('hello');
    expect(md).toContain('## Assistant');
    expect(md).toContain('hi there');
  });

  it('renders tool_use/tool_result pairs with the tool name and JSON input', () => {
    const md = renderArchiveMarkdown([
      entry({ type: 'tool_use', toolUseId: 'x', name: 'Bash', input: { command: 'ls' } }, 0),
      entry({ type: 'tool_result', toolUseId: 'x', blocks: [{ type: 'text', text: 'file.txt' }], isError: false }, 1),
    ]);
    expect(md).toContain('Bash');
    expect(md).toContain('"command": "ls"');
    expect(md).toContain('file.txt');
  });

  it('marks an error tool_result distinctly', () => {
    const md = renderArchiveMarkdown([
      entry({ type: 'tool_result', toolUseId: 'x', blocks: [{ type: 'text', text: 'boom' }], isError: true }, 0),
    ]);
    expect(md).toContain('Tool result (error)');
  });

  it('skips non-conversational state entries (plan/mode/interaction/usage) without throwing', () => {
    const md = renderArchiveMarkdown([
      entry({ type: 'plan', op: 'create', id: 'a', content: 'x', status: 'pending' }, 0),
      entry({ type: 'mode', key: 'k', value: 'v' }, 1),
      entry({ type: 'usage', intelligence: 1, actions: 1, compute: 1 }, 2),
    ]);
    expect(md).toBe('');
  });

  it('empty input renders an empty string', () => {
    expect(renderArchiveMarkdown([])).toBe('');
  });
});
