import { describe, it, expect } from 'vitest';
import { parseToolSpecifier, serializeToolSpecifier } from '../../index.js';

describe('serializeToolSpecifier', () => {
  it('round-trips through parseToolSpecifier', () => {
    for (const spec of [
      'Bash(npm run test:*)',
      'Read(//Users/x/file.txt)',
      'Write(/reports/*)',
      'mcp__composio__GMAIL_SEND_EMAIL',
      'WebFetch(domain:example.com)',
    ]) {
      expect(serializeToolSpecifier(parseToolSpecifier(spec))).toBe(spec);
    }
  });
  it('serializes a bare rule (no content) to the tool name alone', () => {
    expect(serializeToolSpecifier({ toolName: 'Read' })).toBe('Read');
    expect(serializeToolSpecifier({ toolName: 'Read', ruleContent: '' })).toBe('Read');
  });
});
