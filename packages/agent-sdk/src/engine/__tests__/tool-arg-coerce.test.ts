/**
 * tool-arg-coerce — model-agnostic tool-arg normalization.
 *
 * The load-bearing property: open models (DeepSeek/GLM via Fireworks) send a nested
 * object/array param as a STRINGIFIED JSON value; the dispatcher must coerce it to the
 * object the tool's Zod schema declares, while leaving the Anthropic object path and
 * every genuine string byte-identical. Schemas are built with the real (zod 4) `z` so
 * the `_def` duck-typing is exercised against the actual runtime shape.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { coerceStringifiedToolArgs } from '../tool-arg-coerce.js';

// mcp_invoke's real shape.
const mcpInvoke = z.object({
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).nullable().optional(),
});

describe('coerceStringifiedToolArgs', () => {
  it('coerces a stringified record arg (the flash/deepseek mcp_invoke break)', () => {
    const out = coerceStringifiedToolArgs(
      { server: 'filesystem', tool: 'list_directory', args: '{"path": "/app/workspace"}' },
      mcpInvoke,
    ) as Record<string, unknown>;
    expect(out.args).toEqual({ path: '/app/workspace' });
    expect(out.server).toBe('filesystem'); // string fields untouched
  });

  it('leaves an already-object arg untouched and returns the SAME reference (Anthropic path)', () => {
    const input = { server: 'filesystem', tool: 'list_directory', args: { path: '/app/workspace' } };
    const out = coerceStringifiedToolArgs(input, mcpInvoke);
    expect(out).toBe(input); // byte-identical: no clone when nothing coerced
  });

  it('coerces a stringified array field', () => {
    const schema = z.object({ urls: z.array(z.string()).nullable().optional() });
    const out = coerceStringifiedToolArgs({ urls: '["https://a.com","https://b.com"]' }, schema) as Record<string, unknown>;
    expect(out.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('coerces a stringified nested object field', () => {
    const schema = z.object({ budget: z.object({ usd: z.number() }) });
    const out = coerceStringifiedToolArgs({ budget: '{"usd": 5}' }, schema) as Record<string, unknown>;
    expect(out.budget).toEqual({ usd: 5 });
  });

  it('leaves a genuinely-string field alone', () => {
    const schema = z.object({ command: z.string(), path: z.string() });
    const input = { command: 'ls -la', path: '/app' };
    expect(coerceStringifiedToolArgs(input, schema)).toBe(input);
  });

  it('leaves a non-JSON string in a structured slot alone (tool errors clearly, we do not mask)', () => {
    const input = { server: 's', tool: 't', args: 'not json at all' };
    expect(coerceStringifiedToolArgs(input, mcpInvoke)).toBe(input);
  });

  it('does not coerce when the parsed kind mismatches the schema (array string for a record slot)', () => {
    const input = { server: 's', tool: 't', args: '[1,2,3]' };
    const out = coerceStringifiedToolArgs(input, mcpInvoke) as Record<string, unknown>;
    expect(out.args).toBe('[1,2,3]'); // record slot + parsed array ⇒ left as-is
  });

  it('ignores fields not present in the schema', () => {
    const schema = z.object({ known: z.string() });
    const input = { known: 'x', extra: '{"a":1}' };
    const out = coerceStringifiedToolArgs(input, schema) as Record<string, unknown>;
    expect(out.extra).toBe('{"a":1}'); // no schema entry ⇒ untouched
  });

  it('returns non-object / null input unchanged', () => {
    expect(coerceStringifiedToolArgs(null, mcpInvoke)).toBe(null);
    expect(coerceStringifiedToolArgs('hi', mcpInvoke)).toBe('hi');
    expect(coerceStringifiedToolArgs(42, mcpInvoke)).toBe(42);
  });

  it('is inert when parameters is not a zod object', () => {
    const input = { args: '{"path":"/x"}' };
    expect(coerceStringifiedToolArgs(input, undefined)).toBe(input);
    expect(coerceStringifiedToolArgs(input, z.string())).toBe(input);
  });
});
