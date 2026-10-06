import { SOCKET_ERROR_CODES } from '@go/contract';
import type * as C from '@go/contract';
import type { z } from 'zod';

export type ErrorCodeName = z.infer<typeof C.ErrorCode>;

/**
 * A socket call that did not work: the other side's error, or one Go raised itself.
 * `code` is the JSON-RPC code: 404, 409, 422, 429, 500, 503, -32601 or -32700.
 */
export class SocketCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly dataCode?: ErrorCodeName,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SocketCallError';
  }
}

export type RequestFrame = { kind: 'request'; id: string; method: string; params: unknown };
export type NotificationFrame = { kind: 'notification'; method: string; params: unknown };
export type ResultFrame = { kind: 'result'; id: string; result: Record<string, unknown> };
export type ErrorFrame = {
  kind: 'error';
  id: string | null;
  error: { code: number; message: string; dataCode?: string; retryAfterSeconds?: number };
};
export type AnswerFrame = ResultFrame | ErrorFrame;
export type Frame = RequestFrame | NotificationFrame | AnswerFrame | { kind: 'unreadable'; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64;

/** Reads one text frame. Never throws. */
export function readFrame(text: string): Frame {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'not JSON' };
  }
  if (!isObject(v) || v.jsonrpc !== '2.0') return { kind: 'unreadable', reason: 'not a JSON-RPC 2.0 object' };
  if ('method' in v) {
    const method = v.method;
    if (typeof method !== 'string' || method.length < 1 || method.length > 64) return { kind: 'unreadable', reason: 'bad method' };
    if (!('id' in v)) return { kind: 'notification', method, params: v.params };
    if (!isId(v.id)) return { kind: 'unreadable', reason: 'bad id' };
    return { kind: 'request', id: v.id, method, params: v.params };
  }
  const id = v.id;
  const result = v.result;
  if (isId(id) && isObject(result)) return { kind: 'result', id, result };
  const error = v.error;
  if ((isId(id) || id === null) && isObject(error) && typeof error.code === 'number') {
    const data = isObject(error.data) ? error.data : null;
    return {
      kind: 'error',
      id,
      error: {
        code: error.code,
        message: typeof error.message === 'string' ? error.message : '',
        ...(data && typeof data.code === 'string' ? { dataCode: data.code } : {}),
        ...(data && typeof data.retry_after_seconds === 'number' ? { retryAfterSeconds: data.retry_after_seconds } : {}),
      },
    };
  }
  return { kind: 'unreadable', reason: 'neither a request nor an answer' };
}

const CODE_NAME: Partial<Record<number, ErrorCodeName>> = {
  [SOCKET_ERROR_CODES.not_found]: 'not_found',
  [SOCKET_ERROR_CODES.invalid]: 'invalid',
  [SOCKET_ERROR_CODES.conflict]: 'conflict',
  [SOCKET_ERROR_CODES.rate_limited]: 'rate_limited',
  [SOCKET_ERROR_CODES.internal]: 'internal',
  [SOCKET_ERROR_CODES.unavailable]: 'unavailable',
};

export const requestFrame = (id: string, method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

export const notificationFrame = (method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', method, params });

export const resultFrame = (id: string, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result });

/** An error answer. -32700 and -32601 carry no data; every 429 carries retry_after_seconds. */
export function errorFrame(id: string | null, code: number, message: string, retryAfterSeconds?: number): string {
  const name = CODE_NAME[code];
  const data = name
    ? {
        code: name,
        ...(code === SOCKET_ERROR_CODES.rate_limited
          ? { retry_after_seconds: Math.min(3600, Math.max(1, Math.ceil(retryAfterSeconds ?? 1))) }
          : {}),
      }
    : null;
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: message.slice(0, 500), ...(data ? { data } : {}) } });
}
