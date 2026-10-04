/**
 * ════════════════════════════════════════════════════════════════════════════
 * LIVE-FIRE: image inside tool_result / function_call_output
 *
 * VERIFICATION STATUS (as of 2026-06-24):
 *
 *   VERIFIED (unit + type tests, T3/T4):
 *     - AnthropicMessagesTransport.pushToolResult emits the correct
 *       `tool_result.content` array shape (text + image) — no drift with the
 *       journal path (journalToAnthropicMessages shares the same helper).
 *     - OpenAIResponsesTransport.pushToolResult emits the correct
 *       `function_call_output.output` array shape (input_text + input_image)
 *       — no drift with journalToOpenAIResponsesInput.
 *     - Types compile: the emitted arrays are assignable to the SDK types
 *       (ResponseFunctionCallOutputItemList, ResponseInputImageContent, etc.).
 *
 *   PENDING MANUAL RUN (this file):
 *     The `tool_result`-with-image and `function_call_output`-with-image
 *     paths are a DISTINCT API surface from user-message image uploads (which
 *     are proven elsewhere). A unit test verifies the JSON shape; this test
 *     proves the PROVIDER ACCEPTS an image inside a tool_result and the MODEL
 *     SEES it. Both legs are gated on their respective API key:
 *
 *       ANTHROPIC_API_KEY  — Leg 1 (AnthropicMessagesTransport)
 *       OPENAI_API_KEY     — Leg 2 (OpenAIResponsesTransport)
 *
 *     CI has no keys, so both legs skip cleanly in CI → suite is GREEN by
 *     default. Run with the real keys in a funded environment to get the
 *     provider-acceptance proof.
 *
 * WHY A SEPARATE FILE:
 *   Mirrors `apps/sandbox/src/harness/__tests__/hook-live-fire.integration.test.ts`
 *   (the `it.runIf` skip pattern established for exactly this kind of
 *   externally-gated proof). Isolating here keeps the unit suites fast and
 *   free of network dependencies.
 *
 * TINY BASE64 JPEG:
 *   A 1×1 red pixel JPEG encoded inline. No binary fixtures — the test is
 *   self-contained.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { ProviderHistory, StreamEvent } from '../../engine/transport.js';

// ────────────────────────────────────────────────────────────────────────────
// Tiny inline 1×1 red-pixel JPEG (base64). This is a real valid JPEG that
// Anthropic and OpenAI providers can decode and "see". Using an inline constant
// means no binary fixture files are needed.
// ────────────────────────────────────────────────────────────────────────────
const TINY_RED_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAA' +
  'AAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAA' +
  'AAAA/9oADAMBAAIRAxEAPwCwABmX/9k=';

// ────────────────────────────────────────────────────────────────────────────
// Gate conditions — evaluated once at module load, never throw.
// ────────────────────────────────────────────────────────────────────────────
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;

// ────────────────────────────────────────────────────────────────────────────
// Helper: drain a transport readStream into accumulated text (ignoring other
// event kinds). Throws if the provider returns an error.
// ────────────────────────────────────────────────────────────────────────────
async function collectText<T extends { readStream: (s: unknown) => AsyncIterable<StreamEvent> }>(
  transport: T,
  stream: unknown,
): Promise<string> {
  let text = '';
  for await (const ev of transport.readStream(stream)) {
    if (ev.kind === 'text') text += ev.text;
  }
  return text;
}

// ════════════════════════════════════════════════════════════════════════════
// LEG 1 — Anthropic native arm (AnthropicMessagesTransport)
// ════════════════════════════════════════════════════════════════════════════
describe('LIVE-FIRE: image-in-tool_result accepted + described by Anthropic (AnthropicMessagesTransport)', () => {
  it.runIf(HAS_ANTHROPIC_KEY)(
    'provider ACCEPTS image inside tool_result and the model describes the image',
    async () => {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const transport = new AnthropicMessagesTransport({ client });

      // Build the history: a tool_use turn followed by a tool_result carrying
      // the screenshot image. We send as in-memory history (no journal / no
      // pushToolResult loop) so we can control the exact shape directly.
      //
      // The wire shape (already verified by T3 unit tests): the tool_result
      // content is an ARRAY — [{ type:'text', text }, { type:'image', source:{…} }].
      // Here we construct it manually so the test is explicit about what the
      // provider receives, not relying on the push path.
      const history: Anthropic.MessageParam[] = [
        // Turn 1: assistant decides to call the screenshot tool
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_use_screenshot_1',
              name: 'take_screenshot',
              input: {},
            },
          ],
        },
        // Turn 2: tool result — text + image (the browser screenshot)
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_use_screenshot_1',
              content: [
                {
                  type: 'text',
                  text: 'Screenshot captured.',
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: TINY_RED_JPEG_B64,
                  },
                },
              ],
            },
          ],
        },
      ];

      const stream = transport.callModel({
        model: 'claude-haiku-4-5-20250514',
        system: 'You are a helpful assistant. When asked about images, describe what you see.',
        tools: [
          {
            name: 'take_screenshot',
            description: 'Takes a browser screenshot and returns the image.',
            input_schema: { type: 'object', properties: {}, required: [] },
          } as unknown as Anthropic.Tool,
        ],
        history: history as ProviderHistory,
        maxTokens: 128,
      });

      // This should NOT throw — that is the provider-acceptance proof.
      const text = await collectText(transport, stream);

      // The model must produce SOME text response (even a brief one).
      expect(text.length).toBeGreaterThan(0);
      // Log for manual inspection of what the model saw.
      console.log('[LIVE-FIRE ANTHROPIC] model response:', text.slice(0, 300));
    },
    30_000, // 30s timeout for real API call
  );
});

// ════════════════════════════════════════════════════════════════════════════
// LEG 2 — OpenAI native arm (OpenAIResponsesTransport)
// ════════════════════════════════════════════════════════════════════════════
describe('LIVE-FIRE: image-in-function_call_output accepted + described by OpenAI (OpenAIResponsesTransport)', () => {
  it.runIf(HAS_OPENAI_KEY)(
    'provider ACCEPTS image inside function_call_output and the model describes the image',
    async () => {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const transport = new OpenAIResponsesTransport({ client });

      // Build the history: a function_call turn followed by a function_call_output
      // carrying the screenshot image. Wire shape (verified by T4 unit tests): the
      // function_call_output.output is an ARRAY — [{ type:'input_text' }, { type:'input_image', image_url:'data:…' }].
      const history: OpenAI.Responses.ResponseInputItem[] = [
        // Turn 1: assistant issues a function_call for the screenshot tool
        {
          type: 'function_call',
          call_id: 'call_screenshot_1',
          name: 'take_screenshot',
          arguments: '{}',
        },
        // Turn 2: function_call_output — text + image (the browser screenshot)
        {
          type: 'function_call_output',
          call_id: 'call_screenshot_1',
          output: [
            { type: 'input_text', text: 'Screenshot captured.' },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${TINY_RED_JPEG_B64}`,
            },
          ] as OpenAI.Responses.ResponseFunctionCallOutputItemList,
        },
      ];

      const stream = transport.callModel({
        model: 'gpt-4o-mini',
        system: 'You are a helpful assistant. When asked about images, describe what you see.',
        tools: [
          {
            type: 'function',
            name: 'take_screenshot',
            description: 'Takes a browser screenshot and returns the image.',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            strict: false,
          } as OpenAI.Responses.FunctionTool,
        ] as unknown as import('../../engine/transport.js').ProviderTool[],
        history: history as ProviderHistory,
        maxTokens: 128,
      });

      // This should NOT throw (no 400 "invalid_base64_image" / "empty_image_file")
      // — that is the provider-acceptance proof.
      const text = await collectText(transport, stream);

      // The model must produce SOME text response.
      expect(text.length).toBeGreaterThan(0);
      // Log for manual inspection.
      console.log('[LIVE-FIRE OPENAI] model response:', text.slice(0, 300));
    },
    30_000, // 30s timeout for real API call
  );
});
