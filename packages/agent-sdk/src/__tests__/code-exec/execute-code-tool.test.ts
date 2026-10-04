import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { makeExecuteCodeTool } from '../../tools/code-exec/execute-code-tool.js';
import { scrubChildEnv } from '../../tools/code-exec/scrub-env.js';
import { FN_NAME_BY_TOOL } from '../../tools/code-exec/stub-generator.js';
import { LocalSubprocessEnvironment } from '../../tools/code-exec/local-subprocess-environment.js';
import type { ExecutionEnvironment } from '../../ports/execution-environment-port.js';

function has(cmd: string): boolean { try { execFileSync(cmd, ['--version']); return true; } catch { return false; } }

const fakeEnv = (
  res: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>,
): ExecutionEnvironment => ({
  async run() {
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...res };
  },
});
const ctx = { dispatchInProcessTool: async () => ({ text: 'x', isError: false }) } as any;

/**
 * An ExecutionEnvironment that does NOT spawn a real interpreter — it stands in
 * for the subprocess by making ONE in-code tool call over the live bridge (exactly
 * what a generated stub does), then maps the bridge reply to stdout/exit the way an
 * uncaught Python/Node ToolError would. Lets us exercise the bridge→dispatch wiring
 * (incl. the pausedHalt branch) with no python3/node dependency.
 */
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
      if (!reply.ok) {
        // Mimic an uncaught ToolError: the marker lands on stderr + a non-zero exit.
        return { stdout: '', stderr: `Traceback (most recent call last):\nToolError: ${reply.error}`, exitCode: 1, timedOut: false };
      }
      return { stdout: reply.text ?? '', stderr: '', exitCode: 0, timedOut: false };
    },
  };
}

describe('makeExecuteCodeTool', () => {
  const base = { whitelist: ['WebSearch'], getCwd: () => process.cwd(), baseEnv: () => ({ PATH: process.env.PATH }) };

  it('returns a STRING (the tool contract — dispatcher stringifies non-strings)', async () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ stdout: 'answer\n' }), ...base });
    const out = await tool.execute({ language: 'python', code: 'print("answer")' }, ctx);
    expect(typeof out).toBe('string');
  });

  it('returns printed stdout on success', async () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ stdout: 'answer\n' }), ...base });
    const out = (await tool.execute({ language: 'python', code: 'print("answer")' }, ctx)) as string;
    expect(out).toContain('answer');
    expect(out).not.toMatch(/failed|timed out|no output/i);
  });

  it('invokes baseEnv as a thunk, re-reading it once per execution', async () => {
    let calls = 0;
    const tool = makeExecuteCodeTool({
      environment: fakeEnv({ stdout: 'ok\n' }),
      whitelist: ['WebSearch'],
      getCwd: () => process.cwd(),
      baseEnv: () => {
        calls++;
        return { PATH: process.env.PATH };
      },
    });
    await tool.execute({ language: 'python', code: 'print("ok")' }, ctx);
    await tool.execute({ language: 'python', code: 'print("ok")' }, ctx);
    // Thunk is re-read each call (so a cwd/env that mutates between turns is honored),
    // not snapshotted once at factory time.
    expect(calls).toBe(2);
  });

  it('non-zero exit -> explicit failure marker + stderr in the text', async () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ exitCode: 1, stderr: 'Traceback...' }), ...base });
    const out = (await tool.execute({ language: 'python', code: 'boom' }, ctx)) as string;
    expect(out).toMatch(/code execution failed: exit 1/i);
    expect(out).toContain('Traceback');
  });

  it('timeout -> explicit marker', async () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ timedOut: true, exitCode: 124 }), ...base });
    const out = (await tool.execute({ language: 'python', code: 'sleep' }, ctx)) as string;
    expect(out).toMatch(/timed out/i);
  });

  it('empty success -> explicit sentinel', async () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ stdout: '', stderr: '' }), ...base });
    const out = (await tool.execute({ language: 'python', code: 'pass' }, ctx)) as string;
    expect(out).toMatch(/no output/i);
  });

  it('advertises every whitelisted tool fn name in the description (no drift — incl. edit)', () => {
    const whitelist = ['WebSearch', 'WebFetch', 'Read', 'Write', 'Grep', 'Glob', 'Bash', 'Edit'];
    const tool = makeExecuteCodeTool({
      environment: fakeEnv({}), whitelist, getCwd: () => process.cwd(), baseEnv: () => ({}),
    });
    for (const t of whitelist) {
      expect(tool.description).toContain(FN_NAME_BY_TOOL[t]);
    }
    // The previously-omitted companion to write_file must now be advertised.
    expect(tool.description).toContain('edit');
  });

  it('a pausedHalt in-code tool call surfaces "requires human approval" (never hangs)', async () => {
    const tool = makeExecuteCodeTool({
      environment: bridgeCallingEnv('WebSearch', { query: 'q' }),
      whitelist: ['WebSearch'], getCwd: () => process.cwd(), baseEnv: () => ({}),
    });
    const pausedCtx = {
      dispatchInProcessTool: async () => ({ text: '', isError: true, pausedHalt: true }),
    } as any;
    const out = (await tool.execute({ language: 'python', code: 'print(web_search(query="q"))' }, pausedCtx)) as string;
    expect(out).toMatch(/requires human approval/i);
    expect(out).toMatch(/code execution failed/i);
  });

  // ── Slice 2b Task 4: nested-call trace emission ──────────────────────────────
  // Each in-code tool call emits exactly ONE `kind:'raw'` `agent:nested_tool_call`
  // HarnessEvent on ctx.pushEvent (the PERMISSION_DENIED side-channel precedent):
  // trace-only, NO content block. It carries the NESTED call's own toolUseId
  // (distinct from the parent execute_code's ctx.toolCallId) so the
  // tool_calls(trace_id, tool_use_id) unique index never collides.
  it('emits exactly one nested-tool-call raw event per in-code call (parent + nested ids, durationMs)', async () => {
    const pushEvent = vi.fn();
    const tool = makeExecuteCodeTool({
      environment: bridgeCallingEnv('WebSearch', { query: 'q' }),
      whitelist: ['WebSearch'], getCwd: () => process.cwd(), baseEnv: () => ({}),
    });
    const traceCtx = {
      toolCallId: 'parent-123',
      pushEvent,
      dispatchInProcessTool: async () => ({ toolUseId: 'nested-abc', text: 'result', isError: false }),
    } as any;
    await tool.execute({ language: 'python', code: 'print(web_search(query="q"))' }, traceCtx);

    const nested = pushEvent.mock.calls
      .map((c: any) => c[0])
      .filter((e: any) => e.event === 'agent:nested_tool_call');
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({
      kind: 'raw',
      engine: 'native',
      event: 'agent:nested_tool_call',
      data: {
        parentToolUseId: 'parent-123',
        toolUseId: 'nested-abc',
        toolName: 'WebSearch',
        success: true,
      },
    });
    // The nested row's id is the in-code call's own id, NEVER the parent's.
    expect(nested[0].data.toolUseId).not.toBe('parent-123');
    expect(typeof nested[0].data.durationMs).toBe('number');
  });

  it('emits success:false on the pausedHalt / deny branch (mints an id when absent)', async () => {
    const pushEvent = vi.fn();
    const tool = makeExecuteCodeTool({
      environment: bridgeCallingEnv('WebSearch', { query: 'q' }),
      whitelist: ['WebSearch'], getCwd: () => process.cwd(), baseEnv: () => ({}),
    });
    const pausedCtx = {
      toolCallId: 'parent-x',
      pushEvent,
      dispatchInProcessTool: async () => ({ text: '', isError: true, pausedHalt: true }),
    } as any;
    await tool.execute({ language: 'python', code: 'print(web_search(query="q"))' }, pausedCtx);

    const nested = pushEvent.mock.calls
      .map((c: any) => c[0])
      .filter((e: any) => e.event === 'agent:nested_tool_call');
    expect(nested).toHaveLength(1);
    expect(nested[0].data.success).toBe(false);
    // No toolUseId on the dispatch result → a fresh one is minted (never the parent).
    expect(typeof nested[0].data.toolUseId).toBe('string');
    expect(nested[0].data.toolUseId).not.toBe('parent-x');
  });

  it('does NOT emit a nested event (and does not throw) when ctx.pushEvent is absent', async () => {
    const tool = makeExecuteCodeTool({
      environment: bridgeCallingEnv('WebSearch', { query: 'q' }),
      whitelist: ['WebSearch'], getCwd: () => process.cwd(), baseEnv: () => ({}),
    });
    const noPushCtx = {
      toolCallId: 'parent-np',
      dispatchInProcessTool: async () => ({ toolUseId: 'n1', text: 'r', isError: false }),
    } as any;
    // The optional-chain guard means an absent pushEvent is a total no-op, not a crash.
    const out = await tool.execute(
      { language: 'python', code: 'print(web_search(query="q"))' },
      noPushCtx,
    );
    expect(typeof out).toBe('string');
  });

  it('parameters is a zod object (Anthropic-safe)', () => {
    const tool = makeExecuteCodeTool({ environment: fakeEnv({}), ...base });
    expect(tool.parameters).toBeTruthy();
    expect(typeof (tool.parameters as any).safeParse).toBe('function');
  });

  it('short-circuits to the aborted marker when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const tool = makeExecuteCodeTool({ environment: fakeEnv({ stdout: 'should not run' }), ...base });
    const out = (await tool.execute(
      { language: 'python', code: 'print(1)' },
      { dispatchInProcessTool: async () => ({ text: '', isError: false }), signal: ac.signal } as any,
    )) as string;
    expect(out).toBe('[code execution aborted]');
    expect(out).not.toContain('should not run');
  });

  it.skipIf(!has('python3'))(
    'aborts the subprocess mid-run and surfaces an aborted marker promptly',
    async () => {
      const tool = makeExecuteCodeTool({
        environment: new LocalSubprocessEnvironment(),
        whitelist: [],
        getCwd: () => process.cwd(),
        baseEnv: () => ({ PATH: process.env.PATH }),
      });
      const ac = new AbortController();
      const ctxAbort = {
        dispatchInProcessTool: async () => ({ text: '', isError: false }),
        signal: ac.signal,
      } as any;
      const code = 'import time\ntime.sleep(30)\nprint("done")';
      const start = Date.now();
      setTimeout(() => ac.abort(), 150);
      const out = (await tool.execute({ language: 'python', code }, ctxAbort)) as string;
      const elapsed = Date.now() - start;
      expect(out).toContain('[code execution aborted]');
      expect(out).not.toContain('done');
      // Killed on abort, NOT run out to the 5-minute timeout cap.
      expect(elapsed).toBeLessThan(5000);
    },
    20000,
  );
});

describe('scrubChildEnv proxy handling (why egress-shadow must re-inject)', () => {
  it('strips an ambient HTTP(S)_PROXY from the source env (PROXY is not a SAFE_ENV_PREFIX)', () => {
    const out = scrubChildEnv({ PATH: '/x', HTTPS_PROXY: 'http://ambient', HTTP_PROXY: 'http://ambient' }, {});
    expect(out.HTTPS_PROXY).toBeUndefined();
    expect(out.HTTP_PROXY).toBeUndefined();
  });

  it('a proxy var passed via inject survives the scrub (the re-injection path egress-shadow uses)', () => {
    const out = scrubChildEnv({ PATH: '/x' }, { HTTPS_PROXY: 'http://p', HTTP_PROXY: 'http://p' });
    expect(out.HTTPS_PROXY).toBe('http://p');
    expect(out.HTTP_PROXY).toBe('http://p');
  });
});

describe('makeExecuteCodeTool egress-shadow child-env injection (SHELL_EGRESS_V1)', () => {
  const PROXY = 'http://127.0.0.1:59998';
  const capturingEnv = (): { environment: ExecutionEnvironment; captured: { env?: Record<string, string | undefined> } } => {
    const captured: { env?: Record<string, string | undefined> } = {};
    return {
      environment: {
        async run(req) {
          captured.env = req.env;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        },
      },
      captured,
    };
  };
  const base = { whitelist: ['WebSearch'], getCwd: () => process.cwd() };
  const saved: Record<string, string | undefined> = {};
  const setEnv = (flag?: string, url?: string) => {
    saved.flag = process.env.SHELL_EGRESS_V1;
    saved.url = process.env.VESTRA_EGRESS_PROXY_URL;
    if (flag === undefined) delete process.env.SHELL_EGRESS_V1; else process.env.SHELL_EGRESS_V1 = flag;
    if (url === undefined) delete process.env.VESTRA_EGRESS_PROXY_URL; else process.env.VESTRA_EGRESS_PROXY_URL = url;
  };
  afterEach(() => {
    if (saved.flag === undefined) delete process.env.SHELL_EGRESS_V1; else process.env.SHELL_EGRESS_V1 = saved.flag;
    if (saved.url === undefined) delete process.env.VESTRA_EGRESS_PROXY_URL; else process.env.VESTRA_EGRESS_PROXY_URL = saved.url;
  });

  it('OFF: code-exec child env carries NO proxy vars, and an ambient one in baseEnv stays scrubbed (byte-identical)', async () => {
    setEnv(undefined, undefined);
    const cap = capturingEnv();
    const tool = makeExecuteCodeTool({
      environment: cap.environment,
      ...base,
      baseEnv: () => ({ PATH: process.env.PATH, HTTPS_PROXY: 'http://ambient:1' }),
    });
    await tool.execute({ language: 'python', code: 'print(1)' }, ctx);
    expect(cap.captured.env?.HTTPS_PROXY).toBeUndefined();
    expect(cap.captured.env?.HTTP_PROXY).toBeUndefined();
  });

  it('SHADOW: proxy vars are re-injected past scrubChildEnv (both cases), alongside the RPC socket', async () => {
    setEnv('shadow', PROXY);
    const cap = capturingEnv();
    const tool = makeExecuteCodeTool({ environment: cap.environment, ...base, baseEnv: () => ({ PATH: process.env.PATH }) });
    await tool.execute({ language: 'python', code: 'print(1)' }, ctx);
    expect(cap.captured.env?.HTTPS_PROXY).toBe(PROXY);
    expect(cap.captured.env?.HTTP_PROXY).toBe(PROXY);
    expect(cap.captured.env?.https_proxy).toBe(PROXY);
    expect(cap.captured.env?.http_proxy).toBe(PROXY);
    expect(cap.captured.env?.VESTRA_RPC_SOCKET).toBeTruthy(); // existing inject not clobbered
  });

  it('ENFORCE: the proxy vars carry the owning task, so a refusal is logged under it', async () => {
    setEnv('enforce', PROXY);
    const cap = capturingEnv();
    const tool = makeExecuteCodeTool({ environment: cap.environment, ...base, ownerTaskId: 'task-42', baseEnv: () => ({ PATH: process.env.PATH }) });
    await tool.execute({ language: 'python', code: 'print(1)' }, ctx);
    expect(cap.captured.env?.HTTP_PROXY).toBe('http://task:task-42@127.0.0.1:59998');
    expect(cap.captured.env?.https_proxy).toBe('http://task:task-42@127.0.0.1:59998');
  });

  it('SHADOW but proxy down (no URL): no injection (never routes a child at a dead port)', async () => {
    setEnv('shadow', undefined);
    const cap = capturingEnv();
    const tool = makeExecuteCodeTool({ environment: cap.environment, ...base, baseEnv: () => ({ PATH: process.env.PATH }) });
    await tool.execute({ language: 'python', code: 'print(1)' }, ctx);
    expect(cap.captured.env?.HTTPS_PROXY).toBeUndefined();
  });
});
