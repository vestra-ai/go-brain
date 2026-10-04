/**
 * Every path that dispatches a tool must hand the dispatcher an execute context that
 * can carry the injection screen. A dispatch site that passes `undefined` hands the
 * runner a side-effecting call on a possibly-tainted turn with NO screen — and,
 * because an unscreened turn writes no `injection_screen_events` row, its silence
 * reads as coverage rather than as a blind spot. That is exactly the 2026-08-23 shape
 * (#2861): all five re-dispatch sites in `continue-interaction.ts` were blind, a HITL
 * resume re-executed tools with no ask and no verdict, and nothing in the data said so.
 *
 * This suite DERIVES the dispatch sites by walking the agent-sdk tree for
 * `gateAndDispatchTool(` rather than listing them. An earlier version of this guard
 * asserted the invariant over ONE hardcoded file, which is the same mistake the
 * turn-ceiling mint sites made: a green test claiming "every re-dispatch" while whole
 * lanes sat uncovered. Deriving means a FUTURE dispatch site fails here until it
 * threads a context, which is the only version of this test worth having.
 *
 * THE RULE IS POSITIONAL, NOT TEXTUAL. `execCtx` is the 7th parameter of
 * `gateAndDispatchTool`, and the sites spell it half a dozen ways — `screenCtx(opts)`,
 * `deps.execCtx`, `deps.sub.execCtx`, `dispatchExecCtx`, an inline object literal.
 * Requiring the word `injectionScreen` would therefore fail correct sites that
 * delegate to a context built elsewhere. What is checkable, and what actually matters,
 * is that the argument EXISTS and is not literally `undefined`: a site passing
 * `undefined` can never be screened no matter what the seam does, while a site passing
 * a context inherits whatever that context carries.
 *
 * WHAT THIS DOES NOT PROVE, said plainly so nobody reads more into a green run: it is
 * a source lint, so it shows the context is PASSED, not that `injectionScreen` is
 * populated on it at runtime. The behavioural half lives in
 * `continue-interaction.screen.test.ts` and `tool-dispatcher.screen.test.ts`, which
 * drive real dispatches against a recording seam. This exists for the sites those
 * tests do not call yet — the ones added next month.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SDK_SRC = join(__dirname, '..', '..');
const CALL = 'gateAndDispatchTool(';

/** Source files only: tests are allowed to dispatch bare, since a test that wants an
 *  unscreened dispatch is exercising exactly that case. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...tsFilesUnder(abs));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(abs);
  }
  return out;
}

/** The argument list of one call, paren-matched from the opening paren. String and
 *  comment content is not parsed — the arguments here are identifiers and object
 *  literals, and a paren inside a string would only ever widen the slice. */
function argsOf(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  throw new Error('unbalanced parentheses in a gateAndDispatchTool call');
}

/** Split an argument list on TOP-LEVEL commas, so an object literal or a nested call
 *  counts as one argument rather than several. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((a) => a.replace(/\/\/[^\n]*/g, '').trim()).filter((a) => a.length > 0);
}

interface DispatchSite {
  file: string;
  line: number;
  /** The 7th positional argument — `execCtx` — or undefined when none was passed. */
  execCtx: string | undefined;
}

function dispatchSites(): DispatchSite[] {
  const sites: DispatchSite[] = [];
  for (const file of tsFilesUnder(SDK_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (let i = src.indexOf(CALL); i !== -1; i = src.indexOf(CALL, i + 1)) {
      // Skip the declaration itself and any re-export/import of the name.
      const lineStart = src.lastIndexOf('\n', i) + 1;
      const prefix = src.slice(lineStart, i);
      if (/\b(export\s+async\s+function|async\s+function|function|import)\b/.test(prefix)) continue;

      const args = topLevelArgs(argsOf(src, i + CALL.length - 1));
      sites.push({
        file: file.slice(SDK_SRC.length + 1),
        line: src.slice(0, i).split('\n').length,
        execCtx: args[6],
      });
    }
  }
  return sites;
}

describe('every tool-dispatch site can carry the injection screen', () => {
  const sites = dispatchSites();

  it('derives the dispatch sites from the tree, and finds the known ones', () => {
    // A rename or a refactor that moved these calls would otherwise leave this suite
    // passing while checking nothing — the standard failure of a source lint. The
    // floor is the five re-dispatch sites plus the batch/subagent/in-process lanes.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    const files = new Set(sites.map((s) => s.file));
    expect([...files]).toEqual(
      expect.arrayContaining([
        'engine/continue-interaction.ts',
        'engine/round-tool-batch.ts',
        'engine/subagent-runner.ts',
        'engine/in-process-dispatcher.ts',
      ]),
    );
  });

  it('passes an execute context at every one of them', () => {
    const blind = sites
      .filter((s) => s.execCtx === undefined || s.execCtx === 'undefined')
      .map((s) => `${s.file}:${s.line} (execCtx=${s.execCtx ?? 'omitted'})`);

    expect(
      blind,
      'these gateAndDispatchTool call sites pass no execute context, so the injection ' +
        'screen can never reach them: a side-effecting tool on a TAINTED turn would ' +
        'execute unscreened and write NO row, which is the #2861 blind spot. Thread a ' +
        'context (screenCtx(opts) in continue-interaction.ts, deps.execCtx elsewhere).',
    ).toEqual([]);
  });

  it('keeps the seam reachable from the context type, so threading one is enough', () => {
    // The lint above is about call sites rather than about a mechanism, and that is
    // only sound while `execCtx` is in fact where the seam rides. If this declaration
    // moves, the lint's premise is gone and someone should notice here first.
    const dispatcher = readFileSync(join(SDK_SRC, 'engine', 'tool-dispatcher.ts'), 'utf8');
    expect(dispatcher).toContain('injectionScreen?: InjectionScreenSeam');
    expect(dispatcher).toContain('if (execCtx?.injectionScreen)');
  });
});
