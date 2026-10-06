import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { VaultEnv } from './env.js';
import { keepRawJson, securityHeaders } from './http/security.js';
import { internalRoutes } from './internal/routes.js';
import { pageRoutes } from './pages/routes.js';
import type { Rails } from './rails/rail.js';
import type { StripeLike } from './stripe-client.js';

export interface VaultDeps {
  env: VaultEnv;
  pool: pg.Pool;
  now: () => Date;
  stripe: StripeLike;
  rails: Rails;
  /** How the vault calls Go back. Tests pass a fetch that calls Go's app in process. */
  fetch: typeof fetch;
  logger?: FastifyServerOptions['logger'];
}

export async function buildVault(deps: VaultDeps): Promise<FastifyInstance> {
  // Request logging is off: link tokens travel in paths.
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true, trustProxy: true, bodyLimit: 64 * 1024 });
  keepRawJson(app);
  securityHeaders(app);
  app.get('/health', async () => ({ ok: true }));
  await app.register(internalRoutes, { deps });
  await app.register(pageRoutes, { deps });
  return app;
}
