// Health checks for the operator's desk. Each check gets 1.5 s: a slow answer is amber, a failure or no answer is red.
// Every check takes its fetch from outside, so the tests run offline.
import type { Brain } from '../app.js';
import type { Env } from '../env.js';
import { NOT_DEPLOYED, type AdminLanes } from './lanes.js';

export type Dot = 'green' | 'amber' | 'red';

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
  /** Reachable but not ready yet, such as a trip's computer that is still waking. */
  degraded?: boolean;
}

export interface Probe {
  name: string;
  label: string;
  run(signal: AbortSignal): Promise<ProbeOutcome>;
}

export interface ProbeResult {
  name: string;
  label: string;
  dot: Dot;
  ms: number;
  detail: string;
}

export const PROBE_TIMEOUT_MS = 1_500;
/** Slower than this is amber: it works, but people would notice on stage. */
export const SLOW_MS = 750;

export interface ProbeTiming {
  timeoutMs?: number;
  slowMs?: number;
}

type Fetch = typeof fetch;
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export async function runProbe(p: Probe, t: ProbeTiming = {}): Promise<ProbeResult> {
  const timeoutMs = t.timeoutMs ?? PROBE_TIMEOUT_MS;
  const slowMs = t.slowMs ?? SLOW_MS;
  const ctrl = new AbortController();
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      // 'late' first: aborting runs the check's abort listeners at once, and a check that rejects on abort must not win.
      resolve('late');
      ctrl.abort();
    }, timeoutMs);
  });
  const result = (dot: Dot, detail: string): ProbeResult => ({
    name: p.name, label: p.label, dot, ms: Math.round(performance.now() - started), detail: clip(detail),
  });
  try {
    const out = await Promise.race([p.run(ctrl.signal), late]);
    if (out === 'late') return result('red', `no answer in ${timeoutMs / 1000} s`);
    if (!out.ok) return result('red', out.detail);
    if (out.degraded) return result('amber', out.detail);
    return performance.now() - started > slowMs ? result('amber', `${out.detail}, slow`) : result('green', out.detail);
  } catch (e) {
    return result('red', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Every check at once: the page waits for the slowest, never for the sum. */
export function checkAll(probes: Probe[], t: ProbeTiming = {}): Promise<ProbeResult[]> {
  return Promise.all(probes.map((p) => runProbe(p, t)));
}

export function serverProbe(link: { isOpen(): boolean }): Probe {
  return {
    name: 'server',
    label: "The Server's socket",
    run: async () => (link.isOpen() ? { ok: true, detail: 'open' } : { ok: false, detail: 'no Server is connected to Go' }),
  };
}

export function jevProbe(env: Pick<Env, 'TYPESAFE_API_KEY' | 'TYPESAFE_BASE_URL'>, f: Fetch): Probe {
  return {
    name: 'jev',
    label: 'Jev, the quick read',
    async run(signal) {
      if (!env.TYPESAFE_API_KEY) return { ok: false, detail: 'TYPESAFE_API_KEY is not set' };
      // The same touch Go's keep-warm makes: any answer below 500 means the line is up.
      const res = await f(`${trimSlash(env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai')}/`, { redirect: 'manual', signal });
      return res.status < 500 ? { ok: true, detail: 'reachable' } : { ok: false, detail: `HTTP ${res.status}` };
    },
  };
}

export function v1Probe(
  env: Pick<Env, 'VESTRA_API_URL' | 'VESTRA_API_KEYS'>,
  f: Fetch,
  tripId: string | null,
  userIdFor: AdminLanes['v1UserIdFor'],
): Probe {
  return {
    name: 'v1',
    label: tripId ? "/v1 and this trip's computer" : '/v1',
    async run(signal) {
      const user = tripId && userIdFor ? userIdFor(tripId) : null;
      if (tripId && !user) return { ok: false, detail: `trip computers are ${NOT_DEPLOYED}` };
      const key = env.VESTRA_API_KEYS?.split(',')[0]?.trim();
      if (!env.VESTRA_API_URL || !key) return { ok: false, detail: 'VESTRA_API_URL or VESTRA_API_KEYS is not set' };
      const base = trimSlash(env.VESTRA_API_URL);
      const headers = { authorization: `Bearer ${key}` };
      if (!user) {
        const res = await f(`${base}/v1/users?limit=1`, { headers, signal });
        return res.ok ? { ok: true, detail: "reachable; pick a trip to check its computer" } : { ok: false, detail: `HTTP ${res.status}` };
      }
      // Warming is the check: 200 means the computer is up, 202 that it is waking. A warm spends no credits.
      const res = await f(`${base}/v1/users/${user}/warm`, { method: 'POST', headers, signal });
      if (res.status === 200) return { ok: true, detail: 'computer ready' };
      if (res.status === 202) return { ok: true, degraded: true, detail: 'computer waking, check again in a minute' };
      if (res.status === 404) return { ok: false, detail: 'this trip has no computer yet' };
      return { ok: false, detail: `HTTP ${res.status}` };
    },
  };
}

export function ixigoProbe(env: Pick<Env, 'IXIGO_MCP_URL' | 'IXIGO_MCP_TOKEN'>, list: AdminLanes['listIxigoTools']): Probe {
  return {
    name: 'ixigo',
    label: 'ixigo, tools listed',
    async run() {
      if (!list) return { ok: false, detail: `the ixigo connection is ${NOT_DEPLOYED}` };
      if (!env.IXIGO_MCP_URL) return { ok: false, detail: 'IXIGO_MCP_URL is not set' };
      const n = await list(env.IXIGO_MCP_URL, env.IXIGO_MCP_TOKEN);
      return n > 0 ? { ok: true, detail: `${n} tools` } : { ok: false, detail: 'no tools listed' };
    },
  };
}

export function vaultProbe(env: Pick<Env, 'VAULT_URL'>, f: Fetch): Probe {
  return {
    name: 'vault',
    label: "The vault's /health",
    async run(signal) {
      if (!env.VAULT_URL) return { ok: false, detail: 'VAULT_URL is not set' };
      const res = await f(`${trimSlash(env.VAULT_URL)}/health`, { signal });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      return body?.ok === true ? { ok: true, detail: 'up' } : { ok: false, detail: 'answered without ok' };
    },
  };
}

export function modelProbe(env: Pick<Env, 'ANTHROPIC_API_KEY'>, f: Fetch, base = 'https://api.anthropic.com'): Probe {
  return {
    name: 'model',
    label: 'The model API',
    async run(signal) {
      // Listing one model costs nothing and proves the key and the network.
      const res = await f(`${trimSlash(base)}/v1/models?limit=1`, {
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: 'the key was refused' };
      return res.ok ? { ok: true, detail: 'reachable' } : { ok: false, detail: `HTTP ${res.status}` };
    },
  };
}

/** The six rows on the page, in the order the operator reads them. */
export function defaultProbes(brain: Pick<Brain, 'env' | 'door'>, tripId: string | null, lanes: AdminLanes, f: Fetch = fetch): Probe[] {
  return [
    serverProbe(brain.door.link),
    jevProbe(brain.env, f),
    v1Probe(brain.env, f, tripId, lanes.v1UserIdFor),
    ixigoProbe(brain.env, lanes.listIxigoTools),
    vaultProbe(brain.env, f),
    modelProbe(brain.env, f),
  ];
}
