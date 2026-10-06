import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('railway.json', () => {
  it('gives a stopping copy time to finish its turns: SIGKILL comes at least 25 s after SIGTERM', () => {
    const cfg = JSON.parse(readFileSync(new URL('../../railway.json', import.meta.url), 'utf8')) as { deploy: { drainingSeconds?: number } };
    // A composer turn runs at most 20 s, and shutdown waits for the running ones (desk.stop) before the process exits.
    expect(cfg.deploy.drainingSeconds).toBeGreaterThanOrEqual(25);
  });
});
