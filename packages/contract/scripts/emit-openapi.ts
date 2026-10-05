/**
 * Writes the machine-readable contract from the zod schemas (the source of truth):
 *  - openapi/go-brain.json   OpenAPI 3.1: go-brain's two HTTP routes, and every schema under components
 *  - asyncapi/socket.json    AsyncAPI 3.0: the socket, every method in both directions
 *  - socket/methods.json     the method table in plain JSON (name, direction, params, result, time limit)
 * The Python models are generated from openapi/go-brain.json. CI fails if any of these is stale.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONTRACT_VERSION } from '../src/index.js';
import { HTTP_ROUTES } from '../src/routes.js';
import { SIGNATURE_HEADER } from '../src/signing.js';
import { SOCKET_METHODS, SOCKET_PATH } from '../src/socket.js';

const idOf = (s: z.ZodType): string => {
  const id = z.globalRegistry.get(s)?.id;
  if (!id) throw new Error('every params and result schema must be named (.meta({ id }))');
  return id;
};
const ref = (s: z.ZodType) => ({ $ref: `#/components/schemas/${idOf(s)}` });

const { schemas } = z.toJSONSchema(z.globalRegistry, {
  uri: (id) => `#/components/schemas/${id}`,
  io: 'input',
  unrepresentable: 'any',
}) as { schemas: Record<string, Record<string, unknown>> };

/** Drop generator noise: the registry id, and the long date regexes (the format already says it). */
function tidy(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(tidy);
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  delete o.$schema;
  delete o.$id;
  // zod's meta id is a string; a property named `id` (a frame's id) is a schema object and stays.
  if (typeof o.id === 'string') delete o.id;
  if ((o.format === 'date-time' || o.format === 'date') && typeof o.pattern === 'string') delete o.pattern;
  Object.values(o).forEach(tidy);
}
tidy(schemas);

const root = fileURLToPath(new URL('../', import.meta.url));
const write = (path: string, value: unknown) => {
  mkdirSync(root + path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(root + path, JSON.stringify(value, null, 2) + '\n');
};
rmSync(root + 'openapi/go-server.json', { force: true });

// ── OpenAPI: the HTTP routes and every schema ──
const paths: Record<string, unknown> = {};
for (const r of HTTP_ROUTES) {
  paths[r.path] = {
    get: {
      operationId: r.id,
      summary: r.summary,
      parameters: r.signed
        ? [{ name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' },
            description: 't=<unix seconds>,v1=<hex HMAC-SHA256(GO_SIGNING_SECRET, "<t>\\nGET\\n/v1/socket\\n")>' }]
        : [],
      responses: r.response
        ? { '200': { description: 'OK', content: { 'application/json': { schema: ref(r.response) } } } }
        : { '101': { description: 'Switching to the WebSocket. Every frame after this is JSON-RPC 2.0; see asyncapi/socket.json.' },
            '401': { description: 'Missing, stale or wrong signature' } },
    },
  };
}
write('openapi/go-brain.json', {
  openapi: '3.1.0',
  info: { title: 'The Go brain API', version: CONTRACT_VERSION,
    description: 'go-brain is Go, the AI member of every trip group. go-server opens one WebSocket to it and keeps it open; everything travels on that socket as JSON-RPC 2.0. This file has the two HTTP routes and every schema. The socket methods are in asyncapi/socket.json and socket/methods.json. Guide: docs/guide in vestra-ai/go-brain.' },
  paths,
  components: { schemas },
});

// ── the method table ──
const table = SOCKET_METHODS.map((x) => ({
  name: x.name, direction: x.direction, summary: x.summary,
  params: idOf(x.params), result: x.result ? idOf(x.result) : null,
  answer_within_seconds: x.answer_within, sends_event: x.sends_event ?? null,
}));
write('socket/methods.json', { contract: CONTRACT_VERSION, path: SOCKET_PATH, protocol: 'JSON-RPC 2.0 over WebSocket', methods: table });

// ── AsyncAPI 3.0: the socket, described from go-brain's side ──
const messages: Record<string, unknown> = {};
const operations: Record<string, unknown> = {};
for (const x of SOCKET_METHODS) {
  messages[x.name] = { name: x.name, title: x.name, summary: x.summary, payload: {
    type: 'object', required: x.result ? ['jsonrpc', 'id', 'method', 'params'] : ['jsonrpc', 'method', 'params'],
    properties: { jsonrpc: { const: '2.0' }, ...(x.result ? { id: { type: 'string' } } : {}), method: { const: x.name },
      params: { $ref: `#/components/schemas/${idOf(x.params)}` } } } };
  if (x.result) {
    messages[`${x.name}_result`] = { name: `${x.name}_result`, title: `${x.name} answer`, payload: {
      oneOf: [{ type: 'object', required: ['jsonrpc', 'id', 'result'], properties: { jsonrpc: { const: '2.0' }, id: { type: 'string' },
        result: { $ref: `#/components/schemas/${idOf(x.result)}` } } }, { $ref: '#/components/schemas/SocketError' }] } };
  }
  operations[x.name] = {
    action: x.direction === 'to_brain' ? 'receive' : 'send',
    channel: { $ref: '#/channels/socket' },
    summary: x.summary,
    messages: [{ $ref: `#/channels/socket/messages/${x.name}` }],
    ...(x.result ? { reply: { channel: { $ref: '#/channels/socket' }, messages: [{ $ref: `#/channels/socket/messages/${x.name}_result` }] } } : {}),
  };
}
write('asyncapi/socket.json', {
  asyncapi: '3.0.0',
  info: { title: 'The Go brain socket', version: CONTRACT_VERSION,
    description: 'Described from go-brain\'s side: "receive" methods are sent by go-server, "send" methods are sent by Go. Frames are JSON-RPC 2.0.' },
  servers: { staging: { host: 'brain.go.example', protocol: 'wss', pathname: SOCKET_PATH } },
  channels: { socket: { address: SOCKET_PATH, messages } },
  operations,
  components: { schemas },
});
console.log(`wrote openapi/go-brain.json, asyncapi/socket.json and socket/methods.json: ${SOCKET_METHODS.length} socket methods, ${Object.keys(schemas).length} schemas`);
