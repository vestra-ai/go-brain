// tool-bridge-server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { ToolBridgeServer } from '../../tools/code-exec/tool-bridge-server.js';

function rpc(sock: string, obj: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let b = '';
    c.on('connect', () => c.write(JSON.stringify(obj) + '\n'));
    c.on('data', (d) => { b += d; if (b.endsWith('\n')) { c.end(); resolve(JSON.parse(b)); } });
    c.on('error', reject);
  });
}

describe('ToolBridgeServer', () => {
  let server: ToolBridgeServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('dispatches an authenticated whitelisted call', async () => {
    server = new ToolBridgeServer({ whitelist: ['WebSearch'], dispatch: async (t, a) => ({ ok: true, text: `${t}:${JSON.stringify(a)}` }) });
    const ep = await server.listen();
    const r = await rpc(ep.address, { token: ep.token, tool: 'WebSearch', args: { query: 'q' } });
    expect(r).toEqual({ ok: true, text: 'WebSearch:{"query":"q"}' });
  });

  it('rejects a bad token', async () => {
    server = new ToolBridgeServer({ whitelist: ['WebSearch'], dispatch: async () => ({ ok: true, text: 'x' }) });
    const ep = await server.listen();
    const r = await rpc(ep.address, { token: 'WRONG', tool: 'WebSearch', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/auth/i);
  });

  it('rejects a non-whitelisted tool', async () => {
    server = new ToolBridgeServer({ whitelist: ['WebSearch'], dispatch: async () => ({ ok: true, text: 'x' }) });
    const ep = await server.listen();
    const r = await rpc(ep.address, { token: ep.token, tool: 'Bash', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not available/i);
  });

  it('reassembles a multibyte arg split across two TCP writes (no UTF-8 corruption)', async () => {
    let captured: unknown;
    server = new ToolBridgeServer({
      whitelist: ['WebSearch'],
      dispatch: async (_t, a) => { captured = a; return { ok: true, text: 'ok' }; },
    });
    const ep = await server.listen();

    const args = { query: 'café 日本語 😀 résumé' };
    const reqStr = JSON.stringify({ token: ep.token, tool: 'WebSearch', args }) + '\n';
    const full = Buffer.from(reqStr, 'utf8');
    // Split BEFORE the first UTF-8 continuation byte (0b10xxxxxx) so a multibyte
    // char is guaranteed to straddle the two chunks — the exact case that
    // `Buffer.toString()` per-chunk would corrupt.
    let splitAt = -1;
    for (let i = 1; i < full.length; i++) {
      if ((full[i] & 0xc0) === 0x80) { splitAt = i; break; }
    }
    expect(splitAt).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const c = connect(ep.address);
      let b = '';
      c.on('connect', () => {
        c.write(full.subarray(0, splitAt));
        // Force a SEPARATE data event for the tail so the split is real on the wire.
        setTimeout(() => c.write(full.subarray(splitAt)), 15);
      });
      c.on('data', (d) => { b += d; if (b.endsWith('\n')) { c.end(); resolve(); } });
      c.on('error', reject);
    });

    expect(captured).toEqual(args);
  });

  it('enforces maxCalls', async () => {
    server = new ToolBridgeServer({ whitelist: ['WebSearch'], maxCalls: 1, dispatch: async () => ({ ok: true, text: 'x' }) });
    const ep = await server.listen();
    await rpc(ep.address, { token: ep.token, tool: 'WebSearch', args: {} });
    const r = await rpc(ep.address, { token: ep.token, tool: 'WebSearch', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/budget|limit/i);
  });
});
