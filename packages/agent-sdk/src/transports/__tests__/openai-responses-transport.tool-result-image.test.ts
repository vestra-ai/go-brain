import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import {
  journalToOpenAIResponsesInput,
  imageBlockToOutputImageContent,
} from '../openai-responses-messages.js';
import type { ToolDispatchResult } from '../../tools/tool-types.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ImageBlock } from '../../contract/blocks.js';
import type { ProviderHistory } from '../../engine/transport.js';

/**
 * Task 4 — `pushToolResult` (the in-memory push, used when `cfg.journal` is absent)
 * must emit image content in the OpenAI `function_call_output.output` too, via the
 * SAME shared helper the journal converter uses (no drift). Text-only / blocks-undefined
 * keeps `output` as a bare STRING (`r.text`, byte-identical) — the native parity oracle.
 */

function pushOne(r: ToolDispatchResult): OpenAI.Responses.ResponseInputItem.FunctionCallOutput {
  // No client needed: pushToolResult is pure history mutation.
  const t = new OpenAIResponsesTransport({ client: {} as never });
  const h = t.emptyHistory() as ProviderHistory;
  t.pushToolResult(h, r);
  const items = h as OpenAI.Responses.ResponseInputItem[];
  expect(items).toHaveLength(1);
  return items[0] as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
}

describe('OpenAIResponsesTransport.pushToolResult — tool_result image content', () => {
  it('blocks carrying an image → output is the array (input_text + input_image)', () => {
    const item = pushOne({
      toolUseId: 'call_1',
      text: 'Took a screenshot',
      isError: false,
      blocks: [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', mediaType: 'image/jpeg', data: 'B64' },
      ],
    });

    expect(item.type).toBe('function_call_output');
    expect(item.call_id).toBe('call_1');
    expect(item.output).toEqual([
      { type: 'input_text', text: 'Took a screenshot' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,B64' },
    ]);
  });

  it('TYPE-LEVEL: the emitted output array is assignable to ResponseFunctionCallOutputItemList', () => {
    const item = pushOne({
      toolUseId: 'call_t',
      text: 'cap',
      isError: false,
      blocks: [
        { type: 'text', text: 'cap' },
        { type: 'image', mediaType: 'image/png', data: 'B64' },
      ],
    });
    const output = item.output as OpenAI.Responses.ResponseFunctionCallOutputItemList;
    output satisfies OpenAI.Responses.ResponseFunctionCallOutputItemList;
    expect(Array.isArray(output)).toBe(true);
  });

  it('blocks undefined → output === r.text (bare string, byte-identical)', () => {
    const item = pushOne({
      toolUseId: 'call_2',
      text: 'plain text result',
      isError: true,
    });
    expect(item.call_id).toBe('call_2');
    expect(typeof item.output).toBe('string');
    expect(item.output).toBe('plain text result');
  });

  it('text-only blocks (no image) → output stays the bare string r.text', () => {
    const item = pushOne({
      toolUseId: 'call_3',
      text: 'r.text wins',
      isError: false,
      blocks: [{ type: 'text', text: 'r.text wins' }],
    });
    expect(typeof item.output).toBe('string');
    expect(item.output).toBe('r.text wins');
  });

  it('url ImageBlock → input_image carries the url', () => {
    const item = pushOne({
      toolUseId: 'call_4',
      text: 'see',
      isError: false,
      blocks: [
        { type: 'text', text: 'see' },
        { type: 'image', mediaType: 'image/png', data: 'IGN', url: 'https://cdn/z.png' },
      ],
    });
    expect(item.output).toEqual([
      { type: 'input_text', text: 'see' },
      { type: 'input_image', image_url: 'https://cdn/z.png' },
    ]);
  });
});

describe('shared-helper drift guard — journal converter and pushToolResult agree', () => {
  it('both paths produce the SAME input_image content for the same ImageBlock (one helper)', () => {
    const image: ImageBlock = { type: 'image', mediaType: 'image/jpeg', data: 'SHAREDB64' };
    const blocks = [{ type: 'text' as const, text: 'cap' }, image];

    // journal path
    const entry: JournalEntry = {
      uuid: 'u0',
      parentUuid: null,
      seq: 0,
      taskId: 't1',
      rootTaskId: 't1',
      spawnDepth: 0,
      workspaceId: 'w1',
      agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' },
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'tool_result', toolUseId: 'c', isError: false, blocks },
    };
    // P2.0b: paired so the orphan-strip leaves the result under test.
    const call: JournalEntry = {
      ...entry,
      uuid: 'u0-call',
      seq: -1,
      payload: { type: 'tool_use', toolUseId: 'c', name: 'screenshot', input: {} },
    };
    const journalOut = (
      journalToOpenAIResponsesInput([call, entry])[1] as OpenAI.Responses.ResponseInputItem.FunctionCallOutput
    ).output as OpenAI.Responses.ResponseFunctionCallOutputItemList;

    // push path
    const pushOut = pushOne({ toolUseId: 'c', text: 'cap', isError: false, blocks })
      .output as OpenAI.Responses.ResponseFunctionCallOutputItemList;

    // the IMAGE part (second element) is identical across paths…
    expect(journalOut[1]).toEqual(pushOut[1]);
    // …and equals the standalone shared helper's output (no third source of truth).
    expect(journalOut[1]).toEqual(imageBlockToOutputImageContent(image));
    expect(pushOut[1]).toEqual(imageBlockToOutputImageContent(image));
  });
});
