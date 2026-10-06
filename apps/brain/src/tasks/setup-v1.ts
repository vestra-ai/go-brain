/**
 * One-time /v1 setup for Go, safe to run again: memory off for the org, Go's MCP server (its Authorization header a
 * ${user_secret:TRIP_TOKEN} reference), the go-trip-task deployment (a new version on every run; promoted when the key
 * is live), and the webhook endpoint. Prints the ids to put in Railway. Needs a key with the admin and setup scopes.
 */
import { createHash } from 'node:crypto';
import { GO_DEPLOYMENT_SLUG, GO_MCP_SLUG, GO_WEBHOOK_EVENTS, goTaskManifest } from './instructions.js';
import { V1Error, createV1Client } from './v1-client.js';

export interface SetupV1Options {
  baseUrl: string;
  key: string;
  publicUrl: string;
  model?: string;
  /** Send deny_tools: only once Bash PR 2 is on the target, since /v1 refuses a manifest key it does not know. */
  denyTools?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}
export interface SetupV1Result { deploymentId: string; version: number; promoted: boolean; mcpServerId: string; webhookId: string; webhookSecret: string | null }

interface Page<T> { data: T[] }
interface Server { id: string; slug: string; url: string }
interface Deployment { id: string; draft_version: number }

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export async function setupV1(o: SetupV1Options): Promise<SetupV1Result> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const v1 = createV1Client({ baseUrl: o.baseUrl, keys: [o.key], adminKey: o.key, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const publicUrl = o.publicUrl.replace(/\/+$/, '');
  const mcpUrl = `${publicUrl}/mcp`;
  const hookUrl = `${publicUrl}/v1-webhooks`;

  await v1.call('PATCH', '/v1/org', { admin: true, body: { memory_mode: 'none' } });
  log('org: memory_mode is none');

  const servers = await v1.call<Page<Server>>('GET', '/v1/mcp-servers', { query: { limit: 100 } });
  let server = servers.data.find((s) => s.slug === GO_MCP_SLUG);
  if (!server) {
    server = await v1.call<Server>('POST', '/v1/mcp-servers', {
      idempotencyKey: `go-mcp-${short(mcpUrl)}`,
      body: { name: 'Go trip tools', slug: GO_MCP_SLUG, url: mcpUrl, auth: { type: 'headers', headers: { Authorization: 'Bearer ${user_secret:TRIP_TOKEN}' } } },
    });
    log(`mcp server: registered ${server.id} at ${mcpUrl}`);
  } else if (server.url !== mcpUrl) {
    server = await v1.call<Server>('PATCH', `/v1/mcp-servers/${server.id}`, { body: { url: mcpUrl } });
    log(`mcp server: ${server.id} moved to ${mcpUrl}`);
  } else {
    log(`mcp server: ${server.id} is at ${mcpUrl}`);
  }

  const manifest = goTaskManifest({ mcpServerId: server.id, model: o.model ?? 'default', denyTools: o.denyTools === true });
  const note = o.denyTools ? 'Go trip task, with deny_tools' : 'Go trip task';
  let dep: Deployment | null = null;
  try {
    dep = await v1.call<Deployment>('GET', `/v1/deployments/${GO_DEPLOYMENT_SLUG}`);
  } catch (err) {
    if (!(err instanceof V1Error && err.status === 404)) throw err;
  }
  let version: number;
  if (!dep) {
    dep = await v1.call<Deployment>('POST', '/v1/deployments', {
      idempotencyKey: `go-dep-${short(JSON.stringify(manifest))}`,
      body: { name: 'Go trip task', slug: GO_DEPLOYMENT_SLUG, description: "Go's jobs on a trip's computer", manifest, note },
    });
    version = dep.draft_version;
    log(`deployment: created ${dep.id}, version ${version}`);
  } else {
    const saved = await v1.call<{ version: number }>('POST', `/v1/deployments/${dep.id}/versions`, {
      idempotencyKey: `go-ver-${dep.id}-${short(JSON.stringify(manifest))}`,
      body: { manifest, note },
    });
    version = saved.version;
    log(`deployment: ${dep.id}, version ${version}`);
  }
  const promoted = o.key.startsWith('vk_live_');
  if (promoted) {
    await v1.call('POST', `/v1/deployments/${dep.id}/versions/${version}/promote`);
    log(`deployment: version ${version} is live`);
  }

  const hooks = await v1.call<Page<{ id: string; url: string }>>('GET', '/v1/webhooks', { query: { limit: 100 } });
  const existing = hooks.data.find((h) => h.url === hookUrl);
  let webhookId: string;
  let webhookSecret: string | null = null;
  if (existing) {
    webhookId = existing.id;
    log(`webhook: ${webhookId} is at ${hookUrl}`);
  } else {
    const made = await v1.call<{ id: string; secret: string }>('POST', '/v1/webhooks', { body: { url: hookUrl, events: [...GO_WEBHOOK_EVENTS], description: 'Go: job and interaction events' } });
    webhookId = made.id;
    webhookSecret = made.secret;
    log(`webhook: registered ${webhookId} at ${hookUrl}`);
  }

  log('');
  log("Put these in Railway, on Go's brain service:");
  log(`VESTRA_DEPLOYMENT_ID=${dep.id}`);
  log(`VESTRA_MCP_SERVER_ID=${server.id}`);
  if (webhookSecret) log(`VESTRA_WEBHOOK_SECRET=${webhookSecret}`);
  else log('VESTRA_WEBHOOK_SECRET stays as it is (the endpoint already existed). If it was lost, roll it with POST /v1/webhooks/{id}/roll-secret.');
  return { deploymentId: dep.id, version, promoted, mcpServerId: server.id, webhookId, webhookSecret };
}
