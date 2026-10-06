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
  // Request logging off also silences Fastify's own 5xx logs, so a failed request is logged here: by its route pattern,
  // never by its path. Set before any route, so every route uses it.
  app.setErrorHandler((err, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const fields = { err, route: req.routeOptions.url };
    if (status >= 500) req.log.error(fields, 'request failed');
    else req.log.warn(fields, 'request refused');
    return reply
      .status(status)
      .send({ error: status >= 500 ? { code: 'internal', message: 'Something went wrong.' } : { code: 'bad_request', message: err.message.slice(0, 200) } });
  });
  keepRawJson(app);
  securityHeaders(app);
  app.get('/health', async () => ({ ok: true }));
  await app.register(internalRoutes, { deps });
  await app.register(pageRoutes, { deps });
  return app;
}
