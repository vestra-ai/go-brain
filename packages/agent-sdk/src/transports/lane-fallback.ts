/**
 * lane-fallback.ts — LANE_FALLBACK_V1 (harness to nine, LOOP): the second route to the same
 * provider, for a session whose model lane keeps failing.
 *
 * The model lanes ride the ai-proxy service (the server's AI_LANE_BASE_URL: `${lane}/api/proxy/…`)
 * while the API plane (VESTRA_SERVER_URL) still serves the very same credential-proxy routes
 * (apps/server registerProxyRoutes), with the same sandbox token. So when the lane's origin drops
 * connections or answers with bodyless 5xx (an edge answering for an ai-proxy that is briefly
 * gone), the same request has a second route: the same path on the API plane. Codex has the same
 * shape (core/src/client.rs force_http_fallback: WebSockets to HTTPS, once, for the session).
 *
 * The move is short-lived on purpose: the API plane is the deploy-kill seam the ai-proxy exists to
 * escape (every staging merge severs its streams), so a move holds for LANE_FALLBACK_HOLD_MS and
 * then requests go back to the lane (a lane that still fails moves again).
 *
 * Read from the URLs themselves (parsed, never pattern-matched) and from a per-provider
 * declaration: only one of our own proxy routes (`/api/proxy/…`), on an origin that differs from
 * the API plane's, for a provider the API plane serves, has a second route.
 */
import type { ModelProvider } from '../contract/model-capabilities.js';

const PROXY_PATH_PREFIX = '/api/proxy/';

/** How long a move to the second route holds before requests go back to the lane. */
export const LANE_FALLBACK_HOLD_MS = 5 * 60_000;

/**
 * Whether the API plane serves a provider's lane in every env (it holds that provider's key).
 * Declared per provider, never learned by trying: a route that answers "no key" would spend the
 * request's fresh budget on it and the person would have been told it switched. Exhaustive, so a
 * new provider has to say. Meta: staging's API plane holds no Meta key (checked 2026-10-02, key
 * names only); prod's does, and one declaration serves both. DeepSeek has no lane of its own.
 */
export const API_PLANE_SERVES: Readonly<Record<ModelProvider, boolean>> = {
  anthropic: true,
  openai: true,
  fireworks: true,
  google: true,
  xai: true,
  meta: false,
  deepseek: false,
};

/** The same proxy route on the API plane, or undefined when the lane has no second route. */
export function apiPlaneRoute(
  provider: ModelProvider,
  laneBase: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const plane = env.VESTRA_SERVER_URL;
  if (!API_PLANE_SERVES[provider] || !laneBase || !plane) return undefined;
  let lane: URL;
  let api: URL;
  try {
    lane = new URL(laneBase);
    api = new URL(plane);
  } catch {
    return undefined;
  }
  if (lane.origin === api.origin || !lane.pathname.startsWith(PROXY_PATH_PREFIX)) return undefined;
  return `${api.origin}${lane.pathname}${lane.search}`;
}

/** One lane's move to its second route: held until a deadline, then back to the lane. */
export class LaneMove {
  private route: string | undefined;
  private until = 0;

  /** The second route while the move holds; undefined on the lane (never moved, or lapsed). */
  current(now = Date.now()): string | undefined {
    if (this.route !== undefined && now >= this.until) this.route = undefined;
    return this.route;
  }

  /**
   * Move to `route` until `until` (default: the hold from now). False when there is no second
   * route or the move already holds (once per hold).
   */
  move(route: string | undefined, until?: number): boolean {
    const now = Date.now();
    if (route === undefined || this.current(now) !== undefined) return false;
    const deadline = until ?? now + LANE_FALLBACK_HOLD_MS;
    if (deadline <= now) return false;
    this.route = route;
    this.until = deadline;
    return true;
  }
}
