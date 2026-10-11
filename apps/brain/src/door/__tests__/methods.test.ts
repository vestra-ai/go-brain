import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { KNOWN_EVENT_TYPES, TO_GO_SCHEMAS, TO_SERVER_SCHEMAS } from '../methods.js';

describe('the method table', () => {
  it('names exactly the 29 methods in the contract, each in its direction', () => {
    const ours = [
      ...Object.keys(TO_GO_SCHEMAS).map((n) => `to_go:${n}`),
      ...Object.keys(TO_SERVER_SCHEMAS).map((n) => `to_server:${n}`),
    ].sort();
    const theirs = C.SOCKET_METHODS.map((m) => `${m.direction}:${m.name}`).sort();
    expect(ours).toEqual(theirs);
    expect(ours).toHaveLength(29);
  });

  it('uses the very schemas the contract uses for params and results', () => {
    for (const m of C.SOCKET_METHODS) {
      const table: Record<string, readonly [unknown, unknown]> = m.direction === 'to_go' ? TO_GO_SCHEMAS : TO_SERVER_SCHEMAS;
      const row = table[m.name];
      expect(row?.[0]).toBe(m.params);
      expect(row?.[1]).toBe(m.result);
    }
  });

  it('knows exactly the contract event types', () => {
    const theirs = C.Event.options.map((o) => o.shape.type.value).sort();
    expect([...KNOWN_EVENT_TYPES].sort()).toEqual(theirs);
    expect(KNOWN_EVENT_TYPES.size).toBe(23);
  });
});
