/**
 * P3.5 (control-plane test-debt) — first-ever panel() coverage. panel() is a PURE JS
 * combinator inside the GENERATED Weave prelude (weave-stub-generator.ts): a
 * best-of-N fan-out over task() plus an optional judge node. These tests run the
 * real generated program in a real node subprocess over the UDS bridge (host task
 * runner mocked), pinning the prelude's ACTUAL semantics:
 *   - candidate count comes from spec.n (default 1) — models NEVER set the count;
 *   - models rotate across candidates via i % models.length;
 *   - no judge → { candidates }; judge → { candidates, verdict } (never a bare pick);
 *   - the judge prompt embeds only non-null candidates, but the returned candidates
 *     array keeps nulls in candidate positions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolBridgeServer, type BridgeDispatchResult } from '../../tools/code-exec/tool-bridge-server.js';
import { LocalSubprocessEnvironment } from '../../tools/code-exec/local-subprocess-environment.js';
import { generateWeaveProgram } from '../../tools/code-exec/weave-stub-generator.js';

const MARKER = '__WEAVE_RESULT__noncepanel__';

type Dispatch = (op: string, args: unknown) => Promise<BridgeDispatchResult>;
interface TaskSpec { description?: string; prompt?: string; model?: string; responseSchema?: unknown }

let server: ToolBridgeServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function runWeaveScript(
  script: string,
  dispatch: Dispatch,
): Promise<{ result: { ok: boolean; value?: unknown; error?: string } | undefined; stdout: string }> {
  server = new ToolBridgeServer({ whitelist: ['__weave_task', '__weave_event'], maxCalls: 1000, dispatch });
  const endpoint = await server.listen();
  const program = generateWeaveProgram(endpoint, { budgetUsd: 10, tokens: null, resultMarker: MARKER }, script);
  const env = new LocalSubprocessEnvironment();
  const res = await env.run({
    language: 'node', code: program, timeoutMs: 15_000, cwd: process.cwd(),
    env: { ...process.env, VESTRA_RPC_SOCKET: endpoint.address }, bridge: endpoint,
  });
  const line = res.stdout.split('\n').reverse().find((l) => l.includes(MARKER));
  const json = line ? line.slice(line.indexOf(MARKER) + MARKER.length) : undefined;
  return { result: json ? JSON.parse(json) : undefined, stdout: res.stdout };
}

/** Candidate specs arrive over concurrent UDS connections — order by description ("p #i"). */
const byDescription = (specs: TaskSpec[]): TaskSpec[] =>
  [...specs].sort((a, b) => (a.description ?? '').localeCompare(b.description ?? ''));

describe('panel() — best-of-N fan-out + optional judge (prelude combinator)', () => {
  it('best-of-N: n candidates dispatch CONCURRENTLY with "prompt #i" descriptions and rotated models; returns { candidates } in candidate order', async () => {
    const specs: TaskSpec[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch: Dispatch = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const spec = args as TaskSpec;
      specs.push(spec);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight -= 1;
      return { ok: true, text: JSON.stringify({ value: 'out:' + spec.model, spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      'return await panel({ n: 3, prompt: "write a haiku", models: ["m-a", "m-b", "m-c"] });',
      dispatch,
    );
    // No judge → the FULL candidates array, positionally ordered — never a single pick.
    expect(result).toEqual({ ok: true, value: { candidates: ['out:m-a', 'out:m-b', 'out:m-c'] } });
    const sorted = byDescription(specs);
    expect(sorted.map((s) => s.description)).toEqual(['write a haiku #1', 'write a haiku #2', 'write a haiku #3']);
    expect(sorted.map((s) => s.model)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(sorted.every((s) => s.prompt === 'write a haiku')).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1); // candidates fan out via parallel(), not serially
  });

  it('candidate count comes from n ALONE — a models list never implies it (models-only = 1 candidate on models[0]; n:0 → 1; no models → no model key)', async () => {
    const specs: TaskSpec[] = [];
    const dispatch: Dispatch = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      specs.push(args as TaskSpec);
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `const a = await panel({ prompt: "models-only", models: ["m1", "m2", "m3"] });
       const b = await panel({ prompt: "zero-n", n: 0 });
       return { a, b };`,
      dispatch,
    );
    expect(result?.value).toEqual({ a: { candidates: ['V'] }, b: { candidates: ['V'] } });
    expect(specs).toHaveLength(2); // three models did NOT fan out three candidates
    expect(specs[0]).toEqual({ description: 'models-only #1', prompt: 'models-only', model: 'm1' });
    expect(specs[1]).toEqual({ description: 'zero-n #1', prompt: 'zero-n' });
    expect(Object.keys(specs[1] ?? {})).not.toContain('model'); // empty models → key absent, not undefined
  });

  it('judge: dispatches ONCE after ALL candidates settle, with judge:<mode> description, candidates JSON in the prompt, and judge.schema as responseSchema; returns { candidates, verdict }', async () => {
    const candidateSpecs: TaskSpec[] = [];
    const judgeSpecs: TaskSpec[] = [];
    let candidatesSettled = 0;
    let settledWhenJudgeArrived = -1;
    const dispatch: Dispatch = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const spec = args as TaskSpec;
      if ((spec.description ?? '').startsWith('judge:')) {
        judgeSpecs.push(spec);
        settledWhenJudgeArrived = candidatesSettled;
        return { ok: true, text: JSON.stringify({ value: { winner: 2 }, spentUsd: 0, remainingUsd: 10 }) };
      }
      candidateSpecs.push(spec);
      await new Promise((r) => setTimeout(r, 30));
      candidatesSettled += 1;
      return { ok: true, text: JSON.stringify({ value: 'c' + (spec.description ?? '').slice(-1), spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await panel({
         n: 2, prompt: "draft", models: ["mx"],
         judge: { mode: "rank", prompt: "pick the best", schema: { type: "object", required: ["winner"] } },
       });`,
      dispatch,
    );
    // The verdict rides ALONGSIDE the raw candidates — panel never collapses to the pick.
    expect(result?.value).toEqual({ candidates: ['c1', 'c2'], verdict: { winner: 2 } });
    expect(judgeSpecs).toHaveLength(1);
    expect(judgeSpecs[0]?.description).toBe('judge:rank');
    expect(judgeSpecs[0]?.prompt).toBe('pick the best\n\nCANDIDATES:\n' + JSON.stringify(['c1', 'c2']));
    expect(judgeSpecs[0]?.responseSchema).toEqual({ type: 'object', required: ['winner'] });
    expect(settledWhenJudgeArrived).toBe(2); // judge waited for BOTH candidates
    // A single model with n=2 repeats across every candidate (i % 1 === 0).
    expect(byDescription(candidateSpecs).map((s) => s.model)).toEqual(['mx', 'mx']);
  });

  it('null-candidate filter: a failed candidate stays null in candidates but is FILTERED from the judge prompt; judge defaults to mode "vote" with no responseSchema', async () => {
    const judgeSpecs: TaskSpec[] = [];
    const dispatch: Dispatch = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const spec = args as TaskSpec;
      if ((spec.description ?? '').startsWith('judge:')) {
        judgeSpecs.push(spec);
        return { ok: true, text: JSON.stringify({ value: 'verdict-v', spentUsd: 0, remainingUsd: 10 }) };
      }
      if (spec.description === 'gen #2') return { ok: false, text: '', error: 'candidate exploded' };
      return { ok: true, text: JSON.stringify({ value: 'v' + (spec.description ?? '').slice(-1), spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      'return await panel({ n: 3, prompt: "gen", judge: { prompt: "choose" } });',
      dispatch,
    );
    expect(result?.value).toEqual({ candidates: ['v1', null, 'v3'], verdict: 'verdict-v' });
    expect(judgeSpecs[0]?.description).toBe('judge:vote');
    expect(judgeSpecs[0]?.prompt).toBe('choose\n\nCANDIDATES:\n' + JSON.stringify(['v1', 'v3']));
    expect(Object.keys(judgeSpecs[0] ?? {})).not.toContain('responseSchema');
  });

  it('model rotation WRAPS when models is shorter than n (i % models.length)', async () => {
    const specs: TaskSpec[] = [];
    const dispatch: Dispatch = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      specs.push(args as TaskSpec);
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      'return await panel({ n: 5, prompt: "w", models: ["m-a", "m-b"] });',
      dispatch,
    );
    expect(result?.value).toEqual({ candidates: ['V', 'V', 'V', 'V', 'V'] });
    expect(byDescription(specs).map((s) => s.model)).toEqual(['m-a', 'm-b', 'm-a', 'm-b', 'm-a']);
  });
});
