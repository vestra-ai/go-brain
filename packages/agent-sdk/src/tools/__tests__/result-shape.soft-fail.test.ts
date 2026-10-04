/**
 * T5 — a tool failure that used to come back as a plain string moves onto the error channel
 * only behind TOOL_RESULT_SHAPE_V1 (`softFail`, tools/result-shape.ts).
 *
 * Every converted site is driven through its real tool, flag off then on: off, the tool
 * returns today's plain words; on, `toolError(code, <the same words>)`. The move is behaviour,
 * not just bytes: inside execute_code the bridge answers an error result with `ok:false`, so
 * the script's function raises ToolError. Off, a loop over failing items carries on as it did;
 * on, the description tells the model to catch per item, and a script that does carries on.
 *
 * Revert proof: make softFail ignore the flag and every 'off' case fails on its plain string
 * (and the execute_code 'carries on' case fails); route any site back to a plain string and its
 * 'on' case fails on the sentinel; drop the maxBuffer check and searchFailureCode's too_large
 * case fails; drop the guard's typed errors and the WebFetch permission / timeout cases fail.
 * Drop the call's signal from fetchPage (either call site) or the abort-first reading on either
 * WebFetch path and the Stop cases fail on timeout / exec_failed; drop WebSearch's aborted
 * branch and its Stop case fails on exec_failed; route either shell-session wait (process read,
 * submit) back to a plain string and its 'on' case fails on the sentinel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { softFail } from '../result-shape.js';
import { toolError, parseToolErrorCode, type ToolErrorCode } from '../tool-types.js';
import { makeBashTool } from '../bash-tool.js';
import { makeReadTool } from '../read-tool.js';
import { makeWriteTool } from '../write-tool.js';
import { makeEditTool } from '../edit-tool.js';
import { makeGlobTool, searchFailureCode } from '../glob-tool.js';
import { makeGrepTool } from '../grep-tool.js';
import { makeWebSearchTool } from '../web-search-tool.js';
import { makeWebFetchTool, makeRawWebFetchTool } from '../web-fetch-tool.js';
import { makePatchTool } from '../patch-tool.js';
import { processToolOptions, makeProcessTool } from '../process-tool.js';
import { spawnBackground, killByTask } from '../process-registry.js';
import { makeExecuteCodeTool } from '../code-exec/execute-code-tool.js';
import { LocalSubprocessEnvironment } from '../code-exec/local-subprocess-environment.js';
import { makeInProcessDispatcher, inCodePause } from '../../engine/in-process-dispatcher.js';
import { gateAndDispatchTool } from '../../engine/tool-dispatcher.js';
import type { ExecutionEnvironment } from '../../ports/execution-environment-port.js';

const FLAG = 'TOOL_RESULT_SHAPE_V1';
afterEach(() => {
  delete process.env[FLAG];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Run `call` flag off then on: off is today's plain words, on is toolError(code, the same words). */
async function softFailsAs(code: ToolErrorCode, call: () => unknown): Promise<string> {
  delete process.env[FLAG];
  const off = await call();
  expect(typeof off).toBe('string');
  process.env[FLAG] = 'true';
  const on = await call();
  expect(on).toEqual(toolError(code, off as string));
  delete process.env[FLAG];
  return off as string;
}

const ws = (): string => mkdtempSync(join(tmpdir(), 't5-soft-'));

describe('softFail: the flag decides the channel, never the words', () => {
  it('soft fail: off, the plain words; on, the typed sentinel with the same words', () => {
    expect(softFail('exec_failed', 'boom')).toBe('boom');
    process.env[FLAG] = 'true';
    expect(softFail('exec_failed', 'boom')).toEqual(toolError('exec_failed', 'boom'));
  });
});

describe('softFail: every converted native site', () => {
  it('soft fail: Bash, Read, Write and Edit refusals and failures', async () => {
    const dir = ws();
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, '.ssh', 'id_rsa'), 'KEY');
    mkdirSync(join(dir, 'adir'));
    const get = () => dir;
    expect(await softFailsAs('permission', () => makeBashTool(get, 't5').execute({ command: 'rm -rf /' }, {})))
      .toMatch(/^Blocked dangerous command/);
    expect(await softFailsAs('permission', () => makeReadTool(get).execute({ file_path: '.ssh/id_rsa' }, {})))
      .toMatch(/^Blocked: reading/);
    expect(await softFailsAs('invalid_input', () => makeWriteTool(get).execute({ file_path: '../../escape.txt', content: 'x' }, {})))
      .toMatch(/escape|Bad path/i);
    expect(await softFailsAs('permission', () => makeWriteTool(get).execute({ file_path: '.ssh/id_rsa', content: 'x' }, {})))
      .toMatch(/^Blocked: writing/);
    // A target that is a directory: the write itself fails (EISDIR), a plain failure.
    expect(await softFailsAs('exec_failed', () => makeWriteTool(get).execute({ file_path: 'adir', content: 'x' }, {})))
      .toMatch(/^Could not write adir: /);
    expect(await softFailsAs('permission', () => makeEditTool(get).execute({ file_path: '.env', old_string: 'SECRET', new_string: 'X' }, {})))
      .toMatch(/^Blocked: editing/);
  });

  it('soft fail: Glob and Grep bad paths', async () => {
    const get = ws;
    expect(await softFailsAs('invalid_input', () => makeGlobTool(get).execute({ pattern: '*', path: '../../etc' }, {})))
      .toMatch(/escape|Bad path/i);
    expect(await softFailsAs('invalid_input', () => makeGrepTool(get).execute({ pattern: 'x', path: '../../etc' }, {})))
      .toMatch(/escape|Bad path/i);
  });

  it('soft fail: searchFailureCode: an output overflow is too_large (never a transient timeout), then abort, timeout, failure', () => {
    const idle = {};
    const aborted = { signal: AbortSignal.abort() };
    // Node kills the child on an overflow too (killed: true); the code decides first.
    expect(searchFailureCode(idle, { code: 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED', killed: true })).toBe('too_large');
    expect(searchFailureCode(aborted, { code: 'ABORT_ERR' })).toBe('aborted');
    expect(searchFailureCode(idle, { killed: true })).toBe('timeout');
    expect(searchFailureCode(idle, { code: 2 })).toBe('exec_failed');
  });

  it('soft fail: WebSearch: no query, nothing configured, a provider failure', async () => {
    const cfg = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
    expect(await softFailsAs('invalid_input', () => makeWebSearchTool('t', cfg).execute({ query: ' ' }, {})))
      .toBe('WebSearch error: no query provided.');
    expect(await softFailsAs('unavailable', () => makeWebSearchTool('t', () => ({})).execute({ query: 'q' }, {})))
      .toBe('WebSearch error: search is temporarily unavailable.');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    expect(await softFailsAs('exec_failed', () => makeWebSearchTool('t', cfg).execute({ query: 'q' }, {})))
      .toMatch(/^WebSearch error: /);
  });

  it('soft fail: WebFetch argument errors', async () => {
    const cfg = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
    expect(await softFailsAs('invalid_input', () => makeRawWebFetchTool().execute({}, {}))).toBe('WebFetch error: no url provided.');
    expect(await softFailsAs('invalid_input', () => makeRawWebFetchTool().execute({ url: 'ftp://x' }, {})))
      .toMatch(/only http\(s\) URLs are supported/);
    expect(await softFailsAs('invalid_input', () => makeWebFetchTool('t', cfg).execute({ urls: [] }, {})))
      .toBe('WebFetch error: no url provided.');
  });

  it("soft fail: a single WebFetch the guard refuses is permission; one that times out is timeout", async () => {
    // The guard is on by default: a host resolving to the metadata address is refused before any socket.
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    expect(await softFailsAs('permission', () => makeRawWebFetchTool().execute({ url: 'https://a.example' }, {})))
      .toMatch(/^WebFetch error: .* for https:\/\/a\.example$/);
    // A public host whose request runs out its timeout.
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    vi.spyOn(https, 'request').mockImplementation((() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      req.destroy = (e?: Error) => { if (e) queueMicrotask(() => req.emit('error', e)); };
      req.end = () => { queueMicrotask(() => req.emit('timeout')); };
      return req;
    }) as never);
    expect(await softFailsAs('timeout', () => makeRawWebFetchTool().execute({ url: 'https://b.example' }, {})))
      .toMatch(/^WebFetch error: timed out after \d+s for https:\/\/b\.example$/);
  });

  it('soft fail: Patch, each failure with the code for its kind', async () => {
    const dir = ws();
    writeFileSync(join(dir, 'a.ts'), 'real\n');
    const patch = (input: string) => () => makePatchTool(() => dir).execute({ input }, {});
    await softFailsAs('invalid_input', patch('*** Update File: x.ts\n*** End Patch'));
    await softFailsAs('not_found', patch('*** Delete File: gone.ts'));
    await softFailsAs('invalid_input', patch('*** Add File: ../escape.txt\n+pwn'));
    await softFailsAs('permission', patch(['*** Add File: .env', '+SECRET=1'].join('\n')));
    await softFailsAs('invalid_input', patch('*** Add File: a.ts\n+x'));
    expect(await softFailsAs('exec_failed', patch(['*** Update File: a.ts', '@@', '-missing', '+x'].join('\n'))))
      .toMatch(/^\[patch failed: /);
  });

  it('soft fail: process: a missing id, an unknown action', async () => {
    await softFailsAs('invalid_input', () => processToolOptions.execute({ action: 'read' }, {}));
    expect(await softFailsAs('invalid_input', () => processToolOptions.execute({ action: 'frobnicate', id: 'bg_x' }, {})))
      .toMatch(/unknown action/);
  });

  it('soft fail: process in a shell session (SHELL_SESSION_V1): a Stop cutting a wait is aborted', async () => {
    vi.stubEnv('SHELL_SESSION_V1', 'true');
    const owner = 't5-session';
    const id = spawnBackground('sleep 5', owner, ws());
    try {
      const proc = makeProcessTool(owner);
      const stopped = { signal: AbortSignal.abort() };
      expect(await softFailsAs('aborted', () => proc.execute({ action: 'read', id, block: true }, stopped)))
        .toBe(`process: read aborted for ${id}`);
      // The input went in; the Stop cut the wait for its reply.
      expect(await softFailsAs('aborted', () => proc.execute({ action: 'submit', id, data: 'x' }, stopped)))
        .toBe(`Submitted input to ${id}\nprocess: wait aborted for ${id}`);
    } finally {
      killByTask(owner);
    }
  });
});

// ── execute_code: its own failures, and a tool failing INSIDE a script ───────

const fakeEnv = (res: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>): ExecutionEnvironment => ({
  async run() { return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...res }; },
});

/** One in-code tool call over the live bridge, mapped to stdout/exit the way the generated
 *  stub does: ok -> its text on stdout; not ok -> an uncaught ToolError, exit 1. */
function bridgeCallingEnv(tool: string, toolArgs: unknown): ExecutionEnvironment {
  return {
    async run(req) {
      const ep = req.bridge;
      const reply = await new Promise<{ ok: boolean; text?: string; error?: string }>((resolve, reject) => {
        const c = connect(ep.address);
        let b = '';
        c.on('connect', () => c.write(JSON.stringify({ token: ep.token, tool, args: toolArgs }) + '\n'));
        c.on('data', (d) => { b += d; if (b.endsWith('\n')) { c.end(); resolve(JSON.parse(b)); } });
        c.on('error', reject);
      });
      if (!reply.ok) return { stdout: '', stderr: `Traceback (most recent call last):\nToolError: ${reply.error}`, exitCode: 1, timedOut: false };
      return { stdout: reply.text ?? '', stderr: '', exitCode: 0, timedOut: false };
    },
  };
}

/** The in-code re-entry exactly as the loop builds it: the real dispatcher, the taxonomy on.
 *  Glob (not an untrusted-content tool, so no fence muddies the words) over a fresh workspace. */
const inCode = () => {
  const dir = ws();
  return {
    dispatchInProcessTool: makeInProcessDispatcher({
      tools: [makeGlobTool(() => dir)],
      harness: { gateTool: async () => ({ decision: 'allow' as const }) },
      onPause: inCodePause, onAuthHalt: undefined, execCtx: { toolErrorTaxonomy: true },
    }),
  };
};
/** A Glob call the workspace confinement refuses: a softFail('invalid_input') site. */
const BAD_GLOB = { pattern: '*', path: '../../etc' };

const BASE = { whitelist: ['Glob'], getCwd: () => process.cwd(), baseEnv: () => ({ PATH: process.env.PATH }) };
const has = (cmd: string): boolean => { try { execFileSync(cmd, ['--version']); return true; } catch { return false; } };

describe('softFail: execute_code', () => {
  it("soft fail: execute_code's own failures", async () => {
    const run = (env: ExecutionEnvironment, ctx: unknown) => () => makeExecuteCodeTool({ environment: env, ...BASE })
      .execute({ language: 'python', code: 'x' }, ctx as never);
    const ctx = { dispatchInProcessTool: async () => ({ toolUseId: 'x', text: 'x', isError: false }) };
    // No dispatcher is a failure of this call, not a transient outage (exec_failed, never unavailable).
    expect(await softFailsAs('exec_failed', run(fakeEnv({}), {}))).toBe('[execute_code unavailable: no in-process tool dispatcher]');
    expect(await softFailsAs('aborted', run(fakeEnv({}), { ...ctx, signal: AbortSignal.abort() }))).toBe('[code execution aborted]');
    expect(await softFailsAs('exec_failed', run(fakeEnv({ exitCode: 1, stderr: 'Traceback' }), ctx))).toMatch(/^\[code execution failed: exit 1\]/);
    expect(await softFailsAs('timeout', run(fakeEnv({ timedOut: true, exitCode: 124 }), ctx))).toMatch(/^\[code execution timed out\]/);
  });

  it('soft fail: the description tells the model to catch per item, only while the flag is on', () => {
    const off = makeExecuteCodeTool({ environment: fakeEnv({}), ...BASE }).description;
    process.env[FLAG] = 'true';
    const on = makeExecuteCodeTool({ environment: fakeEnv({}), ...BASE }).description;
    expect(off).not.toContain('ToolError');
    expect(on).toBe(`${off} Each function raises ToolError on failure; wrap per-item calls in try/except (Python) or try/catch (Node) to carry on past one.`);
  });

  it('soft fail: a tool failing inside a script: off, the script gets the words and carries on; on, its function raises ToolError', async () => {
    const run = () => makeExecuteCodeTool({ environment: bridgeCallingEnv('Glob', BAD_GLOB), ...BASE })
      .execute({ language: 'python', code: 'print(glob(pattern="*", path="../../etc"))' }, inCode() as never);
    // Off: the failure is a plain success to the bridge; the script printed it and went on.
    const off = await run();
    expect(typeof off).toBe('string');
    expect(off).toMatch(/escape|Bad path/i);
    // On: the bridge answers ok:false, the uncaught ToolError ends the run (a failed execute_code).
    process.env[FLAG] = 'true';
    expect(await run()).toEqual(toolError('exec_failed',
      `[code execution failed: exit 1]\nTraceback (most recent call last):\nToolError: ${off as string} [error:invalid_input]`));
  });

  it.skipIf(!has('python3'))('soft fail: on, a real script that catches per item, as the description says, carries on past every failure', async () => {
    process.env[FLAG] = 'true';
    const tool = makeExecuteCodeTool({ environment: new LocalSubprocessEnvironment(), ...BASE });
    const code = [
      'for p in ["../../etc", "../../var"]:',
      '    try:',
      '        print(glob(pattern="*", path=p))',
      '    except ToolError as e:',
      '        print("caught", "[error:invalid_input]" in str(e))',
      'print("done")',
    ].join('\n');
    const out = await tool.execute({ language: 'python', code }, inCode() as never);
    expect(out).toBe('caught True\ncaught True\ndone\n');
  }, 20_000);
});

/** A Stop that lands 30 ms into the call (the turn's Stop, an early start cancelled). */
const stopMidCall = (): { signal: AbortSignal } => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  return { signal: ac.signal };
};

/**
 * The guard's socket to a public host: it runs out its clock in 200 ms unless the request's own
 * signal aborts first. `onAbort` says how the abort lands: Node's AbortError on the socket, or a
 * timeout that fires in the same breath as the Stop (the race that must still read aborted).
 */
function hangingGuardSocket(onAbort: 'abort-error' | 'timeout-race'): void {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  vi.spyOn(https, 'request').mockImplementation(((_url: string, opts: { signal?: AbortSignal }) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.destroy = (e?: Error) => { if (e) queueMicrotask(() => req.emit('error', e)); };
    req.end = () => {
      const land = () => {
        if (onAbort === 'timeout-race') req.emit('timeout');
        else req.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      };
      if (opts.signal?.aborted) return land();
      const clock = setTimeout(() => req.emit('timeout'), 200);
      opts.signal?.addEventListener('abort', () => { clearTimeout(clock); land(); }, { once: true });
    };
    return req;
  }) as never);
}

/** The plain path's fetch (and the provider proxy's): a late 500 unless the request's signal aborts first. */
function slowFetch(): void {
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (init?.signal?.aborted) return abort();
    const late = setTimeout(() => resolve(new Response('late', { status: 500 })), 200);
    init?.signal?.addEventListener('abort', () => { clearTimeout(late); abort(); }, { once: true });
  })));
}

describe('softFail: a Stop mid-call is aborted, never a timeout', () => {
  it('soft fail: guard on, a single WebFetch cut by a Stop is aborted', async () => {
    hangingGuardSocket('abort-error');
    expect(await softFailsAs('aborted', () => makeRawWebFetchTool().execute({ url: 'https://c.example' }, stopMidCall())))
      .toBe('WebFetch error: The operation was aborted for https://c.example');
  });

  it('soft fail: guard on, a timeout racing the Stop still reads aborted', async () => {
    hangingGuardSocket('timeout-race');
    // The words stay the guard's own (today's bytes, flag off); only the code reads the signal.
    expect(await softFailsAs('aborted', () => makeRawWebFetchTool().execute({ url: 'https://c.example' }, stopMidCall())))
      .toMatch(/^WebFetch error: timed out after \d+s for https:\/\/c\.example$/);
  });

  it('soft fail: guard off, a single WebFetch cut by a Stop is aborted, from both factories', async () => {
    vi.stubEnv('VESTRA_WEBFETCH_GUARD', '0');
    slowFetch();
    expect(await softFailsAs('aborted', () => makeRawWebFetchTool().execute({ url: 'https://d.example' }, stopMidCall())))
      .toBe('WebFetch error: aborted for https://d.example');
    // The native factory: no provider configured, so the raw fallback carries the call's signal.
    expect(await softFailsAs('aborted', () => makeWebFetchTool('t', () => ({})).execute({ url: 'https://d.example' }, stopMidCall())))
      .toBe('WebFetch error: aborted for https://d.example');
  });

  it('soft fail: through the dispatcher, the Stop is stamped [error:aborted], never [error:timeout]', async () => {
    process.env[FLAG] = 'true';
    const pause = async () => 'PAUSED';
    for (const guard of ['1', '0']) {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      const allow = { gateTool: vi.fn(async () => ({ decision: 'allow' as const })) };
      vi.stubEnv('VESTRA_WEBFETCH_GUARD', guard);
      if (guard === '1') hangingGuardSocket('timeout-race');
      else slowFetch();
      const r = await gateAndDispatchTool(makeRawWebFetchTool(), { url: 'https://e.example' }, `tu-${guard}`, allow as never, pause, undefined,
        { toolErrorTaxonomy: true, ...stopMidCall() });
      expect(r.isError).toBe(true);
      expect(r.text.endsWith(' [error:aborted]')).toBe(true);
      expect(parseToolErrorCode(r.text)).toBe('aborted');
      expect(r.text).not.toContain('[error:timeout]');
    }
  });

  it('soft fail: a WebSearch cut by a Stop is aborted, not a plain failure', async () => {
    const cfg = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok', providerOrder: 'exa' });
    slowFetch();
    expect(await softFailsAs('aborted', () => makeWebSearchTool('t', cfg).execute({ query: 'q' }, stopMidCall())))
      .toMatch(/^WebSearch error: /);
  });
});
