import { describe, expect, it } from 'vitest';
import { GO_DENY_TOOLS, GO_TASK_INSTRUCTIONS, GO_WEBHOOK_EVENTS, goTaskManifest } from '../instructions.js';

describe("Go's job instructions", () => {
  it('fit in the 8,000 characters a deployment allows, in plain words with no dashes', () => {
    expect(GO_TASK_INSTRUCTIONS.length).toBeLessThan(8000);
    expect(GO_TASK_INSTRUCTIONS).not.toMatch(/[—–]/);
  });

  it('say the job, the to-do list, Go\'s tools, offer ids, the answer shape, and never paying or signing in with saved cards', () => {
    for (const words of ['to-do list', 'mcp_search', 'offer_id', 'output schema', 'Never pay', 'saved cards', 'hand-off', 'job context']) {
      expect(GO_TASK_INSTRUCTIONS, words).toContain(words);
    }
  });

  it("say that stays and journeys come from Go's search, each pick with its offer_id and whole price, and what a web-only pick is", () => {
    for (const words of ['take your choices from them first', 'total_paise', 'the whole stay', 'every traveller', 'offer_id to null', 'found on the web', 'source_url', 'call the place']) {
      expect(GO_TASK_INSTRUCTIONS, words).toContain(words);
    }
  });
});

describe('the go-trip-task manifest', () => {
  it('allows no apps, keeps no memory, caps spend at 2 dollars, and lets note run without asking', () => {
    const m = goTaskManifest({ mcpServerId: 'mcp_go', model: 'default', denyTools: false });
    expect(m).toMatchObject({
      instructions: GO_TASK_INSTRUCTIONS, mcp_servers: ['mcp_go'], apps: { allow: [] }, memory: { mode: 'none' }, limits: { spend_per_task_usd: 2 },
      mcp_tool_policy: [{ server: 'mcp_go', deny: [], require_approval: [], run_without_asking: ['note'] }],
      approvals: { always: ['payment', 'booking', 'cancellation'] },
    });
    expect(m).not.toHaveProperty('deny_tools');
    expect(goTaskManifest({ mcpServerId: 'mcp_go', model: 'default', denyTools: true }).deny_tools).toEqual([...GO_DENY_TOOLS]);
  });

  it("denies Bash's house tools and Composio, but never the tools that reach Go", () => {
    expect(GO_DENY_TOOLS).toContain('Agent');
    expect(GO_DENY_TOOLS).toContain('session_create');
    expect(GO_DENY_TOOLS).toContain('mcp__composio__*');
    expect(GO_DENY_TOOLS).not.toContain('mcp_search');
    expect(GO_DENY_TOOLS).not.toContain('mcp_invoke');
    expect(GO_WEBHOOK_EVENTS).toEqual(['task.started', 'task.completed', 'task.failed', 'task.stopped', 'interaction.created', 'interaction.resolved', 'interaction.expired']);
  });
});
