import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, StreamLike } from '../../composer/anthropic.js';

export interface Reply {
  /** A thinking block first, with this signature and no text (the API's default display). */
  thinking?: string;
  text?: string;
  tools?: Array<{ name: string; input: unknown }>;
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>;
  /** The stream fails with this, as a dropped connection or an API error would. */
  throws?: Error;
  /** Waits this long first; the turn's abort signal cuts it short. */
  delayMs?: number;
}
export type Script = Reply[] | ((body: any, call: number) => Reply);

/**
 * A scripted model. Every request body is captured; each streamed call answers from the script, by call number or by
 * what it was asked. Side passes (messages.create: P2's notes and fold) are captured apart and answer `side(body)`.
 */
export function fakeAnthropic(script: Script, side: (body: any) => string = () => '{}') {
  const bodies: any[] = [];
  const sideBodies: any[] = [];
  const client: AnthropicLike = {
    messages: {
      async create(body, options) {
        sideBodies.push(JSON.parse(JSON.stringify(body)));
        if (options?.signal?.aborted) throw new Error('aborted');
        return {
          id: `msg_side_${sideBodies.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: side(body), citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          container: null,
          usage: {
            input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            cache_creation: null, server_tool_use: null, service_tier: 'standard', inference_geo: null,
          },
        } as unknown as Anthropic.Message;
      },
      stream(body, options) {
        const n = bodies.length;
        bodies.push(JSON.parse(JSON.stringify(body)));
        const r: Reply = typeof script === 'function' ? script(body, n) : (script[Math.min(n, script.length - 1)] ?? {});
        const tools = r.tools ?? [];
        const content = [
          ...(r.thinking ? [{ type: 'thinking', thinking: '', signature: r.thinking }] : []),
          ...(r.text ? [{ type: 'text', text: r.text, citations: null }] : []),
          ...tools.map((t, k) => ({ type: 'tool_use', id: `toolu_${n}_${k}`, name: t.name, input: t.input, caller: { type: 'direct' } })),
        ];
        const message = {
          id: `msg_${n}`,
          type: 'message',
          role: 'assistant',
          model: (body as { model?: string }).model,
          content,
          stop_reason: tools.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          container: null,
          usage: {
            input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            cache_creation: null, server_tool_use: null, service_tier: 'standard', inference_geo: null, ...r.usage,
          },
        } as unknown as Anthropic.Message;
        const wait = () =>
          new Promise<void>((resolve, reject) => {
            if (!r.delayMs) return resolve();
            const t = setTimeout(resolve, r.delayMs);
            options?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
        const stream = {
          async *[Symbol.asyncIterator]() {
            await wait();
            if (r.throws) throw r.throws;
            if (r.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } };
            for (let k = 0; k < tools.length; k++) {
              yield { type: 'content_block_start', index: k + 1, content_block: { type: 'tool_use', id: `toolu_${n}_${k}`, name: tools[k]!.name, input: {} } };
              yield { type: 'content_block_delta', index: k + 1, delta: { type: 'input_json_delta', partial_json: '{}' } };
            }
          },
          async finalMessage() {
            if (r.throws) throw r.throws;
            return message;
          },
        };
        return stream as unknown as StreamLike;
      },
    },
  };
  return { client, bodies, sideBodies };
}
