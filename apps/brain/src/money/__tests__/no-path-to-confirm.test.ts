import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Go's own source files (apps/brain/src), tests left out. */
const SRC = fileURLToPath(new URL('../../', import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}
const code = walk(SRC).map((path) => ({ path: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
const where = (test: (f: { path: string; text: string }) => boolean) => code.filter(test).map((f) => f.path).sort();

describe('no path to a payment except the two keys', () => {
  it('reads the money lane', () => {
    expect(code.map((f) => f.path)).toContain('money/finish.ts');
  });

  it('only the vault callback path confirms a booking with the travel layer', () => {
    expect(where((f) => !f.path.startsWith('travel/') && /\.confirm\(/.test(f.text))).toEqual(['money/finish.ts']);
  });

  it('only ask_to_pay holds an offer', () => {
    expect(where((f) => !f.path.startsWith('travel/') && /\.hold\(/.test(f.text))).toEqual(['money/ask.ts']);
  });

  it('only money asks the Server for a spend approval', () => {
    expect(where((f) => /request\(\s*'request_spend_approval'/.test(f.text))).toEqual(['money/ask.ts']);
  });

  it('Go holds no rail and no processor: nothing imports one or charges a card', () => {
    expect(where((f) => /from 'stripe'|paymentIntents|\.charge\(/.test(f.text))).toEqual([]);
  });

  it("the trip's computer and Go's MCP server cannot reach money", () => {
    expect(
      where((f) => (f.path.startsWith('mcp/') || f.path.startsWith('tasks/')) && /money\/|askToPay|ask_to_pay|request_spend_approval|\.hold\(|\.confirm\(/.test(f.text)),
    ).toEqual([]);
  });
});
