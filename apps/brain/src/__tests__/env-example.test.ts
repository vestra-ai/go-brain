import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Env } from '../env.js';

describe('.env.example', () => {
  it('names every variable Go reads, lane by lane', () => {
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const named = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    for (const key of Object.keys(Env.shape)) expect(named, key).toContain(key);
  });

  it('holds no secret values', () => {
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const key of ['GO_SIGNING_SECRET', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'VAULT_SHARED_SECRET', 'TWILIO_AUTH_TOKEN', 'OPENAI_API_KEY', 'ADMIN_TOKEN']) {
      expect(text).toMatch(new RegExp(`^#?\\s*${key}=\\s*(#.*)?$`, 'm'));
    }
  });
});
