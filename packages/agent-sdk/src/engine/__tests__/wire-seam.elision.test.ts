/**
 * wire-seam.elision.test.ts — Harness-9 W4: every in-turn history rebuild goes
 * through the elision seam.
 *
 * native-harness.ts declares the turn's elision "decided ONCE per turn, frozen;
 * wire AND ledger share it". Eight sites honoured it. FIVE rebuilt the main loop's
 * `history` straight off `journal.project()`, skipping `wireMessages` entirely:
 *
 *   turn-decisions.ts   consultRecall (the Nami fence)
 *   turn-decisions.ts   appendSteerEntry (mid-task steer)
 *   turn-decisions.ts   injectStagedSteer (boundary steer poll)
 *   severed-stream.ts   sealSeveredRound (severed-stream re-issue)
 *   compaction-recovery.ts  recoverFromOverflow (reactive compaction retry)
 *
 * A SIXTH landed later: memory-sweep.ts runOffloopSweep, the end-of-task off-loop
 * sweep. It was scoped out of the first pass as a "pre-computed span", but it has
 * no span — it projects the WHOLE journal and reuses the loop's own system string
 * and tool schemas, by explicit design, to ride the prefix cache the turn just
 * wrote. That makes it the main prefix, not a side-call prefix, and its raw
 * projection was the OTHER half of the documented rollback cause below
 * ("sweep/side-calls rebuild raw journal"). The scoped-out span really is
 * offloop-usage.ts's `deps.trimmed`, which belongs to the SUGGESTION call and
 * does swap in its own tiny system prompt.
 *
 * WHY IT MATTERS. With elision on, the wire prefix is the ELIDED view. The moment
 * one of these fires, `history` becomes the RAW view and stays raw for the rest of
 * the turn; the next turn head re-projects elided. Prompt caches match an exact
 * prefix, so the session alternates prefixes and every turn becomes a cold write
 * at 1.25x where it was a 0.1x read. This is the documented cause of the 2026-08-13
 * CONTEXT_ELISION_V1 rollback ("sweep/side-calls rebuild raw journal ⇒ cache-miss
 * 8-10x"), and it also breaks ledger coherence in the direction #2600 exists to
 * prevent: the trigger measures the elided view while the raw bytes ship.
 *
 * Each case here drives the REAL function over a real Journal with a real frozen
 * elision and asserts the returned history carries the stub. The last case is the
 * ratchet that stops a sixth site from landing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultRecall, appendSteerEntry, injectStagedSteer, newRecallTurnState } from '../turn-decisions.js';
import { reissueSeveredRound, type SeveredRetryState } from '../severed-stream.js';
import { recoverFromOverflow } from '../compaction-recovery.js';
import { runOffloopSweep } from '../memory-sweep.js';
import { wireMessages, type FrozenElision } from '../context-elision.js';
import { elideProjection } from '../../kernel/compaction/elide.js';
import { createRunContext } from '../run-context.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { NativeConfig } from '../native-config.js';
import type { RoundState } from '../round-engine.js';
import type { ProviderHistory, Transport } from '../transport.js';

const dir = join(tmpdir(), `wire-seam-elision-${process.pid}`);
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.CONTEXT_ELISION_V1;
  delete process.env.NATIVE_STREAM_SEVERED_RETRY;
  await fs.rm(dir, { recursive: true, force: true });
});

/** The projection is a deterministic function of the entries, so a raw rebuild and
 *  an elided one are trivially distinguishable in the returned history. */
function projectingTransport(): Transport {
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    historyFromJournal: (entries: JournalEntry[]) =>
      entries.map((e) => ({ role: e.payload.type, payload: e.payload })) as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    buildTools: (raw) => raw as unknown[],
    classifyError: (err) => (err as { classified?: unknown }).classified as never,
  };
  return t as Transport;
}

/** The projecting transport plus the two methods a side call needs, so the REAL
 *  runOffloopSweep can be driven and the history it actually SENDS inspected. */
function sweepTransport(): { transport: Transport; sent: () => ProviderHistory } {
  let sent: ProviderHistory;
  const t = {
    ...projectingTransport(),
    callModel: (p: { history: ProviderHistory }) => { sent = p.history; return {}; },
    readStream: async function* () { yield { kind: 'text', text: 'FACT [preference] ships on Fridays' }; },
  } as unknown as Transport;
  return { transport: t, sent: () => sent };
}

/** A journal holding a tool_use + a tool_result big enough for the eliding
 *  projection to stub (DEFAULT_ELISION_POLICY.minResultTokens is 500). */
async function seeded(taskId: string): Promise<Journal> {
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });
  const base = { taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', timestamp: '' };
  await journal.append({ ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text: 'hi' }] } });
  await journal.append({
    ...base, principal: { kind: 'agent', agentId: 'native' },
    payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Read', input: { file_path: '/x' } },
  });
  await journal.append({
    ...base, principal: { kind: 'agent', agentId: 'native' },
    payload: { type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text', text: 'B'.repeat(20_000) }] },
  });
  return journal;
}

/** A real frozen elision over the journal, built by the SHIPPED elideProjection with
 *  an explicit cut (the cut POLICY is elide.test.ts's job; here we need real stubs). */
async function realElision(journal: Journal): Promise<FrozenElision> {
  const cut = { resultCutTokens: 1_000_000, imageCutTokens: 1_000_000, strideTokens: 1000, anchor: null };
  const outcome = elideProjection((await journal.project()).messages, cut, { taskId: journal.taskId });
  expect(outcome.replacements.size).toBeGreaterThan(0);
  return {
    replacements: outcome.replacements,
    cut,
    elidedResults: outcome.elidedResults,
    elidedImages: outcome.elidedImages,
    freedTokens: outcome.freedTokens,
  };
}

const ctxFor = (journal: Journal, cfg: NativeConfig): HarnessContext<NativeConfig> =>
  ({ taskId: journal.taskId, sessionId: 's', cwd: '', model: 'm', config: cfg, signal: new AbortController().signal }) as HarnessContext<NativeConfig>;

const asJson = (h: ProviderHistory): string => JSON.stringify(h);

/** The wire form the turn head would have built — what every rebuild must match. */
async function expectedWire(journal: Journal, transport: Transport, elision: FrozenElision): Promise<string> {
  return asJson(transport.historyFromJournal(wireMessages((await journal.project()).messages, elision)));
}

const freshRoundState = (): RoundState => ({
  assistantText: 'partial answer', thinkingBlocks: [], toolUses: [], roundAppended: false,
  inToolBatch: false, stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});

describe('every in-turn history rebuild projects through the elision seam', () => {
  it('consultRecall: the journaled Nami fence re-projects ELIDED, not raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    const journal = await seeded('recall');
    const transport = projectingTransport();
    const elision = await realElision(journal);
    const cfg = { journal } as NativeConfig;
    const seam = { readRelevant: async () => 'a remembered fact', maxPerTurn: 2 };

    const out = await consultRecall(
      seam as never, cfg, ctxFor(journal, cfg), transport, newRecallTurnState(),
      [] as unknown as ProviderHistory, elision,
    );

    expect(asJson(out)).toContain('[elided:');
    expect(asJson(out)).not.toContain('BBBBBBBB');
    expect(asJson(out)).toBe(await expectedWire(journal, transport, elision));
  });

  it('appendSteerEntry: a mid-task steer re-projects ELIDED, not raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    const journal = await seeded('steer-append');
    const transport = projectingTransport();
    const elision = await realElision(journal);
    const cfg = { journal } as NativeConfig;

    const out = await appendSteerEntry(
      cfg, ctxFor(journal, cfg), transport, [] as unknown as ProviderHistory, 'do it differently', elision,
    );

    expect(asJson(out)).toContain('[elided:');
    expect(asJson(out)).not.toContain('BBBBBBBB');
    expect(asJson(out)).toBe(await expectedWire(journal, transport, elision));
  });

  it('injectStagedSteer: the boundary poll re-projects ELIDED, not raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    const journal = await seeded('steer-poll');
    const transport = projectingTransport();
    const elision = await realElision(journal);
    const cfg = { journal, pollSteer: () => ({ text: 'and also this' }) } as unknown as NativeConfig;

    const out = await injectStagedSteer(
      cfg, ctxFor(journal, cfg), transport, [] as unknown as ProviderHistory, true, elision,
    );

    expect(out.steered).toBe(true);
    expect(asJson(out.history)).toContain('[elided:');
    expect(asJson(out.history)).not.toContain('BBBBBBBB');
    expect(asJson(out.history)).toBe(await expectedWire(journal, transport, elision));
  });

  it('reissueSeveredRound: the sealed continuation re-projects ELIDED, not raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    process.env.NATIVE_STREAM_SEVERED_RETRY = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = await seeded('severed');
    const transport = projectingTransport();
    const elision = await realElision(journal);
    const cfg = { journal, retry: { backoffMs: 0 } } as NativeConfig;
    const severed = { classified: { kind: 'network_error', message: 'stream severed', raw: { subtype: 'network_error', errors: [] } } };

    const out = await reissueSeveredRound(
      severed, cfg, ctxFor(journal, cfg), transport, freshRoundState(), [], [] as unknown as ProviderHistory,
      { reissues: 0 } as SeveredRetryState, elision,
    );

    if (!out.reissue) throw new Error('expected a re-issue');
    expect(asJson(out.history)).toContain('[elided:');
    expect(asJson(out.history)).not.toContain('BBBBBBBB');
    expect(asJson(out.history)).toBe(await expectedWire(journal, transport, elision));
  });

  it('recoverFromOverflow: the post-compaction retry re-projects ELIDED, not raw', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    const journal = await seeded('overflow');
    const transport = projectingTransport();
    const elision = await realElision(journal);
    const cfg = { journal, compaction: {} } as NativeConfig;
    const ctx = ctxFor(journal, cfg);

    const out = await recoverFromOverflow({
      err: { classified: { kind: 'context_exceeded', message: 'too big', raw: { subtype: 'context_exceeded', errors: [] } } },
      ctx, cfg, transport,
      rc: createRunContext(journal.taskId),
      alreadyAttempted: false,
      // Required by the contract (a refusal must never be silent); unreached here —
      // this drive's runManualCompaction always resolves.
      onRefused: async () => [],
      runRecovery: async () => ({
        event: { kind: 'raw', engine: 'native', event: 'agent:compacted', data: {} },
        compactionCostUsd: 0,
        compactionUsage: { inputTokens: 0, outputTokens: 0 },
        compactionModel: 'm',
      }),
      elision,
    });

    if (!out.retry) throw new Error('expected a post-compaction retry');
    expect(asJson(out.history)).toContain('[elided:');
    expect(asJson(out.history)).not.toContain('BBBBBBBB');
    expect(asJson(out.history)).toBe(await expectedWire(journal, transport, elision));
  });

  it('runOffloopSweep: the end-of-task sweep sends the ELIDED wire, not the raw journal', async () => {
    process.env.CONTEXT_ELISION_V1 = '1';
    const journal = await seeded('sweep');
    const { transport, sent } = sweepTransport();
    const elision = await realElision(journal);

    const out = await runOffloopSweep({
      transport, journal, model: 'm', system: 'S', providerTools: [], elision,
    });
    expect(out.status).toBe('ok');

    // The prefix the sweep SENT is the turn head's wire form, with the sweep prompt
    // as the only trailing user message. Byte-compared, not inferred.
    const wire = JSON.parse(await expectedWire(journal, transport, elision)) as unknown[];
    wire.push({ role: 'user' });
    expect(asJson(sent())).toBe(JSON.stringify(wire));
    expect(asJson(sent())).toContain('[elided:');
    expect(asJson(sent())).not.toContain('BBBBBBBB');
  });

  it('runOffloopSweep with elision ABSENT is byte-identical to the raw projection it replaced', async () => {
    const journal = await seeded('sweep-off');
    const { transport, sent } = sweepTransport();

    await runOffloopSweep({
      transport, journal, model: 'm', system: 'S', providerTools: [], elision: null,
    });

    // The historic path, verbatim: historyFromJournal(project().messages) + pushUser.
    const raw = transport.historyFromJournal((await journal.project()).messages) as unknown[];
    raw.push({ role: 'user' });
    expect(asJson(sent())).toBe(JSON.stringify(raw));
    expect(asJson(sent())).toContain('BBBBBBBB');
  });

  it('with elision ABSENT every one of them is byte-identical to the raw projection', async () => {
    // The OFF axis: threading the seam must not change a single byte when there is
    // nothing elided — this is what keeps the flag a true control.
    const journal = await seeded('off-axis');
    const transport = projectingTransport();
    const cfg = { journal } as NativeConfig;
    const raw = asJson(transport.historyFromJournal((await journal.project()).messages));

    const steered = await appendSteerEntry(cfg, ctxFor(journal, cfg), transport, [] as unknown as ProviderHistory, 's', null);
    // One user entry was appended by the steer; everything BEFORE it is untouched.
    expect(asJson(steered)).toContain('BBBBBBBB');
    expect(asJson(steered).startsWith(raw.slice(0, raw.length - 1))).toBe(true);
  });
});

// ── the ratchet ──────────────────────────────────────────────────────────────

/**
 * Find every `historyFromJournal(<expr>)` whose argument expression rebuilds off a
 * RAW `journal.project()`.
 *
 * BALANCED-PAREN, NOT LINE-ORIENTED. The first version of this matched one physical
 * line, which meant the identical call wrapped across lines by a formatter walked
 * straight past it — and `round-engine.ts` writes the *compliant* call in exactly
 * that wrapped shape, so the wrapped form is normal here, not exotic. Formatting must
 * never decide whether a guard fires.
 *
 * INDIRECTION IS SEEN TOO, and closing it was not academic. The scan used to be blind
 * to a projection first parked in a local (`const m = (await j.project()).messages; …
 * historyFromJournal(m)`), because `.project()` never appears inside the argument. That
 * blind spot held the ONE live offender in the tree — memory-sweep.ts's runOffloopSweep
 * wrote exactly that shape — so the guard was green over the only thing that was
 * actually wrong, while catching every case that was already fine.
 * `rawProjectionBindings` closes it: an argument that NAMES a local bound to a raw
 * projection is the raw form.
 *
 * WHAT IT STILL CANNOT SEE, stated plainly so the comment does not outrun the code.
 * This is a textual scan, not a parser, and it is blind in three distinct ways:
 *
 *   1. DERIVATION, PARAMETERS, AND SCOPE. Taint follows a binding and pure ALIASES of
 *      it (`const m = p.messages`), never a transforming call: `const span =
 *      someWindow(messages)` is deliberately clean, because that IS the
 *      pre-computed-span exemption below. A PARAMETER is not a binding either — a
 *      projection handed in as an argument (`function build(messages) { …
 *      historyFromJournal(messages) }`) is judged at the CALLER, which is the same
 *      treatment offloop-usage.ts's `deps.trimmed` gets and the same reason it is
 *      clean. The binding set is FILE-scoped, not function-scoped, and that cuts BOTH
 *      ways — the previous wording named only the harmless half. WITHIN one file two
 *      functions that both use the name `messages` share taint: over-reporting, which
 *      FAILS CLOSED. SPLIT ACROSS FILES the same rebuild vanishes, and that direction
 *      FAILS OPEN. File B holds the call and takes the entries as a PARAMETER, so it
 *      binds nothing. File A holds the binding — `const { messages } = await
 *      j.project()` — and hands it to B's helper, so it never names
 *      historyFromJournal. Neither half trips the scan; together they are exactly the
 *      raw rebuild this exists to catch. Measured, with the concatenation as the
 *      positive control: those same two functions joined into ONE file ARE flagged, so
 *      this is the file boundary and not a dead scan.
 *
 *      The residual is narrow rather than theoretical-only: it takes a brand-new
 *      rebuild helper, outside the six that already take `elision` REQUIRED, plus a
 *      caller in a different file. Closing it needs cross-module dataflow, which is a
 *      compiler — and the belt for it is the same one that makes the six safe. The
 *      signature is load-bearing; this scan is the backstop for a module that routes
 *      through no helper at all, and within a file it now catches that.
 *
 *   2. THE WALK IS CONTENT-BLIND. It counts every paren, including ones inside string
 *      literals and comments. The two directions are NOT symmetric, and the asymmetry
 *      is the part worth knowing:
 *        - a stray `)` in a string or comment closes the walk EARLY, truncating the
 *          argument text, so a guilty call can slip through — this direction FAILS
 *          OPEN;
 *        - a stray `(` extends the walk past the real close, over-capturing, which at
 *          worst reports an innocent call — this direction FAILS CLOSED and errs safe.
 *
 *   3. THE `wireMessages` EXEMPTION IS A BAG OF WORDS over the captured text, so it is
 *      disarmed by the substring appearing anywhere for any reason: in a comment, in a
 *      *different* nested argument, or inside a longer identifier such as
 *      `wireMessagesCount`.
 *
 * The two shapes that arise BY ACCIDENT — the same call wrapped across lines by a
 * formatter, and a projection parked in a local — are both caught now; what is left
 * needs deliberately constructed content. The load-bearing belt is still the signature,
 * not this test: `projectWire` is the only sanctioned constructor, and all SIX rebuild
 * helpers (the five above plus `runOffloopSweep`) take `elision` as a REQUIRED
 * parameter, so a new caller cannot reach the raw form without meaning to. This scan
 * exists for the case a signature cannot reach: a brand-new engine module that projects
 * and builds history itself, routing through no helper at all.
 *
 * Deliberately out of scope: a pre-computed span (compaction's own window,
 * offloop-usage.ts's trimmed suggestion slice) is a SIDE-CALL prompt with its own
 * prefix, not the main wire, so it cannot bust the main cache. The off-loop SWEEP is
 * not one of those — it projects the whole journal onto the loop's own prefix, which
 * is why it is now a pinned site above rather than an exemption.
 */
/**
 * The identifiers `src` binds to a RAW journal projection — the belt against
 * INDIRECTION. `const { messages } = await j.project()`, `const { messages: m } = …`,
 * `const p = await j.project()` and `const m = (await j.project()).messages` all bind,
 * and so does a plain reassignment. An initializer that already goes through
 * `wireMessages` binds the WIRE view, not the raw one, and is deliberately not
 * collected — otherwise the compliant form would taint its own result.
 *
 * Taint then propagates through PURE ALIASES only (`const m = p.messages`), to a
 * fixpoint. Renaming a projection is not transforming it; passing it through a call is,
 * and that is exactly the pre-computed-span exemption.
 */
export function rawProjectionBindings(src: string): Set<string> {
  const BINDING = /(?:(?:const|let|var)\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*([^;]*);/g;
  const ALIAS = /^\s*\(?\s*(?:await\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?(?:\.[\w$]+)?\s*\)?\s*$/;
  const decls = [...src.matchAll(BINDING)].map((m) => ({
    names: m[1].startsWith('{')
      ? [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)].map((d) => d[2] ?? d[1])
      : [m[1]],
    init: m[2],
  }));
  const bound = new Set<string>();
  for (const d of decls) {
    if (/\.project\(\)/.test(d.init) && !d.init.includes('wireMessages')) for (const n of d.names) bound.add(n);
  }
  for (let pass = 0; pass < decls.length; pass++) {
    let grew = false;
    for (const d of decls) {
      const alias = d.init.match(ALIAS);
      if (!alias || !bound.has(alias[1])) continue;
      for (const n of d.names) if (!bound.has(n)) { bound.add(n); grew = true; }
    }
    if (!grew) break;
  }
  return bound;
}

export function findRawProjectionSites(src: string): number[] {
  const CALL = 'historyFromJournal(';
  const bound = rawProjectionBindings(src);
  const hits: number[] = [];
  for (let i = src.indexOf(CALL); i !== -1; i = src.indexOf(CALL, i + 1)) {
    const open = i + CALL.length - 1;
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    const args = src.slice(open + 1, j);
    const namesRaw = (args.match(/[A-Za-z_$][\w$]*/g) ?? []).some((r) => bound.has(r));
    if ((/\.project\(\)/.test(args) || namesRaw) && !args.includes('wireMessages')) {
      hits.push(src.slice(0, i).split('\n').length); // 1-based line of the call
    }
  }
  return hits;
}

/** Every `.ts` under engine/, recursively, minus the test tree (whose fixtures
 *  contain the raw form ON PURPOSE — see the ELIDED-vs-raw cases above). */
async function engineSources(dir: string, rel = ''): Promise<Array<{ name: string; src: string }>> {
  const out: Array<{ name: string; src: string }> = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (d.name === '__tests__' || d.name === 'node_modules') continue;
      out.push(...(await engineSources(join(dir, d.name), `${rel}${d.name}/`)));
    } else if (d.name.endsWith('.ts')) {
      out.push({ name: `${rel}${d.name}`, src: await fs.readFile(join(dir, d.name), 'utf8') });
    }
  }
  return out;
}

describe('findRawProjectionSites — the detector itself', () => {
  const wrap = (body: string): string => `async function f() {\n${body}\n}\n`;

  it('flags the single-line raw rebuild', () => {
    expect(findRawProjectionSites(wrap(
      '  history = transport.historyFromJournal((await cfg.journal.project()).messages);',
    ))).toHaveLength(1);
  });

  it('flags the SAME call wrapped across lines — formatting must not disarm the guard', () => {
    // This is the shape round-engine.ts already uses for the COMPLIANT call, so a
    // wrapped raw one is what a formatter produces, not what an evader writes.
    expect(findRawProjectionSites(wrap(
      '  history = transport.historyFromJournal(\n' +
      '    (await cfg.journal.project()).messages,\n' +
      '  );',
    ))).toHaveLength(1);
  });

  it('flags a raw rebuild nested inside a ternary with its own parens', () => {
    expect(findRawProjectionSites(wrap(
      '  const h = cfg.journal\n' +
      '    ? transport.historyFromJournal((await cfg.journal.project()).messages)\n' +
      '    : inMemory;',
    ))).toHaveLength(1);
  });

  it('passes the compliant wireMessages form, single-line and wrapped', () => {
    expect(findRawProjectionSites(wrap(
      '  history = transport.historyFromJournal(wireMessages((await cfg.journal.project()).messages, elision));',
    ))).toEqual([]);
    expect(findRawProjectionSites(wrap(
      '  const projected = transport.historyFromJournal(\n' +
      '    wireMessages((await cfg.journal.project()).messages, deps.elision ?? null),\n' +
      '  );',
    ))).toEqual([]);
  });

  // ── INDIRECTION: the hole that held the one live offender ──────────────────
  // Each of these is the shape memory-sweep.ts actually wrote (or a one-token variant
  // of it), and every one of them returned [] before rawProjectionBindings existed.

  it('flags a DESTRUCTURED projection parked in a local — the exact memory-sweep shape', () => {
    expect(findRawProjectionSites(wrap(
      '  const { messages } = await deps.journal.project();\n' +
      '  history = deps.transport.historyFromJournal(messages);',
    ))).toEqual([3]);
  });

  it('flags a RENAMED destructure, so the guard is not keyed to the word "messages"', () => {
    expect(findRawProjectionSites(wrap(
      '  const { messages: entries } = await j.project();\n' +
      '  const h = t.historyFromJournal(entries);',
    ))).toHaveLength(1);
  });

  it('flags a member-access binding, and the projection object used directly', () => {
    expect(findRawProjectionSites(wrap(
      '  const m = (await j.project()).messages;\n' +
      '  const h = t.historyFromJournal(m);',
    ))).toHaveLength(1);
    expect(findRawProjectionSites(wrap(
      '  const p = await j.project();\n' +
      '  const h = t.historyFromJournal(p.messages);',
    ))).toHaveLength(1);
  });

  it('follows a pure ALIAS hop — renaming a projection does not launder it', () => {
    expect(findRawProjectionSites(wrap(
      '  const p = await j.project();\n' +
      '  const m = p.messages;\n' +
      '  const h = t.historyFromJournal(m);',
    ))).toHaveLength(1);
  });

  it('flags a projection parked by plain REASSIGNMENT, not just a declaration', () => {
    expect(findRawProjectionSites(wrap(
      '  let m: JournalEntry[] = [];\n' +
      '  m = (await j.project()).messages;\n' +
      '  const h = t.historyFromJournal(m);',
    ))).toHaveLength(1);
  });

  it('passes a local that WAS laundered through the seam before the call', () => {
    // The compliant indirect form: the belt must not fire on the fix for itself.
    expect(findRawProjectionSites(wrap(
      '  const { messages } = await deps.journal.project();\n' +
      '  const view = wireMessages(messages, elision);\n' +
      '  history = deps.transport.historyFromJournal(view);',
    ))).toEqual([]);
  });

  it('passes a DERIVED span built from a projection — that is the exemption, not a miss', () => {
    // compaction-run.ts summarizeSpan and offloop-usage.ts runSuggestionCall are this
    // shape: a transforming call produces a side-call prompt with its own prefix.
    expect(findRawProjectionSites(wrap(
      '  const { messages } = await j.project();\n' +
      '  const span = stripInvisibleControlTurns(messages);\n' +
      '  const h = t.historyFromJournal(span);',
    ))).toEqual([]);
  });

  it('passes a pre-computed span — a side-call prompt is not the main prefix', () => {
    expect(findRawProjectionSites(wrap(
      '  const history = transport.historyFromJournal(span);',
    ))).toEqual([]);
    expect(findRawProjectionSites(wrap(
      '  history = deps.transport.historyFromJournal(deps.trimmed);',
    ))).toEqual([]);
  });

  it('reports the line of the CALL, so the failure message points somewhere useful', () => {
    expect(findRawProjectionSites(
      'a\nb\nc\nconst h = t.historyFromJournal((await j.project()).messages);\n',
    )).toEqual([4]);
  });
});

describe('ratchet: no engine module rebuilds provider history off the RAW journal', () => {
  it('every historyFromJournal(project()) under engine/ goes through the wire seam', async () => {
    const engineDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = await engineSources(engineDir);
    // Positive controls: the sweep found the modules AND recursed past the top level
    // (engine/replay/ was unswept while the walk was flat).
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.name.startsWith('replay/'))).toBe(true);
    expect(files.some((f) => f.src.includes('historyFromJournal'))).toBe(true);

    const offenders = files.flatMap((f) => findRawProjectionSites(f.src).map((n) => `${f.name}:${n}`));
    expect(
      offenders,
      `These rebuild provider history off the RAW journal, bypassing the frozen elision.\n` +
        `Use projectWire(journal, transport, elision) instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
