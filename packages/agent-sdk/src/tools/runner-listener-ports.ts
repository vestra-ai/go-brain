/**
 * The runner's own loopback listeners, by port: the exact catalog SHELL_EGRESS_V1=enforce refuses
 * on loopback (apps/sandbox egress-screen.ts). Every other loopback port is the person's (a dev
 * server, `python -m http.server`) and stays open. Each listener registers at its mint site, from
 * the port the OS actually bound, and is forgotten when it closes; a completeness test fails when a
 * runner file listens without registering. Process-wide by nature (one process, one set of sockets).
 */
const listeners = new Map<number, symbol>();

/** Returns this registration's token: only it can unregister the port, so a restart on the same port is never undone by the old server's late close. */
export function registerRunnerListener(port: number, name: string): symbol {
  const token = Symbol(name);
  listeners.set(port, token);
  return token;
}

export function unregisterRunnerListener(port: number, token: symbol): void {
  if (listeners.get(port) === token) listeners.delete(port);
}

export function runnerListenerPorts(): ReadonlySet<number> {
  return new Set(listeners.keys());
}

/** Register `server` once it is listening and forget it when it closes (http, net or ws servers). */
export function trackRunnerListener(
  server: { address(): unknown; once(event: 'listening' | 'close', listener: () => void): unknown },
  name: string,
): void {
  server.once('listening', () => {
    const port = (server.address() as { port?: unknown } | null)?.port;
    if (typeof port !== 'number') return;
    const token = registerRunnerListener(port, name);
    server.once('close', () => unregisterRunnerListener(port, token));
  });
}
