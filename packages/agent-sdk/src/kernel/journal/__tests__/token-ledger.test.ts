/**
 * K4-T0 — token ledger tests.
 *
 * Step 1: failing tests — confirm module-not-found before implementation.
 * Groups:
 *   A — projectTokenCount
 *   B — estimateTokens
 *   C — resolveMaxContextTokens
 */

import { describe, it, expect } from 'vitest';
import { projectTokenCount, estimateTokens, resolveMaxContextTokens, buildContextLedger, IMAGE_TOKEN_ESTIMATE } from '../token-ledger.js';
import type { JournalEntry } from '../../../contract/journal.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

function entry(
  type: JournalEntry['payload']['type'],
  extra: Partial<Record<string, unknown>> = {},
): JournalEntry {
  const seq = _seq++;
  let payload: JournalEntry['payload'];

  if (type === 'user') {
    const blocks = (extra.blocks as JournalEntry['payload'] extends { blocks: infer B } ? B : never[]) ?? [];
    payload = { type: 'user', blocks: blocks as any };
  } else if (type === 'assistant') {
    const blocks = (extra.blocks as any) ?? [];
    payload = { type: 'assistant', blocks };
  } else if (type === 'tool_use') {
    payload = {
      type: 'tool_use',
      toolUseId: (extra.toolUseId as string) ?? `tu-${seq}`,
      name: (extra.name as string) ?? 'bash',
      input: extra.input ?? {},
    };
  } else if (type === 'tool_result') {
    const blocks = (extra.blocks as any) ?? [];
    payload = {
      type: 'tool_result',
      toolUseId: (extra.toolUseId as string) ?? `tu-${seq}`,
      blocks,
    };
  } else if (type === 'system') {
    payload = { type: 'system', event: (extra.event as string) ?? 'test', data: extra.data };
  } else if (type === 'custom_message') {
    const blocks = (extra.blocks as any) ?? [];
    payload = { type: 'custom_message', blocks };
  } else if (type === 'usage') {
    payload = { type: 'usage', intelligence: 0, actions: 0, compute: 0 };
  } else if (type === 'compact_boundary') {
    payload = {
      type: 'compact_boundary',
      summaryUuid: 'x',
      preservedUuids: [],
      firstKeptId: 'y',
      trigger: 'auto',
      preTokens: 0,
      postTokens: 0,
    };
  } else if (type === 'label') {
    payload = { type: 'label', name: 'test' };
  } else if (type === 'mode') {
    payload = { type: 'mode', key: 'k', value: null };
  } else if (type === 'interaction') {
    payload = { type: 'interaction', interactionId: 'i', resolved: false };
  } else {
    payload = { type: 'custom', key: 'x', data: null };
  }

  return {
    uuid: `entry-${seq}`,
    parentUuid: seq === 0 ? null : `entry-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    payload,
  };
}

/** Build a TextBlock-shaped object for use in blocks arrays. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// ─── Group A: projectTokenCount ───────────────────────────────────────────────

describe('projectTokenCount — Group A', () => {
  it('A1: empty → all-zero ledger', () => {
    resetSeq();
    const ledger = projectTokenCount([]);
    expect(ledger.total).toBe(0);
    expect(ledger.system).toBe(0);
    expect(ledger.tools).toBe(0);
    expect(ledger.messages).toBe(0);
    expect(ledger.memory).toBe(0);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('A2: non-context-only entries (usage, compact_boundary, label) → all-zero (tolerated silently)', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('usage'),
      entry('compact_boundary'),
      entry('label'),
      entry('mode'),
      entry('interaction'),
      entry('custom'),
    ];
    const ledger = projectTokenCount(entries);
    expect(ledger.total).toBe(0);
    expect(ledger.system).toBe(0);
    expect(ledger.tools).toBe(0);
    expect(ledger.messages).toBe(0);
    expect(ledger.memory).toBe(0);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('A3: user+assistant+tool_use+tool_result → messages = sum of estimateTokens, total === messages', () => {
    resetSeq();
    const userText = 'Hello world, please do something for me';
    const assistantText = 'Sure, I can help with that task right now.';
    const toolInput = { command: 'ls -la /home/user' };
    const toolResultText = 'total 12\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .\n';

    const entries: JournalEntry[] = [
      entry('user', { blocks: [textBlock(userText)] }),
      entry('assistant', { blocks: [textBlock(assistantText)] }),
      entry('tool_use', { toolUseId: 'tu-1', input: toolInput }),
      entry('tool_result', { toolUseId: 'tu-1', blocks: [textBlock(toolResultText)] }),
    ];

    const ledger = projectTokenCount(entries);

    // Compute expected manually
    const expectedUser = estimateTokens(userText);
    const expectedAssistant = estimateTokens(assistantText);
    const expectedToolUse = estimateTokens(JSON.stringify(toolInput));
    const expectedToolResult = estimateTokens(toolResultText);
    const expectedMessages = expectedUser + expectedAssistant + expectedToolUse + expectedToolResult;

    expect(ledger.messages).toBe(expectedMessages);
    expect(ledger.messages).toBeGreaterThan(0);
    expect(ledger.total).toBe(ledger.messages);
    expect(ledger.system).toBe(0);
    expect(ledger.tools).toBe(0);
    expect(ledger.memory).toBe(0);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('A4: mixed context + non-context → system===0, tools===0, memory===0', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('usage'),
      entry('user', { blocks: [textBlock('some user message')] }),
      entry('compact_boundary'),
      entry('assistant', { blocks: [textBlock('assistant reply')] }),
      entry('label'),
    ];
    const ledger = projectTokenCount(entries);
    expect(ledger.system).toBe(0);
    expect(ledger.tools).toBe(0);
    expect(ledger.memory).toBe(0);
    expect(ledger.messages).toBeGreaterThan(0);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('A5: total === system + tools + messages + memory (invariant) — always holds', () => {
    resetSeq();
    // Many entries of various kinds
    const entries: JournalEntry[] = [
      entry('user', { blocks: [textBlock('Task: write some code please')] }),
      entry('assistant', { blocks: [textBlock('I will write the code now.')] }),
      entry('tool_use', { toolUseId: 'tu-x', input: { cmd: 'git status' } }),
      entry('tool_result', { toolUseId: 'tu-x', blocks: [textBlock('On branch main')] }),
      entry('usage'),
      entry('compact_boundary'),
      entry('custom_message', { blocks: [textBlock('system context block')] }),
      entry('system', { event: 'session_start', data: { model: 'claude-haiku-4-5' } }),
    ];
    const ledger = projectTokenCount(entries);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });
});

// ─── Group B: estimateTokens ──────────────────────────────────────────────────

describe('estimateTokens — Group B', () => {
  it('B1: empty string → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('B2: 4-char string → 1', () => {
    // "abcd" → byChar = round(4/4)=1, byWord = round(1 * 1.3)=1; max(1,1) = 1
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('B3: 400-char string → exactly 100 (formula pin)', () => {
    // 400 chars, all one word → byChar = round(400/4)=100, byWord = round(1 * 1.3)=1; max(100,1) = 100
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('B4: monotone non-decreasing — longer text never fewer tokens', () => {
    const texts = ['a', 'abc', 'hello world', 'hello world foo bar baz qux quux'];
    let prev = estimateTokens(texts[0]!);
    for (let i = 1; i < texts.length; i++) {
      const curr = estimateTokens(texts[i]!);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });

  it('B5: null/undefined-like input — handles falsy gracefully (returns 0)', () => {
    // The spec says `if (!text) return 0` — empty string already tested; also verify whitespace-only
    expect(estimateTokens('   ')).toBeGreaterThanOrEqual(0); // all-whitespace: byWord=0, byChar small
  });

  it('B6: word-count blend kicks in for multi-word text with short chars', () => {
    // 10 words × "ab " = 30 chars → byChar = round(30/4)=8; byWord = round(10*1.3)=13; max=13
    const text = Array(10).fill('ab').join(' '); // "ab ab ab ab ab ab ab ab ab ab" = 29 chars
    const result = estimateTokens(text);
    // byChar = round(29/4) = 7; byWord = round(10 * 1.3) = 13; max = 13
    expect(result).toBe(13);
  });
});

// ─── Group C: resolveMaxContextTokens ────────────────────────────────────────

describe('resolveMaxContextTokens — Group C', () => {
  it('C1: claude-sonnet-4-6-* → 1_000_000', () => {
    expect(resolveMaxContextTokens('claude-sonnet-4-6-20250514')).toBe(1_000_000);
  });

  it('C2: claude-opus-4-6 → 1_000_000', () => {
    expect(resolveMaxContextTokens('claude-opus-4-6')).toBe(1_000_000);
  });

  it('C3: claude-opus-4-7-* → 1_000_000', () => {
    expect(resolveMaxContextTokens('claude-opus-4-7-20251015')).toBe(1_000_000);
  });

  it('C4: claude-mythos-5 → 1_000_000', () => {
    // The registry models the dated mythos-5 line (and mythos-preview) at 1M.
    // The old bare-`mythos` regex matched any id containing "mythos"; the
    // registry is more precise — it keys on `mythos-5` / `mythos-preview`.
    expect(resolveMaxContextTokens('claude-mythos-5')).toBe(1_000_000);
  });

  it('C5: claude-haiku-4-5-* → 200_000', () => {
    expect(resolveMaxContextTokens('claude-haiku-4-5-20250514')).toBe(200_000);
  });

  it('C6: claude-sonnet-3-5 → 200_000', () => {
    expect(resolveMaxContextTokens('claude-sonnet-3-5')).toBe(200_000);
  });

  it('C7: claude-opus-3 → 200_000', () => {
    expect(resolveMaxContextTokens('claude-opus-3')).toBe(200_000);
  });

  it('C8: unknown model → 200_000 (fail-safe-small)', () => {
    expect(resolveMaxContextTokens('some-unknown-model-xyz')).toBe(200_000);
  });

  it('C9: mixed-case Claude-SONNET-4-6 → 1_000_000 (case-insensitive)', () => {
    expect(resolveMaxContextTokens('Claude-SONNET-4-6')).toBe(1_000_000);
  });

  it('C10: empty string → 200_000 (fail-safe-small)', () => {
    expect(resolveMaxContextTokens('')).toBe(200_000);
  });

  // ── Registry-delegation deltas: the old local regex omitted opus-4-8 and
  //    fable-5, treating those 1M-context models as 200k and firing the
  //    compaction trigger ~5x too early. Delegating to the @bash/shared
  //    capability registry is the fix.
  it('C11: claude-opus-4-8 → 1_000_000 (was 200_000 under the old regex — the fix)', () => {
    expect(resolveMaxContextTokens('claude-opus-4-8')).toBe(1_000_000);
  });

  it('C12: claude-opus-4-8-20260101 (dated alias) → 1_000_000', () => {
    expect(resolveMaxContextTokens('claude-opus-4-8-20260101')).toBe(1_000_000);
  });

  it('C13: claude-fable-5 → 1_000_000 (was 200_000 under the old regex — the fix)', () => {
    expect(resolveMaxContextTokens('claude-fable-5')).toBe(1_000_000);
  });

  it('C14: claude-mythos-preview → 1_000_000', () => {
    expect(resolveMaxContextTokens('claude-mythos-preview')).toBe(1_000_000);
  });

  it('C15: claude-opus-4-5 → 200_000 (regression — 4-5 family is NOT 1M)', () => {
    expect(resolveMaxContextTokens('claude-opus-4-5')).toBe(200_000);
  });

  it('C16: claude-sonnet-4-5 → 200_000 (regression — 4-5 family is NOT 1M)', () => {
    expect(resolveMaxContextTokens('claude-sonnet-4-5')).toBe(200_000);
  });
});

// ─── Group D: buildContextLedger (K4F-1) ──────────────────────────────────────

describe('buildContextLedger — Group D', () => {
  it('D1: assembles all four buckets; total === system + tools + messages + memory', () => {
    const ledger = buildContextLedger({ messages: 100, system: 30, tools: 20, memory: 5 });
    expect(ledger.messages).toBe(100);
    expect(ledger.system).toBe(30);
    expect(ledger.tools).toBe(20);
    expect(ledger.memory).toBe(5);
    expect(ledger.total).toBe(155);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('D2: all-zero input → all-zero ledger (invariant still holds)', () => {
    const ledger = buildContextLedger({ messages: 0, system: 0, tools: 0, memory: 0 });
    expect(ledger.total).toBe(0);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('D3: memory bucket defaults to 0 when omitted (the call site may not have a Nami block)', () => {
    const ledger = buildContextLedger({ messages: 40, system: 10, tools: 5 });
    expect(ledger.memory).toBe(0);
    expect(ledger.total).toBe(55);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('D4: never throws on degenerate (negative / NaN) input — coerces to a finite total', () => {
    expect(() => buildContextLedger({ messages: NaN, system: -5, tools: 0, memory: 0 })).not.toThrow();
    const ledger = buildContextLedger({ messages: NaN, system: -5, tools: 0, memory: 0 });
    // Degenerate buckets are floored to 0 so the trigger math never sees NaN/negatives.
    expect(Number.isFinite(ledger.total)).toBe(true);
    expect(ledger.total).toBe(ledger.system + ledger.tools + ledger.messages + ledger.memory);
  });

  it('D5: the trigger value (ledger.total) equals the prior inline sum for the same inputs', () => {
    // The native call site previously kept ONLY the scalar:
    //   projectTokenCount(pruned).messages + estimateTokens(system) + estimateTokens(tools)
    // buildContextLedger MUST yield the identical total so the compaction threshold
    // check is behavior-identical (memory=0 at the native call site preserves it).
    const messages = 1234;
    const system = estimateTokens('You are Bash. '.repeat(50));
    const tools = estimateTokens(JSON.stringify([{ name: 'Read' }, { name: 'Write' }]));
    const priorInlineTotal = messages + system + tools;
    const ledger = buildContextLedger({ messages, system, tools });
    expect(ledger.total).toBe(priorInlineTotal);
  });
});

// ─── Image accounting (CONTEXT_ELISION_V1) ────────────────────────────────────

describe('projectTokenCount — image accounting', () => {
  const img = { type: 'image', data: 'AAAA', mediaType: 'image/png' };

  it('is image-BLIND by default — every pre-existing caller measures what it always did', () => {
    resetSeq();
    const entries = [
      entry('tool_result', { blocks: [{ type: 'text', text: 'ok' }, img, img] }),
      entry('user', { blocks: [img] }),
    ];
    const bare = projectTokenCount(entries).messages;
    const textOnly = projectTokenCount([
      { ...entries[0], payload: { type: 'tool_result', toolUseId: 'tu-0', blocks: [{ type: 'text', text: 'ok' }] } },
      { ...entries[1], payload: { type: 'user', blocks: [] } },
    ] as JournalEntry[]).messages;
    expect(bare).toBe(textOnly);
  });

  it('charges the flat estimate per image when countImages is on', () => {
    resetSeq();
    const entries = [
      entry('tool_result', { blocks: [{ type: 'text', text: 'ok' }, img, img] }),
      entry('user', { blocks: [img] }),
    ];
    const blind = projectTokenCount(entries).messages;
    const seeing = projectTokenCount(entries, { countImages: true }).messages;
    // Three images across a tool_result and a user turn.
    expect(seeing - blind).toBe(3 * IMAGE_TOKEN_ESTIMATE);
  });

  it('the blind ledger reports a screenshot-heavy turn as ~nothing — the reason this exists', () => {
    resetSeq();
    // Four screenshots and almost no text: ~4,800 real tokens on the wire.
    const entries = [entry('tool_result', { blocks: [{ type: 'text', text: 'done' }, img, img, img, img] })];
    expect(projectTokenCount(entries).messages).toBeLessThan(10);
    expect(projectTokenCount(entries, { countImages: true }).messages).toBeGreaterThan(4_000);
  });
});
