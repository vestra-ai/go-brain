// tools/code-exec/weave-stub-generator.ts
//
// Generates the node program for a `Weave` orchestration script (design §1.2 / F3
// code-dispatch). Unlike the execute_code stub (a SYNCHRONOUS `execFileSync` round
// trip — fine for "call tools one at a time", fatal for a fan-out), the Weave prelude
// is ASYNC: each `task()` is a real Promise over a non-blocking UDS socket, so
// `parallel()`/`pipeline()` run N nodes CONCURRENTLY (the host caps real concurrency
// at the per-run `:weave:` pool). The script is written as a `.mjs` (ESM), so the
// bridge client uses `import` (a top-level `require` throws in module scope).
import { randomBytes } from 'node:crypto';
import type { BridgeEndpoint, ExecutionEnvironment } from '../../ports/execution-environment-port.js';
import { ToolBridgeServer, type BridgeDispatchResult } from './tool-bridge-server.js';
import { scrubChildEnv } from './scrub-env.js';
// Re-exported so this module, which OWNS the prelude, still names its own vocabulary;
// the declaration is a leaf so a reader of it need not import the bridge (weave-globals.ts).
export { WEAVE_DISPATCH_GLOBALS } from './weave-globals.js';

export interface WeaveProgramConfig {
  /** The run's USD budget (the script-side `budget` mirror; host enforces the ceiling). */
  budgetUsd: number;
  tokens: number | null;
  /** A per-run NONCE marker the host parses out of stdout — unforgeable by the script. */
  resultMarker: string;
}

/**
 * The interpreter prelude: determinism guardrail + async UDS bridge client +
 * orchestration globals. `parallel`/`pipeline`/`panel` are PURE JS combinators over
 * `task()`; only `task`/`agent` and `phase`/`log` cross the bridge.
 */
function prelude(sock: string, token: string, budgetUsd: number, tokens: number | null): string {
  const S = JSON.stringify(sock);
  const T = JSON.stringify(token);
  return `import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

// ── Determinism guardrail (design §1.2.3) ────────────────────────────────────
// A GUARDRAIL, not a sandbox: it steers the model away from the non-deterministic
// reaches that would diverge on the durable replay (§2). Banning the common ones is
// what keeps a Weave script replay-shaped; vary by node index, pass timestamps via meta.
const _ban = (n) => { throw new Error(n + ' is banned in Weave scripts (determinism — vary by node index, pass timestamps via meta).'); };
Math.random = () => _ban('Math.random()');
const _RealDate = Date;
class _WeaveDate extends _RealDate {
  constructor(...a) { if (a.length === 0) _ban('argless new Date()'); super(...a); }
  static now() { _ban('Date.now()'); }
}
globalThis.Date = _WeaveDate;
try { if (typeof performance !== 'undefined' && performance) performance.now = () => _ban('performance.now()'); } catch (_e) {}
try { if (globalThis.crypto) {
  if (globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = () => _ban('crypto.randomUUID()');
  if (globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues = () => _ban('crypto.getRandomValues()');
} } catch (_e) {}

// ── Async UDS bridge client (one connection per call → real concurrency) ─────
const _SOCK = ${S};
const _TOKEN = ${T};
function _call(op, args) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(_SOCK);
    const dec = new StringDecoder('utf8');
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ token: _TOKEN, tool: op, args }) + '\\n'));
    c.on('data', (d) => { buf += dec.write(d); if (buf.endsWith('\\n')) c.end(); });
    c.on('end', () => {
      buf += dec.end();
      let r;
      try { r = JSON.parse(buf); } catch (_e) { reject(new Error('weave bridge: malformed reply')); return; }
      if (!r.ok) { const e = new Error(r.error || 'weave bridge call failed'); if (r.capExhausted) e.cap = true; if (r.paused) { e.paused = true; e.pending = r.pending; } reject(e); return; }
      resolve(r.text == null ? '' : r.text);
    });
    c.on('error', reject);
  });
}

// ── budget mirror (advisory; the host fuel tank is the hard ceiling) ─────────
const budget = {
  usd: ${Number.isFinite(budgetUsd) ? budgetUsd : 0},
  tokens: ${tokens == null ? 'null' : tokens},
  _spent: 0,
  spentUsd() { return this._spent; },
  remaining() { return Math.max(0, this.usd - this._spent); },
};

// ── orchestration globals ────────────────────────────────────────────────────
// Set when the in-code call budget denies a task() node, so the host/marker can flag
// truncated work instead of letting tail nodes vanish to null silently (review M3).
globalThis.__weaveCapHit = false;
// P3 (durable pause — control-plane P3.1) — set to the paused node's pending identity
// the moment a task() is denied-for-approval. Mirrors __weaveCapHit onto BOTH marker
// lines, so the host classifies a pause distinct from scriptError even when a
// combinator (parallel/pipeline — "a throwing thunk → null" is pinned law) swallowed
// the throw and the script returned normally.
globalThis.__weavePaused = null;
function _pauseSignal() {
  return new Error('WeavePauseSignal: a node paused for human approval — the run suspends here');
}
async function task(spec) {
  // Once pausing, halt every later task() BEFORE the bridge (the host sheds them at
  // its own chokepoint too — this just saves the round trip and halts the script).
  if (globalThis.__weavePaused) throw _pauseSignal();
  let text;
  try { text = await _call('__weave_task', spec || {}); } catch (e) {
    if (e && e.cap) { globalThis.__weaveCapHit = true; return null; }
    if (e && e.paused) {
      if (!globalThis.__weavePaused) globalThis.__weavePaused = e.pending || {};
      throw _pauseSignal();
    }
    return null;
  }
  let r;
  try { r = JSON.parse(text); } catch (_e) { return null; }
  if (typeof r.spentUsd === 'number') budget._spent = r.spentUsd;
  return r.value === undefined ? null : r.value;
}
const agent = task;

// BARRIER: awaits all thunks; a throwing thunk resolves to null (never rejects the batch).
async function parallel(thunks) {
  return Promise.all((thunks || []).map((t) => Promise.resolve().then(() => t()).then((v) => v, () => null)));
}

// NO inter-stage barrier: each item flows through all stages independently; a stage
// that throws drops that item to null and skips its remaining stages.
async function pipeline(items, ...stages) {
  return Promise.all((items || []).map(async (item, i) => {
    let acc = item;
    for (const stage of stages) {
      try { acc = await stage(acc, item, i); } catch (_e) { return null; }
    }
    return acc;
  }));
}

// fan-out N candidates + an optional judge node (best-of-N / quality, design §1.2.6).
async function panel(spec) {
  const s = spec || {};
  const n = s.n && s.n > 0 ? s.n : 1;
  const models = s.models || [];
  const candidates = await parallel(Array.from({ length: n }, (_, i) => () =>
    task({
      description: ((s.prompt || 'panel') + ' #' + (i + 1)),
      prompt: s.prompt || '',
      ...(models.length ? { model: models[i % models.length] } : {}),
    })));
  if (!s.judge) return { candidates };
  const verdict = await task({
    description: 'judge:' + (s.judge.mode || 'vote'),
    prompt: (s.judge.prompt || '') + '\\n\\nCANDIDATES:\\n' + JSON.stringify(candidates.filter((c) => c != null)),
    ...(s.judge.schema ? { responseSchema: s.judge.schema } : {}),
  });
  return { candidates, verdict };
}

// progress (best-effort; fire-and-forget so it never blocks orchestration).
function phase(id) { _call('__weave_event', { kind: 'phase', value: String(id) }).catch(() => {}); }
function log(line) { _call('__weave_event', { kind: 'log', value: String(line) }).catch(() => {}); }
`;
}

/**
 * Assemble the full runnable program: prelude + the model's script wrapped in an
 * async IIFE whose resolved/rejected value is printed under the per-run NONCE marker
 * (the host parses the LAST marker line — a script can't forge a nonce it never sees).
 */
export function generateWeaveProgram(bridge: BridgeEndpoint, config: WeaveProgramConfig, userScript: string): string {
  const marker = JSON.stringify(config.resultMarker);
  // P3 — the paused spread rides BOTH lines (like capHit): a direct-await pause
  // rejects the IIFE; a combinator-swallowed pause resolves it, and only the flag
  // tells the host the run must suspend rather than complete.
  const pausedSpread = '...(globalThis.__weavePaused ? { paused: true, pending: globalThis.__weavePaused } : {})';
  return `${prelude(bridge.address, bridge.token, config.budgetUsd, config.tokens)}
;(async () => {
${userScript}
})().then(
  (v) => process.stdout.write('\\n' + ${marker} + JSON.stringify({ ok: true, value: v === undefined ? null : v, ...(globalThis.__weaveCapHit ? { callBudgetExhausted: true } : {}), ${pausedSpread} }) + '\\n'),
  (e) => process.stdout.write('\\n' + ${marker} + JSON.stringify({ ok: false, error: String((e && e.message) || e), ...(globalThis.__weaveCapHit ? { callBudgetExhausted: true } : {}), ${pausedSpread} }) + '\\n'),
);
`;
}

/** Generous in-code call backstop (task + phase + log all count). The fuel tank +
 *  Weave budget are the REAL spend bounds; this only stops a pathological loop. Set
 *  high so phase()/log() flooding does not silently strand task() nodes; if it IS hit,
 *  the program flags `callBudgetExhausted` (never a silent truncation — review M3). */
const WEAVE_MAX_CALLS = 50_000;
/** Weave orchestrations run far longer than a single execute_code call. */
const WEAVE_DEFAULT_TIMEOUT_MS = 600_000;

export type WeaveBridgeDispatch = (op: string, args: unknown) => Promise<BridgeDispatchResult>;

export interface RunWeaveScriptOptions {
  environment: ExecutionEnvironment;
  getCwd: () => string;
  baseEnv: () => Record<string, string | undefined>;
  /** The script-side `budget` mirror value (host enforces the real ceiling). */
  budgetUsd: number;
  tokens?: number | null;
  /** Handles `__weave_task` (run one node) + `__weave_event` (progress). */
  dispatch: WeaveBridgeDispatch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WeaveScriptResult {
  /** The script returned normally (true) vs threw / never produced a marker (false). */
  ok: boolean;
  /** The script's returned value (null when none, or on a crash/timeout). */
  value: unknown;
  /** A script throw message OR a subprocess-failure note. */
  error?: string;
  /** Set when the in-code call budget denied ≥1 task() node — work was truncated and
   *  the caller must surface it (review M3, no silent caps). */
  callBudgetExhausted?: boolean;
  /** P3 (durable pause) — the script halted (or finished) with a node PAUSED for
   *  human approval. Classified DISTINCT from scriptError by the caller: a paused
   *  run is a suspension, never "[weave failed]". `pendingNode` mirrors the marker's
   *  compact pending-leaf identity (observability; the Weave run's own captured
   *  state is what the durable interaction is built from). */
  paused?: boolean;
  pendingNode?: { toolName?: string; contentHash?: string; nodeLabel?: string };
  stdout: string;
  timedOut: boolean;
}

/**
 * Run a Weave orchestration script in the node subprocess, bridging its `task()`
 * calls to `opts.dispatch`. Owns the UDS bridge + program assembly + the per-run
 * NONCE marker parse so the orchestration tool stays free of the interpreter
 * plumbing. Never throws — a crash/timeout returns `{ ok:false, value:null, error }`.
 */
export async function runWeaveScript(script: string, opts: RunWeaveScriptOptions): Promise<WeaveScriptResult> {
  const marker = `__WEAVE_RESULT__${randomBytes(9).toString('hex')}__`;
  const bridge = new ToolBridgeServer({
    whitelist: ['__weave_task', '__weave_event'],
    maxCalls: WEAVE_MAX_CALLS,
    dispatch: opts.dispatch,
  });
  try {
    const endpoint = await bridge.listen();
    const program = generateWeaveProgram(
      endpoint,
      { budgetUsd: opts.budgetUsd, tokens: opts.tokens ?? null, resultMarker: marker },
      script,
    );
    const env = scrubChildEnv(opts.baseEnv(), { VESTRA_RPC_SOCKET: endpoint.address });
    const res = await opts.environment.run({
      language: 'node',
      code: program,
      timeoutMs: opts.timeoutMs ?? WEAVE_DEFAULT_TIMEOUT_MS,
      cwd: opts.getCwd(),
      env,
      bridge: endpoint,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const line = res.stdout.split('\n').reverse().find((l) => l.includes(marker));
    if (line) {
      const json = line.slice(line.indexOf(marker) + marker.length);
      try {
        const parsed = JSON.parse(json) as {
          ok?: boolean; value?: unknown; error?: string; callBudgetExhausted?: boolean;
          paused?: boolean; pending?: { toolName?: string; contentHash?: string; nodeLabel?: string };
        };
        return {
          ok: parsed.ok === true,
          value: parsed.ok === true ? (parsed.value ?? null) : null,
          ...(parsed.error !== undefined ? { error: parsed.error } : {}),
          ...(parsed.callBudgetExhausted === true ? { callBudgetExhausted: true } : {}),
          ...(parsed.paused === true ? { paused: true } : {}),
          ...(parsed.paused === true && parsed.pending !== undefined ? { pendingNode: parsed.pending } : {}),
          stdout: res.stdout,
          timedOut: res.timedOut,
        };
      } catch {
        /* fall through to the no-result note */
      }
    }
    const note = res.timedOut ? 'weave script timed out' : `weave script produced no result (exit ${res.exitCode})`;
    return { ok: false, value: null, error: note, stdout: res.stdout, timedOut: res.timedOut };
  } finally {
    await bridge.close();
  }
}
