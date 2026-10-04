import { describe, it, expect } from 'vitest';
import { journalToOpenAIResponsesInput } from '../openai-responses-messages.js';
import { journalToAnthropicMessages } from '../../engine/native-messages.js';
import type { JournalEntry } from '../../contract/journal.js';

/**
 * §4.3a durability (the PRODUCTION path). The native loop is journal-driven:
 * `pushAssistant` is NEVER called on the journal path — history is re-projected
 * from `journalToOpenAIResponsesInput` after every tool batch. So the encrypted
 * reasoning items MUST ride the journal `tool_use` payload (a provider-tagged,
 * optional field) or reasoning-model tool turns 400 in production.
 *
 * The same field MUST be invisible to `journalToAnthropicMessages` (the Anthropic
 * arm byte-identity hard invariant) — it reads named fields off the payload and
 * never iterates it, so a new optional `reasoning?` field can never leak in.
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

describe('journalToOpenAIResponsesInput — echoes encrypted reasoning before its function_call (§4.3a)', () => {
  it('emits a {type:reasoning} item immediately before the tool_use that carried it', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      baseEntry(1, { type: 'assistant', blocks: [], api: 'openai_responses', provider: 'openai' }),
      baseEntry(2, {
        type: 'tool_use',
        toolUseId: 'call_1',
        name: 'do_it',
        input: { x: 1 },
        // provider-tagged optional field — captured encrypted reasoning items.
        reasoning: [{ id: 'rs_1', encryptedContent: 'ENC1' }],
      }),
      baseEntry(3, { type: 'tool_result', toolUseId: 'call_1', blocks: [{ type: 'text', text: 'ok' }] }),
    ];

    const input = journalToOpenAIResponsesInput(entries);
    const reasoningIdx = input.findIndex((i) => (i as { type?: string }).type === 'reasoning');
    const fcIdx = input.findIndex((i) => (i as { type?: string }).type === 'function_call');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(fcIdx);
    expect(input[reasoningIdx]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1' });
    expect(input[fcIdx]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'do_it' });
  });

  it('emits NO reasoning item for a tool_use with no captured reasoning (byte-identical)', () => {
    // P2.0b: paired so the orphan-strip leaves the call under test.
    const entries: JournalEntry[] = [
      baseEntry(0, { type: 'tool_use', toolUseId: 'call_2', name: 'f', input: {} }),
      baseEntry(1, { type: 'tool_result', toolUseId: 'call_2', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    // Full-array assertion: no stray reasoning, no extra items — exactly the paired
    // function_call + function_call_output, in order.
    expect(input).toEqual([
      { type: 'function_call', call_id: 'call_2', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'ok' },
    ]);
  });

  it('PR4 — rides the journaled issuer on an internal `_issuer` marker for the cross-issuer guard', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, {
        type: 'tool_use',
        toolUseId: 'call_1',
        name: 'do_it',
        input: {},
        reasoning: [{ id: 'rs_1', encryptedContent: 'ENC1', issuer: 'google' }],
      }),
      // P2.0b: paired so the orphan-strip leaves the call (and its reasoning).
      baseEntry(1, { type: 'tool_result', toolUseId: 'call_1', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    const r = input.find((i) => (i as { type?: string }).type === "reasoning") as unknown as Record<string, unknown>;
    expect(r._issuer).toBe('google');
    expect(r.encrypted_content).toBe('ENC1');
  });

  it('PR4 — omits `_issuer` when the journaled reasoning has no issuer (byte-identical)', () => {
    const entries: JournalEntry[] = [
      baseEntry(0, {
        type: 'tool_use',
        toolUseId: 'call_1',
        name: 'do_it',
        input: {},
        reasoning: [{ id: 'rs_1', encryptedContent: 'ENC1' }],
      }),
      // P2.0b: paired so the orphan-strip leaves the call (and its reasoning).
      baseEntry(1, { type: 'tool_result', toolUseId: 'call_1', blocks: [{ type: 'text', text: 'ok' }] }),
    ];
    const input = journalToOpenAIResponsesInput(entries);
    const r = input.find((i) => (i as { type?: string }).type === "reasoning") as unknown as Record<string, unknown>;
    expect('_issuer' in r).toBe(false);
  });
});

describe('journalToAnthropicMessages — §4.3a invariant: never sees the reasoning field', () => {
  it('a tool_use entry carrying reasoning[] projects byte-identically (no reasoning/encrypted_content leak)', () => {
    const withReasoning: JournalEntry[] = [
      baseEntry(0, {
        type: 'tool_use',
        toolUseId: 'call_1',
        name: 'do_it',
        input: { x: 1 },
        reasoning: [{ id: 'rs_1', encryptedContent: 'ENC1' }],
      }),
    ];
    const withoutReasoning: JournalEntry[] = [
      baseEntry(0, { type: 'tool_use', toolUseId: 'call_1', name: 'do_it', input: { x: 1 } }),
    ];

    const a = journalToAnthropicMessages(withReasoning);
    const b = journalToAnthropicMessages(withoutReasoning);
    // The reasoning field is invisible — projections are byte-identical.
    expect(a).toEqual(b);
    const json = JSON.stringify(a);
    expect(json).not.toContain('encrypted_content');
    expect(json).not.toMatch(/"type":"reasoning"/);
    expect(json).not.toContain('ENC1');
  });
});
