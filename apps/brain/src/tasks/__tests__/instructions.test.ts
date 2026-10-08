import { describe, expect, it } from 'vitest';
import {
  DEMO_LISTINGS, GO_BLOCKED_PATHS, GO_BROWSER_DOMAINS, GO_DENY_TOOLS, GO_RECIPE_INSTRUCTIONS, GO_TASK_INSTRUCTIONS, GO_WEBHOOK_EVENTS,
  goRecipeManifest, goTaskManifest,
} from '../instructions.js';

describe('the travel search job (go-recipe)', () => {
  it('passes the script to computer_eval as its expression, waits for the results first, and returns rows unchanged', () => {
    // Bash's computer_eval takes `expression`: a call with `script` is refused, and the model's retry costs about 7 s.
    expect(GO_RECIPE_INSTRUCTIONS).toContain('Call computer_eval with the script as its `expression` argument, exactly as given.');
    expect(GO_RECIPE_INSTRUCTIONS).toContain('Call computer_wait with the text the message names, so the results are on the page.');
    expect(GO_RECIPE_INSTRUCTIONS).toContain('Return that list as rows, unchanged.');
    // When computer_eval is held for a person's yes, a read-only snapshot instead; never a looser money guard.
    expect(GO_RECIPE_INSTRUCTIONS).toContain('call computer_snapshot with full set to true instead');
    expect(GO_RECIPE_INSTRUCTIONS).not.toMatch(/[—–]/);
  });
});

describe("Go's job instructions", () => {
  it('fit in the 8,000 characters a deployment allows, in plain words with no dashes', () => {
    expect(GO_TASK_INSTRUCTIONS.length).toBeLessThan(8000);
    expect(GO_TASK_INSTRUCTIONS).not.toMatch(/[—–]/);
  });

  it('in demo mode say plainly that the listings are simulated, to take them as they are and use their own facts', () => {
    expect(DEMO_LISTINGS).toContain("The listings from Go's search tools are simulated for this demo. Choose from them as they are, and don't check them against public websites.");
    for (const words of ['reviews', 'beach distance', 'own facts']) expect(DEMO_LISTINGS, words).toContain(words);
    expect(DEMO_LISTINGS).not.toMatch(/[—–]/);
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

  it("with the browser fetch, closes ixigo's payment page beside the sites it allows, on both deployments (Bash #4591)", () => {
    expect(GO_BLOCKED_PATHS).toEqual(['ixigo.com/payments/']);
    expect(goTaskManifest({ mcpServerId: 'mcp_go', model: 'default', denyTools: false }).browser).toBeUndefined();
    expect(goTaskManifest({ mcpServerId: 'mcp_go', model: 'default', denyTools: false, browserFetch: true }).browser).toEqual({
      allowed_domains: [...GO_BROWSER_DOMAINS], blocked_paths: ['ixigo.com/payments/'],
    });
    expect(goRecipeManifest({ model: 'fast', denyTools: false }).browser).toBeUndefined();
    expect(goRecipeManifest({ model: 'fast', denyTools: false, browserFetch: true }).browser).toEqual({ blocked_paths: ['ixigo.com/payments/'] });
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
