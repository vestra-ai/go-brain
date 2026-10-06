import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Brain } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { v1UserIdFor } from '../../tasks/computer.js';
import { armedToken, searchAsTheJob } from '../../tasks/testing/job-search.js';
import { FakeIxigoStore } from '../../travel/fake-ixigo/data.js';
import { createTravelLayer } from '../../travel/layer.js';
import { createFakeTravel } from '../../travel/mcp-travel.js';
import { createResultsStore, type ResultsStore } from '../../travel/results.js';
import { mcpCallRecorder, registerGoMcp } from '../routes.js';
import { createTokenStore, type TokenStore } from '../tokens.js';

const now = () => new Date('2026-10-07T12:00:00Z');
const LATER = new Date('2026-10-07T13:00:00Z');
let db: Awaited<ReturnType<typeof withSchema>>;
let app: FastifyInstance;
let base = '';
let tokens: TokenStore;
let results: ResultsStore;
const asked: string[] = [];
const page = vi.fn(async () => 'Meher: vegetarian (message #32)');
const recall = vi.fn(async () => [{ text: "I'm veg btw", messageId: 'm_32', seq: 32 }]);
const note = vi.fn(async () => 'saved' as const);
const memory = { page, recall, note } as unknown as NonNullable<Brain['memory']>;

beforeAll(async () => {
  db = await withSchema();
  tokens = createTokenStore(db.pool, now);
  results = createResultsStore(db.pool);
  const travel = createTravelLayer({
    switches: new FakeSwitches(), now, fake: createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' }), ixigo: null, results,
  });
  app = Fastify({ logger: false });
  await registerGoMcp(app, {
    packs: { get: async (tripId: string) => { asked.push(tripId); return goaPack(); } },
    memory: () => memory,
    travel: () => travel,
    results,
    record: mcpCallRecorder(db.pool, async () => ['gt_villas'], now),
    tokens,
    log: app.log,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'trip-computer', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const body = (r: unknown): any => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

describe("Go's MCP server", () => {
  it('lists six tools; everything but note is marked read-only', async () => {
    const c = await connect(await tokens.mint('t_goa', LATER));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['note', 'person', 'recall', 'search_flights', 'search_stays', 'trip']);
    for (const t of tools) expect(t.annotations?.readOnlyHint === true, t.name).toBe(t.name !== 'note');
    await c.close();
  });

  it('answers trip() with what the group sees, and no budget, money, invite link or person ids', async () => {
    const c = await connect(await tokens.mint('t_goa', LATER));
    const trip = body(await c.callTool({ name: 'trip', arguments: {} }));
    expect(trip).toMatchObject({ title: 'Goa 🌴', destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } });
    expect(trip.people.map((p: { name: string }) => p.name)).toEqual(['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir']);
    const text = JSON.stringify(trip);
    for (const hidden of ['budget', 'money', 'invite', 'p_rahul', 'photo_url', 'has_upi']) expect(text, hidden).not.toContain(hidden);
    await c.close();
  });

  it("reads a person's group-visible page and this trip's recall, and passes a note on as a group-visible suggestion", async () => {
    const c = await connect(await tokens.mint('t_goa', LATER));
    expect(body(await c.callTool({ name: 'person', arguments: { name: 'meher' } }))).toEqual({ name: 'Meher', page: 'Meher: vegetarian (message #32)' });
    expect(page).toHaveBeenLastCalledWith('t_goa', 'p_meher', 'group');
    expect(body(await c.callTool({ name: 'recall', arguments: { question: 'who is veg?' } }))).toEqual({ hits: [{ text: "I'm veg btw", message_id: 'm_32', seq: 32 }] });
    expect(recall).toHaveBeenLastCalledWith('t_goa', 'who is veg?', 'group');
    expect(body(await c.callTool({ name: 'note', arguments: { person: 'Priya', topic: 'food', text: 'Vegetarian', proof_message_id: 'm_32' } }))).toEqual({ result: 'saved' });
    expect(note).toHaveBeenLastCalledWith('t_goa', { personId: 'p_priya', topic: 'food', text: 'Vegetarian', proofMessageId: 'm_32', audience: 'group' });
    const nobody = await c.callTool({ name: 'person', arguments: { name: 'Zoya' } });
    expect(nobody.isError).toBe(true);
    expect(body(nobody)).toMatchObject({ error: 'no_such_person', people: ['Rahul', 'Priya', 'Arjun', 'Meher', 'Kabir'] });
    await c.close();
  });

  it('searches stays read-only, each result with its offer id and checked prices, and keeps what it showed for this trip', async () => {
    const r = await searchAsTheJob({
      goUrl: base, token: await tokens.mint('t_goa', LATER), tool: 'search_stays',
      args: { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5, must_have: ['pool'] },
    });
    expect(r.checked_at).toBe('2026-10-07T12:00:00.000Z');
    const sol = r.results.find((x) => x.title === 'Villa Sol')!;
    expect(sol).toMatchObject({ offer_id: 'fake:st-villa-sol-anjuna-20261106-20261109-5', price_minor: 1280000, price_note: 'per night', total_paise: 3840000 });
    for (const x of r.results) expect(x.total_paise, x.title).toBe(x.price_minor * 3);
    // Saved for this trip, so a job's offer ids resolve to these checked prices when it finishes.
    expect(await results.findOffer('t_goa', sol.offer_id)).toMatchObject({ option: { offerId: sol.offer_id, priceMinor: 1280000, totalMinor: 3840000 }, checkedAt: '2026-10-07T12:00:00.000Z' });
    expect(await results.findOffer('t_manali', sol.offer_id)).toBeNull();
  });

  it("finds the TRIP_TOKEN Go armed for a trip on the fake /v1, and says so when there is none", () => {
    const fake = { secrets: new Map([[`${v1UserIdFor('t_goa')}/TRIP_TOKEN`, 'gtt_token_for_goa']]) };
    expect(armedToken(fake, 't_goa')).toBe('gtt_token_for_goa');
    expect(() => armedToken(fake, 't_manali')).toThrow(/no TRIP_TOKEN/);
  });

  it('reads only the trip its token names', async () => {
    const c = await connect(await tokens.mint('t_manali', LATER));
    await c.callTool({ name: 'trip', arguments: {} });
    expect(asked.at(-1)).toBe('t_manali');
    await c.close();
  });

  it('refuses no token, a wrong token and a revoked token, and takes POST only', async () => {
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const post = (auth?: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: list });
    expect((await post()).status).toBe(401);
    expect((await post(`Bearer gtt_${'x'.repeat(43)}`)).status).toBe(401);
    const old = await tokens.mint('t_old', LATER);
    await tokens.revokeAll('t_old');
    expect((await post(`Bearer ${old}`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('logs every call against the trip and its running jobs', async () => {
    const { rows } = await db.pool.query<{ trip_id: string; tool: string; task_ids: string[]; ok: boolean }>('select trip_id, tool, task_ids, ok from mcp_calls order by id');
    expect(rows.find((r) => r.tool === 'note')).toMatchObject({ trip_id: 't_goa', task_ids: ['gt_villas'], ok: true });
    expect(rows.find((r) => r.tool === 'person' && r.ok === false)).toBeDefined();
  });
});
