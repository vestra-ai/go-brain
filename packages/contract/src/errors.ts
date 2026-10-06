import { z } from 'zod';

/** What went wrong. On the socket it is `error.data.code` of a SocketError; over HTTP it is in an ErrorBody. */
export const ErrorCode = z
  .enum([
    /** 401: the signature header is missing, stale or wrong. Do not retry; check the secret and the clock. */
    'bad_signature',
    /** 404: the trip, person, card or other id does not exist. */
    'not_found',
    /** 422: the body did not match the contract. Do not retry the same body. */
    'invalid',
    /** 409: the request clashes with the current state, e.g. closing a vote that is already closed. */
    'conflict',
    /** 429: slow down. Wait `retry_after_seconds` (on the socket) before trying again. */
    'rate_limited',
    /** 500: a bug on the other side. Retry later. */
    'internal',
    /** 503: down for a moment (a deploy). Retry later. */
    'unavailable',
  ])
  .meta({ id: 'ErrorCode' });

/** The body of an HTTP error: the socket upgrade's 401, or /v1/health. On the socket, errors are SocketError frames. */
export const ErrorBody = z
  .object({ error: z.object({ code: ErrorCode, message: z.string().max(500) }) })
  .meta({ id: 'ErrorBody' });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HTTP_STATUS_FOR: Record<z.infer<typeof ErrorCode>, number> = {
  bad_signature: 401,
  not_found: 404,
  invalid: 422,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};
