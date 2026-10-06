import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { SocketCallError } from '../rpc.js';
import { createServerLink, newRequestId, type ServerLinkImpl, type SocketHandle } from '../server-link.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

type Sent = { id?: string; method: string; params: Record<string, unknown> };

function socket(id: string): SocketHandle & { sent: Sent[] } {
  const sent: Sent[] = [];
  return { id, instance: id, sent, send: (f: string) => { sent.push(JSON.parse(f) as Sent); } };
}

function link(extra: Partial<Parameters<typeof createServerLink>[0]> = {}) {
  const slept: number[] = [];
  const results: Array<{ method: string; result: unknown }> = [];
  const l = createServerLink({
    pool: db.pool,
    log: silentLog,
    timeoutMs: 1_000,
    waitForSocketMs: 2_000,
    sleep: async (ms) => { slept.push(ms); },
    onResult: (method, _params, result) => { results.push({ method, result }); },
    ...extra,
  });
  return { l, slept, results };
}

const answer = (l: ServerLinkImpl, id: string, result: Record<string, unknown>) => l.onAnswer({ kind: 'result', id, result });
const fail = (l: ServerLinkImpl, id: string, code: number, message: string, more: { dataCode?: string; retryAfterSeconds?: number } = {}) =>
  l.onAnswer({ kind: 'error', id, error: { code, message, ...more } });

describe('ServerLink', () => {
  it('sends a request with a go_ id on an open socket and resolves with the answer', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    const p = l.request('read_messages', { trip_id: 't_goa', after_seq: 0 });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    const sent = a.sent[0]!;
    expect(sent.id).toMatch(/^go_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sent.method).toBe('read_messages');
    answer(l, sent.id!, { messages: [], has_more: false });
    await expect(p).resolves.toEqual({ messages: [], has_more: false });
  });

  it('keeps a write in go_requests with its turn and its answer', async () => {
    const { l, results } = link();
    const a = socket('a');
    l.attach(a);
    const rid = newRequestId();
    const p = l.request('add_reaction', { request_id: rid, trip_id: 't_goa', message_id: 'm_4', emoji: '✅' }, { turnId: 'turn_1' });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    answer(l, a.sent[0]!.id!, { seq: 7 });
    await expect(p).resolves.toEqual({ seq: 7 });
    const { rows } = await db.pool.query('select rpc_id, turn_id, method, result, answered_at from go_requests where request_id = $1', [rid]);
    expect(rows[0]).toMatchObject({ rpc_id: a.sent[0]!.id, turn_id: 'turn_1', method: 'add_reaction', result: { seq: 7 } });
    expect(rows[0].answered_at).toBeInstanceOf(Date);
    expect(results).toContainEqual({ method: 'add_reaction', result: { seq: 7 } });
  });

  it('the Server reconnects mid-request: sent again on the new socket with the same id and request_id, done once', async () => {
    const { l } = link({ timeoutMs: 5_000 });
    const a = socket('a');
    l.attach(a);
    const rid = newRequestId();
    const p = l.request('post_message', { request_id: rid, trip_id: 't_goa', text: 'Hi all' });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    l.detach('a');
    await new Promise((r) => setTimeout(r, 50));
    const b = socket('b');
    l.attach(b);
    await vi.waitFor(() => expect(b.sent).toHaveLength(1));
    expect(b.sent[0]!.id).toBe(a.sent[0]!.id);
    expect(b.sent[0]!.params.request_id).toBe(rid);
    answer(l, b.sent[0]!.id!, { message_id: 'm_go_1', seq: 3 });
    await expect(p).resolves.toEqual({ message_id: 'm_go_1', seq: 3 });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('with two instances, a lost socket\'s request moves to the other one', async () => {
    const { l } = link({ timeoutMs: 5_000 });
    const a = socket('a');
    const b = socket('b');
    l.attach(a);
    l.attach(b);
    const p = l.request('read_trip', { trip_id: 't_goa' });
    await vi.waitFor(() => expect(a.sent.length + b.sent.length).toBe(1));
    const [first, other] = a.sent.length ? [a, b] : [b, a];
    l.detach(first.id);
    await vi.waitFor(() => expect(other.sent).toHaveLength(1));
    expect(other.sent[0]!.id).toBe(first.sent[0]!.id);
    fail(l, other.sent[0]!.id!, 404, 'no such trip', { dataCode: 'not_found' });
    await expect(p).rejects.toMatchObject({ code: 404, dataCode: 'not_found' });
  });

  it('waits for a socket, and gives up with 503 when none opens', async () => {
    const { l, slept } = link({ waitForSocketMs: 20, retryDelaysMs: [0, 0, 0] });
    await expect(l.request('read_trip', { trip_id: 't_goa' })).rejects.toMatchObject({ code: 503, dataCode: 'unavailable' });
    expect(slept).toEqual([0, 0, 0]);
  });

  it('retries a timeout after 0.5 s with the same id', async () => {
    const { l, slept } = link({ timeoutMs: 200 });
    const a = socket('a');
    l.attach(a);
    const p = l.request('read_trip', { trip_id: 't_goa' });
    await vi.waitFor(() => expect(a.sent.length).toBeGreaterThanOrEqual(2));
    expect(a.sent[1]!.id).toBe(a.sent[0]!.id);
    expect(slept[0]).toBe(500);
    fail(l, a.sent[1]!.id!, 404, 'gone', { dataCode: 'not_found' });
    await expect(p).rejects.toBeInstanceOf(SocketCallError);
  });

  it('honours retry_after_seconds on a 429', async () => {
    const { l, slept } = link();
    const a = socket('a');
    l.attach(a);
    const p = l.request('read_messages', { trip_id: 't_goa', after_seq: 3 });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    fail(l, a.sent[0]!.id!, 429, 'slow down', { dataCode: 'rate_limited', retryAfterSeconds: 2 });
    await vi.waitFor(() => expect(a.sent).toHaveLength(2));
    expect(slept).toEqual([2_000]);
    answer(l, a.sent[1]!.id!, { messages: [], has_more: false });
    await expect(p).resolves.toEqual({ messages: [], has_more: false });
  });

  it('treats 409 as final: no retry, and the error is kept', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    const rid = newRequestId();
    const p = l.request('close_vote', { request_id: rid, trip_id: 't_goa', decision_id: 'd_villa' });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    fail(l, a.sent[0]!.id!, 409, 'vote not open', { dataCode: 'conflict' });
    await expect(p).rejects.toMatchObject({ code: 409, dataCode: 'conflict', message: 'vote not open' });
    expect(a.sent).toHaveLength(1);
    const { rows } = await db.pool.query('select error from go_requests where request_id = $1', [rid]);
    expect(rows[0].error).toEqual({ code: 409, message: 'vote not open' });
  });

  it('rejects with -32601 when the Server does not support a method yet', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    const p = l.request('read_trip', { trip_id: 't_goa' });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    fail(l, a.sent[0]!.id!, -32601, 'unknown method read_trip');
    await expect(p).rejects.toMatchObject({ code: -32601 });
  });

  it('never sends params that break the contract', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    await expect(
      l.request('add_reaction', { request_id: newRequestId(), trip_id: 't_goa', emoji: '✅' } as never),
    ).rejects.toMatchObject({ code: 422, dataCode: 'invalid' });
    expect(a.sent).toHaveLength(0);
  });

  it('answers a write that is already done from go_requests, sending nothing', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    const rid = newRequestId();
    await db.pool.query(
      `insert into go_requests (request_id, rpc_id, trip_id, method, params, result, answered_at)
       values ($1, 'go_old', 't_goa', 'post_message', '{}', '{"message_id":"m_go_9","seq":9}', now())`,
      [rid],
    );
    await expect(l.request('post_message', { request_id: rid, trip_id: 't_goa', text: 'again' })).resolves.toEqual({ message_id: 'm_go_9', seq: 9 });
    expect(a.sent).toHaveLength(0);
  });

  it('sends a write once when two calls carry the same request_id', async () => {
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    const rid = newRequestId();
    const params = { request_id: rid, trip_id: 't_goa', message_id: 'm_5', emoji: '👍' };
    const p1 = l.request('add_reaction', params);
    const p2 = l.request('add_reaction', params);
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    answer(l, a.sent[0]!.id!, { seq: 11 });
    await expect(Promise.all([p1, p2])).resolves.toEqual([{ seq: 11 }, { seq: 11 }]);
    expect(a.sent).toHaveLength(1);
  });

  it('after a restart, sends unanswered writes again with their old JSON-RPC id', async () => {
    const rid = newRequestId();
    await db.pool.query(
      `insert into go_requests (request_id, rpc_id, trip_id, method, params, created_at)
       values ($1, 'go_before_restart', 't_goa', 'post_message', $2::jsonb, now())`,
      [rid, JSON.stringify({ request_id: rid, trip_id: 't_goa', text: 'Hi all' })],
    );
    const { l } = link();
    const a = socket('a');
    l.attach(a);
    expect(await l.resumePending()).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(a.sent.some((f) => f.id === 'go_before_restart')).toBe(true));
    const f = a.sent.find((x) => x.id === 'go_before_restart')!;
    expect(f.params).toEqual({ request_id: rid, trip_id: 't_goa', text: 'Hi all' });
    answer(l, 'go_before_restart', { message_id: 'm_go_2', seq: 4 });
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query('select answered_at from go_requests where request_id = $1', [rid]);
      expect(rows[0].answered_at).toBeInstanceOf(Date);
    });
  });

  it("sends a trip's requests and typing on the socket that last brought that trip's events", async () => {
    const { l } = link();
    const one = socket('one');
    const two = socket('two');
    l.attach(one);
    l.attach(two);
    l.noteTrip('t_a', 'one');
    l.noteTrip('t_b', 'two');
    const page = { messages: [], has_more: false };
    const asks = [
      l.request('read_messages', { trip_id: 't_a', after_seq: 0 }),
      l.request('read_messages', { trip_id: 't_b', after_seq: 0 }),
      l.request('read_messages', { trip_id: 't_a', after_seq: 5 }),
      l.request('read_messages', { trip_id: 't_b', after_seq: 5 }),
    ];
    await vi.waitFor(() => expect(one.sent.length + two.sent.length).toBe(4));
    expect(one.sent.map((f) => f.params.trip_id)).toEqual(['t_a', 't_a']);
    expect(two.sent.map((f) => f.params.trip_id)).toEqual(['t_b', 't_b']);
    l.notify('typing', { trip_id: 't_b', on: true });
    expect(two.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_b', on: true } });
    expect(one.sent).toHaveLength(2);
    for (const f of [...one.sent, ...two.sent]) if (f.id) answer(l, f.id, page);
    await expect(Promise.all(asks)).resolves.toEqual([page, page, page, page]);
  });

  it("a trip's socket closes: its waiting write goes again on the other socket, and later requests follow the trip's next socket", async () => {
    const { l } = link({ timeoutMs: 5_000 });
    const one = socket('one');
    const two = socket('two');
    l.attach(one);
    l.attach(two);
    l.noteTrip('t_a', 'one');
    l.noteTrip('t_b', 'two');
    const rid = newRequestId();
    const p = l.request('post_message', { request_id: rid, trip_id: 't_a', text: 'The villas are in' });
    await vi.waitFor(() => expect(one.sent).toHaveLength(1));
    expect(two.sent).toHaveLength(0);
    l.detach('one');
    await vi.waitFor(() => expect(two.sent).toHaveLength(1));
    expect(two.sent[0]!.id).toBe(one.sent[0]!.id);
    expect(two.sent[0]!.params.request_id).toBe(rid);
    answer(l, two.sent[0]!.id!, { message_id: 'm_go_5', seq: 12 });
    await expect(p).resolves.toEqual({ message_id: 'm_go_5', seq: 12 });
    // The Server dials again and t_a's events come on the new socket: t_a's requests follow them there.
    const three = socket('three');
    l.attach(three);
    l.noteTrip('t_a', 'three');
    const q = l.request('read_trip', { trip_id: 't_a' });
    await vi.waitFor(() => expect(three.sent).toHaveLength(1));
    expect(two.sent).toHaveLength(1);
    fail(l, three.sent[0]!.id!, 404, 'no such trip', { dataCode: 'not_found' });
    await expect(q).rejects.toMatchObject({ code: 404 });
  });

  it('a trip no socket has brought yet uses any open socket, and a note naming a closed socket is ignored', async () => {
    const { l } = link();
    const one = socket('one');
    l.attach(one);
    l.noteTrip('t_new', 'gone');
    const p = l.request('read_messages', { trip_id: 't_new', after_seq: 0 });
    await vi.waitFor(() => expect(one.sent).toHaveLength(1));
    answer(l, one.sent[0]!.id!, { messages: [], has_more: false });
    await expect(p).resolves.toEqual({ messages: [], has_more: false });
  });

  it('typing is a notification: dropped with no socket, sent with no id otherwise', () => {
    const { l } = link();
    expect(() => l.notify('typing', { trip_id: 't_goa', on: true })).not.toThrow();
    const a = socket('a');
    l.attach(a);
    l.notify('typing', { trip_id: 't_goa', on: true });
    expect(a.sent).toEqual([{ jsonrpc: '2.0', method: 'typing', params: { trip_id: 't_goa', on: true } }]);
    expect(l.isOpen()).toBe(true);
  });

  it('close() makes requests waiting for a socket give up at once', async () => {
    const { l } = link({ waitForSocketMs: 10_000, retryDelaysMs: [] });
    const p = l.request('read_trip', { trip_id: 't_goa' });
    l.close();
    await expect(p).rejects.toMatchObject({ code: 503 });
  });
});
