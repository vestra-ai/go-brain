// The helpers the admin page borrows from other lanes, read only (master interface note 9): P4's v1UserIdFor and
// createHttpMcpCaller, P6's loadCallsConfig and maskPhone. A lane that is not on this build yet reads on the page as
// "not deployed on this Go yet", and nothing here changes when it lands.
import type { Env } from '../env.js';

export const NOT_DEPLOYED = 'not deployed on this Go yet';

export interface AdminLanes {
  /** P4 (tasks/computer.ts): the /v1 user that holds a trip's computer. */
  v1UserIdFor: ((tripId: string) => string) | null;
  /** P4 (travel/mcp-caller.ts): lists ixigo's tools over MCP and closes the connection again. */
  listIxigoTools: ((url: string, token: string | undefined) => Promise<number>) | null;
  /** P6 (calls/config.ts): who Go may phone, and a number with its middle hidden. */
  calls: { allowlist(env: Env): Array<{ name: string | null; phone: string }>; maskPhone(phone: string): string } | null;
}

interface ComputerModule {
  v1UserIdFor?: (tripId: string) => string;
}
interface McpCallerModule {
  createHttpMcpCaller?: (o: { url: string; token?: string; name?: string }) => { listTools(): Promise<unknown[]>; close(): Promise<void> };
}
interface CallsModule {
  loadCallsConfig?: (env: Env) => { allowlist: Array<{ name: string | null; phone: string }> };
  maskPhone?: (phone: string) => string;
}

/** A lane's module, or null when that lane is not on this build. */
const optional = <T>(load: () => Promise<unknown>): Promise<T | null> => load().then((m) => m as T, () => null);

export async function loadAdminLanes(): Promise<AdminLanes> {
  const [computer, mcp, callsConfig] = await Promise.all([
    // @ts-ignore P4's file: not on every build yet, and then this lane reads as not deployed.
    optional<ComputerModule>(() => import('../tasks/computer.js')),
    // @ts-ignore P4's file: not on every build yet, and then this lane reads as not deployed.
    optional<McpCallerModule>(() => import('../travel/mcp-caller.js')),
    // @ts-ignore P6's file: not on every build yet, and then this lane reads as not deployed.
    optional<CallsModule>(() => import('../calls/config.js')),
  ]);
  const connect = mcp?.createHttpMcpCaller;
  const load = callsConfig?.loadCallsConfig;
  const mask = callsConfig?.maskPhone;
  return {
    v1UserIdFor: computer?.v1UserIdFor ?? null,
    listIxigoTools: connect
      ? async (url, token) => {
          const caller = connect({ url, name: 'go-admin-probe', ...(token ? { token } : {}) });
          try {
            return (await caller.listTools()).length;
          } finally {
            await caller.close();
          }
        }
      : null,
    calls: load && mask ? { allowlist: (env) => load(env).allowlist, maskPhone: mask } : null,
  };
}
