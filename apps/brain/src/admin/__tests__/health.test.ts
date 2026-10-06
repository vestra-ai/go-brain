import { describe, expect, it } from 'vitest';
import { checkAll, ixigoProbe, jevProbe, modelProbe, PROBE_TIMEOUT_MS, runProbe, serverProbe, v1Probe, vaultProbe, type Probe } from '../health.js';
import { loadAdminLanes, NOT_DEPLOYED } from '../lanes.js';

/** Stands in for P4's v1UserIdFor. */
const v1UserIdFor = (tripId: string): string => `vu_${tripId}`;

const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const probe = (run: Probe['run']): Probe => ({ name: 'x', label: 'Something', run });

function fakeFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { f, calls };
}

describe('runProbe', () => {
  it('a quick, good answer is green, with the time it took', async () => {
    const r = await runProbe(probe(async () => ({ ok: true, detail: 'open' })));
    expect(r).toMatchObject({ name: 'x', label: 'Something', dot: 'green', detail: 'open' });
    expect(r.ms).toBeLessThan(100);
  });

  it('a slow answer is amber and says so', async () => {
    const r = await runProbe(probe(() => after(800, { ok: true, detail: 'reachable' })));
    expect(r).toMatchObject({ dot: 'amber', detail: 'reachable, slow' });
    expect(r.ms).toBeGreaterThanOrEqual(750);
  });

  it('reachable but not ready is amber', async () => {
    const r = await runProbe(probe(async () => ({ ok: true, degraded: true, detail: 'computer waking' })));
    expect(r).toMatchObject({ dot: 'amber', detail: 'computer waking' });
  });

  it('a failure is red with its reason, and so is a throw', async () => {
    expect(await runProbe(probe(async () => ({ ok: false, detail: 'HTTP 503' })))).toMatchObject({ dot: 'red', detail: 'HTTP 503' });
    const thrown = await runProbe(probe(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    }));
    expect(thrown).toMatchObject({ dot: 'red', detail: 'connect ECONNREFUSED 10.0.0.1:443' });
  });

  it('gives up at 1.5 s: red, and the check is told to stop', async () => {
    let aborted = false;
    const r = await runProbe(probe((signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    })));
    expect(PROBE_TIMEOUT_MS).toBe(1_500);
    expect(r).toMatchObject({ dot: 'red', detail: 'no answer in 1.5 s' });
    expect(r.ms).toBeGreaterThanOrEqual(1_450);
    expect(r.ms).toBeLessThan(2_000);
    expect(aborted).toBe(true);
  });

  it('runs every check at once, so the page waits for the slowest only', async () => {
    const started = Date.now();
    const rs = await checkAll([1, 2, 3].map(() => probe(() => after(300, { ok: true, detail: 'ok' }))));
    expect(rs.map((r) => r.dot)).toEqual(['green', 'green', 'green']);
    expect(Date.now() - started).toBeLessThan(800);
  });
});

describe('the checks', () => {
  it("the Server's socket: open is green, none is red", async () => {
    expect((await runProbe(serverProbe({ isOpen: () => true }))).dot).toBe('green');
    expect(await runProbe(serverProbe({ isOpen: () => false }))).toMatchObject({ dot: 'red', detail: 'no Server is connected to Go' });
  });

  it("/v1 warms the chosen trip's computer: ready is green, waking amber, no computer red", async () => {
    const first = `vk_test_${'a'.repeat(43)}`;
    const env = { VESTRA_API_URL: 'https://api.vestra.test/', VESTRA_API_KEYS: `${first},vk_test_${'b'.repeat(43)}` };
    for (const [status, dot] of [[200, 'green'], [202, 'amber'], [404, 'red'], [500, 'red']] as const) {
      const { f, calls } = fakeFetch(() => new Response('{}', { status }));
      expect((await runProbe(v1Probe(env, f, 't_goa', v1UserIdFor))).dot, String(status)).toBe(dot);
      expect(calls[0]?.url).toBe(`https://api.vestra.test/v1/users/${v1UserIdFor('t_goa')}/warm`);
      expect(calls[0]?.init?.method).toBe('POST');
      expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${first}`);
    }
    const listed = fakeFetch(() => new Response('{"data":[]}', { status: 200 }));
    expect((await runProbe(v1Probe(env, listed.f, null, v1UserIdFor))).dot).toBe('green');
    expect(listed.calls[0]?.url).toBe('https://api.vestra.test/v1/users?limit=1');
    expect(await runProbe(v1Probe({}, listed.f, 't_goa', v1UserIdFor))).toMatchObject({ dot: 'red', detail: 'VESTRA_API_URL or VESTRA_API_KEYS is not set' });
  });

  it("the vault's /health: ok is green, anything else red", async () => {
    const up = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect((await runProbe(vaultProbe({ VAULT_URL: 'https://vault.test' }, up.f))).dot).toBe('green');
    expect(up.calls[0]?.url).toBe('https://vault.test/health');
    const down = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    expect(await runProbe(vaultProbe({ VAULT_URL: 'https://vault.test' }, down.f))).toMatchObject({ dot: 'red', detail: 'HTTP 502' });
    expect(await runProbe(vaultProbe({}, down.f))).toMatchObject({ dot: 'red', detail: 'VAULT_URL is not set' });
  });

  it('the model API: lists one model with the key; a refused key is red', async () => {
    const ok = fakeFetch(() => new Response('{"data":[]}', { status: 200 }));
    expect((await runProbe(modelProbe({ ANTHROPIC_API_KEY: 'sk-test' }, ok.f, 'https://models.test'))).dot).toBe('green');
    expect(ok.calls[0]?.url).toBe('https://models.test/v1/models?limit=1');
    expect(new Headers(ok.calls[0]?.init?.headers).get('x-api-key')).toBe('sk-test');
    const refused = fakeFetch(() => new Response('{}', { status: 401 }));
    expect(await runProbe(modelProbe({ ANTHROPIC_API_KEY: 'sk-bad' }, refused.f, 'https://models.test'))).toMatchObject({ dot: 'red', detail: 'the key was refused' });
  });

  it('Jev: any answer below 500 means reachable; no key is red', async () => {
    const answered = fakeFetch(() => new Response('', { status: 404 }));
    expect((await runProbe(jevProbe({ TYPESAFE_API_KEY: 'ts-key' }, answered.f))).dot).toBe('green');
    expect(answered.calls[0]?.url).toBe('https://api.typesafe.ai/');
    const broken = fakeFetch(() => new Response('', { status: 502 }));
    expect(await runProbe(jevProbe({ TYPESAFE_API_KEY: 'ts-key', TYPESAFE_BASE_URL: 'https://jev.test' }, broken.f))).toMatchObject({ dot: 'red', detail: 'HTTP 502' });
    expect(await runProbe(jevProbe({}, broken.f))).toMatchObject({ dot: 'red', detail: 'TYPESAFE_API_KEY is not set' });
  });
});

describe('a lane that is not on this Go yet', () => {
  it('reads as not deployed, without a call: the trip computer and the ixigo connection', async () => {
    const { f, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    const env = { VESTRA_API_URL: 'https://api.vestra.test', VESTRA_API_KEYS: `vk_test_${'a'.repeat(43)}` };
    expect(await runProbe(v1Probe(env, f, 't_goa', null))).toMatchObject({ dot: 'red', detail: `trip computers are ${NOT_DEPLOYED}` });
    expect((await runProbe(v1Probe(env, f, null, null))).dot).toBe('green');
    expect(await runProbe(ixigoProbe({ IXIGO_MCP_URL: 'https://mcp.ixigo.test' }, null))).toMatchObject({
      dot: 'red', detail: `the ixigo connection is ${NOT_DEPLOYED}`,
    });
    expect(calls.map((c) => c.url)).toEqual(['https://api.vestra.test/v1/users?limit=1']);
  });

  it('loading the other lanes never throws: each helper is there or null', async () => {
    const lanes = await loadAdminLanes();
    expect(lanes.v1UserIdFor === null || typeof lanes.v1UserIdFor === 'function').toBe(true);
    expect(lanes.listIxigoTools === null || typeof lanes.listIxigoTools === 'function').toBe(true);
    expect(lanes.calls === null || typeof lanes.calls.maskPhone === 'function').toBe(true);
  });
});
