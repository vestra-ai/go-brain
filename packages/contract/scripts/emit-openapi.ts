/**
 * Writes openapi/go-server.json (what go-server serves) and openapi/go-brain.json (what go-brain
 * serves) from the zod schemas, which are the source of truth. Both files carry every schema under
 * components, so either one is enough to generate models (the Python models come from go-server.json).
 * CI fails if these files are stale.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONTRACT_VERSION } from '../src/index.js';
import { GO_BRAIN_ROUTES, GO_SERVER_ROUTES, type Route } from '../src/routes.js';
import { SIGNATURE_HEADER } from '../src/signing.js';

const ref = (s: z.ZodType): { $ref: string } => {
  const id = z.globalRegistry.get(s)?.id;
  if (!id) throw new Error('every route body must be a named schema (.meta({ id }))');
  return { $ref: `#/components/schemas/${id}` };
};

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
  delete o.id;
  if ((o.format === 'date-time' || o.format === 'date') && typeof o.pattern === 'string') delete o.pattern;
  Object.values(o).forEach(tidy);
}
tidy(schemas);

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
});

function paths(routes: readonly Route[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const pathParams = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 64 },
    }));
    const queryParams = Object.entries(r.query?.shape ?? {}).map(([name, field]) => ({
      name, in: 'query', required: !(field as z.ZodType).safeParse(undefined).success,
      schema: { type: name === 'trip_id' ? 'string' : 'integer' },
    }));
    const signed = r.id !== 'health';
    out[r.path] ??= {};
    out[r.path]![r.method.toLowerCase()] = {
      operationId: r.id,
      summary: r.summary,
      parameters: [
        ...pathParams,
        ...queryParams,
        ...(signed
          ? [{ name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' },
              description: 't=<unix seconds>,v1=<hex HMAC-SHA256(GO_SIGNING_SECRET, "<t>\\n<METHOD>\\n<path?query>\\n<raw body>")>' }]
          : []),
      ],
      ...(r.request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(r.request) } } } } : {}),
      responses: {
        [String(r.status)]: { description: r.status === 202 ? 'Accepted' : 'OK', content: { 'application/json': { schema: ref(r.response) } } },
        ...(signed ? { '401': errorResponse('Missing, stale or wrong signature') } : {}),
        '404': errorResponse('Unknown id'),
        '409': errorResponse('Clashes with the current state'),
        '422': errorResponse('The body did not match the contract'),
        '429': errorResponse('Too many requests'),
        '500': errorResponse('A bug on the server'),
        '503': errorResponse('Down for a moment'),
      },
    };
  }
  return out;
}

function doc(server: 'go-server' | 'go-brain', routes: readonly Route[], description: string) {
  return {
    openapi: '3.1.0',
    info: { title: `Go contract: what ${server} serves`, version: CONTRACT_VERSION, description },
    paths: paths(routes),
    components: { schemas },
  };
}

const dir = fileURLToPath(new URL('../openapi/', import.meta.url));
mkdirSync(dir, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(`${dir}${name}`, JSON.stringify(value, null, 2) + '\n');
write('go-server.json', doc('go-server', GO_SERVER_ROUTES,
  'The trip API. go-brain calls these to read the trip and act in it. Money is in whole minor units. Guide: docs/guide in vestra-ai/go-brain.'));
write('go-brain.json', doc('go-brain', GO_BRAIN_ROUTES,
  'Events in, and the questions go-server asks go-brain. Guide: docs/guide in vestra-ai/go-brain.'));
console.log(`wrote ${dir}go-server.json (${GO_SERVER_ROUTES.length} routes) and go-brain.json (${GO_BRAIN_ROUTES.length} routes), ${Object.keys(schemas).length} schemas`);
