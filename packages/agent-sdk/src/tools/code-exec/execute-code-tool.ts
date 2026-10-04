// tools/code-exec/execute-code-tool.ts
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { RawToolOptions, ToolExecuteContext } from '../tool-types.js';
import { softFail } from '../result-shape.js';
import { toolResultShapeEnabled } from '../../policy/feature-flags.js';
import type { ExecutionEnvironment, ExecResult } from '../../ports/execution-environment-port.js';
import { ToolBridgeServer } from './tool-bridge-server.js';
import { generateStub, fnNamesForWhitelist } from './stub-generator.js';
import { scrubChildEnv } from './scrub-env.js';
import { egressProxyVars } from '../egress-proxy-env.js';
import { truncateOutput } from '../output-limits.js';

/** The script cap when the caller sets none. Exported for the tool watchdog window pin (L5). */
export const EXECUTE_CODE_DEFAULT_TIMEOUT_MS = 300_000;
const MAX_STDOUT = 50_000;
const MAX_STDERR = 10_000;

/**
 * The product socket-event name an in-code (nested) tool call carries for
 * trace-only observability. Kept as a pure literal here (NOT imported from the
 * product `EVENTS` vocabulary) because the SDK contract intentionally stays free
 * of Vestra's socket-event constants — the `raw` HarnessEvent's `event` field is a
 * plain `string` (see contract/events.ts). This literal is byte-identical to
 * `EVENTS.AGENT_NESTED_TOOL_CALL` (a conformance assertion in apps/sandbox proves
 * it). The PERMISSION_DENIED side channel is the exact precedent.
 */
const AGENT_NESTED_TOOL_CALL_EVENT = 'agent:nested_tool_call';

const PARAMS = z.object({
  language: z.enum(['python', 'node']),
  code: z.string(),
  timeout_ms: z.number().int().positive().optional(),
});

/**
 * `execute_code.execute` returns a plain STRING — the standard Vestra tool
 * contract (the dispatcher flattens any non-string return via JSON.stringify and
 * forces dispatch isError:false, so a structured `{text,isError}` object would be
 * stringified into the model's view and lose the error signal). Like `Bash`, we
 * convey failures IN the returned text via explicit markers
 * ("[code execution failed: exit N]", "[code execution timed out]",
 * "[code produced no output]") so a failure is never silent to the model.
 */
export interface ExecuteCodeOptions {
  environment: ExecutionEnvironment;
  whitelist: string[];
  getCwd: () => string;
  /**
   * Thunk (NOT a snapshot): re-read once per `execute_code` invocation so a cwd/env
   * mutated by a prior turn (e.g. an `export` carried in the persisted TerminalSession)
   * is honored on the next run. A snapshotted value would freeze the env at factory time.
   */
  baseEnv: () => Record<string, string | undefined>;
  timeoutCapMs?: number;
  /** The task running the code: SHELL_EGRESS_V1=enforce logs a refused connection under it. */
  ownerTaskId?: string;
}

export function makeExecuteCodeTool(opts: ExecuteCodeOptions): RawToolOptions {
  const cap = opts.timeoutCapMs ?? EXECUTE_CODE_DEFAULT_TIMEOUT_MS;
  // Derive the advertised fn list from the SAME whitelist→fn-name mapping the stub
  // generator uses, so the description can never drift from the actual stubs (the
  // old hand-written list silently omitted `edit`).
  const fnList = fnNamesForWhitelist(opts.whitelist).join(', ');
  return {
    name: 'execute_code',
    description:
      'Run a short Python or Node script. It may call a fixed set of Vestra tools as functions ' +
      `(see the auto-imported stubs: ${fnList}). ` +
      'Only what the script prints to stdout is returned. Use this to batch many tool calls and ' +
      'process their results in code instead of calling tools one at a time.' +
      // T5 (TOOL_RESULT_SHAPE_V1): a tool's failure reaches the script as a raised ToolError
      // (softFail puts it on the error channel), so a loop must catch per item to carry on.
      // Read at factory time, so a session's description is stable. Off: byte-identical.
      (toolResultShapeEnabled() ? ' Each function raises ToolError on failure; wrap per-item calls in try/except (Python) or try/catch (Node) to carry on past one.' : ''),
    parameters: PARAMS,
    // T5 (TOOL_RESULT_SHAPE_V1): every failure in the one error shape (softFail); the words are unchanged.
    execute: async (rawArgs: unknown, ctx: ToolExecuteContext): Promise<ReturnType<typeof softFail>> => {
      const args = PARAMS.parse(rawArgs);
      // Already cancelled before we even start: don't spawn anything.
      if (ctx.signal?.aborted) return softFail('aborted', '[code execution aborted]');
      const dispatch = ctx.dispatchInProcessTool;
      if (!dispatch) {
        return softFail('exec_failed', '[execute_code unavailable: no in-process tool dispatcher]');
      }
      const bridge = new ToolBridgeServer({
        whitelist: opts.whitelist,
        dispatch: async (tool, toolArgs): Promise<{ ok: boolean; text: string; error?: string }> => {
          const startedAt = Date.now();
          const r = await dispatch(tool, toolArgs);
          const durationMs = Date.now() - startedAt;
          // Trace-only side channel (K3 single-emitter precedent: PERMISSION_DENIED):
          // a raw HarnessEvent the sink forwards VERBATIM to the trace recorder —
          // NO content block, NO UI card. Absent pushEvent → no emit, total — but
          // note a subagent's execute_code is NOT such a case: it is a model-driven
          // call under the subagent's dispatch execCtx, which carries a channel, so
          // its trace events DO emit. What stays channel-less is the in-code
          // re-entry (`baseExecCtx`) used for tools called from inside the script.
          //
          // Carries the NESTED call's OWN toolUseId (distinct from the parent
          // execute_code's ctx.toolCallId), minting a fresh one if the dispatch
          // result lacks it — so the tool_calls(trace_id, tool_use_id) unique
          // index never collides with the parent row.
          ctx.pushEvent?.({
            kind: 'raw',
            engine: 'native',
            event: AGENT_NESTED_TOOL_CALL_EVENT,
            data: {
              parentToolUseId: ctx.toolCallId,
              toolUseId: r.toolUseId ?? randomUUID(),
              toolName: tool,
              success: !r.pausedHalt && !r.isError,
              durationMs,
            },
          });
          if (r.pausedHalt) {
            // Pause-composition (Slice 2d): an in-code tool call CANNOT durably pause —
            // the subprocess is blocked on a synchronous bridge RPC and cannot be
            // suspended across a process restart (firing the real onPause would create a
            // phantom interaction that corrupts resume; see inCodePause). Rather than a
            // dead end, tell the model to HOIST the call to the top level, where the
            // real HITL approval flow works.
            return {
              ok: false,
              text: '',
              error: `tool '${tool}' requires human approval, which isn't available inside execute_code. Call '${tool}' directly as a normal tool call (not from a script) to get the approval prompt.`,
            };
          }
          return r.isError ? { ok: false, text: '', error: r.text } : { ok: true, text: r.text };
        },
      });
      try {
        const endpoint = await bridge.listen();
        const stub = generateStub(args.language, opts.whitelist, endpoint);
        const code = `${stub}\n${args.code}`;
        const env = scrubChildEnv(opts.baseEnv(), {
          VESTRA_RPC_SOCKET: endpoint.address,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // SHELL_EGRESS_V1=shadow: re-inject the proxy vars scrubChildEnv strips
          // (HTTP(S)_PROXY are not SAFE_ENV_PREFIXES), routing code-exec egress
          // through the screening proxy. undefined ⇒ nothing merged ⇒ byte-identical.
          ...egressProxyVars(undefined, opts.ownerTaskId), // the default env; this file reads no env itself
        });
        const res = await opts.environment.run({
          language: args.language,
          code,
          timeoutMs: Math.min(args.timeout_ms ?? cap, cap),
          cwd: opts.getCwd(),
          env,
          bridge: endpoint,
          // exactOptionalPropertyTypes: forward the abort signal only when present
          // so the environment can KILL the child on a user abort.
          ...(ctx.signal !== undefined && { signal: ctx.signal }),
        });
        // A user abort during the run KILLS the subprocess (execFile's `signal`),
        // so the child never runs out the timeout. Surface it explicitly — never
        // silently — with whatever partial output it produced before the kill.
        if (ctx.signal?.aborted) {
          const tail = truncateOutput((res.stdout ?? '') + (res.stderr ?? ''), MAX_STDOUT).text.trim();
          return softFail('aborted', tail ? `[code execution aborted]\n${tail}` : '[code execution aborted]');
        }
        return formatResult(res);
      } finally {
        await bridge.close();
      }
    },
  };
}

function formatResult(res: ExecResult): ReturnType<typeof softFail> {
  if (res.timedOut) {
    const tail = truncateOutput(res.stdout + res.stderr, MAX_STDOUT).text;
    return softFail('timeout', `[code execution timed out]\n${tail}`.trim());
  }
  const out = truncateOutput(res.stdout, MAX_STDOUT).text;
  const err = truncateOutput(res.stderr, MAX_STDERR).text;
  if (res.exitCode !== 0) {
    const body = [err, out].filter(Boolean).join('\n');
    return softFail('exec_failed', `[code execution failed: exit ${res.exitCode}]${body ? `\n${body}` : ''}`);
  }
  if (!out.trim() && !err.trim()) return '[code produced no output]';
  return err.trim() ? `${out}\n[stderr]\n${err}` : out;
}
