import type { FastifyInstance } from 'fastify';

/** A fetch that answers from a Fastify app in the same process: no port, no network. */
export function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const out = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response(res.body === '' ? null : res.body, { status: res.statusCode, headers: out });
  }) as typeof fetch;
}
