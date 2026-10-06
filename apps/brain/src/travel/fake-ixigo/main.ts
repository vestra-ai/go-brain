/**
 * The fake ixigo as its own process, for the demo and for anyone who wants to try Go's travel tools by hand:
 *   PORT=8788 FAKE_IXIGO_TOKEN=<random> pnpm --filter ./apps/brain fake-ixigo
 * Point Go at it with IXIGO_MCP_URL=http://<host>:8788/mcp and IXIGO_MCP_TOKEN=<the same token>.
 */
import Fastify from 'fastify';
import { FakeIxigoStore } from './data.js';
import { registerFakeIxigoRoutes } from './server.js';

const port = Number(process.env.PORT ?? 8788);
const token = process.env.FAKE_IXIGO_TOKEN;
const app = Fastify({ logger: true });
await registerFakeIxigoRoutes(app, { store: new FakeIxigoStore({ now: () => new Date() }), ...(token ? { token } : {}) });
await app.listen({ port, host: '0.0.0.0' });
