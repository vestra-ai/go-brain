import { describe, it, expect } from 'vitest';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import {
  blocksToGeminiInteractionsContent,
  journalToGeminiInteractionsSteps,
  normalizeGeminiInteractionsUsage,
  replayStepsToWire,
  toolResultToGeminiContent,
} from '../gemini-interactions-messages.js';
import { GEMINI_SENTINEL_THOUGHT_SIGNATURE } from '../gemini-interactions-validity.js';

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`, parentUuid: seq === 1 ? null : `u${seq - 1}`, seq, taskId: 't', rootTaskId: 't',
    spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' },
    timestamp: '2026-09-03T00:00:00.000Z', payload,
  };
}

/** The user-turn media block PR 1 puts on the journal (sizeBytes is a HINT; 0 = unknown). */
const MEDIA = {
  type: 'media' as const, kind: 'video' as const, filename: 'clip.mp4', path: 'files/clip.mp4',
  url: 'https://cdn/clip.mp4', mediaType: 'video/mp4', sizeBytes: 9000, contentSha: 'sha-1',
};

describe('blocksToGeminiInteractionsContent / toolResultToGeminiContent', () => {
  it('images lead, then text; a url-bearing image carries the INTERNAL marker', () => {
    const out = blocksToGeminiInteractionsContent([
      { type: 'text', text: 'see' },
      { type: 'image', data: '', mediaType: 'image/png', url: 'https://cdn/x.png' } as never,
      { type: 'image', data: 'AAAA', mediaType: 'image/jpeg' } as never,
    ]);
    expect(out).toEqual([
      { type: 'image', data: '', mime_type: 'image/png', vestraImageUrl: 'https://cdn/x.png' },
      { type: 'image', data: 'AAAA', mime_type: 'image/jpeg' },
      { type: 'text', text: 'see' },
    ]);
  });

  // VIDEO_UNDERSTANDING_V1 §7 — a media block never carries bytes. It projects to
  // an item the request-build pass resolves to a Files API uri, carrying the
  // INTERNAL vestraMediaRef marker until then.
  it('a media block projects to {type:kind, mime_type, uri:"", vestraMediaRef:{path,url?,sha?,mimeType,sizeBytes,displayName}} — media first, then images, then text', () => {
    const out = blocksToGeminiInteractionsContent([
      { type: 'text', text: 'watch this' },
      { type: 'image', data: 'AAAA', mediaType: 'image/png' } as never,
      MEDIA as never,
    ]);
    expect(out).toEqual([
      {
        type: 'video', mime_type: 'video/mp4', uri: '',
        vestraMediaRef: {
          path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', sha: 'sha-1',
          mimeType: 'video/mp4', sizeBytes: 9000, displayName: 'clip.mp4',
        },
      },
      { type: 'image', data: 'AAAA', mime_type: 'image/png' },
      { type: 'text', text: 'watch this' },
    ]);
  });

  it('a media block with no url and no sha omits both keys; audio and document keep their kind', () => {
    const out = blocksToGeminiInteractionsContent([
      { ...MEDIA, kind: 'audio', filename: 'note.mp3', path: 'files/note.mp3', mediaType: 'audio/mpeg', sizeBytes: 0, url: undefined, contentSha: undefined } as never,
      { ...MEDIA, kind: 'document', filename: 'deck.pdf', path: 'files/deck.pdf', mediaType: 'application/pdf', url: undefined, contentSha: undefined } as never,
    ]);
    expect(out).toEqual([
      { type: 'audio', mime_type: 'audio/mpeg', uri: '', vestraMediaRef: { path: 'files/note.mp3', mimeType: 'audio/mpeg', sizeBytes: 0, displayName: 'note.mp3' } },
      { type: 'document', mime_type: 'application/pdf', uri: '', vestraMediaRef: { path: 'files/deck.pdf', mimeType: 'application/pdf', sizeBytes: 9000, displayName: 'deck.pdf' } },
    ]);
  });

  it('watchOptions {resolution:"low", startSec:12, endSec:40} on the block \u2192 resolution:"low", processing:{start_offset:"12s", end_offset:"40s"}; absent \u2192 neither key', () => {
    const [withOpts] = blocksToGeminiInteractionsContent([
      { ...MEDIA, watchOptions: { resolution: 'low', startSec: 12, endSec: 40 } } as never,
    ]);
    expect(withOpts).toMatchObject({ resolution: 'low', processing: { start_offset: '12s', end_offset: '40s' } });

    const [bare] = blocksToGeminiInteractionsContent([MEDIA as never]);
    expect(bare).not.toHaveProperty('resolution');
    expect(bare).not.toHaveProperty('processing');

    // Each half of `processing` stands alone.
    const [startOnly] = blocksToGeminiInteractionsContent([{ ...MEDIA, watchOptions: { startSec: 0 } } as never]);
    expect(startOnly).toMatchObject({ processing: { start_offset: '0s' } });
    expect((startOnly as { processing: Record<string, unknown> }).processing).not.toHaveProperty('end_offset');
    expect(startOnly).not.toHaveProperty('resolution');
  });

  it('watchOptions.strict rides onto the MARKER, not the wire item; absent \u21d2 no strict key anywhere', () => {
    const [strict] = blocksToGeminiInteractionsContent([
      { ...MEDIA, watchOptions: { strict: true } } as never,
    ]);
    // It travels with the ref the materialize pass reads, never as a wire field.
    expect((strict as { vestraMediaRef: Record<string, unknown> }).vestraMediaRef.strict).toBe(true);
    expect(strict).not.toHaveProperty('strict');

    const [bare] = blocksToGeminiInteractionsContent([MEDIA as never]);
    expect((bare as { vestraMediaRef: Record<string, unknown> }).vestraMediaRef).not.toHaveProperty('strict');
  });

  it('a text-only tool result is ONE text item from the fallback; an image result keeps every block in order', () => {
    expect(toolResultToGeminiContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'a\nb'))
      .toEqual([{ type: 'text', text: 'a\nb' }]);
    expect(toolResultToGeminiContent([
      { type: 'text', text: 'shot' },
      { type: 'image', data: 'QQ', mediaType: 'image/png' } as never,
    ], 'shot')).toEqual([{ type: 'text', text: 'shot' }, { type: 'image', data: 'QQ', mime_type: 'image/png' }]);
  });
});

describe('replayStepsToWire', () => {
  it('an OLD normalized channel maps back one for one: each text step is its own model_output — never merged', () => {
    expect(replayStepsToWire([
      { type: 'thought', signature: 'sig-A', summary: 'plan' },
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'look.' },
      { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { p: '/a' } },
      { type: 'thought', signature: 'sig-B' },
    ])).toEqual([
      { type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'plan' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Let me ' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'look.' }] },
      { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { p: '/a' } },
      { type: 'thought', signature: 'sig-B' },
    ]);
  });

  it('a verbatim wire channel goes back byte-for-byte — two model_outputs stay two, unknown steps stay', () => {
    const wire = [
      { type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'plan' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Let me ' }] },
      { type: 'google_search_call', id: 'gs_1', arguments: { queries: ['x'] } },
      { type: 'model_output', content: [{ type: 'image', data: 'QQ', mime_type: 'image/png' }] },
      { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { p: '/a' } },
    ];
    expect(JSON.stringify(replayStepsToWire(structuredClone(wire)))).toBe(JSON.stringify(wire));
  });
});

describe('journalToGeminiInteractionsSteps', () => {
  it('default split projection: user → user_input, assistant text → model_output, tool_use → function_call, tool_result → function_result by call_id', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'read a' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'on it' }], api: 'gemini_interactions', provider: 'google' }),
      entry({ type: 'tool_use', toolUseId: 'fc_1', name: 'Read', input: { p: '/a' } }),
      entry({ type: 'tool_result', toolUseId: 'fc_1', blocks: [{ type: 'text', text: 'file a' }] }),
    ]);
    expect(steps).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'read a' }] },
      // The split path has no signature to replay; the sentinel keeps the wire
      // valid, and it leads the turn — Google 400s a thought after text.
      { type: 'thought', signature: GEMINI_SENTINEL_THOUGHT_SIGNATURE },
      { type: 'model_output', content: [{ type: 'text', text: 'on it' }] },
      { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { p: '/a' } },
      { type: 'function_result', call_id: 'fc_1', name: 'Read', result: [{ type: 'text', text: 'file a' }] },
    ]);
  });

  it('replays geminiSteps VERBATIM (signed thought kept) and does NOT double-fold the tool_use entries it carries', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'read a' }] }),
      entry({
        type: 'assistant', blocks: [{ type: 'text', text: 'on it' }], api: 'gemini_interactions', provider: 'google',
        geminiSteps: [
          { type: 'thought', signature: 'sig-A', summary: 'plan' },
          { type: 'text', text: 'on it' },
          { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { p: '/a' } },
        ],
      }),
      entry({ type: 'tool_use', toolUseId: 'fc_1', name: 'Read', input: { p: '/a' } }),
      entry({ type: 'tool_result', toolUseId: 'fc_1', blocks: [{ type: 'text', text: 'file a' }] }),
    ]);
    expect(steps.map((s) => s.type)).toEqual(['user_input', 'thought', 'model_output', 'function_call', 'function_result']);
    expect(steps[1]).toEqual({ type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'plan' }] });
    expect(steps.filter((s) => s.type === 'function_call')).toHaveLength(1);
  });

  it('CROSS-ISSUER GUARD: geminiSteps on an entry another dialect minted are ignored; foreign thinking blocks never reach the wire', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'q' }] }),
      entry({
        type: 'assistant', api: 'anthropic_messages', provider: 'anthropic',
        blocks: [{ type: 'thinking', thinking: 'secret', signature: 'anth-sig' } as never, { type: 'text', text: 'answer' }],
        anthropicBlocks: [{ type: 'thinking', thinking: 'secret', signature: 'anth-sig' }, { type: 'text', text: 'answer' }],
        // A hostile/buggy writer stamped Gemini steps on an Anthropic turn — must be ignored.
        geminiSteps: [{ type: 'thought', signature: 'not-ours' }, { type: 'text', text: 'answer' }],
      }),
    ]);
    expect(steps).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'q' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(JSON.stringify(steps)).not.toContain('secret');
    expect(JSON.stringify(steps)).not.toContain('not-ours');
  });

  it('a call pruned upstream (suspend/compaction) leaves ALONE — the real signed thought stays, never the sentinel', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'q' }] }),
      entry({
        type: 'assistant', blocks: [{ type: 'text', text: 'on it' }], api: 'gemini_interactions', provider: 'google',
        geminiSteps: [
          { type: 'thought', signature: 'sig-A' },
          { type: 'model_output', content: [{ type: 'text', text: 'on it' }] },
          { type: 'function_call', id: 'fc_keep', name: 'Read', arguments: { p: 1 } },
          { type: 'function_call', id: 'fc_gone', name: 'Read', arguments: { p: 2 } },
        ],
      }),
      entry({ type: 'tool_use', toolUseId: 'fc_keep', name: 'Read', input: { p: 1 } }),
      entry({ type: 'tool_result', toolUseId: 'fc_keep', blocks: [{ type: 'text', text: 'r' }] }),
      // No tool_use / tool_result for fc_gone — pruned. Replaying it would re-orphan it.
    ]);
    // Probed 2026-09-23: thought + text + one of two calls + its result is a 200.
    expect(steps).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'q' }] },
      { type: 'thought', signature: 'sig-A' },
      { type: 'model_output', content: [{ type: 'text', text: 'on it' }] },
      { type: 'function_call', id: 'fc_keep', name: 'Read', arguments: { p: 1 } },
      { type: 'function_result', call_id: 'fc_keep', name: 'Read', result: [{ type: 'text', text: 'r' }] },
    ]);
    expect(JSON.stringify(steps)).not.toContain(GEMINI_SENTINEL_THOUGHT_SIGNATURE);
  });

  it('runs the orphan strip + floor at the whole-history seam', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'q' }] }),
      entry({ type: 'assistant', blocks: [], api: 'gemini_interactions', provider: 'google' }),
      entry({ type: 'tool_use', toolUseId: 'fc_1', name: 'Read', input: {} }),
      // no tool_result for fc_1
    ]);
    expect(steps.map((s) => s.type)).toEqual(['user_input', 'thought', 'function_call', 'function_result']);
    expect((steps[3] as { result: unknown }).result).toEqual([{ type: 'text', text: '(no output)' }]);
  });

  it('a journal round written WITHOUT the channel (pre-#3399, or a capture miss) replays with the sentinel thought, never bare', () => {
    // Staging task 7717fe8a: an assistant entry with no geminiSteps followed by its
    // tool_use — a bare function_call on the wire is a Google 400.
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [], model: 'gemini-3.8-flash', api: 'gemini_interactions', provider: 'google' } as never),
      entry({ type: 'tool_use', toolUseId: 'call_33881', name: 'TodoCreate', input: { subject: 'x' } }),
      entry({ type: 'tool_result', toolUseId: 'call_33881', blocks: [{ type: 'text', text: 'ok' }] }),
    ]);
    expect(steps.map((s) => s.type)).toEqual(['user_input', 'thought', 'function_call', 'function_result']);
    expect(steps[1]).toEqual({ type: 'thought', signature: GEMINI_SENTINEL_THOUGHT_SIGNATURE });
    expect(steps[2]).toMatchObject({ type: 'function_call', id: 'call_33881', name: 'TodoCreate' });
  });

  it('an isError tool_result carries is_error', () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'q' }] }),
      entry({ type: 'tool_use', toolUseId: 'fc_1', name: 'Read', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'fc_1', blocks: [{ type: 'text', text: 'ENOENT' }], isError: true }),
    ]);
    expect(steps[3]).toMatchObject({ type: 'function_result', call_id: 'fc_1', is_error: true });
  });
});

describe('journalToGeminiInteractionsSteps \u2014 media', () => {
  it("carries a user entry's media block the same way the live push does (replay = live)", () => {
    seq = 0;
    const steps = journalToGeminiInteractionsSteps([
      entry({ type: 'user', blocks: [MEDIA as never, { type: 'text', text: 'watch this' }] }),
    ]);
    expect(steps).toEqual([
      {
        type: 'user_input',
        content: [
          {
            type: 'video', mime_type: 'video/mp4', uri: '',
            vestraMediaRef: {
              path: 'files/clip.mp4', url: 'https://cdn/clip.mp4', sha: 'sha-1',
              mimeType: 'video/mp4', sizeBytes: 9000, displayName: 'clip.mp4',
            },
          },
          { type: 'text', text: 'watch this' },
        ],
      },
    ]);
  });
});

describe('normalizeGeminiInteractionsUsage — the single NormalizedUsage convention', () => {
  it("Google's own streaming example: 11 input + 90 output + 245 thought = 346; input is EXCLUSIVE of cached; thoughts fold into output", () => {
    expect(normalizeGeminiInteractionsUsage({
      total_input_tokens: 11, total_cached_tokens: 0, total_output_tokens: 90, total_thought_tokens: 245, total_tokens: 346,
    })).toEqual({ inputTokens: 11, outputTokens: 335, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 245 });
    expect(normalizeGeminiInteractionsUsage({ total_input_tokens: 1000, total_cached_tokens: 900, total_output_tokens: 10 }))
      .toEqual({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 });
  });

  it('a cached count larger than input is clamped; missing fields read as 0', () => {
    expect(normalizeGeminiInteractionsUsage({ total_input_tokens: 5, total_cached_tokens: 50 }))
      .toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 });
    expect(normalizeGeminiInteractionsUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });
});
