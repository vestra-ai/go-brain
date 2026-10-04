import { describe, it, expect } from 'vitest';
import { FakeTransport, UnsetTransport, type StreamEvent } from '../transport.js';
import type { OutputFormat } from '../../contract/output-format.js';

// A trivial scripted stream so callModel has something to return.
function scriptedDone(): StreamEvent[] {
  return [
    { kind: 'text', text: 'ok' },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

const FORMAT: OutputFormat = {
  type: 'json_schema',
  name: 'routine_spec',
  schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
};

describe('Transport.callModel — outputFormat seam (E1)', () => {
  it('FakeTransport starts with no recorded outputFormat', () => {
    const t = new FakeTransport(scriptedDone());
    expect(t.lastOutputFormat).toBeUndefined();
  });

  it('FakeTransport.callModel echoes the requested outputFormat', () => {
    const t = new FakeTransport(scriptedDone());
    t.callModel({
      model: 'fake',
      system: '',
      tools: [],
      history: t.emptyHistory(),
      maxTokens: 100,
      outputFormat: FORMAT,
    });
    // The requested format is captured verbatim for conformance assertions.
    expect(t.lastOutputFormat).toEqual(FORMAT);
  });

  it('FakeTransport.callModel returns the scripted events (behavior unchanged)', () => {
    const events = scriptedDone();
    const t = new FakeTransport(events);
    const stream = t.callModel({
      model: 'fake',
      system: '',
      tools: [],
      history: t.emptyHistory(),
      maxTokens: 100,
      outputFormat: FORMAT,
    });
    // Same events array returned — scripted return path unchanged.
    expect(stream).toBe(events);
  });

  it('FakeTransport.callModel WITHOUT outputFormat leaves the capture undefined (byte-identity path)', () => {
    const t = new FakeTransport(scriptedDone());
    t.callModel({ model: 'fake', system: '', tools: [], history: t.emptyHistory(), maxTokens: 100 });
    expect(t.lastOutputFormat).toBeUndefined();
  });

  it('UnsetTransport.callModel still throws even when an outputFormat is passed', () => {
    const t = new UnsetTransport();
    expect(() =>
      t.callModel({
        model: 'm',
        system: '',
        tools: [],
        history: [],
        maxTokens: 1,
        outputFormat: FORMAT,
      }),
    ).toThrow(/UnsetTransport\.callModel called before NativeConfig\.transport was installed/);
  });
});
