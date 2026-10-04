/**
 * K4F-1 — the additive `context_usage` HarnessEvent kind.
 *
 * The native arm emits NO context-fullness meter today (only the Claude SDK arm
 * does). To reach parity WITHOUT letting the engine touch sockets (the
 * arm-no-streaming-emit wall), the engine yields a `{ kind: 'context_usage' }`
 * HarnessEvent carrying the flat snapshot the web ContextMeter already consumes,
 * and the core sink maps it onto EVENTS.AGENT_CONTEXT_USAGE — mirroring how K4C-1
 * added `{ kind: 'usage' }`.
 *
 * These tests pin the CONTRACT shape (it is additive — every field beyond the
 * discriminant + flat snapshot is optional, so omitting the kind is byte-identical).
 */

import { describe, it, expect } from 'vitest';
import type { HarnessEvent } from '../events.js';

describe('context_usage HarnessEvent kind (K4F-1)', () => {
  it('typechecks as a HarnessEvent carrying the flat snapshot', () => {
    const evt: HarnessEvent = {
      kind: 'context_usage',
      snapshot: {
        totalTokens: 12_000,
        maxTokens: 1_000_000,
        percentage: 1.2,
        model: 'claude-sonnet-4-6',
      },
    };
    expect(evt.kind).toBe('context_usage');
    const e = evt as Extract<HarnessEvent, { kind: 'context_usage' }>;
    expect(e.snapshot.totalTokens).toBe(12_000);
    expect(e.snapshot.maxTokens).toBe(1_000_000);
    expect(e.snapshot.percentage).toBe(1.2);
    expect(e.snapshot.model).toBe('claude-sonnet-4-6');
  });

  it('carries OPTIONAL per-category buckets (system/tools/messages/memory)', () => {
    const evt: Extract<HarnessEvent, { kind: 'context_usage' }> = {
      kind: 'context_usage',
      snapshot: {
        totalTokens: 155,
        maxTokens: 200_000,
        percentage: 0.0775,
        model: 'claude-haiku-4-5-20250514',
        system: 30,
        tools: 20,
        messages: 100,
        memory: 5,
      },
    };
    expect(evt.snapshot.system).toBe(30);
    expect(evt.snapshot.tools).toBe(20);
    expect(evt.snapshot.messages).toBe(100);
    expect(evt.snapshot.memory).toBe(5);
  });

  it('the per-category buckets are OPTIONAL — a snapshot with only the flat 4 fields is valid', () => {
    // Compile-time proof the additive fields do not become required: a flat-only
    // snapshot is a well-formed context_usage event (byte-identical to the minimal shape).
    const evt: Extract<HarnessEvent, { kind: 'context_usage' }> = {
      kind: 'context_usage',
      snapshot: { totalTokens: 0, maxTokens: 200_000, percentage: 0, model: '' },
    };
    expect('system' in evt.snapshot).toBe(false);
    expect('memory' in evt.snapshot).toBe(false);
  });
});
