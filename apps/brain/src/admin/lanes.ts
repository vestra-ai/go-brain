// The helpers the admin page borrows from other lanes, read only (master interface note 9): P4's v1UserIdFor and
// createHttpMcpCaller, P6's loadCallsConfig and maskPhone. Tests pass their own, including none at all, which reads on
// the page as "not deployed on this Go yet".
import { loadCallsConfig, maskPhone } from '../calls/config.js';
import type { Env } from '../env.js';
import { v1UserIdFor } from '../tasks/computer.js';
import { createHttpMcpCaller } from '../travel/mcp-caller.js';

export const NOT_DEPLOYED = 'not deployed on this Go yet';

export interface AdminLanes {
  /** P4 (tasks/computer.ts): the /v1 user that holds a trip's computer. */
  v1UserIdFor: ((tripId: string) => string) | null;
  /** P4 (travel/mcp-caller.ts): lists ixigo's tools over MCP and closes the connection again. */
  listIxigoTools: ((url: string, token: string | undefined) => Promise<number>) | null;
  /** P6 (calls/config.ts): who Go may phone, and a number with its middle hidden. */
  calls: { allowlist(env: Env): Array<{ name: string | null; phone: string }>; maskPhone(phone: string): string } | null;
}

/** Lists ixigo's tools over MCP and closes the connection again. */
async function listIxigoTools(url: string, token: string | undefined): Promise<number> {
  const caller = createHttpMcpCaller({ url, name: 'go-admin-probe', ...(token ? { token } : {}) });
  try {
    return (await caller.listTools()).length;
  } finally {
    await caller.close();
  }
}

export const ADMIN_LANES: AdminLanes = {
  v1UserIdFor,
  listIxigoTools,
  calls: { allowlist: (env) => loadCallsConfig(env).allowlist, maskPhone },
};
