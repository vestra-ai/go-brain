import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { registerFakeIxigoRoutes } from '../fake-ixigo/server.js';
import { createHttpMcpCaller, createInProcessCaller } from '../mcp-caller.js';

const NOW = new Date('2026-10-07T12:00:00Z');
let app: FastifyInstance;
let url = '';

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerFakeIxigoRoutes(app, { store: new FakeIxigoStore({ now: () => NOW }), token: 'tok-1234567890' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  await app.close();
});

const fakeClient = (callTool: () => Promise<unknown>) => ({ callTool: vi.fn(callTool), listTools: vi.fn(async () => ({ tools: [] })), close: vi.fn(async () => undefined) });

describe('createHttpMcpCaller', () => {
  it('calls a real MCP server with the bearer and reads its JSON answer and tool hints', async () => {
    const caller = createHttpMcpCaller({ url, token: 'tok-1234567890' });
    const r = await caller.call('search_flights', { origin: 'Delhi', destination: 'Goa', date: '2026-11-06' });
    expect(r.isError).toBe(false);
    expect((r.data as { flights: unknown[] }).flights).toHaveLength(10);
    const tools = await caller.listTools();
    expect(tools.find((t) => t.name === 'search_stays')?.annotations).toEqual({ readOnlyHint: true });
    await caller.close();
  });

  it('answers a JSON-RPC error on the same connection, without reconnecting', async () => {
    const client = fakeClient(async () => {
      throw new McpError(ErrorCode.InvalidParams, 'bad args');
    });
    const connectImpl = vi.fn(async () => client);
    const caller = createHttpMcpCaller({ url: 'https://ixigo.invalid/mcp', connectImpl });
    const r = await caller.call('search_flights', {});
    expect(r).toMatchObject({ isError: true, data: null });
    expect(r.text).toContain('bad args');
    expect(connectImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnects once after a transport failure, and says unreachable after a second', async () => {
    const dead = fakeClient(async () => {
      throw new Error('socket hang up');
    });
    const alive = fakeClient(async () => ({ content: [{ type: 'text', text: '{"ok":1}' }] }));
    const connectImpl = vi.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(alive);
    const caller = createHttpMcpCaller({ url: 'https://ixigo.invalid/mcp', connectImpl });
    expect(await caller.call('anything', {})).toEqual({ text: '{"ok":1}', data: { ok: 1 }, isError: false });
    expect(connectImpl).toHaveBeenCalledTimes(2);
    expect(dead.close).toHaveBeenCalled();

    const always = vi.fn(async () => fakeClient(async () => {
      throw new Error('ECONNRESET');
    }));
    const down = await createHttpMcpCaller({ url: 'https://ixigo.invalid/mcp', connectImpl: always }).call('anything', {});
    expect(down.isError).toBe(true);
    expect(down.text).toMatch(/unreachable/);
    expect(always).toHaveBeenCalledTimes(2);
  });
});

describe('createInProcessCaller', () => {
  it('runs the fake ixigo in this process, with the same answers and hints as over the wire', async () => {
    const caller = createInProcessCaller(new FakeIxigoStore({ now: () => NOW }));
    const r = await caller.call('search_stays', { location: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' });
    expect((r.data as { stays: unknown[] }).stays.length).toBeGreaterThan(5);
    expect((await caller.call('search_stays', { location: 'x' })).isError).toBe(true);
    const tools = await caller.listTools();
    expect(tools).toHaveLength(7);
    expect(tools.find((t) => t.name === 'hold_booking')?.inputSchema).toMatchObject({ type: 'object' });
  });
});
