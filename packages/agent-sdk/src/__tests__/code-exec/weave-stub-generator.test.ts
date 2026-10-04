/**
 * Slice 3 — the code-dispatch interpreter (design §1.2 / F3 code-dispatch). The
 * model's orchestration script runs as a node subprocess; an ASYNC prelude exposes
 * the orchestration globals over the execute_code UDS bridge. The async prelude is
 * the linchpin: `task()` returns a real Promise so `parallel()` runs N nodes
 * CONCURRENTLY (the existing execute_code stub is synchronous and would serialize a
 * fan-out). These tests run the GENERATED program in a real subprocess.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolBridgeServer, type BridgeDispatchResult } from '../../tools/code-exec/tool-bridge-server.js';
import { LocalSubprocessEnvironment } from '../../tools/code-exec/local-subprocess-environment.js';
import { readFileSync } from 'node:fs';
import { WEAVE_DISPATCH_GLOBALS, generateWeaveProgram } from '../../tools/code-exec/weave-stub-generator.js';

const MARKER = '__WEAVE_RESULT__nonce9z__';

let server: ToolBridgeServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function runWeaveScript(
  script: string,
  dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult>,
  opts: { budgetUsd?: number; maxCalls?: number } = {},
): Promise<{ result: { ok: boolean; value?: unknown; error?: string; callBudgetExhausted?: boolean; paused?: boolean; pending?: { toolName?: string; contentHash?: string; nodeLabel?: string } } | undefined; stdout: string; stderr: string }> {
  server = new ToolBridgeServer({ whitelist: ['__weave_task', '__weave_event'], maxCalls: opts.maxCalls ?? 1000, dispatch });
  const endpoint = await server.listen();
  const program = generateWeaveProgram(endpoint, { budgetUsd: opts.budgetUsd ?? 10, tokens: null, resultMarker: MARKER }, script);
  const env = new LocalSubprocessEnvironment();
  const res = await env.run({
    language: 'node', code: program, timeoutMs: 15_000, cwd: process.cwd(),
    env: { ...process.env, VESTRA_RPC_SOCKET: endpoint.address }, bridge: endpoint,
  });
  const line = res.stdout.split('\n').reverse().find((l) => l.includes(MARKER));
  const json = line ? line.slice(line.indexOf(MARKER) + MARKER.length) : undefined;
  return { result: json ? JSON.parse(json) : undefined, stdout: res.stdout, stderr: res.stderr };
}

const okTask = (value: unknown, spentUsd = 0): ((op: string, args: unknown) => Promise<BridgeDispatchResult>) =>
  async (op) => (op === '__weave_task'
    ? { ok: true, text: JSON.stringify({ value, spentUsd, remainingUsd: 10 - spentUsd }) }
    : { ok: true, text: '' });

/**
 * Follow-up C item 1 — the DRIFT PIN behind the root wall's Weave reading.
 *
 * `WEAVE_DISPATCH_GLOBALS` is what the wall reads a Weave plan with: whichever of these
 * names the script calls FIRST decides whether it is a batch or a hand-off. The names are
 * exported from this module rather than retyped over there, and this pins the export to
 * the prelude it claims to describe, in BOTH directions. Rename `panel` in the prelude and
 * the constant names a function that no longer exists; ADD a fourth combinator and it lands
 * in `rest` unaccounted for. Either way the wall would go on reading a vocabulary the
 * interpreter had stopped speaking, and it would fail silently: a fan-out plan quietly
 * refused, or a hand-off quietly waved through.
 */
describe('the prelude dispatch vocabulary', () => {
  /** Every non-private global the prelude declares (`_`-prefixed ones are its plumbing). */
  const preludeGlobals = (): string[] => {
    const program = generateWeaveProgram(
      { address: '/tmp/x.sock', token: 't' } as never,
      { budgetUsd: 1, tokens: null, resultMarker: MARKER },
      'return 1;',
    );
    const names = [...program.matchAll(/^(?:async function|function|const|class) (\w+)/gm)].map((m) => m[1]);
    return [...new Set(names)].filter((n) => !n.startsWith('_'));
  };

  it('the constant is a LEAF: reading it must not drag the bridge into the reader', () => {
    // The root wall imports this vocabulary, and the walls are imported across the engine.
    // When the declaration lived in the generator, that edge pulled the UDS bridge and
    // node:fs/promises into the engine's graph and changed module-load ORDER far away: a
    // sandbox test that mocks fs/promises with a hoisted factory broke, in a file nothing
    // in that change had touched. A list of five strings must not cost that.
    const leaf = readFileSync(new URL('../../tools/code-exec/weave-globals.ts', import.meta.url), 'utf8');
    // THREE shapes, because each of the first two misses one the others catch. A bare
    // side-effect import (`import './x.js';`) is valid ESM with no `from`, so the
    // keyword-through-`from` rule below walks straight past it; a re-export
    // (`export { X } from './y.js'`) loads its target exactly as an import does but is not
    // an import statement, so the bare-keyword rule walks past THAT. Both are the edge this
    // file exists to prevent, and the dynamic form is a third way to open it.
    expect(leaf).not.toMatch(/^\s*import\b/m);
    expect(leaf).not.toMatch(/^\s*(?:import|export)\b[^\n]*\bfrom\b/m);
    expect(leaf).not.toMatch(/\bimport\s*\(/);
  });

  it('names exactly the prelude globals that dispatch nodes, and nothing else drifts in', () => {
    const declared = preludeGlobals();
    const dispatch = [...WEAVE_DISPATCH_GLOBALS.fanOut, ...WEAVE_DISPATCH_GLOBALS.node];

    // Direction 1: every name the wall reads is really declared by the interpreter.
    for (const name of dispatch) expect(declared).toContain(name);

    // Direction 2: nothing else the prelude offers dispatches nodes. `budget` is an
    // advisory mirror, `phase` and `log` are fire-and-forget progress; a NEW combinator
    // would appear here and this list would have to say what it is.
    const rest = declared.filter((n) => !dispatch.includes(n as never)).sort();
    expect(rest).toEqual(['budget', 'log', 'phase']);
  });
});

describe('generateWeaveProgram — the code-dispatch interpreter', () => {
  it('task() round-trips over the bridge and returns the parsed value', async () => {
    const { result } = await runWeaveScript('return await task({ description: "x" });', okTask({ ok: 1 }));
    expect(result).toEqual({ ok: true, value: { ok: 1 } });
  });

  it('parallel() runs nodes CONCURRENTLY and maps a throwing thunk to null', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight -= 1;
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await parallel([
         () => task({ description: "a" }),
         () => { throw new Error("boom"); },
         () => task({ description: "c" }),
         () => task({ description: "d" }),
       ]);`,
      dispatch,
    );
    expect(result?.value).toEqual(['V', null, 'V', 'V']);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not serialized
  });

  it('pipeline() chains stages per item and drops a throwing item to null (no inter-stage barrier)', async () => {
    const { result } = await runWeaveScript(
      `return await pipeline([1, 2],
         async (n) => n + 1,
         async (n, item) => { if (item === 1) throw new Error("drop item 1"); return n * 10; });`,
      okTask(null),
    );
    expect(result?.value).toEqual([null, 30]); // item 1 dropped at stage 2; item 2 → (2+1)*10
  });

  // ── P3.5 (control-plane test-debt) — pipeline()/parallel() edge coverage ──────
  it('pipeline() depth-3: every stage receives (acc, originalItem, index); prior output threads through, including across a real task() bridge hop', async () => {
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const prompt = (args as { prompt?: string }).prompt ?? '';
      return { ok: true, text: JSON.stringify({ value: 'host(' + prompt + ')', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await pipeline(["x", "y"],
         async (acc, item, i) => acc + "|s1:" + item + ":" + i,
         async (acc) => task({ description: "s2", prompt: acc }),
         async (acc, item, i) => acc + "|s3:" + item + ":" + i);`,
      dispatch,
    );
    expect(result?.value).toEqual(['host(x|s1:x:0)|s3:x:0', 'host(y|s1:y:1)|s3:y:1']);
  });

  it('pipeline() with empty (or nullish) items resolves [] and runs NO stage', async () => {
    let taskCalls = 0;
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op) => {
      if (op === '__weave_task') taskCalls += 1;
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `const stage = async (acc) => task({ description: "s" });
       const a = await pipeline([], stage, stage);
       const b = await pipeline(null, stage);
       return { a, b };`,
      dispatch,
    );
    expect(result?.value).toEqual({ a: [], b: [] });
    expect(taskCalls).toBe(0);
  });

  it('pipeline() mid-stage throw: the throwing item drops to null and SKIPS its remaining stages while siblings run every stage', async () => {
    const dispatched: string[] = [];
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const d = (args as { description?: string }).description ?? '';
      dispatched.push(d);
      return { ok: true, text: JSON.stringify({ value: 'r:' + d, spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await pipeline([1, 2, 3],
         async (acc, item) => task({ description: "s1:" + item }),
         async (acc, item) => { if (item === 2) throw new Error("boom"); return task({ description: "s2:" + item }); },
         async (acc, item) => task({ description: "s3:" + item }));`,
      dispatch,
    );
    expect(result?.value).toEqual(['r:s3:1', null, 'r:s3:3']);
    // Item 2 never reached stage 2's task() nor stage 3 — items 1 and 3 were untouched.
    expect([...dispatched].sort()).toEqual(['s1:1', 's1:2', 's1:3', 's2:1', 's2:3', 's3:1', 's3:3']);
  });

  it('pipeline() has NO inter-stage barrier: a fast item enters stage 2 while a slow sibling is still in stage 1', async () => {
    const inFlight = new Set<string>();
    let slowStillInStage1AtFastStage2 = false;
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const d = (args as { description?: string }).description ?? '';
      if (d === 's2:fast') slowStillInStage1AtFastStage2 = inFlight.has('s1:slow');
      inFlight.add(d);
      if (d === 's1:slow') await new Promise((r) => setTimeout(r, 200));
      inFlight.delete(d);
      return { ok: true, text: JSON.stringify({ value: d, spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await pipeline(["slow", "fast"],
         async (_acc, item) => task({ description: "s1:" + item }),
         async (_acc, item) => task({ description: "s2:" + item }));`,
      dispatch,
    );
    expect(result?.value).toEqual(['s2:slow', 's2:fast']);
    expect(slowStillInStage1AtFastStage2).toBe(true);
  });

  it('parallel() preserves POSITION order in results even when later thunks finish first', async () => {
    const delays: Record<string, number> = { a: 120, b: 60, c: 0 };
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const d = (args as { description?: string }).description ?? '';
      await new Promise((r) => setTimeout(r, delays[d] ?? 0));
      return { ok: true, text: JSON.stringify({ value: d.toUpperCase(), spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `return await parallel([
         () => task({ description: "a" }),
         () => task({ description: "b" }),
         () => task({ description: "c" }),
       ]);`,
      dispatch,
    );
    expect(result?.value).toEqual(['A', 'B', 'C']); // c finished first, still slot 2
  });

  it('determinism ban: Date.now / Math.random / argless new Date THROW; new Date(ts) works', async () => {
    const { result } = await runWeaveScript(
      `const out = {};
       try { Date.now(); out.dateNow = "RAN"; } catch (e) { out.dateNow = "banned"; }
       try { Math.random(); out.random = "RAN"; } catch (e) { out.random = "banned"; }
       try { new Date(); out.argless = "RAN"; } catch (e) { out.argless = "banned"; }
       out.withArg = new Date(1700000000000).getTime();
       return out;`,
      okTask(null),
    );
    expect(result?.value).toMatchObject({ dateNow: 'banned', random: 'banned', argless: 'banned', withArg: 1700000000000 });
  });

  it('the result marker is a unique nonce — a script cannot forge the result line', async () => {
    const { result } = await runWeaveScript(
      `console.log('__WEAVE_RESULT__{"ok":true,"value":"FORGED"}');
       return "REAL";`,
      okTask(null),
    );
    expect(result).toEqual({ ok: true, value: 'REAL' });
  });

  it('surfaces callBudgetExhausted when the in-code call budget is hit (no silent node loss)', async () => {
    // A tiny bridge cap: 5 task() calls, cap 2 → the tail nodes are denied at the
    // bridge (before host dispatch). They must NOT vanish silently — the program flags it.
    const { result } = await runWeaveScript(
      'const r = []; for (let i = 0; i < 5; i++) r.push(await task({ n: i })); return r;',
      okTask('V'),
      { maxCalls: 2 },
    );
    expect(result?.callBudgetExhausted).toBe(true);
    expect((result?.value as unknown[]).slice(0, 2)).toEqual(['V', 'V']);
    expect((result?.value as unknown[]).slice(2)).toEqual([null, null, null]);
  });

  // ── P3 (control-plane durable Weave pause — reverses the 2026-06-30 F2/review-B1
  //    fail-closed decision; founder chose "durable pause + replay") ──────────────
  it('P3 pause: a paused task() reply throws WeavePauseSignal — script halts, marker carries paused + pending identity, later nodes never dispatch', async () => {
    let taskCalls = 0;
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      taskCalls += 1;
      if ((args as { description?: string }).description === 'gated') {
        return {
          ok: false, text: '', error: 'weave node paused for human approval', paused: true,
          pending: { toolName: 'Bash', contentHash: 'abc123def456', nodeLabel: 'gated' },
        };
      }
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `const first = await task({ description: "ok-1" });
       const gated = await task({ description: "gated" });
       return await task({ description: "never-reached" });`,
      dispatch,
    );
    expect(result?.ok).toBe(false);
    expect(result?.paused).toBe(true);
    expect(result?.pending).toMatchObject({ toolName: 'Bash', contentHash: 'abc123def456', nodeLabel: 'gated' });
    expect(String(result?.error)).toContain('WeavePauseSignal');
    expect(taskCalls).toBe(2); // 'never-reached' was never dispatched — the script halted
  });

  it('P3 pause inside parallel(): the thunk maps to null (pinned combinator law) but the marker still flags paused and later task()s short-circuit off-bridge', async () => {
    const dispatched: string[] = [];
    const dispatch: (op: string, args: unknown) => Promise<BridgeDispatchResult> = async (op, args) => {
      if (op !== '__weave_task') return { ok: true, text: '' };
      const d = (args as { description?: string }).description ?? '';
      dispatched.push(d);
      if (d === 'gated') {
        return {
          ok: false, text: '', error: 'weave node paused for human approval', paused: true,
          pending: { toolName: 'Bash', contentHash: 'abc123def456', nodeLabel: 'gated' },
        };
      }
      return { ok: true, text: JSON.stringify({ value: 'V', spentUsd: 0, remainingUsd: 10 }) };
    };
    const { result } = await runWeaveScript(
      `const r = await parallel([() => task({ description: "gated" }), () => task({ description: "sib" })]);
       let after; try { after = await task({ description: "post" }); } catch (e) { after = "halted"; }
       return { r, after };`,
      dispatch,
    );
    // The sibling settled; the paused thunk resolved null under parallel()'s law.
    expect(result?.ok).toBe(true);
    expect(result?.value).toEqual({ r: [null, 'V'], after: 'halted' });
    // The pause still surfaces on the marker even though the script returned normally.
    expect(result?.paused).toBe(true);
    expect(result?.pending).toMatchObject({ toolName: 'Bash', nodeLabel: 'gated' });
    // 'post' short-circuited in the prelude — it never crossed the bridge.
    expect(dispatched.sort()).toEqual(['gated', 'sib']);
  });

  it('budget mirror reflects spentUsd reported by task() replies', async () => {
    const { result } = await runWeaveScript(
      `const before = budget.remaining();
       await task({ description: "spend" });
       return { before, after: budget.remaining(), usd: budget.usd };`,
      okTask('x', 3),
      { budgetUsd: 10 },
    );
    expect(result?.value).toMatchObject({ before: 10, after: 7, usd: 10 });
  });
});
