import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateToolArgs, formatToolArgIssues } from '../tool-arg-validate.js';

const schema = z.object({
  path: z.string(),
  limit: z.number().optional(),
  mode: z.enum(['read', 'write']).optional(),
});

describe('validateToolArgs', () => {
  it('accepts a valid call', () => {
    expect(validateToolArgs({ path: '/a', limit: 3 }, schema)).toEqual({ ok: true });
  });
  it('refuses a missing required field and names the path', () => {
    const r = validateToolArgs({ limit: 3 }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/^path: /);
  });
  it('refuses a wrong type and an enum typo, capped at 5 issues', () => {
    const r = validateToolArgs({ path: 1, limit: 'x', mode: 'delete' }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeLessThanOrEqual(5);
      expect(r.issues.join(' ')).toMatch(/path/);
      expect(r.issues.join(' ')).toMatch(/mode/);
    }
  });
  it('tolerates null for an optional field (models send null; tools already handle it)', () => {
    expect(validateToolArgs({ path: '/a', limit: null, mode: null }, schema)).toEqual({ ok: true });
  });
  it('ignores unknown keys (Zod object default) — validate-only, no stripping of the call', () => {
    expect(validateToolArgs({ path: '/a', extra: 1 }, schema)).toEqual({ ok: true });
  });
  it('passes JSON-Schema parameters (MCP tools) through untouched', () => {
    expect(validateToolArgs({ anything: true }, { type: 'object', properties: {} })).toEqual({ ok: true });
    expect(validateToolArgs({ anything: true }, undefined)).toEqual({ ok: true });
  });
  it('a throwing schema is the schema\'s bug, not the call\'s', () => {
    const broken = { safeParse: () => { throw new Error('boom'); } };
    expect(validateToolArgs({}, broken)).toEqual({ ok: true });
  });
});

describe('formatToolArgIssues', () => {
  it('names the tool, lists the issues, tells the model what to do', () => {
    const text = formatToolArgIssues('Read', ['path: Required', 'limit: Expected number']);
    expect(text).toBe('Invalid arguments for Read: path: Required; limit: Expected number. Fix the arguments and call the tool again.');
  });
});

describe('validateToolArgs — a safeParse that returns a non-result', () => {
  it('is the schema\'s bug too: never refuses, never throws', () => {
    expect(validateToolArgs({}, { safeParse: () => undefined })).toEqual({ ok: true });
    expect(validateToolArgs({}, { safeParse: () => ({}) })).toEqual({ ok: true });
  });
});
