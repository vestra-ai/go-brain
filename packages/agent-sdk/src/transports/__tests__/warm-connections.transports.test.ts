/**
 * WARM_CONNECTIONS_V1 across the five wire formats: the flag decides whether the
 * provider clients (Anthropic, OpenAI Responses, Chat Completions) and the two
 * hand-rolled Gemini lanes route through the ONE process pool, and each transport's
 * `prewarm(model)` opens a connection to the host that model's requests go to.
 *
 * Off must be byte-identical: the clients are built with today's options (no
 * `fetchOptions` key at all), the Gemini `fetch` init carries no `dispatcher`, and the
 * request on the wire is the same bytes either way.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  AnthropicMessagesTransport,
  ChatCompletionsTransport,
  GeminiInteractionsTransport,
  GeminiTransport,
  OpenAIResponsesTransport,
} from '../index.js';
import { sharedWarmPool, resetSharedWarmPoolForTests } from '../warm-connections.js';
import type { Transport } from '../../engine/transport.js';

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };

let server: Server;
let origin: string;
let connections: Socket[] = [];
let seen: Seen[] = [];
let requestSockets: Socket[] = [];

const REPLIES: Record<string, unknown> = {
  '/v1/messages': {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 },
  },
  '/v1/chat/completions': {
    id: 'c1', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  '/v1/responses': { id: 'r1', object: 'response', status: 'completed', output: [], usage: null },
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    requestSockets.push(req.socket);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REPLIES[req.url ?? ''] ?? {}));
    });
  });
  server.on('connection', (s: Socket) => connections.push(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const ENV = {
  ANTHROPIC_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key', FIREWORKS_API_KEY: 'test-key',
  XAI_API_KEY: 'test-key', META_API_KEY: 'test-key', GEMINI_API_KEY: 'test-key',
};
/** Every lane at the local server, with the flag OFF whatever the ambient env says. */
const pointAtServer = (): void => {
  vi.stubEnv('WARM_CONNECTIONS_V1', '');
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv('ANTHROPIC_BASE_URL', origin);
  vi.stubEnv('OPENAI_BASE_URL', `${origin}/v1`);
  vi.stubEnv('FIREWORKS_BASE_URL', `${origin}/v1`);
  vi.stubEnv('META_BASE_URL', `${origin}/v1`);
  vi.stubEnv('GEMINI_BASE_URL', origin);
};

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await resetSharedWarmPoolForTests();
  server.closeAllConnections();
  connections = [];
  seen = [];
  requestSockets = [];
});

type WithFetchOptions = { fetchOptions?: { dispatcher?: unknown } };
const anthropicClient = (t = new AnthropicMessagesTransport()): WithFetchOptions & {
  messages: { create(b: unknown): Promise<unknown> };
} => (t as unknown as { getClient(): never }).getClient();
const openAIClient = (t: ChatCompletionsTransport | OpenAIResponsesTransport, provider: string): WithFetchOptions & {
  chat: { completions: { create(b: unknown): Promise<unknown> } };
  responses: { create(b: unknown): Promise<unknown> };
} => (t as unknown as { getClient(p: string): never }).getClient(provider);

/** Every SDK client the transports build, one per lane. */
function allClients(): WithFetchOptions[] {
  return [
    anthropicClient(),
    ...(['openai', 'fireworks', 'xai'] as const).map((p) => openAIClient(new ChatCompletionsTransport(), p)),
    ...(['openai', 'meta'] as const).map((p) => openAIClient(new OpenAIResponsesTransport(), p)),
  ];
}

/** The `fetch` init each Gemini lane sends, captured by a stub (the lanes are hand-rolled on fetch). */
async function geminiInits(): Promise<RequestInit[]> {
  const inits: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    inits.push(init);
    return new Response('', { status: 500 });
  }));
  const base = { system: 's', tools: [], history: [], maxTokens: 10 };
  for (const t of [new GeminiTransport(), new GeminiInteractionsTransport()] as Transport[]) {
    const stream = t.callModel({ ...base, model: 'gemini-3.8-flash' } as never);
    await (async () => { for await (const _e of t.readStream(stream)) void _e; })().catch(() => {});
  }
  return inits;
}

describe('WARM_CONNECTIONS_V1 off: byte-identical', () => {
  it('warm connections off: every provider client is built with no fetchOptions (today\'s options)', () => {
    pointAtServer();
    for (const c of allClients()) expect(c.fetchOptions).toBeUndefined();
    expect(sharedWarmPool()).toBeUndefined();
  });

  it('warm connections off: the Gemini lanes call fetch with no dispatcher key', async () => {
    pointAtServer();
    const inits = await geminiInits();
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method']);
    }
  });

  it('warm connections off: prewarm opens no connection on any lane', async () => {
    pointAtServer();
    for (const [t, model] of lanes()) t.prewarm?.(model);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toHaveLength(0);
  });
});

/** Every wire format with a model that routes to it. */
function lanes(): Array<[Transport, string]> {
  return [
    [new AnthropicMessagesTransport(), 'claude-sonnet-5'],
    [new OpenAIResponsesTransport(), 'gpt-5.6-luna'],
    [new ChatCompletionsTransport(), 'deepseek-v4-flash'],
    [new GeminiTransport(), 'gemini-3.8-flash'],
    [new GeminiInteractionsTransport(), 'gemini-3.8-flash'],
  ];
}

describe('WARM_CONNECTIONS_V1 on', () => {
  it('warm connections on: every lane routes through the one shared pool', async () => {
    pointAtServer();
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    const dispatcher = sharedWarmPool()!.fetchInit.dispatcher;
    expect(dispatcher).toBeDefined();
    for (const c of allClients()) expect(c.fetchOptions?.dispatcher).toBe(dispatcher);
    for (const init of await geminiInits()) {
      expect((init as { dispatcher?: unknown }).dispatcher).toBe(dispatcher);
    }
  });

  it.each(lanes().map(([t, m]) => [t.api, m] as const))(
    'warm connections: the %s lane prewarms the host its requests go to',
    async (api, model) => {
      pointAtServer();
      vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
      const t = lanes().find(([x]) => x.api === api)![0];
      t.prewarm!(model);
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      expect(seen).toHaveLength(0); // a connection, never a request
    },
  );

  it('warm connections: a turn\'s first request rides the connection its prewarm opened', async () => {
    pointAtServer();
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    const t = new AnthropicMessagesTransport();
    (t as Transport).prewarm!('claude-sonnet-5');
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await anthropicClient(t).messages.create({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(connections).toHaveLength(1);
    expect(requestSockets[0]).toBe(connections[0]);
  });

  it('warm connections: prewarm never throws, even with no credentials for the lane', () => {
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('XAI_API_KEY', '');
    expect(() => new OpenAIResponsesTransport().prewarm!('gpt-5.6-luna')).not.toThrow();
    expect(() => new ChatCompletionsTransport().prewarm!('grok-4.7')).not.toThrow();
  });
});

describe('WARM_CONNECTIONS_V1: the wire is the same bytes either way', () => {
  /** One request per SDK lane, as the server received it. */
  async function capture(): Promise<Seen[]> {
    seen = [];
    await anthropicClient().messages.create({ model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    await openAIClient(new ChatCompletionsTransport(), 'fireworks').chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    await openAIClient(new OpenAIResponsesTransport(), 'openai').responses.create({ model: 'm', input: 'hi' });
    return seen.map((s) => ({ ...s, headers: { ...s.headers } }));
  }

  it('warm connections: flag on sends the same method, path, headers and body as flag off', async () => {
    pointAtServer();
    const off = await capture();
    vi.stubEnv('WARM_CONNECTIONS_V1', 'true');
    const on = await capture();
    expect(off).toHaveLength(3);
    expect(on).toEqual(off);
  });
});
