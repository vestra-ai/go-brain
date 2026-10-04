import { describe, it, expect } from 'vitest';
import { buildPromptBreakdown } from '../prompt-span.js';

// Anthropic-shape tool schemas (the native arm's providerTools).
const tool = (name: string, pad: number) => ({
  name,
  description: 'x'.repeat(pad),
  input_schema: { type: 'object', properties: {} },
});

describe('buildPromptBreakdown', () => {
  it('measures system, layers, tools, and msg0 from the served payload', () => {
    const b = buildPromptBreakdown({
      system: 'SYSTEM-PROMPT-BYTES',
      providerTools: [tool('Bash', 100), tool('Edit', 40)],
      history: [{ role: 'user', content: 'hello world' }],
      layerSizes: [
        { id: 'soul', chars: 1200 },
        { id: 'operational', chars: 300 },
      ],
    });

    expect(b.systemChars).toBe('SYSTEM-PROMPT-BYTES'.length);
    expect(b.layers).toEqual([
      { id: 'soul', chars: 1200 },
      { id: 'operational', chars: 300 },
    ]);
    expect(b.toolsCount).toBe(2);
    expect(b.toolsChars).toBe(JSON.stringify([tool('Bash', 100), tool('Edit', 40)]).length);
    // msg0 = the JSON envelope of the first message.
    expect(b.msg0Chars).toBe(JSON.stringify({ role: 'user', content: 'hello world' }).length);
  });

  it('returns the top-5 largest tool schemas, descending, with names', () => {
    const tools = [
      tool('a', 10),
      tool('b', 500),
      tool('c', 50),
      tool('d', 800),
      tool('e', 5),
      tool('f', 300),
      tool('g', 200),
    ];
    const b = buildPromptBreakdown({ system: '', providerTools: tools, history: [] });
    expect(b.topTools.map((t) => t.name)).toEqual(['d', 'b', 'f', 'g', 'c']);
    expect(b.topTools).toHaveLength(5);
    // descending by chars
    for (let i = 1; i < b.topTools.length; i++) {
      expect(b.topTools[i - 1].chars).toBeGreaterThanOrEqual(b.topTools[i].chars);
    }
  });

  it('omits layers when no sizes supplied (empty array, never undefined)', () => {
    const b = buildPromptBreakdown({ system: 'abc', providerTools: [], history: [] });
    expect(b.layers).toEqual([]);
    expect(b.toolsCount).toBe(0);
    expect(b.toolsChars).toBe(JSON.stringify([]).length);
    expect(b.topTools).toEqual([]);
    expect(b.msg0Chars).toBe(0);
  });

  it('never throws on hostile inputs — degrades to zeros', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const b = buildPromptBreakdown({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      system: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providerTools: [circular] as any,
      history: circular,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      layerSizes: 'nope' as any,
    });
    expect(b.systemChars).toBe(0);
    expect(b.layers).toEqual([]);
    expect(b.toolsCount).toBe(1);
    // circular JSON.stringify throws → that tool's chars degrade to 0, never throws out.
    expect(b.toolsChars).toBe(0);
    expect(b.msg0Chars).toBe(0);
    expect(b.topTools).toEqual([{ name: 'unknown', chars: 0 }]);
  });

  it('reads the OpenAI function-tool name shape too', () => {
    const b = buildPromptBreakdown({
      system: '',
      providerTools: [{ type: 'function', function: { name: 'search', parameters: {} } }],
      history: [],
    });
    expect(b.topTools[0].name).toBe('search');
  });
});
