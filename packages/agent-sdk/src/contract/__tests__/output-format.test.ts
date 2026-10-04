import { describe, it, expect } from 'vitest';
import type { OutputFormat, JsonSchemaSubset, JsonSchemaNode } from '../../index.js';

describe('OutputFormat contract type', () => {
  it('admits a json_schema output format with a nested object schema', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 0 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    };
    const fmt: OutputFormat = { type: 'json_schema', schema, name: 'demo' };
    expect(fmt.type).toBe('json_schema');
    expect(fmt.name).toBe('demo');
    expect(fmt.schema.type).toBe('object');
  });

  it('name is optional', () => {
    const fmt: OutputFormat = {
      type: 'json_schema',
      schema: { type: 'object', additionalProperties: false, properties: {} },
    };
    expect(fmt.name).toBeUndefined();
  });

  it('a JsonSchemaNode admits anyOf branches', () => {
    const node: JsonSchemaNode = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    };
    expect(Array.isArray(node.anyOf)).toBe(true);
  });
});
