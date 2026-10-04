import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  offloadIfOversized,
  offloadThresholdForModel,
  DEFAULT_OFFLOAD_THRESHOLD_CHARS,
} from '../context-offload.js';

// Phase 4 (§1.7) — the offload threshold reads a fraction of the resolved
// model's contextWindowTokens instead of Phase 3's fixed floor.
describe('offloadThresholdForModel', () => {
  it('falls back to the fixed floor when no model is given (byte-identical to pre-Phase-4)', () => {
    expect(offloadThresholdForModel(undefined)).toBe(DEFAULT_OFFLOAD_THRESHOLD_CHARS);
  });

  it('gives a 1M-context model a larger threshold than a 200k-context model', () => {
    const big = offloadThresholdForModel('claude-sonnet-5'); // 1M context
    const small = offloadThresholdForModel('claude-haiku-4-5'); // 200k context
    expect(big).toBeGreaterThan(small);
  });

  it('clamps to a sane range for a pathologically tiny or huge context window', () => {
    // Unknown model → 200k fallback window; still within [min, max].
    const t = offloadThresholdForModel('totally-unknown-model');
    expect(t).toBeGreaterThanOrEqual(DEFAULT_OFFLOAD_THRESHOLD_CHARS);
    expect(t).toBeLessThanOrEqual(200_000);
  });

  it('NEVER goes below the pre-Phase-4 fixed floor for a 200k-context model (no regression)', () => {
    // 200_000 * 0.02 * 4 = 16,000 UNCLAMPED — would be a real regression vs the
    // old fixed 20,000-char floor every dispatch site already relied on.
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5']) {
      expect(offloadThresholdForModel(id)).toBeGreaterThanOrEqual(DEFAULT_OFFLOAD_THRESHOLD_CHARS);
    }
  });

  it('never throws on an unknown model id', () => {
    expect(() => offloadThresholdForModel('nonexistent-xyz')).not.toThrow();
  });
});

describe('offloadIfOversized — model-aware threshold', () => {
  const workingDir = join(tmpdir(), `context-offload-model-test-${process.pid}`);
  afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

  it('an explicit thresholdChars still wins over the model-derived default', async () => {
    const text = 'a'.repeat(50);
    const result = await offloadIfOversized({
      text, workingDir, taskId: 't1', toolCallId: 'tc1', thresholdChars: 10, model: 'claude-sonnet-5',
    });
    expect(result.offloaded).toBe(true); // 50 > explicit 10, even though the model's derived threshold is much larger
  });

  it('a large-context model raises the effective threshold vs no model at all', async () => {
    const text = 'a'.repeat(DEFAULT_OFFLOAD_THRESHOLD_CHARS + 1); // over the fixed floor
    const noModel = await offloadIfOversized({ text, workingDir, taskId: 't1', toolCallId: 'no-model' });
    const withModel = await offloadIfOversized({ text, workingDir, taskId: 't1', toolCallId: 'with-model', model: 'claude-sonnet-5' });
    expect(noModel.offloaded).toBe(true); // over the fixed 20k floor
    expect(withModel.offloaded).toBe(false); // under the 1M-context model's larger derived threshold
  });
});
