import { describe, it, expect } from 'vitest';
import { classifySideEffect, composioToolkitOf, type SideEffectFamily } from '../side-effect-classifier.js';
import type { ToolCall } from '../../contract/harness.js';

// The classifier's ONE job: map a tool call to its side-effect family, so the
// access-level ladder can decide ask vs run. The table below is load-bearing —
// it is the production definition of what "Balanced" (asks on external send +
// mutation + delete + payment) means. See spec §2.1.

const WS = '/app/workspace';
const classify = (
  toolName: string,
  toolInput: unknown = {},
  ctx: { workspaceRoot?: string; shellCwd?: string | null } = {},
): SideEffectFamily =>
  classifySideEffect(
    { toolName, toolInput, toolCallId: 't' } as ToolCall,
    { workspaceRoot: ctx.workspaceRoot ?? WS, shellCwd: ctx.shellCwd },
  );

const bash = (command: string, ctx?: { workspaceRoot?: string; shellCwd?: string | null }) =>
  classify('Bash', { command }, ctx);

describe('classifySideEffect — readonly', () => {
  it('builtin reads', () => {
    expect(classify('Read', { file_path: 'a.txt' })).toBe('readonly');
    expect(classify('Glob', { pattern: '*.ts' })).toBe('readonly');
    expect(classify('Grep', { pattern: 'foo' })).toBe('readonly');
  });
  it('web + progress tools', () => {
    expect(classify('WebFetch', { url: 'https://x.com' })).toBe('readonly');
    expect(classify('WebSearch', { query: 'x' })).toBe('readonly');
    expect(classify('web_search', { query: 'x' })).toBe('readonly');
    expect(classify('TodoWrite', { todos: [] })).toBe('readonly');
  });
  it('interactive tools are readonly (never level-gated — they mint their own interaction)', () => {
    expect(classify('AskUserQuestion', {})).toBe('readonly');
    expect(classify('ExitPlanMode', {})).toBe('readonly');
  });
  it('bash reads', () => {
    expect(bash('ls -la')).toBe('readonly');
    expect(bash('cat foo.txt')).toBe('readonly');
    expect(bash('git status')).toBe('readonly');
    expect(bash('grep -r foo .')).toBe('readonly');
    expect(bash('echo perform')).toBe('readonly'); // perform ≠ rm
    expect(bash('cat form.txt')).toBe('readonly'); // form ≠ rm
  });
  it('composio + mcp reads (READ verbs)', () => {
    expect(classify('mcp__composio__GMAIL_FETCH_EMAILS')).toBe('readonly');
    expect(classify('mcp__composio__AIRTABLE_LIST_RECORDS')).toBe('readonly');
    expect(classify('mcp__composio__GITHUB_GET_REPO')).toBe('readonly'); // delete toolkit, GET verb → read
    expect(classify('mcp__server__get_list')).toBe('readonly');
    expect(classify('mcp__server__list_rows')).toBe('readonly');
  });
});

describe('classifySideEffect — workspace_write', () => {
  it('builtin edits', () => {
    expect(classify('Write', { file_path: 'a.txt' })).toBe('workspace_write');
    expect(classify('Edit', { file_path: 'a.txt' })).toBe('workspace_write');
    expect(classify('NotebookEdit', { file_path: 'a.ipynb' })).toBe('workspace_write');
    expect(classify('MultiEdit', { file_path: 'a.txt' })).toBe('workspace_write');
  });
  it('patch update/add (pure write, no delete/move) → workspace_write', () => {
    expect(classify('Patch', { input: '*** Update File: a.ts\n@@\n-x\n+y' })).toBe('workspace_write');
    expect(classify('Patch', { input: '*** Add File: new.ts\n+hello' })).toBe('workspace_write');
  });
  it('bash writes (redirect / mutating head)', () => {
    expect(bash('echo hi > out.txt')).toBe('workspace_write');
    expect(bash('mkdir foo')).toBe('workspace_write');
    expect(bash('cp a b')).toBe('workspace_write');
    expect(bash('git commit -m x')).toBe('workspace_write');
  });
  it('SAFE rm (plain, specific, in-workspace) is a workspace write, not a dangerous delete', () => {
    expect(bash('rm foo.txt')).toBe('workspace_write');
    expect(bash('rm scratch.txt')).toBe('workspace_write');
    expect(bash('rmdir emptydir')).toBe('workspace_write');
  });
  it('unparseable bash with NO delete/glob/force token → workspace_write (never readonly — fail toward asking)', () => {
    expect(bash('echo $(printf x)')).toBe('workspace_write');
    expect(bash('cat "$(ls "$DIR")"')).toBe('workspace_write');
  });
});

describe('classifySideEffect — dangerous_delete', () => {
  it('recursive / force / glob rm', () => {
    expect(bash('rm -rf /')).toBe('dangerous_delete');
    expect(bash('rm -rf scratch/')).toBe('dangerous_delete');
    expect(bash('sudo rm -rf x')).toBe('dangerous_delete');
    expect(bash('rm *.md')).toBe('dangerous_delete');
  });
  it('rm escaping the workspace via a persisted shell cwd', () => {
    expect(bash('rm hostname', { workspaceRoot: WS, shellCwd: '/etc' })).toBe('dangerous_delete');
  });
  it('cd out of the workspace then a relative rm (in-command cwd move)', () => {
    expect(bash('cd /etc && rm hostname', { workspaceRoot: WS, shellCwd: WS })).toBe('dangerous_delete');
  });
  it('most-severe across positions: a safe read + a dangerous rm', () => {
    expect(bash('ls && rm -rf /')).toBe('dangerous_delete');
    expect(bash('echo x > f && rm -rf g')).toBe('dangerous_delete');
  });
  it('unparseable bash carrying a delete/force token', () => {
    expect(bash('echo $(rm -rf /)')).toBe('dangerous_delete');
    expect(bash('cat "$(rm x)"')).toBe('dangerous_delete');
  });
  it('patch delete / move envelopes', () => {
    expect(classify('Patch', { input: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' })).toBe('dangerous_delete');
    expect(classify('Patch', { input: '*** Move File: a.ts -> b.ts' })).toBe('dangerous_delete');
  });
  it('composio + mcp deletes', () => {
    expect(classify('mcp__composio__GITHUB_DELETE_REPO')).toBe('dangerous_delete');
    expect(classify('mcp__composio__AIRTABLE_DELETE_RECORD')).toBe('dangerous_delete'); // unknown toolkit + DELETE verb
    expect(classify('mcp__composio__AIRTABLE_PURGE_BASE')).toBe('dangerous_delete');
    expect(classify('mcp__db__delete_row')).toBe('dangerous_delete');
    expect(classify('mcp__cache__purge_all')).toBe('dangerous_delete');
  });
});

describe('classifySideEffect — external_send', () => {
  it('composio sends (SEND / REPLY / POST / PUBLISH verbs)', () => {
    expect(classify('mcp__composio__GMAIL_SEND_EMAIL')).toBe('external_send');
    expect(classify('mcp__composio__SLACK_SEND_MESSAGE')).toBe('external_send');
    expect(classify('mcp__composio__SLACK_REPLY_TO_MESSAGE')).toBe('external_send');
    expect(classify('mcp__composio__TWITTER_POST_TWEET')).toBe('external_send');
    expect(classify('mcp__composio__LINKEDIN_PUBLISH_POST')).toBe('external_send');
  });
  it('generic mcp sends', () => {
    expect(classify('mcp__server__publish')).toBe('external_send');
    expect(classify('mcp__server__send')).toBe('external_send');
  });
});

describe('classifySideEffect — external_mutation', () => {
  it('composio create/update on a non-payment/non-delete toolkit', () => {
    expect(classify('mcp__composio__NOTION_UPDATE_PAGE')).toBe('external_mutation');
    expect(classify('mcp__composio__NOTION_ARCHIVE_PAGE')).toBe('external_mutation'); // unknown verb
    expect(classify('mcp__composio__GITHUB_CREATE_ISSUE')).toBe('external_mutation'); // delete toolkit, CREATE (not delete)
  });
  it('a known PAYMENT toolkit with a non-payment verb is NOT payment (matches the floor)', () => {
    expect(classify('mcp__composio__STRIPE_DELETE_CUSTOMER')).toBe('external_mutation');
  });
  it('generic mcp mutation', () => {
    expect(classify('mcp__server__update_row')).toBe('external_mutation');
  });
  it('whole-word verb matching — near-misses are not send/delete', () => {
    expect(classify('mcp__composio__BLOG_REMOVED_DRAFTS')).toBe('external_mutation'); // REMOVED ≠ REMOVE
    expect(classify('mcp__server__sender_info')).toBe('external_mutation'); // SENDER ≠ SEND
  });
});

describe('classifySideEffect — payment', () => {
  it('composio payment toolkits + payment verbs', () => {
    expect(classify('mcp__composio__STRIPE_CREATE_CHARGE')).toBe('payment');
    expect(classify('mcp__composio__PAYPAL_CREATE_PAYOUT')).toBe('payment');
  });
  it('unknown toolkit + payment verb', () => {
    expect(classify('mcp__composio__SOMEPAY_CHARGE_CARD')).toBe('payment');
    expect(classify('mcp__composio__SOMEPAY_TRANSFER_FUNDS')).toBe('payment');
  });
  it('generic mcp payment verbs', () => {
    expect(classify('mcp__bank__transfer_funds')).toBe('payment');
    expect(classify('mcp__wallet__withdraw_balance')).toBe('payment');
    expect(classify('mcp__shop__refund_order')).toBe('payment');
  });
});

// Workbench executors carry agent-authored CODE, not a tools[] list. The classifier
// scans the code so THE RULING holds (founder 2026-07-15 — at Relaxed only deletes/
// payments ask): a proxied send classifies like a direct send, a proxied delete/
// payment keeps its floor, pure local compute is a workspace_write, and anything we
// cannot read (dynamic slug, missing code) fails toward payment. Deep coverage lives
// in decide-tool-gate.meta-executor.test.ts; this pins the family table entries.
describe('classifySideEffect — workbench executor code scan', () => {
  const WB = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';
  const wb = (code: unknown) => classify(WB, typeof code === 'string' ? { code } : (code as object));
  it('pure local compute → workspace_write', () => {
    expect(wb('df = load(); print(df.head())')).toBe('workspace_write');
  });
  it('proxied read/send/delete/payment classify by the inner slug', () => {
    expect(wb('run_composio_tool("GMAIL_FETCH_EMAILS", {})')).toBe('readonly');
    expect(wb('run_composio_tool("GMAIL_SEND_EMAIL", {})')).toBe('external_send');
    expect(wb('proxy_execute("GITHUB_DELETE_REPO", {})')).toBe('dangerous_delete');
    expect(wb('run_composio_tool("STRIPE_CREATE_CHARGE", {})')).toBe('payment');
  });
  // 2026-09-21: unreadable has its OWN family — same hard floor at every level,
  // without the payment words (prod task 46f85398: "Approve a payment" for a
  // Notion write).
  it('dynamic slug / missing code fail toward unknown, at payment strength', () => {
    expect(wb('run_composio_tool(slug, {})')).toBe('unknown');
    expect(wb({})).toBe('unknown');
  });
});

describe('classifySideEffect — totality', () => {
  it('never throws on a malformed shape (defaults away from readonly for unknown non-read tools)', () => {
    expect(() => classify('Bash', { command: 123 })).not.toThrow();
    expect(() => classify('', undefined)).not.toThrow();
  });
});

// B1b: the ONE toolkit split, shared by classifyComposio and the gate's per-app
// config lookup — pinned here so the two can never drift on which app a call is.
describe('composioToolkitOf', () => {
  it('extracts the lowercased toolkit slug of a Composio tool', () => {
    expect(composioToolkitOf('mcp__composio__GMAIL_SEND_EMAIL')).toBe('gmail');
    expect(composioToolkitOf('mcp__composio__STRIPE_CREATE_CHARGE')).toBe('stripe');
    expect(composioToolkitOf('mcp__composio__NOTION_UPDATE_PAGE')).toBe('notion');
  });
  it('null for non-Composio tools', () => {
    expect(composioToolkitOf('Bash')).toBe(null);
    expect(composioToolkitOf('Write')).toBe(null);
    expect(composioToolkitOf('mcp__server__get_list')).toBe(null);
    expect(composioToolkitOf('')).toBe(null);
  });
  it("null when there is no action segment (mirrors classifyComposio's unknown-external branch)", () => {
    expect(composioToolkitOf('mcp__composio__GMAIL')).toBe(null);
    expect(composioToolkitOf('mcp__composio___LEADING')).toBe(null);
    expect(composioToolkitOf('mcp__composio__')).toBe(null);
  });
});
