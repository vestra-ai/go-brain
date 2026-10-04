/**
 * TOOL_DESC_TRIM_V1 (harness to nine T3) — the resident core's heaviest tools advertise
 * trimmed text, and Zod-built schemas drop the safe-integer bounds zod adds to `.int()`.
 *
 * Three promises, each pinned here for the SDK-built tools (Bash, Read, Grep):
 *  1. OFF (unset or any non-opt-in value) is byte-identical: the description is
 *     TOOL_DESCRIPTIONS exactly and the schema still carries its bounds. The bench catalog
 *     drift guard (apps/sandbox bench-catalog-snapshot.test.ts) pins every tool's serialized
 *     bytes against the snapshot taken before this flag existed.
 *  2. ON changes WORDS only: with every description and the two bound keywords removed, the
 *     ON schema deep-equals the OFF schema (same keys, types, enums, required, nullability).
 *  3. ON keeps the behaviour-critical lines (the neighbour, the background and output-cap
 *     recipes, the paging marker, every default) and speaks the product's register.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isOpenAIStrictCompatible } from '../../contract/openai-strict-schema.js';
import { toToolJsonSchema, type JsonSchema } from '../../contract/tool-json-schema.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';
import { TOOL_DESCRIPTIONS } from '../descriptions/index.js';
import { TRIMMED_TOOL_DESCRIPTIONS, toolDescription } from '../descriptions/trimmed.js';
import { makeBashTool, makeGrepTool, makeReadTool, taskOutputToolOptions } from '../index.js';
import type { RawToolOptions } from '../tool-types.js';

const FLAG = 'TOOL_DESC_TRIM_V1';
const prev = process.env[FLAG];
afterEach(() => {
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
});
function withFlag<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return fn();
}

const BUILDERS: Record<'Bash' | 'Read' | 'Grep', () => RawToolOptions> = {
  Bash: () => makeBashTool(() => '/tmp', 'task-1'),
  Read: () => makeReadTool(() => '/tmp'),
  Grep: () => makeGrepTool(() => '/tmp'),
};
const NAMES = Object.keys(BUILDERS) as Array<keyof typeof BUILDERS>;

/** The wire view: description + converted schema, under the flag value given. */
function wire(name: keyof typeof BUILDERS, value: string | undefined): { description: string; schema: JsonSchema } {
  return withFlag(value, () => {
    const t = BUILDERS[name]();
    return { description: t.description, schema: toToolJsonSchema(t.parameters) };
  });
}

/** Strip every `description` and the safe-integer bounds: what is left is the schema's shape. */
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

describe('TOOL_DESC_TRIM_V1 off: byte-identical', () => {
  it.each([undefined, 'false', '0', 'TRUE', ''])('flag=%s: descriptions are TOOL_DESCRIPTIONS exactly and the bounds stay', (value) => {
    for (const name of NAMES) {
      const w = wire(name, value);
      expect(w.description, name).toBe(TOOL_DESCRIPTIONS[name]);
      expect(withFlag(value, () => toolDescription(name)), name).toBe(TOOL_DESCRIPTIONS[name]);
    }
    // Grep's six integer options are where the bounds sit; off, every one keeps them.
    expect(JSON.stringify(wire('Grep', value).schema).split(SAFE).length - 1).toBe(12);
  });

  it('off is the same serialized schema as the legacy param text', () => {
    // Mutation: swap a GREP_PARAM_TEXT string for its trimmed twin -> this goes red.
    const grep = wire('Grep', undefined).schema as { properties: Record<string, { description?: string }> };
    expect(grep.properties.glob?.description).toBe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") — maps to rg --glob');
    expect(grep.properties['-n']?.description).toBe('Show line numbers (rg -n). Requires output_mode: "content". Defaults to true.');
    const bash = wire('Bash', undefined).schema as { properties: Record<string, { description?: string }> };
    expect(bash.properties.dangerouslyDisableSandbox?.description).toBe(
      'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
    );
  });
});

describe('TOOL_DESC_TRIM_V1 on: words change, the schema shape does not', () => {
  it.each(['true', '1'])('flag=%s: every tool advertises the trimmed description', (value) => {
    for (const name of NAMES) expect(wire(name, value).description, name).toBe(TRIMMED_TOOL_DESCRIPTIONS[name]);
  });

  it('the shape (keys, types, enums, required, nullability, real bounds) is identical to off', () => {
    for (const name of NAMES) expect(shapeOf(wire(name, 'true').schema), name).toEqual(shapeOf(wire(name, undefined).schema));
  });

  it('the safe-integer bounds are gone and a real bound stays', () => {
    for (const name of NAMES) expect(JSON.stringify(wire(name, 'true').schema), name).not.toContain(SAFE);
    // Bash `timeout` and Read `offset`/`limit` are `.positive()`: exclusiveMinimum 0 is a real bound.
    const read = wire('Read', 'true').schema as { properties: Record<string, { anyOf: Array<Record<string, unknown>> }> };
    expect(read.properties.offset?.anyOf[0]).toEqual({ type: 'integer', exclusiveMinimum: 0 });
    const declared = withFlag('true', () => toToolJsonSchema(z.object({ n: z.number().int().min(0).max(10) })));
    expect((declared as { properties: { n: unknown } }).properties.n).toEqual({ type: 'integer', minimum: 0, maximum: 10 });
  });

  it('each tool costs fewer tokens on the wire', () => {
    for (const name of NAMES) {
      const off = estimateTokens(JSON.stringify(wire(name, undefined)));
      const on = estimateTokens(JSON.stringify(wire(name, 'true')));
      expect(on, name).toBeLessThan(off);
    }
  });
});

describe('TOOL_DESC_TRIM_V1 on: the behaviour-critical lines survive', () => {
  const props = (name: keyof typeof BUILDERS): Record<string, { description?: string }> =>
    (wire(name, 'true').schema as { properties: Record<string, { description?: string }> }).properties;

  it('Bash keeps the background contract, the output-cap recipe and its neighbours', () => {
    const d = TRIMMED_TOOL_DESCRIPTIONS.Bash;
    expect(d).toContain('run_in_background: true');
    expect(d).toContain('task_id');
    expect(d).toContain('process tool');
    expect(d).toContain('> out.txt 2>&1');
    expect(d).toMatch(/Glob and Grep, not find\/grep\/cat\/head\/tail/);
    expect(props('Bash').timeout?.description).toMatch(/600000/);
    expect(props('Bash').description?.description).toMatch(/active voice, 5-10 words/);
    expect(props('Bash').pty?.description).toMatch(/background runs only/);
    // The parity field says what it does here: nothing. Never an invitation to bypass.
    expect(props('Bash').dangerouslyDisableSandbox?.description).toMatch(/no effect/i);
  });

  it('Read keeps images, the partial-read marker, the size limit, PDFs and its neighbours', () => {
    const d = TRIMMED_TOOL_DESCRIPTIONS.Read;
    expect(d).toMatch(/PNG, JPEG, GIF, WEBP/);
    expect(d).toMatch(/shown range and the next `offset`/);
    expect(d).toMatch(/size limit .* Grep/);
    expect(d).toMatch(/PDF cannot be read directly/);
    expect(d).toMatch(/Glob \(by name\) or Grep \(by content\)/);
    expect(props('Read').offset?.description).toMatch(/too big to read at once/);
  });

  it('Grep keeps its neighbour, the paging marker and every default', () => {
    const d = TRIMMED_TOOL_DESCRIPTIONS.Grep;
    expect(d).toMatch(/use Glob/);
    expect(d).toMatch(/shown range and the next `offset`/);
    expect(d).toMatch(/skips ignored files/);
    const p = props('Grep');
    expect(p.output_mode?.description).toMatch(/"files_with_matches" \(default\)/);
    expect(p.output_mode?.description).toMatch(/"content".*-A\/-B\/-C\/context\/-n\/-o/);
    expect(p['-n']?.description).toMatch(/default true/);
    expect(p.head_limit?.description).toMatch(/250.*0 for all/);
    expect(p.path?.description).toMatch(/workspace root/);
  });

  it('speaks the product register: no em or en dashes, never Claude', () => {
    const texts = [
      ...Object.values(TRIMMED_TOOL_DESCRIPTIONS),
      ...NAMES.flatMap((n) => Object.values(props(n)).map((p) => p.description ?? '')),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/[–—]/);
      expect(t).not.toMatch(/Claude/);
    }
  });
});

/**
 * The bound strip has one effect beyond bytes, on the OpenAI-shaped lanes (Responses and
 * chat-completions): a tool is sent strict:true only when its converted schema passes
 * isOpenAIStrictCompatible, and minimum/maximum are not on its whitelist. For a tool whose
 * ONLY blocker was zod's safe-int range, the flag turns constrained decoding on: Monitor
 * and TaskOutput (resident; every field required, `timeout`/`timeout_ms` an `.int()`) and
 * the deferred stop_app. Every other tool keeps its strict status. Read over the bench
 * catalog snapshot, which holds each tool's converted schema off and (as `variants`) on.
 */
describe('TOOL_DESC_TRIM_V1 and OpenAI strict mode', () => {
  type Entry = { name: string; parameters: unknown; deferrable?: boolean; deferrableWide?: boolean };
  const snapshot = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../bench/fixtures/catalog.json', import.meta.url)), 'utf8'),
  ) as { tools: Entry[]; variants: Record<string, Entry[]> };
  const onByName = new Map(snapshot.variants[FLAG]?.map((t) => [t.name, t]));
  const flips = snapshot.tools
    .filter((t) => isOpenAIStrictCompatible(t.parameters) !== isOpenAIStrictCompatible((onByName.get(t.name) ?? t).parameters))
    .map((t) => t.name);

  it('exactly Monitor, TaskOutput and the deferred stop_app change, and only from not-strict to strict', () => {
    expect(flips.sort()).toEqual(['Monitor', 'TaskOutput', 'stop_app']);
    for (const name of flips) {
      const off = snapshot.tools.find((t) => t.name === name);
      expect(isOpenAIStrictCompatible(off?.parameters), `${name} off`).toBe(false);
      expect(isOpenAIStrictCompatible(onByName.get(name)?.parameters), `${name} on`).toBe(true);
    }
    // The wide resident core: no tool there changes strict status (stop_app is deferred,
    // TaskOutput is wide-deferred since T1b finish, and Monitor since T1b to 12K).
    const resident = snapshot.tools.filter((t) => !t.deferrable && !t.deferrableWide).map((t) => t.name);
    expect(resident.filter((n) => flips.includes(n)).sort()).toEqual([]);
  });

  it('TaskOutput, built here: not strict-compatible off, strict-compatible on', () => {
    const compat = (value: string | undefined): boolean =>
      withFlag(value, () => isOpenAIStrictCompatible(toToolJsonSchema(taskOutputToolOptions.parameters)));
    expect(compat(undefined)).toBe(false);
    expect(compat('true')).toBe(true);
  });

  it('Bash, Read and Grep keep their strict status (their nullable optionals still block it)', () => {
    for (const name of NAMES) {
      expect(isOpenAIStrictCompatible(wire(name, 'true').schema), name).toBe(isOpenAIStrictCompatible(wire(name, undefined).schema));
    }
  });
});
