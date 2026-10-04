/**
 * K5-T3 — withMcpConnectRetry: the bounded MCP-connect retry, EXTRACTED from
 * native-harness.ts (buildPrologue's MCP_SETUP_ATTEMPTS loop) so both the per-turn
 * tool-list build AND the continue path's composio re-dispatch share one helper.
 *
 * A Composio MCP cold-wake hiccup ("-32001 Request timed out") must not fail the
 * operation outright — the remote MCP warms up on a retry (live-observed on staging:
 * a timed-out call succeeded ~15s later). 3 attempts with `attempt * 750ms` backoff.
 * A PERSISTENT failure (all attempts throw) rethrows — never silently swallowed. An
 * aborted signal rethrows immediately (no further spend).
 */
export interface McpRetryOptions {
  /** Total attempts before giving up (default 3, matching the original loop). */
  attempts?: number;
  /** Backoff base: delay before attempt N is `N * baseDelayMs` (default 750; 0 in tests). */
  baseDelayMs?: number;
  signal?: AbortSignal;
}

export async function withMcpConnectRetry<T>(fn: () => Promise<T>, opts: McpRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 750;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || opts.signal?.aborted) throw err;
      if (baseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, attempt * baseDelayMs));
    }
  }
}
