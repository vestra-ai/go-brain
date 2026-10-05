import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { SocketCallError, SocketTimeoutError } from '@go/sim';
import { FrameLog } from '../frames.js';
import { AnswerProblemError, Link } from '../link.js';

/** A stand-in socket that keeps what is sent on it. */
function socket(): WebSocket & { sent: any[] } {
  const sent: any[] = [];
  return { sent, send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket & { sent: any[] };
}

function twoSockets() {
  const link = new Link(new FrameLog());
  const a = socket();
  const b = socket();
  link.attach(a, 'a');
  link.attach(b, 'b'); // b is the newest
  return { link, a, b };
}

describe('which socket a request goes on', () => {
  it('goes on the socket the event came on, not the newest', () => {
    const { link, a, b } = twoSockets();
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    link.notify('typing', { trip_id: 't_goa', on: true }, a);
    expect(a.sent.map((f) => f.method)).toEqual(['read_trip', 'typing']);
    expect(b.sent).toEqual([]);
  });

  it('goes on the newest open socket when the event came on a socket that has closed', () => {
    const { link, a, b } = twoSockets();
    link.detach(a);
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    link.notify('typing', { trip_id: 't_goa', on: true }, a);
    expect(a.sent).toEqual([]);
    expect(b.sent.map((f) => f.method)).toEqual(['read_trip', 'typing']);
  });

  it('goes again on the newest open socket, with the same id, when its socket closes before the answer', () => {
    const { link, a, b } = twoSockets();
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    const [sent] = a.sent;
    link.detach(a);
    expect(b.sent).toEqual([sent]);
  });
});

describe("checking the Server's answers", () => {
  /** Sends one request and answers it with `answer` (the id is filled in). Resolves with the outcome and the problem rows. */
  async function answered(method: string, params: object, answer: Record<string, unknown>) {
    const frames = new FrameLog();
    const link = new Link(frames);
    const ws = socket();
    link.attach(ws, 'server-1');
    const outcome = link.request(method, params, { timeoutMs: 1000 }).then((result) => ({ result }), (error: unknown) => ({ error }));
    link.settle({ jsonrpc: '2.0', id: ws.sent[0].id, ...answer }, 'server-1');
    return { ...(await outcome), problems: frames.list().filter((f) => f.direction === 'problem') };
  }

  const post = { request_id: 'rq_fake_1', trip_id: 't_goa', text: 'hi' };

  it('resolves with a result that passes the contract, with no problem row', async () => {
    const r = await answered('post_message', post, { result: { message_id: 'm_go_1', seq: 7 } });
    expect(r).toEqual({ result: { message_id: 'm_go_1', seq: 7 }, problems: [] });
  });

  it('fails post_message answered {} and adds a problem row naming the method and what is missing', async () => {
    const r = await answered('post_message', post, { result: {} });
    expect(r.error).toBeInstanceOf(AnswerProblemError);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ instance: 'server-1' });
    expect(r.problems[0]!.text).toMatch(/^post_message: the result does not pass the contract: .*message_id/);
  });

  it('treats an answer with no result as a problem, never as {}', async () => {
    const r = await answered('add_reaction', { request_id: 'rq_fake_2', trip_id: 't_goa', message_id: 'm_1', emoji: '✅' }, {});
    expect(r.error).toBeInstanceOf(AnswerProblemError);
    expect(r.problems[0]!.text).toContain('add_reaction');
  });

  it('fails with the error, and adds a problem row when an error other than -32601 or -32700 has no data.code', async () => {
    const r = await answered('read_trip', { trip_id: 't_goa' }, { error: { code: 409, message: 'clash' } });
    expect(r.error).toBeInstanceOf(SocketCallError);
    expect(r.error).toMatchObject({ code: 409, dataCode: undefined });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.text).toBe('read_trip: error 409 has no data.code. Every error but -32700 and -32601 needs one.');
  });

  it('accepts -32601 with no data.code, and a 429 with its data', async () => {
    const unknown = await answered('read_trip', { trip_id: 't_goa' }, { error: { code: -32601, message: 'unknown method read_trip' } });
    expect(unknown.error).toMatchObject({ code: -32601 });
    expect(unknown.problems).toEqual([]);
    const busy = await answered('read_trip', { trip_id: 't_goa' }, { error: { code: 429, message: 'slow down', data: { code: 'rate_limited', retry_after_seconds: 5 } } });
    expect(busy.error).toMatchObject({ code: 429, dataCode: 'rate_limited', retryAfterSeconds: 5 });
    expect(busy.problems).toEqual([]);
  });

  it('adds a problem row when no answer comes in time', async () => {
    const frames = new FrameLog();
    const link = new Link(frames);
    link.attach(socket(), 'server-1');
    await expect(link.request('read_trip', { trip_id: 't_goa' }, { timeoutMs: 20 })).rejects.toBeInstanceOf(SocketTimeoutError);
    expect(frames.list().filter((f) => f.direction === 'problem')).toMatchObject([{ instance: 'server-1', text: 'read_trip: no answer within 20 ms' }]);
  });
});
