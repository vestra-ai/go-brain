// stub-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateStub, FN_NAME_BY_TOOL } from '../../tools/code-exec/stub-generator.js';

describe('generateStub', () => {
  const bridge = { kind: 'uds' as const, address: '/tmp/s.sock', token: 'NONCE' };

  it('maps tool names to idiomatic fn names', () => {
    expect(FN_NAME_BY_TOOL.WebSearch).toBe('web_search');
    expect(FN_NAME_BY_TOOL.Bash).toBe('run');
  });

  it('python stub defines a fn per whitelisted tool and embeds the token + socket', () => {
    const src = generateStub('python', ['WebSearch', 'Read'], bridge);
    expect(src).toContain('def web_search(');
    expect(src).toContain('def read_file(');
    expect(src).toContain('NONCE');
    expect(src).toContain('/tmp/s.sock');
    expect(src).not.toContain('def run(');         // Bash not in whitelist here
  });

  it('node stub defines a fn per whitelisted tool', () => {
    const src = generateStub('node', ['WebSearch', 'Bash'], bridge);
    expect(src).toContain('function web_search(');
    expect(src).toContain('function run(');
  });

  it('node header uses ESM imports (snippets run as .mjs — top-level require would throw)', () => {
    const src = generateStub('node', ['WebSearch'], bridge);
    // The header (everything before the inline _CLIENT helper) must be ESM.
    const header = src.slice(0, src.indexOf('const _CLIENT'));
    expect(header).toContain("import { execFileSync as _execSync } from 'node:child_process';");
    // No top-level CommonJS require in the header (the _CLIENT helper, which runs
    // via `node -e` as CommonJS, legitimately keeps its own require()).
    expect(header).not.toMatch(/\brequire\(/);
  });
});
