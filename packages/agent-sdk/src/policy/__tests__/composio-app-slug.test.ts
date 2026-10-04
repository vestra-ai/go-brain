/**
 * appSlugForToolCall — the toolkit slug that names a permission card's brand
 * icon. It MUST derive from the same unwrap the gate/summary use, so the icon
 * can never contradict the decision. In particular the incident case
 * (a lone GMAIL_SEND_EMAIL laundered through COMPOSIO_MULTI_EXECUTE_TOOL) must
 * still resolve to "gmail" — the wrapper's own name names no app.
 */
import { describe, it, expect } from 'vitest';
import { appSlugForToolCall } from '../composio-naming.js';
import type { ToolCall } from '../../contract/harness.js';

const call = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 'tc_1',
});

const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
/** The real payload shape the incident trace carried. */
const meta = (...slugs: string[]): ToolCall =>
  call(META, { tools: slugs.map((s) => ({ tool_slug: s, arguments: {} })) });

describe('appSlugForToolCall', () => {
  it('names the app for a direct Composio tool', () => {
    expect(appSlugForToolCall(call('mcp__composio__GMAIL_SEND_EMAIL'))).toBe('gmail');
    expect(appSlugForToolCall(call('mcp__composio__GITHUB_CREATE_ISSUE'))).toBe('github');
    expect(appSlugForToolCall(call('mcp__composio__GOOGLEDRIVE_UPLOAD'))).toBe('googledrive');
  });

  it('unwraps a single-app meta-executor to that app (the incident case)', () => {
    expect(appSlugForToolCall(meta('GMAIL_SEND_EMAIL'))).toBe('gmail');
  });

  it('names the app when every inner action shares one toolkit', () => {
    expect(appSlugForToolCall(meta('GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'))).toBe('gmail');
  });

  it('returns null when a meta-executor spans several apps (no single icon)', () => {
    expect(appSlugForToolCall(meta('GMAIL_SEND_EMAIL', 'SLACK_POST_MESSAGE'))).toBeNull();
  });

  it('returns null for an opaque executor payload (REMOTE_WORKBENCH has no tools[])', () => {
    expect(appSlugForToolCall(call('mcp__composio__COMPOSIO_REMOTE_WORKBENCH', { code: '…' }))).toBeNull();
    expect(appSlugForToolCall(meta())).toBeNull(); // empty tools[]
  });

  it('returns null for discovery/connection meta-tools (they name no app)', () => {
    expect(appSlugForToolCall(call('mcp__composio__COMPOSIO_SEARCH_TOOLS'))).toBeNull();
    expect(appSlugForToolCall(call('mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'))).toBeNull();
    expect(appSlugForToolCall(call('mcp__composio__MY_CONNECTIONS'))).toBeNull();
  });

  it('returns null for non-Composio tools and garbage input', () => {
    expect(appSlugForToolCall(call('Bash', { command: 'ls' }))).toBeNull();
    expect(appSlugForToolCall(call('Write', { file_path: '/tmp/x' }))).toBeNull();
    expect(appSlugForToolCall(call(''))).toBeNull();
    expect(appSlugForToolCall({ toolName: undefined as unknown as string, toolInput: {}, toolCallId: 't' })).toBeNull();
  });
});
