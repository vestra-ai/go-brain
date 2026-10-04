/**
 * SHELL_EGRESS_V1 (W2 egress chokepoint) — child-env proxy injection, shadow and enforce.
 *
 * The screening proxy lives in apps/sandbox (which can import this package, not the
 * other way round), so the two ends of the contract cross the package boundary via
 * env vars, never an import:
 *   - apps/sandbox reads SHELL_EGRESS_V1; in 'shadow' or 'enforce' it starts the
 *     screening proxy and publishes its URL as VESTRA_EGRESS_PROXY_URL (EGRESS_PROXY_URL_ENV).
 *   - the SDK's Bash + code-exec child envs call egressProxyVars() to point outbound
 *     tool traffic at that proxy.
 *
 * FAIL-OPEN by construction: injection requires BOTH the flag ('shadow' | 'enforce') AND
 * a live proxy URL. Flag off, or proxy failed to start (no URL) ⇒ returns undefined ⇒
 * nothing injected ⇒ byte-identical child env. A missing proxy must leave egress
 * untouched, not point children at a dead port.
 *
 * 'enforce' (S3) makes the proxy refuse private, link-local/metadata, CGNAT and ULA
 * targets, and carries the owning task as the proxy's Basic credential `task:<id>` so a
 * refusal is logged under its task. Attribution only: the credential decides nothing.
 * The proxy is a layer, not the boundary: a child that ignores HTTP(S)_PROXY (a raw
 * socket, `--noproxy`) is not screened; the kernel layer is a separate lane.
 *
 * Reads process.env only — no @bash/* import (the engine reads no @bash/*).
 */

/** Env var the sandbox publishes the screening-proxy URL into; the SDK reads it here. */
export const EGRESS_PROXY_URL_ENV = 'VESTRA_EGRESS_PROXY_URL';

/** Flag env var (registered as SHELL_EGRESS_V1 in @bash/shared FLAG_REGISTRY). */
const SHELL_EGRESS_FLAG_ENV = 'SHELL_EGRESS_V1';

type Env = Record<string, string | undefined>;

/**
 * Proxy env vars to merge into a Bash / code-exec child env, or undefined when egress
 * routing is not active. Both cases of HTTP(S)_PROXY are set because different tools
 * read different casings (curl reads lowercase, node/others uppercase).
 */
export function egressProxyVars(env: Env = process.env, taskId?: string): Record<string, string> | undefined {
  const mode = shellEgressMode(env);
  if (mode === 'off') return undefined;
  const base = env[EGRESS_PROXY_URL_ENV];
  if (!base) return undefined;
  const url = mode === 'enforce' && taskId ? base.replace('://', `://task:${encodeURIComponent(taskId)}@`) : base;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url };
}

export type ShellEgressMode = 'off' | 'shadow' | 'enforce';

/**
 * The EFFECTIVE mode, the one rule both ends read (apps/sandbox starts the proxy in it; this
 * file shapes child envs by it). Exact strings; anything else is off (fail-safe). A desktop
 * runner (VESTRA_RUNNER_MODE=dial) runs enforce as shadow: the cloud box's private network
 * holds nothing of the person's, while their own machine's LAN and localhost do.
 */
export function shellEgressMode(env: Env = process.env): ShellEgressMode {
  const v = env[SHELL_EGRESS_FLAG_ENV];
  if (v === 'enforce') return env.VESTRA_RUNNER_MODE === 'dial' ? 'shadow' : 'enforce';
  return v === 'shadow' ? 'shadow' : 'off';
}

/** Enforce with a live proxy: children's loopback traffic must reach the proxy too (no NO_PROXY exemption). */
export function egressEnforced(env: Env = process.env): boolean {
  return shellEgressMode(env) === 'enforce' && !!env[EGRESS_PROXY_URL_ENV];
}
