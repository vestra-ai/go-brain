// scrub-env.test.ts
import { describe, it, expect } from 'vitest';
import { scrubChildEnv, SECRET_SUBSTRINGS, SAFE_ENV_PREFIXES } from '../../tools/code-exec/scrub-env.js';

describe('scrubChildEnv', () => {
  it('drops secrets, keeps safe names, injects last', () => {
    const out = scrubChildEnv(
      { ANTHROPIC_API_KEY: 'sk', MY_TOKEN: 't', PATH: '/usr/bin', HOME: '/home/x', RANDOM: 'r' },
      { VESTRA_RPC_SOCKET: '/tmp/s.sock', PYTHONUTF8: '1' },
    );
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();   // secret substring KEY
    expect(out.MY_TOKEN).toBeUndefined();            // secret substring TOKEN
    expect(out.RANDOM).toBeUndefined();              // not on safe-prefix allowlist
    expect(out.PATH).toBe('/usr/bin');               // safe prefix
    expect(out.HOME).toBe('/home/x');                // safe prefix
    expect(out.VESTRA_RPC_SOCKET).toBe('/tmp/s.sock'); // injected
    expect(out.PYTHONUTF8).toBe('1');
  });

  it('exposes the rule constants', () => {
    expect(SECRET_SUBSTRINGS).toContain('KEY');
    expect(SAFE_ENV_PREFIXES).toContain('PATH');
  });
});
