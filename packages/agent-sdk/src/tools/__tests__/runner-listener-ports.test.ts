import { describe, it, expect } from 'vitest';
import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerRunnerListener, unregisterRunnerListener, runnerListenerPorts, trackRunnerListener } from '../runner-listener-ports.js';

const listening = (server: ReturnType<typeof createServer>, port = 0) =>
  new Promise<number>((r) => server.listen(port, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

describe('runner listener catalog (SHELL_EGRESS_V1=enforce refuses exactly these on loopback)', () => {
  it('register and unregister by port, with the registration that owns it', () => {
    const token = registerRunnerListener(45123, 'test');
    expect(runnerListenerPorts().has(45123)).toBe(true);
    unregisterRunnerListener(45123, token);
    expect(runnerListenerPorts().has(45123)).toBe(false);
  });

  it('an older registration never removes a newer one on the same port', () => {
    const older = registerRunnerListener(45124, 'old');
    const newer = registerRunnerListener(45124, 'new');
    unregisterRunnerListener(45124, older);
    expect(runnerListenerPorts().has(45124)).toBe(true);
    unregisterRunnerListener(45124, newer);
    expect(runnerListenerPorts().has(45124)).toBe(false);
  });

  it('trackRunnerListener registers the port the OS bound once listening, and forgets it on close', async () => {
    const server = createServer();
    trackRunnerListener(server, 'test-server');
    const port = await listening(server);
    expect(runnerListenerPorts().has(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(runnerListenerPorts().has(port)).toBe(false);
  });

  it("a listener restarted on the same port before the old one's late close stays registered", async () => {
    // The old server holds a request in flight, so its 'close' fires only when that ends,
    // after the port is already free and a new server has bound it.
    let inFlight!: ServerResponse;
    let onArrive!: () => void;
    const arrived = new Promise<void>((r) => { onArrive = r; });
    const old = createServer((_req, res) => { inFlight = res; onArrive(); });
    trackRunnerListener(old, 'control');
    const port = await listening(old);
    request({ host: '127.0.0.1', port, agent: false }).on('error', () => {}).end();
    await arrived;
    const closed = new Promise<void>((r) => old.close(() => r()));
    const restarted = createServer();
    trackRunnerListener(restarted, 'control');
    await listening(restarted, port);
    inFlight.socket?.destroy(); // the old server's last connection ends: its late 'close' fires now
    await closed;
    expect(runnerListenerPorts().has(port)).toBe(true);
    await new Promise<void>((r) => restarted.close(() => r()));
    expect(runnerListenerPorts().has(port)).toBe(false);
  });
});
