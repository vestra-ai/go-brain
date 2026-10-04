/**
 * A TOOL SEARCH THAT FOUND NOTHING MUST NOT BE SILENT.
 *
 * The server-side rail's two barren outcomes are both HTTP 200: the search errors
 * (`tool_search_tool_result_error`), or it runs and matches zero tools. In either
 * case the turn completes normally and the model carries on without a capability
 * it explicitly went looking for. Nothing fails, nothing retries, nothing is
 * counted — which is precisely the shape of every deferral bug that has reached a
 * user: not an error, a number that quietly stops moving.
 *
 * These tests drive the real transport with a stubbed client, so what they assert
 * is what a production turn would actually emit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';

/**
 * A client whose finalMessage carries `content`. No stream deltas: the blocks this
 * test is about are the ones the transport reads off the ASSEMBLED final message,
 * which is the same source the verbatim-replay channel uses.
 */
function makeMockClient(content: unknown[]) {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      /* no deltas */
    },
    async finalMessage() {
      return { content, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } } as unknown;
    },
  }));
  return { messages: { stream } } as never;
}

/** Drive one turn to completion; the assertions are on what was warned. */
async function runOneTurn(content: unknown[]): Promise<void> {
  const t = new AnthropicMessagesTransport({ client: makeMockClient(content) });
  const s = t.callModel({
    model: 'claude-sonnet-5',
    system: 'S',
    tools: [],
    history: [{ role: 'user', content: 'go' }],
    maxTokens: 1024,
  } as never);
  for await (const _ of t.readStream(s)) {
    /* consume */
  }
}

const SEARCH_CALL = {
  type: 'server_tool_use',
  id: 'srvtoolu_01ABC',
  name: 'tool_search_tool_regex',
  input: { pattern: 'present.*output' },
};

/** Collect console.warn lines as plain strings, so assertions stay untyped-free. */
let warned: string[] = [];
let restoreWarn: () => void = () => {};
function captureWarnings(): void {
  warned = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warned.push(args.map((a) => String(a)).join(' '));
  });
  restoreWarn = () => spy.mockRestore();
}
afterEach(() => restoreWarn());

describe('a barren server-side tool search is reported', () => {
  it('names the error code and the pattern when the search could not run', async () => {
    captureWarnings();
    await runOneTurn([
      SEARCH_CALL,
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_01ABC',
        content: {
          type: 'tool_search_tool_result_error',
          error_code: 'too_many_requests',
          error_message: 'rate limited',
        },
      },
    ]);

    const line = warned.find((m) => m.includes('[TOOL_SEARCH_FAILED]'));
    expect(line).toBeDefined();
    expect(line).toContain('too_many_requests');
    // The pattern is the only thing that makes a miss debuggable after the fact.
    expect(line).toContain('present.*output');
  });

  it('reports a search that ran and matched nothing, with the pattern that missed', async () => {
    captureWarnings();
    await runOneTurn([
      SEARCH_CALL,
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_01ABC',
        content: { type: 'tool_search_tool_search_result', tool_references: [] },
      },
    ]);

    const line = warned.find((m) => m.includes('[TOOL_SEARCH_EMPTY]'));
    expect(line).toBeDefined();
    expect(line).toContain('present.*output');
  });

  it('stays quiet when the search actually found a tool', async () => {
    captureWarnings();
    await runOneTurn([
      SEARCH_CALL,
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_01ABC',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'present_output' }],
        },
      },
    ]);

    expect(warned.filter((m) => m.includes('TOOL_SEARCH_'))).toEqual([]);
  });

  it('stays quiet on an ordinary turn that never searched', async () => {
    captureWarnings();
    await runOneTurn([{ type: 'text', text: 'done' }]);

    expect(warned.filter((m) => m.includes('TOOL_SEARCH_'))).toEqual([]);
  });
});
