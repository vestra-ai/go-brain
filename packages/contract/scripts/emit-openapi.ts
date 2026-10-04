/**
 * Writes packages/contract/openapi.json from the zod schemas (the source of truth).
 * The Go team generates their client/server types from that file. CI fails if it is stale.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ROUTES } from '../src/routes.js';
import { SIGNATURE_HEADER } from '../src/signing.js';

const schema = (s: z.ZodType, io: 'input' | 'output') => z.toJSONSchema(s, { io, unrepresentable: 'any' });
const paths: Record<string, Record<string, unknown>> = {};
for (const r of ROUTES) {
  const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  paths[r.path] ??= {};
  paths[r.path]![r.method.toLowerCase()] = {
    operationId: r.id,
    summary: r.summary,
    tags: [r.server],
    parameters: [
      ...params,
      { name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' },
        description: 't=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>' },
    ],
    ...(r.request ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.request, 'input') } } } } : {}),
    responses: { [r.id === 'postMessageIn' ? '202' : '200']: { description: 'OK', content: { 'application/json': { schema: schema(r.response, 'output') } } },
      '401': { description: 'Missing, stale or wrong signature' }, '422': { description: 'Body failed the schema' } },
  };
}
const doc = {
  openapi: '3.1.0',
  info: { title: 'Go contract: go-server ⇄ go-brain', version: '0.1.0',
    description: 'Tag go-brain = routes go-brain serves; tag go-server = routes go-server serves. Money is integer minor units. The spend approval token format is in packages/contract/src/spend-approval.ts.' },
  paths,
};
const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out} (${ROUTES.length} routes)`);
