import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { errorFrame, readFrame, requestFrame, resultFrame, SocketCallError } from '../rpc.js';

describe('readFrame', () => {
  it('tells requests, notifications, results and errors apart', () => {
    expect(readFrame('{"jsonrpc":"2.0","id":"gs_1","method":"send_event","params":{"a":1}}')).toEqual({
      kind: 'request', id: 'gs_1', method: 'send_event', params: { a: 1 },
    });
    expect(readFrame('{"jsonrpc":"2.0","method":"typing","params":{}}').kind).toBe('notification');
    expect(readFrame('{"jsonrpc":"2.0","id":"go_1","result":{"seq":7}}')).toEqual({ kind: 'result', id: 'go_1', result: { seq: 7 } });
    expect(
      readFrame('{"jsonrpc":"2.0","id":"go_1","error":{"code":429,"message":"slow","data":{"code":"rate_limited","retry_after_seconds":3}}}'),
    ).toEqual({ kind: 'error', id: 'go_1', error: { code: 429, message: 'slow', dataCode: 'rate_limited', retryAfterSeconds: 3 } });
  });

  it('calls anything else unreadable', () => {
    for (const t of [
      'nope',
      '[]',
      '{"jsonrpc":"1.0","id":"a","method":"x","params":{}}',
      '{"jsonrpc":"2.0","id":"","method":"x","params":{}}',
      `{"jsonrpc":"2.0","id":"${'x'.repeat(65)}","method":"x","params":{}}`,
      '{"jsonrpc":"2.0","id":"a"}',
    ]) {
      expect(readFrame(t).kind).toBe('unreadable');
    }
  });
});

describe('building frames', () => {
  it('requests and results are plain JSON-RPC 2.0', () => {
    expect(C.SocketRequest.parse(JSON.parse(requestFrame('go_1', 'read_trip', { trip_id: 't_goa' })))).toBeTruthy();
    expect(C.SocketResult.parse(JSON.parse(resultFrame('gs_1', { accepted: true, duplicate: false })))).toBeTruthy();
  });

  it('errors match the contract and name their code', () => {
    const f = JSON.parse(errorFrame('gs_1', 409, 'already closed'));
    expect(C.SocketError.parse(f)).toBeTruthy();
    expect(f.error.data).toEqual({ code: 'conflict' });
  });

  it('every 429 carries retry_after_seconds', () => {
    expect(JSON.parse(errorFrame('gs_1', 429, 'slow down')).error.data).toEqual({ code: 'rate_limited', retry_after_seconds: 1 });
    expect(JSON.parse(errorFrame('gs_1', 429, 'slow down', 7)).error.data.retry_after_seconds).toBe(7);
  });

  it('-32700 and -32601 carry no data, and -32700 has a null id', () => {
    const parse = JSON.parse(errorFrame(null, C.SOCKET_ERROR_CODES.parse_error, 'unreadable'));
    expect(parse.id).toBeNull();
    expect(parse.error.data).toBeUndefined();
    expect(JSON.parse(errorFrame('gs_2', C.SOCKET_ERROR_CODES.unknown_method, 'unknown')).error.data).toBeUndefined();
  });

  it('cuts a long message to 500 characters', () => {
    expect(JSON.parse(errorFrame('gs_1', 500, 'x'.repeat(900))).error.message).toHaveLength(500);
  });
});

describe('SocketCallError', () => {
  it('keeps the code, the error name and the wait', () => {
    const e = new SocketCallError(429, 'slow', 'rate_limited', 3);
    expect([e.code, e.dataCode, e.retryAfterSeconds, e.message]).toEqual([429, 'rate_limited', 3, 'slow']);
    expect(e).toBeInstanceOf(Error);
  });
});
