import { describe, it, expect } from 'vitest';
import { VESTRA_AGENT_SDK_NAME } from '../index.js';
import * as core from '../index.js';

describe('@vestra/agent-sdk package', () => {
  it('exports its name', () => {
    expect(VESTRA_AGENT_SDK_NAME).toBe('@vestra/agent-sdk');
  });
});

describe('SDK entry-point separation (core stays pure)', () => {
  it('does NOT export the generic tool factories from the root (they live behind /tools)', () => {
    expect((core as Record<string, unknown>).makeReadTool).toBeUndefined();
    expect((core as Record<string, unknown>).makeBashTool).toBeUndefined();
    expect((core as Record<string, unknown>).spawnBackground).toBeUndefined();
  });
  it('still exports the pure tool TYPES contract from the root', () => {
    // RawToolOptions is a type (erased), so assert a value the root must keep:
    expect(typeof (core as Record<string, unknown>).VESTRA_AGENT_SDK_NAME).toBe('string');
  });
  it('does NOT export the query() front door from the root (it lives behind /query)', () => {
    // ring 5: query() drives the engine (I/O) → it MUST stay out of the pure root
    // that @bash/shared re-exports. It is reachable only via @vestra/agent-sdk/query.
    expect((core as Record<string, unknown>).query).toBeUndefined();
    expect((core as Record<string, unknown>).HARNESS_REGISTRY).toBeUndefined();
  });
});
