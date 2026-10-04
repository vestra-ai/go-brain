import { describe, it, expect } from 'vitest';
import type { OutputFormat } from '../../contract/output-format.js';
import type { NativeConfig } from '../native-config.js';

// E6 — the run-level structured-output knob lives on NativeConfig as two
// OPTIONAL fields, threaded at the query-manager call site exactly like
// maxTurns / maxBudgetUsd. This is a TYPE-level proof: a NativeConfig literal
// that sets both fields must compile, and the field types must be exactly
// `OutputFormat` / `number`. Absent (undefined) keeps the native arm
// byte-identical, so the fields must be optional.
describe('NativeConfig — E6 structured-output run-level knob', () => {
  it('accepts outputFormat: OutputFormat and maxStructuredOutputRetries: number', () => {
    const fmt: OutputFormat = { type: 'json_schema', schema: { type: 'object' } };
    const cfg: Pick<NativeConfig, 'outputFormat' | 'maxStructuredOutputRetries'> = {
      outputFormat: fmt,
      maxStructuredOutputRetries: 2,
    };
    expect(cfg.outputFormat).toBe(fmt);
    expect(cfg.maxStructuredOutputRetries).toBe(2);
  });

  it('leaves both fields optional (a config that omits them still satisfies the pick)', () => {
    const cfg: Pick<NativeConfig, 'outputFormat' | 'maxStructuredOutputRetries'> = {};
    expect(cfg.outputFormat).toBeUndefined();
    expect(cfg.maxStructuredOutputRetries).toBeUndefined();
  });
});
