import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeIxigoStore } from '../data.js';
import { registerFakeIxigoRoutes } from '../server.js';

const TOKEN = 'fake-ixigo-test-token-0001';
let app: FastifyInstance;
let base = '';

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerFakeIxigoRoutes(app, { store: new FakeIxigoStore({ now: () => new Date('2026-10-07T12:00:00Z') }), token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return client;
}
const body = (r: unknown): any => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('the fake ixigo over MCP', () => {
  it('lists its nine tools, marking searches and status read-only and cancelling destructive', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_booking', 'confirm_booking', 'flight_status', 'hold_booking', 'pnr_status', 'search_buses', 'search_flights', 'search_stays', 'search_trains',
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(hints.search_flights).toMatchObject({ readOnlyHint: true });
    expect(hints.search_stays).toMatchObject({ readOnlyHint: true });
    expect(hints.hold_booking).toMatchObject({ readOnlyHint: false });
    expect(hints.cancel_booking).toMatchObject({ destructiveHint: true });
    await c.close();
  });

  it('answers a flight search over the wire with the same fares as the catalog', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'search_flights', arguments: { origin: 'Delhi', destination: 'Goa', date: '2026-11-06' } });
    const flights = body(r).flights as Array<{ flight_no: string; fare_paise: number; depart_at: string }>;
    expect(flights.find((f) => f.flight_no === '2134')).toMatchObject({ fare_paise: 592000, depart_at: '2026-11-06T18:10:00+05:30' });
    await c.close();
  });

  it('answers a refused booking as a tool error with the reason', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'confirm_booking', arguments: { hold_id: 'hold_nope', payment_ref: 'x' } });
    expect(r.isError).toBe(true);
    expect(body(r)).toEqual({ error: 'hold_not_found' });
    await c.close();
  });

  it('refuses a call without the bearer, and takes POST only', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, name: 'fake-ixigo' });
  });
});
