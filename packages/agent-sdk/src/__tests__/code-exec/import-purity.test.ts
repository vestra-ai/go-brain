// import-purity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..'); // packages/agent-sdk/src
const FILES = [
  'ports/execution-environment-port.ts',
  'tools/code-exec/index.ts',
  'tools/code-exec/local-subprocess-environment.ts',
  'tools/code-exec/docker-environment.ts',
  'tools/code-exec/scrub-env.ts',
  'tools/code-exec/stub-generator.ts',
  'tools/code-exec/tool-bridge-server.ts',
  'tools/code-exec/execute-code-tool.ts',
];

describe('code-exec SDK purity', () => {
  for (const rel of FILES) {
    it(`${rel} has no @bash/*, process.env, or Blaxel reference`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).not.toMatch(/from\s+['"]@bash\//);
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/blaxel/i);
    });
  }
});
