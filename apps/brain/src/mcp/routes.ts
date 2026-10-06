/**
 * POST /mcp: Go's MCP server over streamable HTTP, a fresh server and transport per request, closed with the
 * response. The bearer is a trip token; no token, a wrong one or a revoked one is 401 before anything is read.
 */
import type pg from 'pg';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildGoMcpServer, type GoMcpDeps } from './server.js';
import type { TokenStore } from './tokens.js';

export interface GoMcpRouteDeps extends GoMcpDeps {
  tokens: Pick<TokenStore, 'tripFor'>;
  log: Pick<FastifyBaseLogger, 'error'>;
}

const bearerOf = (header: string | undefined): string | null => /^Bearer (\S+)$/i.exec(header ?? '')?.[1] ?? null;

export async function registerGoMcp(app: FastifyInstance, d: GoMcpRouteDeps): Promise<void> {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerOf(req.headers.authorization);
    const tripId = token ? await d.tokens.tripFor(token) : null;
    if (!tripId) return reply.code(401).send({ error: 'unauthorized' });
    const server = buildGoMcpServer(tripId, d);
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
    } catch (err) {
      d.log.error({ err, tripId }, 'mcp: a request failed');
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
}

/** Writes each MCP call to mcp_calls, against the trip and the jobs running in it then. */
export function mcpCallRecorder(pool: pg.Pool, activeTaskIds: (tripId: string) => Promise<string[]>, now: () => Date): GoMcpDeps['record'] {
  return async (row) => {
    const taskIds = await activeTaskIds(row.tripId).catch(() => [] as string[]);
    await pool.query('insert into mcp_calls (trip_id, task_ids, tool, args, ok, ms, at) values ($1, $2, $3, $4, $5, $6, $7)', [
      row.tripId, taskIds, row.tool, JSON.stringify(row.args ?? {}), row.ok, Math.round(row.ms), now(),
    ]);
  };
}
