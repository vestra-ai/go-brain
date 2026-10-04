import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import {
  journalToOpenAIResponsesInput,
  imageBlockToOutputImageContent,
} from '../openai-responses-messages.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ImageBlock } from '../../contract/blocks.js';

/**
 * Task 4 — native OPENAI RESPONSES arm tool_result image content.
 *
 * After T1 (blocks on the dispatch result) + T2 (blocks persisted in the journal),
 * `journalToOpenAIResponsesInput` must reconstruct screenshots on resume: a tool_result
 * journal entry whose `blocks` carry an ImageBlock emits the `function_call_output`
 * with `output` as the CONTENT-ARRAY form — `ResponseInputTextContent` (input_text)
 * + `ResponseInputImageContent` (input_image), order preserved — NOT a flattened
 * string. The CRITICAL detail is the function-call-OUTPUT content variant
 * (`ResponseInputImageContent`, `detail` optional), NOT the user-message
 * `ResponseInputImage`.
 *
 * HARD INVARIANT (the native parity oracle — no prior conformance test pins the
 * native OpenAI tool_result wire shape): a TEXT-ONLY tool_result keeps `output` as a
 * bare STRING, byte-identical to today.
 */

function baseEntry(seq: number, payload: JournalEntry['payload']): JournalEntry {
  return {
    uuid: `u_${seq}`,
    parentUuid: seq === 0 ? null : `u_${seq - 1}`,
    seq,
    taskId: 't1',
    rootTaskId: 't1',
    spawnDepth: 0,
    workspaceId: 'w1',
    agentId: 'native',
    principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** Read the function_call_output item produced for a tool_result entry.
 *  P2.0b: the result is paired with a matching tool_use so the orphan-strip
 *  leaves it — the output shape is what's under test here. */
function fcoOutput(entry: JournalEntry): unknown {
  const toolUseId = (entry.payload as { toolUseId: string }).toolUseId;
  const call: JournalEntry = {
    ...entry,
    uuid: `${entry.uuid}-call`,
    seq: entry.seq - 0.5,
    payload: { type: 'tool_use', toolUseId, name: 'screenshot', input: {} },
  };
  const input = journalToOpenAIResponsesInput([call, entry]);
  expect(input).toHaveLength(2);
  const item = input[1] as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
  expect(item.type).toBe('function_call_output');
  return item.output;
}

describe('journalToOpenAIResponsesInput — tool_result image content (resume reconstructs screenshots)', () => {
  it('emits output as an array (input_text + input_image), order preserved, with the call_id', () => {
    const entry = baseEntry(0, {
      type: 'tool_result',
      toolUseId: 'call_screenshot',
      isError: false,
      blocks: [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', mediaType: 'image/jpeg', data: 'BASE64DATA' },
      ],
    });

    // P2.0b: paired so the orphan-strip leaves the result under test.
    const call = baseEntry(1, { type: 'tool_use', toolUseId: 'call_screenshot', name: 'screenshot', input: {} });
    const input = journalToOpenAIResponsesInput([call, entry]);
    const item = input[1] as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
    expect(item.type).toBe('function_call_output');
    expect(item.call_id).toBe('call_screenshot');

    // ARRAY form: input_text part PLUS the input_image part (data: url), order preserved.
    expect(Array.isArray(item.output)).toBe(true);
    expect(item.output).toEqual([
      { type: 'input_text', text: 'Took a screenshot' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BASE64DATA' },
    ]);
  });

  it('TYPE-LEVEL: the emitted output array is assignable to ResponseFunctionCallOutputItemList', () => {
    // This MUST COMPILE — it proves the emitted value uses the correct
    // function-call-output content variants (input-side), guarding against the
    // wrong (user-message ResponseInputImage) variant.
    const output = fcoOutput(
      baseEntry(0, {
        type: 'tool_result',
        toolUseId: 'c',
        isError: false,
        blocks: [
          { type: 'text', text: 'cap' },
          { type: 'image', mediaType: 'image/png', data: 'B64' },
        ],
      }),
    ) as OpenAI.Responses.ResponseFunctionCallOutputItemList;

    // The `satisfies` below is the compile-time guard; the runtime assert just
    // keeps the value live so the type is exercised.
    output satisfies OpenAI.Responses.ResponseFunctionCallOutputItemList;
    expect(Array.isArray(output)).toBe(true);
  });

  it('BYTE-IDENTICAL: a text-only tool_result keeps output as a bare STRING (not an array)', () => {
    const output = fcoOutput(
      baseEntry(0, {
        type: 'tool_result',
        toolUseId: 'call_text',
        isError: true,
        blocks: [{ type: 'text', text: 'plain result' }],
      }),
    );
    expect(typeof output).toBe('string');
    expect(output).toBe('plain result');
  });

  it('url ImageBlock → input_image carries the url (not a data: url)', () => {
    const output = fcoOutput(
      baseEntry(0, {
        type: 'tool_result',
        toolUseId: 'call_url',
        blocks: [
          { type: 'text', text: 'see' },
          { type: 'image', mediaType: 'image/png', data: 'IGNORED', url: 'https://cdn/x.png' },
        ],
      }),
    );
    expect(output).toEqual([
      { type: 'input_text', text: 'see' },
      { type: 'input_image', image_url: 'https://cdn/x.png' },
    ]);
  });
});

describe('imageBlockToOutputImageContent — function-call-output image content variant', () => {
  it('base64 ImageBlock → { type:input_image, image_url:data: }', () => {
    const block: ImageBlock = { type: 'image', mediaType: 'image/gif', data: 'DAT' };
    expect(imageBlockToOutputImageContent(block)).toEqual({
      type: 'input_image',
      image_url: 'data:image/gif;base64,DAT',
    });
  });

  it('url ImageBlock → { type:input_image, image_url:url } (url preferred over base64)', () => {
    const block: ImageBlock = {
      type: 'image',
      mediaType: 'image/webp',
      data: 'DAT',
      url: 'https://cdn/y.webp',
    };
    expect(imageBlockToOutputImageContent(block)).toEqual({
      type: 'input_image',
      image_url: 'https://cdn/y.webp',
    });
  });

  it('TYPE-LEVEL: the helper output is assignable to ResponseInputImageContent', () => {
    const v = imageBlockToOutputImageContent({ type: 'image', mediaType: 'image/png', data: 'D' });
    v satisfies OpenAI.Responses.ResponseInputImageContent;
    expect(v.type).toBe('input_image');
  });
});
