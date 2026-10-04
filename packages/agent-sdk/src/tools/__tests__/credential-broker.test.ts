import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKER_LANES, WITHHELD_RUNNER_SECRETS } from '../credential-broker.js';
import { getSession, cleanupSession, setTaskExtraEnv } from '../terminal-session.js';
import { makeExecuteCodeTool } from '../code-exec/execute-code-tool.js';
import { EGRESS_PROXY_URL_ENV } from '../egress-proxy-env.js';

const run = promisify(execFile);
const SEED = mkdtempSync(join(tmpdir(), 'vbrk-seed-'));
const REAL = `real-sandbox-bearer.${'r'.repeat(40)}`;
const PLACEHOLDER = /^vbrk_[0-9a-f]{32}$/;
const FLAG = 'SHELL_CREDENTIAL_BROKER_V1';
/** A distinct live value for every withheld runner secret, plus a copy of one under an innocent name. */
const WITHHELD_VALUES = Object.fromEntries(Object.keys(WITHHELD_RUNNER_SECRETS).map((k) => [k, `${k.toLowerCase()}.${'s'.repeat(32)}`]));
const COPY = 'TURN_TOKEN_COPY_FOR_TEST';
const EGRESS_FLAG = 'SHELL_EGRESS_V1';
const KEYS = [FLAG, COPY, EGRESS_FLAG, EGRESS_PROXY_URL_ENV, ...Object.keys(WITHHELD_VALUES), ...BROKER_LANES.flatMap((l) => [l.baseVar, l.tokenVar])];

type Hit = { path: string; auth: string | undefined };
type Recorder = { url: string; hits: Hit[]; seen: Array<{ headers: IncomingHttpHeaders; body: string }>; server: Server };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function recorder(): Promise<Recorder> {
  const hits: Hit[] = [];
  const seen: Recorder['seen'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', auth: req.headers.authorization });
      seen.push({ headers: req.headers, body });
      res.end('ok');
    });
  });
  return { url: await listen(server), hits, seen, server };
}

/** One request straight to a broker's port, no pooled socket (a proxy-style absolute URL is allowed as `path`). */
function send(port: number, path: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, agent: false, method: body ? 'POST' : 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rawStatus = (port: number, path: string, auth: string) => send(port, path, { authorization: auth });
const portOf = (env: NodeJS.ProcessEnv) => Number(new URL(env.VESTRA_SERVER_URL!).port);

/** GET through a broker lane; resolves with every chunk as it arrived and whether the body completed. */
function streamThrough(url: string, onChunk: (n: number) => void): Promise<{ chunks: string[]; complete: boolean }> {
  return new Promise((resolve, reject) => {
    request(url, { agent: false }, (res: IncomingMessage) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => { chunks.push(c); onChunk(chunks.length); });
      res.on('error', () => {}); // a cut body surfaces as complete: false below
      res.on('close', () => resolve({ chunks, complete: res.complete }));
    }).on('error', reject).end();
  });
}

/** A real child process calling `url` with a bearer, exactly as a skill script's curl does. */
async function childFetch(env: NodeJS.ProcessEnv, url: string, bearer: string): Promise<string> {
  const js = 'fetch(process.argv[1],{headers:{authorization:"Bearer "+process.argv[2]}}).then(r=>r.text()).then(t=>process.stdout.write(t))';
  const { stdout } = await run(process.execPath, ['-e', js, url, bearer], { env });
  return stdout;
}

const owners: string[] = [];
const newOwner = (n: string) => { const id = `task_vbrk_${n}_${owners.length}`; owners.push(id); return id; };
const saved: Record<string, string | undefined> = {};
let api: Recorder;
let outside: Recorder;

function setRunnerEnv(flag: string | undefined): void {
  for (const k of KEYS) saved[k] ??= process.env[k] ?? '\0unset';
  if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
  for (const lane of BROKER_LANES) {
    process.env[lane.tokenVar] = REAL; // the runner holds ONE bearer under all seven names
    process.env[lane.baseVar] = lane.route === 'api' ? api.url : `${api.url}/api/proxy/${lane.route}/v1`;
  }
  Object.assign(process.env, WITHHELD_VALUES, { [COPY]: WITHHELD_VALUES.CF_TURN_API_TOKEN });
}

beforeAll(async () => { api = await recorder(); outside = await recorder(); });
afterAll(() => { api.server.close(); outside.server.close(); });
afterEach(() => {
  for (const id of owners.splice(0)) cleanupSession(id);
  for (const [k, v] of Object.entries(saved)) { if (v === '\0unset') delete process.env[k]; else process.env[k] = v; }
  for (const k of Object.keys(saved)) delete saved[k];
  api.hits.length = 0; api.seen.length = 0; outside.hits.length = 0;
});

const carriesReal = (env: Record<string, string | undefined>) => Object.entries(env).filter(([, v]) => v?.includes(REAL)).map(([k]) => k);
const SECRET_VALUES = [REAL, ...Object.values(WITHHELD_VALUES)];
const carriesSecret = (env: Record<string, string | undefined>) => Object.entries(env).filter(([, v]) => SECRET_VALUES.some((x) => v?.includes(x))).map(([k]) => k);

describe('credential broker (SHELL_CREDENTIAL_BROKER_V1)', () => {
  it('broker: child env never carries a real token', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('never'), SEED, { envCapture: true });
    await s.ready();
    const placeholder = s.broker!.placeholder;
    expect(placeholder).toMatch(PLACEHOLDER);

    const fg = s.buildExec('env');
    const bg = s.childEnv();
    for (const env of [fg.env, bg]) {
      expect(carriesReal(env)).toEqual([]);
      for (const lane of BROKER_LANES) expect(env[lane.tokenVar]).toBe(placeholder);
    }

    // A real shell through the real wrapper: `env` shows placeholders only.
    const { stdout } = await run(fg.file, fg.args, { env: fg.env, cwd: fg.cwd });
    expect(stdout).not.toContain(REAL);
    expect(stdout).toContain(`VESTRA_API_TOKEN=${placeholder}`);

    // execute_code's subprocess env is built from the same session.
    let codeEnv: Record<string, string | undefined> = {};
    const tool = makeExecuteCodeTool({
      environment: { async run(req) { codeEnv = req.env; return { stdout: '', stderr: '', exitCode: 0, timedOut: false }; } },
      whitelist: ['WebSearch'], getCwd: () => SEED, baseEnv: () => s.childEnv(),
    });
    await tool.execute({ language: 'python', code: 'print(1)' }, { dispatchInProcessTool: async () => ({ text: 'x', isError: false }) } as never);
    expect(Object.keys(codeEnv).length).toBeGreaterThan(0);
    expect(carriesReal(codeEnv)).toEqual([]);
  });

  it('broker: placeholder works against our API', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('works'), SEED);
    await s.ready();
    const env = s.childEnv();
    expect(env.VESTRA_SERVER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);

    expect(await childFetch(env, `${env.VESTRA_SERVER_URL}/api/routines?app=gmail`, env.VESTRA_API_TOKEN!)).toBe('ok');
    expect(api.hits).toEqual([{ path: '/api/routines?app=gmail', auth: `Bearer ${REAL}` }]);

    // A model lane keeps its base path; and a token refresh applies at once (read live).
    process.env.OPENAI_API_KEY = `${REAL}-refreshed`;
    expect(await childFetch(env, `${env.OPENAI_BASE_URL}/responses`, env.OPENAI_API_KEY!)).toBe('ok');
    expect(api.hits[1]).toEqual({ path: '/api/proxy/openai/v1/responses', auth: `Bearer ${REAL}-refreshed` });
  });

  it('broker: placeholder is useless elsewhere', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('useless'), SEED);
    await s.ready();
    const env = s.childEnv();
    const port = portOf(env);
    const bearer = `Bearer ${env.VESTRA_API_TOKEN}`;

    // Sent straight to an outside host, the placeholder is just a string.
    await childFetch(env, `${outside.url}/steal`, env.VESTRA_API_TOKEN!);
    expect(outside.hits).toEqual([{ path: '/steal', auth: `Bearer ${s.broker!.placeholder}` }]);

    // The loopback proxy never forwards anywhere but the runner's own lanes.
    expect(await rawStatus(port, `${outside.url}/steal`, bearer)).toBe(403); // used as an HTTP proxy
    expect(await rawStatus(port, '/elsewhere/steal', bearer)).toBe(404); // not a lane
    expect(await rawStatus(port, `/api@${new URL(outside.url).host}/steal`, bearer)).toBe(403); // host smuggle
    expect(await rawStatus(port, `/api:${new URL(outside.url).port}/steal`, bearer)).toBe(403); // port smuggle
    expect(outside.hits).toHaveLength(1);
    expect(api.hits).toEqual([]);
  });

  it('broker: swaps only in credential headers, never the body or any other header', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('exact'), SEED);
    await s.ready();
    const p = s.broker!.placeholder;
    const body = JSON.stringify({ note: p });
    expect(await send(portOf(s.childEnv()), '/api/echo', { authorization: `Bearer ${p}`, 'x-api-key': p, 'user-agent': p }, body)).toBe(200);
    const [{ headers, body: got }] = api.seen;
    expect(headers.authorization).toBe(`Bearer ${REAL}`);
    expect(headers['x-api-key']).toBe(REAL);
    expect(headers['user-agent']).toBe(p);
    expect(got).toBe(body);
  });

  it('broker: one session placeholder is useless on another session broker', async () => {
    setRunnerEnv('true');
    const a = getSession(newOwner('a'), SEED);
    const b = getSession(newOwner('b'), SEED);
    await a.ready();
    await b.ready();
    expect(await rawStatus(portOf(b.childEnv()), '/api/ping', `Bearer ${a.broker!.placeholder}`)).toBe(200);
    expect(api.hits).toEqual([{ path: '/ping', auth: `Bearer ${a.broker!.placeholder}` }]); // forwarded, never swapped
  });

  it('broker: a streamed response flows through as written, and an upstream that dies mid-body cuts it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      if (req.url?.endsWith('/die')) setTimeout(() => res.socket?.destroy(), 20);
      else void held.then(() => res.end('data: two\n\n'));
    });
    const upstreamUrl = await listen(upstream);
    setRunnerEnv('true');
    process.env.OPENAI_BASE_URL = upstreamUrl;
    const s = getSession(newOwner('stream'), SEED);
    await s.ready();
    const env = s.childEnv();
    // The upstream writes its second event only once the child HAS the first: a buffering proxy would hang here.
    const sse = await streamThrough(`${env.OPENAI_BASE_URL}/events`, (n) => { if (n === 1) release(); });
    expect(sse).toEqual({ chunks: ['data: one\n\n', 'data: two\n\n'], complete: true });
    const cut = await streamThrough(`${env.OPENAI_BASE_URL}/die`, () => {});
    expect(cut.complete).toBe(false);
    upstream.close();
  });

  it('broker: after cleanupSession the port refuses connections', async () => {
    setRunnerEnv('true');
    const id = newOwner('closed');
    const s = getSession(id, SEED);
    await s.ready();
    const port = portOf(s.childEnv());
    expect(await rawStatus(port, '/api/ping', 'none')).toBe(200);
    cleanupSession(id);
    await expect(rawStatus(port, '/api/ping', 'none')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('broker: loopback routes never persist into the captured shell env', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('capture'), SEED, { envCapture: true });
    await s.ready();
    const { file, args, env, cwd } = s.buildExec('true');
    await run(file, args, { env, cwd });
    s.captureEnv();
    // Whatever a host login profile adds may persist; nothing the broker set does.
    const persisted = existsSync(join(s.dir, 'env')) ? readFileSync(join(s.dir, 'env'), 'utf8') : '';
    expect(persisted).not.toMatch(/127\.0\.0\.1|vbrk_|_BASE_URL=|NO_PROXY=/i);
  });

  it('broker: a company variable named like a withheld secret keeps its own value', async () => {
    setRunnerEnv('true');
    const owner = newOwner('company');
    const own = `the-company-own-turn-token.${'o'.repeat(24)}`;
    setTaskExtraEnv(owner, { CF_TURN_API_TOKEN: own }); // Platform API L17: the company's variable
    const s = getSession(owner, SEED);
    await s.ready();
    expect(s.buildExec('env').env.CF_TURN_API_TOKEN).toBe(own);
    expect(s.childEnv().CF_TURN_API_TOKEN).toBe(own);
    expect(carriesSecret(s.childEnv())).toEqual([]); // and the runner's own value is still nowhere
  });

  it('broker: no runner secret reaches a child, brokered or withheld', async () => {
    setRunnerEnv('true');
    const s = getSession(newOwner('withheld'), SEED, { envCapture: true });
    await s.ready();
    const fg = s.buildExec('env');
    for (const env of [fg.env, s.childEnv()]) {
      expect(Object.keys(env).filter((k) => Object.hasOwn(WITHHELD_RUNNER_SECRETS, k))).toEqual([]);
      expect(carriesSecret(env)).toEqual([]); // not even a copy under another name
    }
    const { stdout } = await run(fg.file, fg.args, { env: fg.env, cwd: fg.cwd });
    expect(stdout).not.toContain('CF_TURN_API_TOKEN=');
    expect(SECRET_VALUES.filter((x) => stdout.includes(x))).toEqual([]);
  });

  it('broker + egress enforce: the loopback hop is not exempted from the egress proxy', async () => {
    setRunnerEnv('true');
    Object.assign(process.env, { [EGRESS_FLAG]: 'enforce', [EGRESS_PROXY_URL_ENV]: 'http://127.0.0.1:59999' });
    const s = getSession(newOwner('enforce'), SEED);
    await s.ready();
    const env = s.childEnv();
    // The enforce proxy refuses the runner's own listeners on loopback, so a blanket
    // NO_PROXY for 127.0.0.1 would let a command reach every one of them.
    expect([env.NO_PROXY, env.no_proxy]).toEqual([undefined, undefined]);
    expect(env.HTTP_PROXY).toMatch(/^http:\/\/task:/);
  });

  it('broker + egress shadow: the loopback NO_PROXY exemption is unchanged', async () => {
    setRunnerEnv('true');
    Object.assign(process.env, { [EGRESS_FLAG]: 'shadow', [EGRESS_PROXY_URL_ENV]: 'http://127.0.0.1:59999' });
    const s = getSession(newOwner('shadow'), SEED);
    await s.ready();
    expect([s.childEnv().NO_PROXY, s.childEnv().no_proxy]).toEqual(['127.0.0.1,localhost', '127.0.0.1,localhost']);
  });

  it('broker off: child env byte-identical', async () => {
    setRunnerEnv(undefined);
    const s = getSession(newOwner('off'), SEED);
    expect(s.broker).toBeUndefined();
    await s.ready();
    const { env } = s.buildExec('env');
    const expected = {
      ...process.env,
      VESTRA_CMD: 'env', VESTRA_CWD: SEED, VESTRA_WORKDIR: SEED, VESTRA_CWDFILE: join(s.dir, 'cwd'),
    };
    expect(Object.entries(env)).toEqual(Object.entries(expected)); // same keys, same order, same values
    expect(Object.entries(s.childEnv())).toEqual(Object.entries({ ...process.env }));
    expect(env.VESTRA_API_TOKEN).toBe(REAL); // today's behaviour, unchanged
    expect(env.CF_TURN_API_TOKEN).toBe(WITHHELD_VALUES.CF_TURN_API_TOKEN);
  });
});
