/**
 * GATE RULES CARRY SELF-CHECKING EXAMPLES (harness to nine, S5).
 *
 * Every rule in the gate's tables names real inputs it must catch (`match`) and
 * near misses the gate must let through (`noMatch`), at least two of each. This
 * file holds them: a pattern or floor edit that changes what a rule catches, a
 * regex rule shipped without examples, or a break in the Relaxed invariant (at
 * Relaxed a permission card fires only for payments and destructive deletes)
 * fails CI and names the example that stopped holding. (A new floor delete shape
 * or asking Composio verdict fails earlier, at compile time: the floor's example
 * tables are keyed on those unions.) The command rules run in both SECURITY_PATTERNS_V2
 * states: off, the whole regex table; on, the catalog rules (command-catalogs.ts), the regexes
 * no catalog supersedes, and the superseded ones kept as verb backstops (their examplesV2).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DANGEROUS_BASH_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  READ_CRITICAL_FILE_PATTERNS,
  checkDangerousBashCommand,
  regexReads,
  checkCommandCatalogs,
  COMMAND_CATALOG_RULES,
  checkSensitiveFile,
  SENSITIVITY_FLOOR_RULES,
  RELAXED_INVARIANT_EXAMPLES,
  sensitivityFloorAsks,
  decideToolGate,
  analyzeCommand,
  stripHeredocBodies,
  bashPositionDeleteShape,
  composioVerdict,
  COMPOSIO_TOOL_PREFIX,
  type RuleExamples,
  type FloorExample,
} from '../../index.js';

const WS = '/app/workspace';
/** Where the command rules resolve relative and `~` targets: the shell at the workspace root, home /root. */
const CMD = { shellCwd: WS, home: '/root' };
const V2 = 'SECURITY_PATTERNS_V2';
const setV2 = (on: boolean) => { if (on) process.env[V2] = 'true'; else delete process.env[V2]; };

interface CheckedRule<T> {
  name: string;
  examples: RuleExamples<T> | undefined;
  /** The rule's regex, when it is one: a g or y flag makes `.test` stateful on the shared instance. */
  regex?: RegExp;
  /** Does THIS rule catch the example? (Every `match` must be caught.) */
  catches: (example: T) => boolean;
  /** Does ANY rule stop the example? (Every `noMatch` must get through.) */
  stops: (example: T) => boolean;
}

/** Every example that does not hold, one line each; empty when they all hold. */
function brokenExamples<T>(rules: ReadonlyArray<CheckedRule<T>>, show: (e: T) => string): string[] {
  const broken: string[] = [];
  for (const { name, examples, regex, catches, stops } of rules) {
    if (regex && /[gy]/.test(regex.flags)) broken.push(`${name}: a g or y flag makes .test stateful`);
    if (!examples || examples.match.length < 2 || examples.noMatch.length < 2) {
      broken.push(`${name}: needs at least two match and two noMatch examples`);
      continue;
    }
    for (const e of examples.match) if (!catches(e)) broken.push(`${name}: should catch ${show(e)}`);
    for (const e of examples.noMatch) if (stops(e)) broken.push(`${name}: should let through ${show(e)}`);
  }
  return broken;
}

const showCall = (e: FloorExample): string => `${e.toolName} ${JSON.stringify(e.toolInput)}`;
const asCall = (e: FloorExample) => ({ ...e, toolCallId: 'example' });

describe('rules: every example holds', () => {
  afterEach(() => setV2(false));

  for (const on of [false, true]) {
    it(`dangerous command patterns (${V2} ${on ? 'on: the regexes it keeps and the verb backstops' : 'off: the whole table'})`, () => {
      setV2(on);
      const parse = (e: string) => (on ? analyzeCommand(e, { wrapperOptions: true }) : undefined);
      const rules = DANGEROUS_BASH_PATTERNS.filter((r) => !on || r.supersededBy === undefined || r.verb !== undefined).map((r) => ({
        name: `${r.description} ${r.pattern}${on && r.verb ? ` (backstop for ${r.verb})` : ''}`,
        examples: on && r.supersededBy ? r.examplesV2 : r.examples,
        regex: r.pattern,
        catches: (e: string) =>
          regexReads(r, e, parse(e)).some((text) => r.pattern.test(text)) && checkDangerousBashCommand(e, CMD).blocked,
        stops: (e: string) => checkDangerousBashCommand(e, CMD).blocked,
      }));
      expect(rules.length).toBe(on ? DANGEROUS_BASH_PATTERNS.length - 2 : DANGEROUS_BASH_PATTERNS.length);
      expect(brokenExamples(rules, JSON.stringify)).toEqual([]);
    });
  }

  it(`command catalog rules (${V2} on)`, () => {
    setV2(true);
    const rules = COMMAND_CATALOG_RULES.map((r) => ({
      name: `${r.rule}: ${r.description}`,
      examples: r.examples,
      catches: (e: string) => checkCommandCatalogs(e, CMD)?.rule === r.rule && checkDangerousBashCommand(e, CMD).blocked,
      stops: (e: string) => checkDangerousBashCommand(e, CMD).blocked,
    }));
    expect(brokenExamples(rules, JSON.stringify)).toEqual([]);
  });

  it('sensitive file patterns', () => {
    const rules = SENSITIVE_FILE_PATTERNS.map((r) => ({
      name: `${r.description} ${r.pattern}`,
      examples: r.examples,
      regex: r.pattern,
      catches: (e: string) => r.pattern.test(e) && checkSensitiveFile(e).blocked,
      stops: (e: string) => checkSensitiveFile(e).blocked,
    }));
    expect(brokenExamples(rules, JSON.stringify)).toEqual([]);
  });

  it('critical read patterns', () => {
    const rules = READ_CRITICAL_FILE_PATTERNS.map((re) => ({
      name: String(re),
      examples: re.examples,
      regex: re,
      catches: (e: string) => re.test(e),
      stops: (e: string) => READ_CRITICAL_FILE_PATTERNS.some((r) => r.test(e)),
    }));
    expect(brokenExamples(rules, JSON.stringify)).toEqual([]);
  });

  it('sensitivity floor rules (workspace and shell at /app/workspace)', () => {
    expect(SENSITIVITY_FLOOR_RULES.length).toBeGreaterThan(0);
    const floorAsks = (e: FloorExample) =>
      sensitivityFloorAsks(asCall(e), { workspaceRoot: WS, shellCwd: WS });
    // A keyed rule catches only when the floor asks AND its own classifier names
    // its key, so an example cannot pass on the strength of another rule.
    const shapesOf = (e: FloorExample) =>
      analyzeCommand(stripHeredocBodies(String((e.toolInput as { command?: unknown }).command ?? '')))
        .commands.map(bashPositionDeleteShape);
    const verdictOf = (e: FloorExample) =>
      e.toolName.startsWith(COMPOSIO_TOOL_PREFIX)
        ? composioVerdict(e.toolName.slice(COMPOSIO_TOOL_PREFIX.length), undefined)
        : null;
    const rules = SENSITIVITY_FLOOR_RULES.map((r) => ({
      name: r.kind === 'bash-shape' ? `${r.rule} [${r.shape}]` : r.kind === 'composio-verdict' ? `${r.rule} [${r.verdict}]` : r.rule,
      examples: r.examples,
      catches: (e: FloorExample) =>
        floorAsks(e) &&
        (r.kind === 'bash-shape' ? e.toolName === 'Bash' && shapesOf(e).includes(r.shape)
          : r.kind === 'composio-verdict' ? verdictOf(e) === r.verdict
          : true),
      stops: floorAsks,
    }));
    expect(brokenExamples(rules, showCall)).toEqual([]);
  });
});

describe('the Relaxed invariant: a card fires only for payments and destructive deletes', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; setV2(false); });

  for (const [flag, v2] of [['off', false], ['on', false], ['off', true], ['on', true]] as const) {
    it(`holds through the gate at Relaxed (ACCESS_LEVELS_V1 ${flag}, ${V2} ${v2 ? 'on' : 'off'})`, () => {
      if (flag === 'on') process.env.ACCESS_LEVELS_V1 = '1';
      else delete process.env.ACCESS_LEVELS_V1;
      setV2(v2);
      const decide = (e: FloorExample) =>
        decideToolGate(asCall(e), {
          mode: 'default',
          accessLevel: 'relaxed',
          cwd: WS,
          shellCwd: WS,
          // Connected, so the unconnected-app ask never fires: this pins the floor.
          connectedComposioToolkits: new Set(['gmail', 'slack', 'stripe', 'github']),
          permissionRules: { allow: [], ask: [], deny: [] },
        }).decision;
      const rule: CheckedRule<FloorExample> = {
        name: 'Relaxed invariant',
        examples: RELAXED_INVARIANT_EXAMPLES,
        catches: (e) => decide(e) === 'needs_human',
        stops: (e) => decide(e) !== 'allow',
      };
      expect(brokenExamples([rule], showCall)).toEqual([]);
    });
  }
});
