import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { describeToolCall, describeRule } from '../describe-tool.js';

const call = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't1',
});
const bash = (command: string): ToolCall => call('Bash', { command });

describe('describeToolCall — Bash verb + targets', () => {
  it('names the files of a multi-file recursive delete, and the recursion', () => {
    // A delete NAMES its targets (founder ruling 2026-08-09): "which files?" is
    // the question in front of an irreversible ask, and a count does not answer it.
    expect(describeToolCall(bash('rm -rf /tmp/shot1.png /tmp/shot2.png'))).toBe(
      'Delete 2 files: shot1.png, shot2.png and everything inside',
    );
  });

  it('describes a single-file delete by name', () => {
    expect(describeToolCall(bash('rm scratch.txt'))).toBe('Delete scratch.txt');
  });

  it('describes a recursive directory delete honestly', () => {
    expect(describeToolCall(bash('rm -rf build/'))).toBe('Delete build/ and everything inside');
  });

  it('describes a glob delete by its pattern', () => {
    expect(describeToolCall(bash('rm *.md'))).toBe('Delete files matching *.md');
  });

  it('NEVER drops a delete phrase past the 3-slot cap (slot-4 delete)', () => {
    expect(describeToolCall(bash('cat a.md && cat b.md && cat c.md && rm x'))).toBe(
      'Read a.md, then Read b.md, then Delete x',
    );
  });

  it('describes a multi-file read with a count', () => {
    expect(describeToolCall(bash('cat a.md b.md c.md'))).toBe('Read 3 files');
  });

  it('describes a single-file read by basename', () => {
    expect(describeToolCall(bash('cat skills/bloom/INDEX.md'))).toBe('Read INDEX.md');
  });

  it('describes a script run by its basename', () => {
    expect(describeToolCall(bash('node skills/bloom/scripts/validate-bloom.mjs'))).toBe(
      'Run validate-bloom.mjs',
    );
  });

  it('describes a subcommand CLI with its subcommand', () => {
    expect(describeToolCall(bash('git commit -m "wip"'))).toBe('Run git commit');
  });

  it('names a push by what it does, from the same catalog the gate judged it with', () => {
    expect(describeToolCall(bash('git push origin main'))).toBe('Push to main on origin');
    expect(describeToolCall(bash('git push -u origin feature/x'))).toBe('Push feature/x to origin');
  });

  it('describes a compound command step by step', () => {
    expect(describeToolCall(bash('ls && rm x'))).toBe('List files, then Delete x');
  });

  it('describes a search with its pattern', () => {
    expect(describeToolCall(bash('grep -r needle src'))).toBe('Search files for "needle"');
  });

  it('falls back to a generic verb phrase when the command cannot be enumerated', () => {
    // Unparseable ($(…)) — the head token still names the intent class.
    expect(describeToolCall(bash('cat "$(ls lib)"'))).toBe('Read files');
  });

  it('says nothing inventive about an unknown unparseable head', () => {
    // Was "Run somecli". Minting copy from any plain-word head is what let the
    // shell keyword `for` become a headline on a read-only probe loop (task
    // 564a0462, 2026-08-10); a program name we do not recognize says no more to
    // a non-technical reader than a keyword does. Recognized heads still speak
    // (see the cases above and below) — see describe-tool.no-raw-token.test.ts.
    expect(describeToolCall(bash('somecli "$(pwd)"'))).toBe('Run a shell command');
  });

  it('never UNDERSTATES a hidden delete on the unparseable path', () => {
    // The floor asks about this command because of the rm token; the headline
    // must not read as a harmless read. Said without shell words, because the
    // reader is not a shell user.
    expect(describeToolCall(bash('cat "$(rm x)"'))).toBe('Delete files in your workspace');
  });

  it('never invents a verb from a script preamble (the c479 shape)', () => {
    // `set -euo pipefail` opens most agent-authored scripts. Lifting its first
    // token produced "Run set" on a real delete ask (staging incident c479).
    expect(describeToolCall(bash("set -euo pipefail\nold='x'\ncurl -X DELETE $URL"))).toBe(
      'Run a shell command',
    );
  });

  it('reads a heredoc as data, not as the command being run', () => {
    // The guard strips heredoc bodies before judging; the words must agree with
    // the guard, or a documented "rm -rf" becomes a delete headline.
    expect(describeToolCall(bash("cat > notes.md <<'EOF'\nrm -rf build\nEOF"))).toBe(
      'Read notes.md',
    );
  });
});

describe('describeToolCall — file tools', () => {
  it('describes a Write by basename', () => {
    expect(describeToolCall(call('Write', { file_path: '/app/workspace/files/report.md' }))).toBe(
      'Save report.md',
    );
  });

  it('describes an Edit by basename', () => {
    expect(describeToolCall(call('Edit', { file_path: 'notes/plan.md' }))).toBe('Edit plan.md');
  });

  it('describes a Read by basename', () => {
    expect(describeToolCall(call('Read', { file_path: 'a/b/c.txt' }))).toBe('Read c.txt');
  });
});

describe('describeToolCall — Composio / MCP humanization', () => {
  it('humanizes a Composio action with its toolkit', () => {
    expect(describeToolCall(call('mcp__composio__GMAIL_SEND_EMAIL'))).toBe('Send email on Gmail');
  });

  it('humanizes a multi-word Google toolkit', () => {
    expect(describeToolCall(call('mcp__composio__GOOGLE_CALENDAR_CREATE_EVENT'))).toBe(
      'Create event on Google Calendar',
    );
  });

  it('humanizes a generic MCP action with its server', () => {
    expect(describeToolCall(call('mcp__db__delete_row'))).toBe('Delete row (db)');
  });

  it('humanizes a squashed multi-word toolkit via the shared display table', () => {
    expect(describeToolCall(call('mcp__composio__GOOGLEDRIVE_GET_FILE_METADATA'))).toBe(
      'Get file metadata on Google Drive',
    );
    expect(describeToolCall(call('mcp__composio__LINKEDIN_CREATE_POST'))).toBe(
      'Create post on LinkedIn',
    );
  });

  it('capitalizes an unknown toolkit slug as the display fallback', () => {
    expect(describeToolCall(call('mcp__composio__ZAPIER_RUN_ACTION'))).toBe(
      'Run action on Zapier',
    );
  });
});

describe('describeToolCall — totality + copy rules', () => {
  it('falls back to "Use <tool>" for unknown tools', () => {
    expect(describeToolCall(call('SomeNewTool'))).toBe('Use SomeNewTool');
  });

  it('never throws on malformed input', () => {
    expect(describeToolCall(call('Bash', { command: 123 }))).toBe('Run a shell command');
    expect(describeToolCall(call('Bash', null))).toBe('Run a shell command');
    expect(describeToolCall({ toolName: '', toolInput: undefined, toolCallId: 'x' })).toBe(
      'Use this tool',
    );
    expect(
      describeToolCall(undefined as unknown as ToolCall),
    ).toBe('Use this tool');
  });

  it('produces copy with no em dashes and no "Claude" (user-facing rules)', () => {
    const samples = [
      describeToolCall(bash('rm -rf a b')),
      describeToolCall(bash('cat a b c')),
      describeToolCall(bash('node run.mjs')),
      describeToolCall(call('Write', { file_path: 'x.md' })),
      describeToolCall(call('mcp__composio__GMAIL_SEND_EMAIL')),
      describeToolCall(call('WeirdTool')),
    ];
    for (const s of samples) {
      expect(s).not.toContain('—');
      expect(s.toLowerCase()).not.toContain('claude');
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });

  it('truncates very long targets instead of overflowing the card', () => {
    const long = 'x'.repeat(200);
    const out = describeToolCall(bash(`cat ${long}.md`));
    expect(out.length).toBeLessThanOrEqual(80);
  });
});

describe('describeRule — stored permission-rule strings (test-locked)', () => {
  it('describes the git push family with a human verb', () => {
    expect(describeRule('Bash(git push:*)')).toBe('Push code with git');
  });

  it('describes an npm run-script family, dropping the filler "run"', () => {
    expect(describeRule('Bash(npm run test:*)')).toBe('Run npm test commands');
  });

  it('describes a generic Bash head family as "Run <head> commands"', () => {
    expect(describeRule('Bash(ls:*)')).toBe('Run ls commands');
  });

  it('describes a Write rule as an edit of the basename', () => {
    expect(describeRule('Write(/app/workspace/report.md)')).toBe('Edit report.md');
  });

  it('describes an Edit rule as an edit of the basename', () => {
    expect(describeRule('Edit(notes/plan.md)')).toBe('Edit plan.md');
  });

  it('describes a Read rule by the basename', () => {
    expect(describeRule('Read(a/b/c.txt)')).toBe('Read c.txt');
  });

  it('humanizes a Composio rule via the shared toolkit + verb tables', () => {
    expect(describeRule('mcp__composio__GMAIL_SEND_EMAIL')).toBe('Send email on Gmail');
    expect(describeRule('mcp__composio__GOOGLEDRIVE_GET_FILE_METADATA')).toBe(
      'Get file metadata on Google Drive',
    );
  });

  it('describes a WebFetch domain rule as "Fetch from <host>"', () => {
    expect(describeRule('WebFetch(domain:api.github.com)')).toBe('Fetch from api.github.com');
  });

  it('describes a bare tool rule as a blanket grant', () => {
    expect(describeRule('WebSearch')).toBe('Use WebSearch freely');
  });
});

describe('describeToolCall — Composio meta-executor unwrap', () => {
  const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
  const exec = (...slugs: string[]): ToolCall =>
    call(META, { tools: slugs.map((s) => ({ tool_slug: s, arguments: {} })) });

  it('describes a single inner action by what it will actually do', () => {
    expect(describeToolCall(exec('GMAIL_SEND_EMAIL'))).toBe('Send email on Gmail');
  });

  it('describes a multi-action payload with a count and the app list', () => {
    expect(describeToolCall(exec('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE'))).toBe(
      'Run 2 actions on Gmail and Notion',
    );
    expect(describeToolCall(exec('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'))).toBe(
      'Run 2 actions on Gmail',
    );
    expect(
      describeToolCall(exec('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE', 'SLACK_POST_MESSAGE')),
    ).toBe('Run 3 actions on Gmail, Notion and Slack');
  });

  it("falls back to today's copy when the payload cannot be read", () => {
    expect(describeToolCall(call(META, { tools: 'garbage' }))).toBe('Multi execute tool on Composio');
    expect(describeToolCall(call(META, {}))).toBe('Multi execute tool on Composio');
  });

  it('meta copy obeys the copy rules (no em dashes, no "Claude", ≤ 80 chars)', () => {
    const samples = [
      describeToolCall(exec('GMAIL_SEND_EMAIL')),
      describeToolCall(exec('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE')),
      describeToolCall(call(META, {})),
    ];
    for (const s of samples) {
      expect(s).not.toContain('—');
      expect(s.toLowerCase()).not.toContain('claude');
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('describeRule — totality + copy rules', () => {
  it('never throws on malformed or blanket input', () => {
    expect(describeRule('')).toBe('Use this tool');
    expect(describeRule(undefined as unknown as string)).toBe('Use this tool');
    expect(describeRule('Bash()')).toBe('Run any command');
    expect(describeRule('Bash(*)')).toBe('Run any command');
  });

  it('produces copy with no em dashes, no "Claude", and ≤ 80 chars', () => {
    const samples = [
      describeRule('Bash(git push:*)'),
      describeRule('Bash(npm run build:*)'),
      describeRule('Write(/a/b/report.md)'),
      describeRule('mcp__composio__GMAIL_SEND_EMAIL'),
      describeRule('WebFetch(domain:example.com)'),
      describeRule('SomeTool'),
    ];
    for (const s of samples) {
      expect(s).not.toContain('—');
      expect(s.toLowerCase()).not.toContain('claude');
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });
});
