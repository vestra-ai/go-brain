/**
 * Calling an MCP server. ixigo's: streamable HTTP, one client per process, a bearer, 8 s to connect, 25 s per call,
 * one reconnect after a transport failure (the shape of Bash's fal-mcp-upstream.ts). The fake ixigo: in this process.
 * A JSON-RPC error from the server is the call's own answer on a good connection; anything else is the transport.
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { FAKE_IXIGO_ARGS, FAKE_IXIGO_TOOLS, callFakeIxigo, type FakeIxigoStore } from './fake-ixigo/data.js';

const HANDSHAKE_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 25_000;
const DROP_TIMEOUT_MS = 5_000;

export interface McpCallResult { text: string; data: unknown; isError: boolean }
export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface McpCaller {
  /**
   * One tool call. A failed connect is tried again (nothing was sent). A failure after the request went out is tried
   * again only for a call marked readOnly: a hold or a confirm must never reach ixigo twice.
   */
  call(tool: string, args: Record<string, unknown>, opts?: { readOnly?: boolean }): Promise<McpCallResult>;
  listTools(): Promise<McpToolInfo[]>;
  close(): Promise<void>;
}

interface UpstreamClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }, schema?: undefined, opts?: { timeout: number }): Promise<unknown>;
  listTools(params?: undefined, opts?: { timeout: number }): Promise<{ tools: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
}

/** The three methods used, checked once at connect: a wrong SDK shape fails the connect, never a call. */
function asUpstreamClient(c: unknown): UpstreamClient {
  const o = c as { callTool?: unknown; listTools?: unknown; close?: unknown } | null;
  if (typeof o?.callTool !== 'function' || typeof o.listTools !== 'function' || typeof o.close !== 'function') {
    throw new Error('the MCP client has no callTool, listTools or close');
  }
  return c as UpstreamClient;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** The server answered with a JSON-RPC error: the call was wrong, the connection is fine. Timeouts and closes are the transport. */
const isProtocolError = (err: unknown): err is McpError =>
  err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export function textResult(result: unknown): McpCallResult {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return { text, data: parseJson(text), isError: r.isError === true };
}

function toToolInfo(t: Record<string, unknown>): McpToolInfo {
  const a = (t.annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
  const annotations = {
    ...(typeof a.readOnlyHint === 'boolean' ? { readOnlyHint: a.readOnlyHint } : {}),
    ...(typeof a.destructiveHint === 'boolean' ? { destructiveHint: a.destructiveHint } : {}),
  };
  return {
    name: String(t.name),
    ...(typeof t.description === 'string' ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

async function realConnect(url: string, token: string | undefined, name: string): Promise<unknown> {
  const client = new Client({ name, version: '1.0.0' });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  // The transport's sessionId getter is `string | undefined`, which exactOptionalPropertyTypes refuses for Transport.
  await client.connect(transport as Transport, { timeout: HANDSHAKE_TIMEOUT_MS });
  return client;
}

export function createHttpMcpCaller(o: { url: string; token?: string; name?: string; connectImpl?: () => Promise<unknown> }): McpCaller {
  const connectImpl = o.connectImpl ?? (() => realConnect(o.url, o.token, o.name ?? 'go-brain'));
  let client: Promise<UpstreamClient> | null = null;
  const ensure = (): Promise<UpstreamClient> => (client ??= connectImpl().then(asUpstreamClient));
  const drop = async (): Promise<void> => {
    const c = client;
    client = null;
    const closing = (async () => {
      try {
        await (await c)?.close();
      } catch {
        // already gone
      }
    })();
    await Promise.race([closing, sleep(DROP_TIMEOUT_MS)]);
  };
  async function attempt<T>(
    run: (c: UpstreamClient) => Promise<T>,
    onProtocol: (err: McpError) => T,
    onDown: (reason: string) => T,
    resendable: boolean,
  ): Promise<T> {
    let reason = 'no answer';
    for (let i = 0; i < 2; i += 1) {
      let c: UpstreamClient;
      try {
        c = await ensure();
      } catch (err) {
        // The connect failed, so nothing was sent: trying again is safe for any call.
        reason = err instanceof Error ? err.message : String(err);
        await drop();
        continue;
      }
      try {
        return await run(c);
      } catch (err) {
        if (isProtocolError(err)) return onProtocol(err);
        reason = err instanceof Error ? err.message : String(err);
        await drop();
        // The request may have reached the server: only a call that is safe to repeat goes again.
        if (!resendable) break;
      }
    }
    return onDown(reason);
  }
  return {
    call: (tool, args, opts) =>
      attempt(
        async (c) => textResult(await c.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })),
        (err) => ({ text: err.message, data: null, isError: true }),
        (reason) => ({ text: `The travel service is unreachable right now: ${reason}`, data: null, isError: true }),
        opts?.readOnly === true,
      ),
    listTools: () =>
      attempt(
        async (c) => (await c.listTools(undefined, { timeout: HANDSHAKE_TIMEOUT_MS })).tools.map(toToolInfo),
        (err) => {
          throw err;
        },
        (reason) => {
          throw new Error(`The travel service is unreachable right now: ${reason}`);
        },
        true,
      ),
    close: drop,
  };
}

/** The fake ixigo in this process: the same tool table the fake's MCP server serves, with no network hop. */
export function createInProcessCaller(store: FakeIxigoStore): McpCaller {
  return {
    async call(tool, args) {
      const r = callFakeIxigo(store, tool, args);
      return { text: JSON.stringify(r.value), data: r.value, isError: r.isError };
    },
    async listTools() {
      return FAKE_IXIGO_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(FAKE_IXIGO_ARGS[t.name]), annotations: t.annotations }));
    },
    async close() {
      // nothing to close
    },
  };
}
