import { describe, it, expect } from 'vitest';
import {
  COMPOSIO_TOOL_PREFIX,
  BROWSER_CONTROL_DENY_MESSAGE,
  isComposioMetaTool,
  extractToolkitFromToolName,
  checkDangerousBashCommand,
  checkSensitiveFile,
} from '../../index.js';

describe('engine constants (relocated into the SDK)', () => {
  it('exposes the composio tool prefix and a non-empty browser-control deny message', () => {
    expect(typeof COMPOSIO_TOOL_PREFIX).toBe('string');
    expect(COMPOSIO_TOOL_PREFIX.length).toBeGreaterThan(0);
    expect(typeof BROWSER_CONTROL_DENY_MESSAGE).toBe('string');
    expect(BROWSER_CONTROL_DENY_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('composio-naming helpers (relocated)', () => {
  it('extracts a toolkit from a composio tool name and detects meta tools', () => {
    expect(typeof isComposioMetaTool('SOMETHING')).toBe('boolean');
    expect(typeof extractToolkitFromToolName('GMAIL_SEND_EMAIL')).toBe('string');
  });
});

describe('security engine (relocated)', () => {
  it('flags a dangerous bash command and a sensitive file', () => {
    expect(checkDangerousBashCommand('rm -rf /').blocked).toBe(true);
    expect(checkDangerousBashCommand('ls -la').blocked).toBe(false);
    expect(checkSensitiveFile('/app/workspace/.env').blocked).toBe(true);
  });

  it('flags the same with SECURITY_PATTERNS_V2 on (the catalogs, not the regexes)', () => {
    process.env.SECURITY_PATTERNS_V2 = 'true';
    try {
      expect(checkDangerousBashCommand('rm -rf /')).toMatchObject({ blocked: true, pattern: 'catastrophic-target' });
      expect(checkDangerousBashCommand('ls -la').blocked).toBe(false);
    } finally {
      delete process.env.SECURITY_PATTERNS_V2;
    }
  });
});
