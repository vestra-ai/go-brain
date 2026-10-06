/**
 * The fake ixigo as an MCP server: streamable HTTP, a fresh server and transport per request (nothing kept between
 * calls), a bearer when a token is set. Every tool answers its value as JSON text; a refusal is isError.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FAKE_IXIGO_ARGS, FAKE_IXIGO_TOOLS, callFakeIxigo, type FakeIxigoStore } from './data.js';

export function buildFakeIxigoServer(store: FakeIxigoStore): McpServer {
  const server = new McpServer({ name: 'fake-ixigo', version: '1.0.0' });
  for (const t of FAKE_IXIGO_TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: FAKE_IXIGO_ARGS[t.name].shape, annotations: t.annotations },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const r = callFakeIxigo(store, t.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(r.value) }], ...(r.isError ? { isError: true } : {}) };
      },
    );
  }
  return server;
}

function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/i.exec(header ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function registerFakeIxigoRoutes(app: FastifyInstance, o: { store: FakeIxigoStore; token?: string }): Promise<void> {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    if (o.token && !bearerOk(req.headers.authorization, o.token)) return reply.code(401).send({ error: 'unauthorized' });
    const server = buildFakeIxigoServer(o.store);
    // No sessionIdGenerator: stateless, one transport per request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    // The SDK writes the response itself; Fastify hands the raw socket over.
    reply.hijack();
    reply.raw.on('close', () => {
      void server.close().catch(() => undefined);
    });
    try {
      // The transport types its handlers `| undefined`, which exactOptionalPropertyTypes refuses for Transport.
      await server.connect(transport as Transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'mcp_failed' }));
      }
    }
    return reply;
  });
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(405).send({ error: 'method_not_allowed' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
  app.get('/health', async () => ({ ok: true, name: 'fake-ixigo' }));
}
