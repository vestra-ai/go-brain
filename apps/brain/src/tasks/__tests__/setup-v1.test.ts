import { describe, expect, it } from 'vitest';
import { GO_DENY_TOOLS } from '../instructions.js';
import { setupV1 } from '../setup-v1.js';

const KEY = `vk_test_${'s'.repeat(43)}`;
const LIVE = `vk_live_${'s'.repeat(43)}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface State { servers: Array<{ id: string; slug: string; url: string }>; deployment: { id: string; draft_version: number } | null; hooks: Array<{ id: string; url: string }> }
function fakeVestra(state: State) {
  const calls: Array<{ method: string; path: string; body: any; key: string | undefined }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const key = (init?.headers as Record<string, string>).authorization?.replace('Bearer ', '');
    calls.push({ method, path: url.pathname, body, key });
    const route = `${method} ${url.pathname}`;
    if (route === 'PATCH /v1/org') return json(200, { id: 'org_go', memory_mode: body.memory_mode });
    if (route === 'GET /v1/mcp-servers') return json(200, { data: state.servers });
    if (route === 'POST /v1/mcp-servers') {
      const s = { id: 'mcp_go1', slug: body.slug, url: body.url };
      state.servers.push(s);
      return json(201, s);
    }
    if (route === 'GET /v1/deployments/go-recipe') return json(404, { error: { code: 'deployment_not_found', message: 'none' } });
    if (route === 'POST /v1/deployments' && body.slug === 'go-recipe') return json(201, { id: 'dep_recipe1', draft_version: 1 });
    if (route === 'GET /v1/deployments/go-trip-task') return state.deployment ? json(200, state.deployment) : json(404, { error: { code: 'deployment_not_found', message: 'none' } });
    if (route === 'POST /v1/deployments') {
      state.deployment = { id: 'dep_go1', draft_version: 1 };
      return json(201, state.deployment);
    }
    if (/^POST \/v1\/deployments\/[^/]+\/versions$/.test(route)) {
      state.deployment!.draft_version += 1;
      return json(201, { object: 'deployment_version', version: state.deployment!.draft_version });
    }
    if (/\/promote$/.test(route)) return json(200, { promoted: true });
    if (route === 'GET /v1/webhooks') return json(200, { data: state.hooks });
    if (route === 'POST /v1/webhooks') {
      const h = { id: 'whk_go1', url: body.url };
      state.hooks.push(h);
      return json(201, { ...h, secret: 'whsec_test_secret_0123456789' });
    }
    return json(500, { error: { code: 'unexpected', message: route } });
  }) as typeof fetch;
  return { f, calls };
}

describe('setupV1', () => {
  it('on a fresh org: memory off, the MCP server with a secret reference, the deployment, the webhook, and the ids to set', async () => {
    const state: State = { servers: [], deployment: null, hooks: [] };
    const { f, calls } = fakeVestra(state);
    const lines: string[] = [];
    const r = await setupV1({ baseUrl: 'https://api.test', key: KEY, publicUrl: 'https://go.example/', fetch: f, log: (l) => lines.push(l) });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/org', body: { memory_mode: 'none' }, key: KEY });
    const mcp = calls.find((c) => c.method === 'POST' && c.path === '/v1/mcp-servers')!;
    expect(mcp.body).toEqual({ name: 'Go trip tools', slug: 'go-trip', url: 'https://go.example/mcp', auth: { type: 'headers', headers: { Authorization: 'Bearer ${user_secret:TRIP_TOKEN}' } } });
    const dep = calls.find((c) => c.method === 'POST' && c.path === '/v1/deployments')!;
    expect(dep.body).toMatchObject({ slug: 'go-trip-task', manifest: { mcp_servers: ['mcp_go1'], apps: { allow: [] } } });
    expect(dep.body.manifest).not.toHaveProperty('deny_tools');
    expect(dep.body.manifest).not.toHaveProperty('browser');
    expect(calls.some((c) => c.path === '/v1/deployments/go-recipe')).toBe(false);
    const hook = calls.find((c) => c.method === 'POST' && c.path === '/v1/webhooks')!;
    expect(hook.body).toMatchObject({ url: 'https://go.example/v1-webhooks', events: ['task.started', 'task.completed', 'task.failed', 'task.stopped', 'interaction.created', 'interaction.resolved', 'interaction.expired'] });
    expect(r).toEqual({ deploymentId: 'dep_go1', version: 1, promoted: false, mcpServerId: 'mcp_go1', webhookId: 'whk_go1', webhookSecret: 'whsec_test_secret_0123456789' });
    expect(lines).toContain('VESTRA_DEPLOYMENT_ID=dep_go1');
    expect(lines).toContain('VESTRA_MCP_SERVER_ID=mcp_go1');
    expect(lines).toContain('VESTRA_WEBHOOK_SECRET=whsec_test_secret_0123456789');
    expect(calls.some((c) => /promote$/.test(c.path))).toBe(false);
  });

  it('run again with --deny-tools: finds the server and the webhook, and saves a new version with deny_tools', async () => {
    const state: State = { servers: [{ id: 'mcp_go1', slug: 'go-trip', url: 'https://go.example/mcp' }], deployment: { id: 'dep_go1', draft_version: 1 }, hooks: [{ id: 'whk_go1', url: 'https://go.example/v1-webhooks' }] };
    const { f, calls } = fakeVestra(state);
    const r = await setupV1({ baseUrl: 'https://api.test', key: KEY, publicUrl: 'https://go.example', denyTools: true, fetch: f, log: () => undefined });
    expect(calls.filter((c) => c.method === 'POST' && (c.path === '/v1/mcp-servers' || c.path === '/v1/webhooks' || c.path === '/v1/deployments'))).toEqual([]);
    const version = calls.find((c) => c.path === '/v1/deployments/dep_go1/versions')!;
    expect(version.body.manifest.deny_tools).toEqual([...GO_DENY_TOOLS]);
    expect(r).toMatchObject({ version: 2, webhookSecret: null });
  });

  it('with the browser fetch and a recipe model: ixigo.com allowed for the trip user, and go-recipe on that model', async () => {
    const { f, calls } = fakeVestra({ servers: [], deployment: null, hooks: [] });
    const lines: string[] = [];
    const r = await setupV1({ baseUrl: 'https://api.test', key: KEY, publicUrl: 'https://go.example', browserFetch: true, recipeModel: 'fast-model', fetch: f, log: (l) => lines.push(l) });
    const trip = calls.find((c) => c.method === 'POST' && c.path === '/v1/deployments' && c.body.slug === 'go-trip-task')!;
    // ixigo and its train data, never ixigo's payment page (one click pays with a saved card there).
    expect(trip.body.manifest.browser).toEqual({ allowed_domains: ['ixigo.com', 'ixigotrainsapi.confirmtkt.com'], blocked_paths: ['ixigo.com/payments/'] });
    const recipe = calls.find((c) => c.method === 'POST' && c.path === '/v1/deployments' && c.body.slug === 'go-recipe')!;
    expect(recipe.body.manifest).toMatchObject({ model: 'fast-model', memory: { mode: 'none' }, limits: { spend_per_task_usd: 0.5 } });
    expect(recipe.body.manifest.instructions).toContain('computer_eval');
    expect(r.recipeDeploymentId).toBe('dep_recipe1');
    expect(lines).toContain('VESTRA_RECIPE_DEPLOYMENT_ID=dep_recipe1');
  });

  it('promotes the new version when the key is live', async () => {
    const { f, calls } = fakeVestra({ servers: [], deployment: null, hooks: [] });
    const r = await setupV1({ baseUrl: 'https://api.test', key: LIVE, publicUrl: 'https://go.example', fetch: f, log: () => undefined });
    expect(r.promoted).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/deployments/dep_go1/versions/1/promote')).toBe(true);
  });
});
