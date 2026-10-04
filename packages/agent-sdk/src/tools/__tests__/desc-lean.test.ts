/**
 * TOOL_DESC_LEAN_V1 (harness to nine, T1b to 12K) — the safe subset of TOOL_DESC_TRIM_V1.
 * TOOL_DESC_TRIM_V1 stays off: its staging drill drifted (GPT split parallel helpers, Gemini
 * grepped through Bash, Sonnet backgrounded once in three) and its bound strip turned Monitor,
 * TaskOutput and stop_app strict on the OpenAI lanes. This flag keeps only what cannot change
 * what a model does:
 *  1. OFF (unset or any non-opt-in value) is byte-identical.
 *  2. ON cuts only what a tool says twice: each lean description is the full one minus exactly
 *     one passage, and every clause of it is a parameter's own text; Grep's parameters lose only
 *     their ripgrep notes (multiline says in words that patterns can span lines). Read's words,
 *     and every "only", are untouched (#4251 review H1).
 *  3. ON changes no tool's OpenAI strict status, here and across the whole bench catalog: the
 *     safe-integer bounds go only where the strict gate answers the same either way.
 *  4. TOOL_DESC_TRIM_V1, when on, wins.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isOpenAIStrictCompatible } from '../../contract/openai-strict-schema.js';
import { toToolJsonSchema, type JsonSchema } from '../../contract/tool-json-schema.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';
import { TOOL_DESCRIPTIONS } from '../descriptions/index.js';
import { LEAN_TOOL_DESCRIPTIONS, TRIMMED_TOOL_DESCRIPTIONS } from '../descriptions/trimmed.js';
import { makeBashTool, makeGrepTool, makeReadTool, taskOutputToolOptions } from '../index.js';
import type { RawToolOptions } from '../tool-types.js';

const LEAN = 'TOOL_DESC_LEAN_V1';
const TRIM = 'TOOL_DESC_TRIM_V1';
const saved = { [LEAN]: process.env[LEAN], [TRIM]: process.env[TRIM] };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
function withFlags<T>(lean: string | undefined, fn: () => T, trim?: string): T {
  for (const [k, v] of [[LEAN, lean], [TRIM, trim]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn();
}

const BUILDERS: Record<'Bash' | 'Read' | 'Grep', () => RawToolOptions> = {
  Bash: () => makeBashTool(() => '/tmp', 'task-1'),
  Read: () => makeReadTool(() => '/tmp'),
  Grep: () => makeGrepTool(() => '/tmp'),
};
const NAMES = Object.keys(BUILDERS) as Array<keyof typeof BUILDERS>;

/** The wire view: description + converted schema (converted under the same flags). */
function wire(name: keyof typeof BUILDERS, lean: string | undefined): { description: string; schema: JsonSchema } {
  return withFlags(lean, () => {
    const t = BUILDERS[name]();
    return { description: t.description, schema: toToolJsonSchema(t.parameters) };
  });
}
const props = (s: JsonSchema): Record<string, { description?: string }> =>
  (s as { properties: Record<string, { description?: string }> }).properties;

/** Every `description` and the two safe-integer bounds removed: the schema's shape. */
function shapeOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' && typeof v === 'string') continue;
    if (k === 'minimum' && v === -Number.MAX_SAFE_INTEGER) continue;
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue;
    out[k] = shapeOf(v);
  }
  return out;
}
const SAFE = String(Number.MAX_SAFE_INTEGER);

/** The one passage each lean description drops: its parameters say every clause of it. */
const DROPPED = {
  // "Give a short `description` in active voice" stays: it drives the step labels the person reads.
  Bash: '; `timeout` (ms, max 600000) bounds a long command',
  Grep:
    'Narrow with `glob` or `type`; `output_mode` is "files_with_matches" (default), "content" or "count"; ' +
    '`-A`/`-B`/`-C`/`context` add context lines, `-n` line numbers, `-i` ignores case, `-o` gives only the ' +
    'match, `multiline` spans lines, `head_limit`/`offset` page. ',
};

describe('TOOL_DESC_LEAN_V1 off: byte-identical', () => {
  it('unset or any non-opt-in value: TOOL_DESCRIPTIONS exactly, and the schema keeps its bounds', () => {
    const base = Object.fromEntries(NAMES.map((n) => [n, JSON.stringify(wire(n, undefined))]));
    for (const value of ['false', '0', 'TRUE', '']) {
      for (const name of NAMES) expect(JSON.stringify(wire(name, value)), `${name} at ${JSON.stringify(value)}`).toBe(base[name]);
    }
    for (const name of NAMES) expect(wire(name, undefined).description).toBe(TOOL_DESCRIPTIONS[name]);
    expect(JSON.stringify(wire('Grep', undefined).schema)).toContain(SAFE);
  });
});

describe('TOOL_DESC_LEAN_V1 on: only what a tool says twice goes', () => {
  it('Bash and Grep each drop exactly one passage of their full text; nothing else is reworded', () => {
    // Mutation: any further trim (the T3 words) breaks the equality.
    expect(LEAN_TOOL_DESCRIPTIONS.Bash).toBe(TOOL_DESCRIPTIONS.Bash.replace(DROPPED.Bash, ''));
    expect(LEAN_TOOL_DESCRIPTIONS.Grep).toBe(TOOL_DESCRIPTIONS.Grep.replace(DROPPED.Grep, ''));
    expect(TOOL_DESCRIPTIONS.Bash).toContain(DROPPED.Bash);
    expect(TOOL_DESCRIPTIONS.Grep).toContain(DROPPED.Grep);
    expect(wire('Bash', 'true').description).toBe(LEAN_TOOL_DESCRIPTIONS.Bash);
    expect(wire('Grep', 'true').description).toBe(LEAN_TOOL_DESCRIPTIONS.Grep);
    expect(wire('Read', 'true').description).toBe(TOOL_DESCRIPTIONS.Read);
  });

  it('every clause of a dropped sentence is a parameter of that tool saying it', () => {
    const bash = props(wire('Bash', 'true').schema);
    expect(bash.description?.description).toMatch(/active voice/);
    expect(bash.timeout?.description).toMatch(/milliseconds \(max 600000\)/);
    const grep = props(wire('Grep', 'true').schema);
    for (const p of ['glob', 'type', 'output_mode', '-A', '-B', '-C', 'context', '-n', '-i', '-o', 'multiline', 'head_limit', 'offset']) {
      expect(grep[p]?.description, p).toBeTruthy();
    }
    expect(grep.output_mode?.description).toContain('"files_with_matches" (default)');
    expect(grep.head_limit?.description).toContain('Defaults to 250');
  });

  it('every behavioural line stays word for word', () => {
    const bash = wire('Bash', 'true').description;
    for (const line of [
      'This is the primitive work you do directly',
      // Mutation: drop it again (the #4251 first cut) → the UI's step labels lose their source.
      'Give a short `description` in active voice.',
      'set `run_in_background: true`: you get a `task_id` at once and read, feed or stop it with the process tool',
      're-run with `> out.txt 2>&1` and Read that file with `offset`/`limit`',
      'To find files or search inside them use Glob and Grep, not find/grep/cat/head/tail',
    ]) expect(bash).toContain(line);
    const grep = wire('Grep', 'true').description;
    for (const line of ['To find files by name, use Glob.', 'A capped result ends with the shown range and the next `offset`.', 'Faster than grep via Bash, and skips ignored files.']) {
      expect(grep).toContain(line);
    }
    expect(wire('Read', 'true').description).toContain('Use `offset` and `limit` only for a file too big to read in one go');
    // Read's parameters keep their "only", word for word (Claude Code's own ReadInput text).
    const read = props(wire('Read', 'true').schema);
    for (const p of ['offset', 'limit']) expect(read[p]?.description, p).toContain('Only provide if the file is too large to read at once.');
  });

  it('Grep loses only its ripgrep notes, each parameter exactly; Read loses no word at all', () => {
    const off = props(wire('Grep', undefined).schema);
    const on = props(wire('Grep', 'true').schema);
    expect(Object.keys(on)).toEqual(Object.keys(off));
    for (const [p, full] of Object.entries(off)) {
      // Mutation: lose any other word (a default, a "Requires output_mode") → this equality fails.
      const expected = p === 'multiline'
        ? 'Enable multiline mode where . matches newlines and patterns can span lines.'
        : (full.description ?? '').replace(/ ?\(rg [^)]*\)| — maps to rg --glob/g, '');
      expect(on[p]?.description, p).toBe(expected);
    }
    expect(Object.values(on).map((x) => x.description ?? '').join('\n')).not.toMatch(/\brg\b/);
    const readOff = props(wire('Read', undefined).schema);
    const readOn = props(wire('Read', 'true').schema);
    for (const p of Object.keys(readOff)) expect(readOn[p]?.description, p).toBe(readOff[p]?.description);
  });

  it('each tool costs fewer tokens on the wire', () => {
    for (const name of NAMES) {
      const cost = (lean: string | undefined) => estimateTokens(JSON.stringify(wire(name, lean)));
      expect(cost('true'), name).toBeLessThan(cost(undefined));
    }
  });
});

describe('TOOL_DESC_LEAN_V1 and OpenAI strict mode: no flip anywhere', () => {
  it('the shape (keys, types, enums, required, nullability, real bounds) is identical to off', () => {
    for (const name of NAMES) expect(shapeOf(wire(name, 'true').schema), name).toEqual(shapeOf(wire(name, undefined).schema));
  });

  it('Bash, Read and Grep lose the safe-integer bounds and keep their strict status', () => {
    for (const name of NAMES) {
      const on = wire(name, 'true').schema;
      expect(JSON.stringify(on), name).not.toContain(SAFE);
      expect(isOpenAIStrictCompatible(on), name).toBe(isOpenAIStrictCompatible(wire(name, undefined).schema));
    }
  });

  it('TaskOutput keeps its bounds: dropping them would make it strict (TOOL_DESC_TRIM_V1 did)', () => {
    const at = (lean: string | undefined, trim?: string) => withFlags(lean, () => toToolJsonSchema(taskOutputToolOptions.parameters), trim);
    // Mutation: an unconditional strip under the lean flag → no bounds, strict-compatible.
    expect(JSON.stringify(at('true'))).toContain(SAFE);
    expect(isOpenAIStrictCompatible(at('true'))).toBe(false);
    expect(isOpenAIStrictCompatible(at(undefined))).toBe(false);
    // TOOL_DESC_TRIM_V1 wins when both are on: its own strip, its own flip.
    expect(isOpenAIStrictCompatible(at('true', 'true'))).toBe(true);
  });

  it('across the bench catalog, the lean variant flips no tool and touches only what it says', () => {
    type Entry = { name: string; description: string; parameters: unknown };
    const snapshot = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../bench/fixtures/catalog.json', import.meta.url)), 'utf8'),
    ) as { tools: Entry[]; variants: Record<string, Entry[]> };
    const lean = snapshot.variants[LEAN] ?? [];
    // Mutation: drop the strict-neutral check → Monitor, TaskOutput and stop_app join the variant, strict.
    expect(lean.map((t) => t.name).sort()).toEqual(['Bash', 'Grep', 'Read', 'Weave', 'announce_preview', 'execute_code', 'process']);
    for (const t of lean) {
      const base = snapshot.tools.find((b) => b.name === t.name)!;
      expect(isOpenAIStrictCompatible(t.parameters), t.name).toBe(isOpenAIStrictCompatible(base.parameters));
      expect(shapeOf(t.parameters), t.name).toEqual(shapeOf(base.parameters));
      if (!['Bash', 'Grep'].includes(t.name)) expect(t.description, t.name).toBe(base.description);
    }
  });
});

describe('TOOL_DESC_LEAN_V1 with TOOL_DESC_TRIM_V1: the trim wins', () => {
  it('both on: the trimmed words, not the lean ones', () => {
    expect(withFlags('true', () => BUILDERS.Bash().description, 'true')).toBe(TRIMMED_TOOL_DESCRIPTIONS.Bash);
    expect(withFlags('true', () => BUILDERS.Grep().description, 'true')).toBe(TRIMMED_TOOL_DESCRIPTIONS.Grep);
  });
});
