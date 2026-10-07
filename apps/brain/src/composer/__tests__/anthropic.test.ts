import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anthropicClient, KEEP_ALIVE_MS, keepAliveAgent } from '../anthropic.js';

let server: Server;
let connections = 0;
let url = '';
/** A stand-in for Anthropic's streaming Messages API: one short text answer. */
function streamReply(res: import('node:http').ServerResponse): void {
  const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Three flights on Friday.' } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
  ev('message_stop', {});
  res.end();
}
beforeAll(async () => {
  server = createServer((req, res) => (req.url?.startsWith('/v1/messages') ? streamReply(res) : res.end('ok')));
  // Like Anthropic's edge (Cloudflare): over HTTP/1.1 it answers "Connection: keep-alive" with no "Keep-Alive: timeout"
  // hint, so the client's own idle timeout decides how long a connection lives. 0 sends no hint and never times out.
  server.keepAliveTimeout = 0;
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connections a dispatcher opens for two requests with a quiet spell of 4.3 s between them. */
async function connectionsFor(dispatcher: Agent): Promise<number> {
  const before = connections;
  await (await undiciFetch(url, { dispatcher })).text();
  await pause(4_300);
  await (await undiciFetch(url, { dispatcher })).text();
  await dispatcher.close();
  return connections - before;
}

describe("Go's connection to Anthropic", () => {
  it('keeps an idle connection a minute, so an ask after a quiet spell skips a new handshake', async () => {
    expect(KEEP_ALIVE_MS).toBe(60_000);
    // undici's default drops the idle connection after 4 s: the second request opens a new one.
    expect(await connectionsFor(new Agent())).toBe(2);
    expect(await connectionsFor(keepAliveAgent())).toBe(1);
  }, 15_000);

  it('streams a real answer through undici and that agent, as the composer reads it', async () => {
    const client = anthropicClient('sk-test', { baseURL: url.replace(/\/$/, '') });
    const stream = client.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'flights?' }] });
    const kinds: string[] = [];
    for await (const ev of stream) kinds.push(ev.type);
    const final = await stream.finalMessage();
    expect(kinds).toContain('content_block_delta');
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'Three flights on Friday.' });
    expect(final.usage.output_tokens).toBe(7);
  });

  it('the client sends every request through that agent', () => {
    const client = anthropicClient('sk-test') as unknown as { fetchOptions?: { dispatcher?: unknown }; maxRetries?: number };
    expect(client.fetchOptions?.dispatcher).toBeInstanceOf(Agent);
    expect(client.maxRetries).toBe(0);
  });
});
