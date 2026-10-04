// tools/code-exec/tool-bridge-server.ts
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeEndpoint } from '../../ports/execution-environment-port.js';

export interface BridgeDispatchResult {
  ok: boolean;
  text: string;
  error?: string;
  /** Set on the maxCalls denial so a caller (e.g. the Weave prelude) can distinguish
   *  "call budget exhausted" from an ordinary tool error and surface it (no silent caps). */
  capExhausted?: boolean;
  /** P3 (durable Weave pause) — the dispatched node PAUSED for human approval: the
   *  Weave prelude halts the script (WeavePauseSignal) instead of null-dropping the
   *  node. `pending` is a compact copy of the host-captured pending-leaf identity so
   *  the marker line is self-describing; the HOST run state stays authoritative for
   *  the durable interaction (a script cannot forge a pause into a real interaction). */
  paused?: boolean;
  pending?: { toolName: string; contentHash: string; nodeLabel: string };
}
export interface ToolBridgeOptions {
  whitelist: string[];
  dispatch: (tool: string, args: unknown) => Promise<BridgeDispatchResult>;
  maxCalls?: number;
}

const DEFAULT_MAX_CALLS = 50;

export class ToolBridgeServer {
  private server: Server | undefined;
  private dir: string | undefined;
  private readonly token = randomBytes(24).toString('hex');
  private calls = 0;
  private readonly maxCalls: number;
  constructor(private readonly opts: ToolBridgeOptions) {
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  }

  async listen(): Promise<BridgeEndpoint> {
    // AF_UNIX path must stay under 104 bytes (macOS limit).
    // Use /tmp directly to avoid long macOS tmpdir paths like /var/folders/...
    this.dir = await mkdtemp('/tmp/vb-');
    const address = join(this.dir, 'b.sock');
    this.server = createServer((sock) => this.onConn(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(address, resolve);
    });
    return { kind: 'uds', address, token: this.token };
  }

  private onConn(sock: Socket): void {
    // A multibyte UTF-8 char can straddle two TCP chunks; decoding each chunk
    // independently (Buffer.toString()) would corrupt it silently. StringDecoder
    // holds back the incomplete tail byte(s) until the next chunk completes them.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    sock.on('data', async (d) => {
      buf += decoder.write(d as Buffer);
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = '';
      const reply = (r: BridgeDispatchResult) => sock.end(JSON.stringify(r) + '\n');
      let req: { token?: string; tool?: string; args?: unknown };
      try { req = JSON.parse(line); } catch { reply({ ok: false, text: '', error: 'bad request json' }); return; }
      if (req.token !== this.token) { reply({ ok: false, text: '', error: 'auth failed' }); return; }
      if (!req.tool || !this.opts.whitelist.includes(req.tool)) { reply({ ok: false, text: '', error: `tool '${req.tool}' not available in code` }); return; }
      if (this.calls >= this.maxCalls) { reply({ ok: false, text: '', error: `in-code tool-call budget (${this.maxCalls}) exhausted`, capExhausted: true }); return; }
      this.calls += 1;
      try { reply(await this.opts.dispatch(req.tool, req.args ?? {})); }
      catch (e) { reply({ ok: false, text: '', error: e instanceof Error ? e.message : String(e) }); }
    });
    sock.on('error', () => { /* client gone; ignore */ });
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((res) => this.server!.close(() => res()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.server = undefined; this.dir = undefined;
  }
}
