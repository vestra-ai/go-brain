/**
 * subagent-type-registry.ts — Phase 4 (§1.7) the SubagentType registry.
 *
 * ONE registry, BOTH spawn surfaces (founder directive 2026-07-01): `Agent`
 * tool's `subagent_type` and Weave `task({subagentType})` both select from
 * this SAME registry — never build it twice.
 *
 * `never Haiku` is STRUCTURAL here, not a prose nudge: {@link register} REJECTS
 * any type whose resolved `model` is below the policy floor (AC-R1). A type
 * with NO `model` (the common case today — see {@link projectSubagentTypesFromAbilities})
 * inherits whatever the spawner/parent uses; `resolveRoutedSpawn` (routed-spawn.ts)
 * floor-checks the RESOLVED model — override if given, else the PARENT's model —
 * not just an explicit override, so a "Lite" session (whose OWN top-level model
 * IS claude-haiku-4-5) can't silently hand that model down to a spawned child
 * simply because the type/spawn declared no override. The floor is never
 * bypassed by omitting a type-level or per-spawn model.
 *
 * SCOPE: "BOTH spawn surfaces" above means the `Agent`/`Weave` tools in
 * `agent-tool.ts` (the `native`/`openai_responses` runtime arms). It does NOT
 * cover the Claude Agent SDK arm's own Task tool or the `openai` runtime arm's
 * `Agent.asTool()` subagents (openai-subagents.ts) — see agent-tool.ts's file
 * header for the full scope note.
 */
import { resolveCapabilities } from '../contract/model-capabilities.js';
import type { PermissionRuleValue } from '../contract/permission.js';

export const GENERAL_PURPOSE_TYPE = 'general-purpose';
export const EXPLORER_TYPE = 'explorer';
export const RESEARCHER_TYPE = 'researcher';

export interface SubagentTypeConfig {
  name: string;
  description: string;
  /** Absent for `general-purpose` (inline `prompt` is the only type allowed to
   *  skip a baked-in systemPrompt — design §1.2.1). */
  systemPrompt?: string;
  /** The model this type pins by default. Absent = inherit the spawner's model
   *  (no registration-time floor check — the floor still applies at spawn time
   *  to whatever model actually runs, via routed-spawn.ts). */
  model?: string;
  /**
   * NOTE: no `transport`/`responseFormat` fields here (design doc §1.7 lists
   * them). Transport is NOT an independent axis in this architecture —
   * `resolveRoutedSpawn`/`resolveChildTransport` derive the wire dialect FROM
   * the resolved model id (`resolveCapabilities(model).api`), so a type-level
   * transport override would be silently unenforceable. `responseFormat` has
   * no consumer either: the Agent tool has no structured-output mechanism, and
   * Weave already has its own PER-SPAWN `responseSchema` (WeaveNodeSpec),
   * unrelated to a type-level default. Declaring either field here without a
   * real consumer would silently mislead a `.forge` config author into
   * believing they work — deferred until a real per-transport or per-type
   * structured-output mechanism exists.
   */
  /** Tool names this type's nodes may see. Absent = the harness's default
   *  working set (byte-identical to pre-Phase-4 buildSubagentToolset). */
  toolset?: string[];
  /**
   * Orchestration walls (D2): may an agent of this type spawn helpers? Default
   * false: a type is a leaf unless it says otherwise. Only consulted when the walls
   * are on; flag-off keeps every type recursion-capable through the protected slot.
   */
  delegates?: boolean;
  /** Skill slugs. Absent/empty = no skill-based tool scoping applied (AC-R3). */
  skills?: string[];
  /**
   * AC-R2 — path/tool-name `deny` rules layered ONTO the structural
   * sensitive-deny-by-default set for any non-`general-purpose` type (see
   * subagent-permissions.ts). DELIBERATELY has no `allow` field: "a child's
   * policy REPLACES the parent's (strict-subset — a child can only narrow)" is
   * enforced STRUCTURALLY by this shape — there is no way to declare a new
   * allow rule on a subagent type, so a type can only ADD restrictions, never
   * grant one back. ALSO deliberately has no `ask` field — see
   * `SubagentPermissions`'s doc comment in subagent-permissions.ts for why a
   * node-level "prompt a human" primitive would be silently unenforceable.
   */
  permissions?: {
    deny?: PermissionRuleValue[];
  };
}

/**
 * P2.1 (control-plane) — the first-party built-in subagent types, the SINGLE
 * source both spawn surfaces read: the registry ctor seeds them (so the policy
 * layer resolves their toolset/permissions), and the `Agent` tool projects them
 * into its spawnable roster (agent-tool.ts) so they are dispatchable ALONGSIDE
 * installed abilities — even with zero abilities installed. An installed ability
 * WINS a slug collision (both the registry projection and the roster add a
 * built-in only where no ability already claims the slug).
 *
 * None pins a `model` (all inherit the spawner's model — the floor still applies
 * at spawn time via routed-spawn.ts). `general-purpose` alone carries no
 * `systemPrompt` (the inline-prompt escape hatch, design §1.2.1); `explorer`/
 * `researcher` bake a short prompt that composes with the caller's `prompt` the
 * same way an ability agent's does. Neither declares custom `permissions` — the
 * non-`general-purpose` structural sensitive-deny set (subagent-permissions.ts)
 * is the intended gate. `toolset` narrows each to its minimal working set (AC-R6):
 * P2.3 adds first-class WebSearch/WebFetch to explorer/researcher so the research
 * archetypes can reach the web (SSRF-guarded + metered) while raw-socket egress via
 * Bash stays denied by the sensitive set.
 */
export const BUILT_IN_SUBAGENT_TYPES: readonly SubagentTypeConfig[] = [
  {
    name: GENERAL_PURPOSE_TYPE,
    description: 'General-purpose agent for open-ended tasks (inline prompt allowed).',
    delegates: true,
  },
  {
    name: EXPLORER_TYPE,
    description: 'Read-only search agent for broad, fast codebase exploration.',
    systemPrompt:
      'You are a read-only exploration agent. Search and read across the codebase to map its ' +
      'structure and locate exactly what the caller needs, then report your findings with precise ' +
      'file:line references. Never modify anything: no writing, editing, or other side effects.',
    // P2.3 — first-class WebSearch/WebFetch so exploration can reach the web too;
    // read-only stays intact (no Write). The web tools are SSRF-guarded + metered.
    toolset: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    delegates: false,
  },
  {
    name: RESEARCHER_TYPE,
    description: 'Research agent that explores, synthesizes, and writes up findings.',
    systemPrompt:
      'You are a research agent. Investigate the task thoroughly, synthesize what you find into ' +
      'clear findings, and write notes or a report to files when that helps. Cite concrete evidence ' +
      '(file:line references or sources) so the caller can verify your conclusions.',
    // P2.3 — researcher = explorer + Write + first-class web (SSRF-guarded + metered).
    toolset: ['Read', 'Grep', 'Glob', 'Write', 'WebSearch', 'WebFetch'],
    delegates: false,
  },
];

/** AC-R1 — thrown by {@link SubagentTypeRegistry.register} when a type's pinned
 *  model resolves below the policy floor. Carries the offending type + model so
 *  the caller can report WHY registration failed. */
export class SubagentFloorViolationError extends Error {
  constructor(
    readonly typeName: string,
    readonly model: string,
  ) {
    super(
      `SubagentType "${typeName}" pins model "${model}", which is below the policy floor ` +
        `(no Haiku) — registration REJECTED, not silently upgraded.`,
    );
    this.name = 'SubagentFloorViolationError';
  }
}

/** Unknown-type error listing every registered type (AC-R1's "resolves a known
 *  type" complement). Both spawn surfaces (Agent tool + Weave) use this SAME
 *  error so an unknown subagentType fails identically either way. */
export class UnknownSubagentTypeError extends Error {
  constructor(
    readonly requested: string,
    readonly available: readonly string[],
  ) {
    super(`Unknown subagent_type "${requested}". Available: ${available.join(', ')}`);
    this.name = 'UnknownSubagentTypeError';
  }
}

/**
 * STRUCTURAL "never Haiku": a model id whose resolved family is Haiku is below
 * the policy floor. Reuses the SAME family-matching the billing/pricing seam
 * already uses (resolveCapabilities) — no second floor definition to drift.
 */
export function isBelowModelFloor(modelId: string): boolean {
  return resolveCapabilities(modelId).id.toLowerCase().includes('haiku');
}

export class SubagentTypeRegistry {
  private readonly types = new Map<string, SubagentTypeConfig>();

  constructor() {
    // Seed the first-party built-ins (general-purpose/explorer/researcher) from
    // the single {@link BUILT_IN_SUBAGENT_TYPES} source — always present, never
    // rejected (none pins a model). Set directly (not via `register`) to mirror
    // general-purpose's historic unconditional presence; a projected ability with
    // a colliding slug REPLACES its built-in below (ability wins).
    for (const builtIn of BUILT_IN_SUBAGENT_TYPES) this.types.set(builtIn.name, builtIn);
  }

  /** Registers (or REPLACES) a type. Throws {@link SubagentFloorViolationError}
   *  and registers NOTHING when `config.model` is below the policy floor. */
  register(config: SubagentTypeConfig): SubagentTypeConfig {
    if (config.model !== undefined && isBelowModelFloor(config.model)) {
      throw new SubagentFloorViolationError(config.name, config.model);
    }
    this.types.set(config.name, config);
    return config;
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  /** Throws {@link UnknownSubagentTypeError} for a name not registered. */
  resolve(name: string): SubagentTypeConfig {
    const found = this.types.get(name);
    if (!found) throw new UnknownSubagentTypeError(name, this.names());
    return found;
  }

  names(): string[] {
    return [...this.types.keys()];
  }
}

/** The minimal shape {@link projectSubagentTypesFromAbilities} needs from an
 *  installed ability's agent roster — matches `ActiveAgent` (@bash/shared). */
export interface ProjectableAgent {
  slug: string;
  description?: string | null;
  prompt?: string | null;
  /**
   * ALL fields below are absent in today's real `ActiveAgent` projection
   * (ActiveAgent carries only slug/description/prompt/avatar/color) — accepted
   * here so a future `.forge`-config enrichment can populate them WITHOUT a
   * registry change. A `model` below the floor REJECTS that one type.
   */
  model?: string;
  toolset?: string[];
  skills?: string[];
  permissions?: SubagentTypeConfig['permissions'];
  /** Orchestration walls (D2): whether agents of this projected type may spawn
   *  helpers. Absent = leaf. */
  delegates?: boolean;
}
export interface ProjectableAbility {
  agents: readonly ProjectableAgent[];
}

/**
 * Project the installed-ability agent roster into a {@link SubagentTypeRegistry}
 * (design §1.7: "projected from `.forge` config" — abilities ARE the current
 * `.forge`-materialized config surface for installed agents). A single agent
 * that fails registration (e.g. a future data source pins a Haiku model)
 * REJECTS that ONE type — `onRejected` reports it — rather than failing the
 * whole harness boot.
 */
export function projectSubagentTypesFromAbilities(
  abilities: readonly ProjectableAbility[],
  onRejected?: (slug: string, error: Error) => void,
): SubagentTypeRegistry {
  const registry = new SubagentTypeRegistry();
  for (const ability of abilities) {
    for (const agent of ability.agents) {
      try {
        registry.register({
          name: agent.slug,
          description: agent.description ?? agent.slug,
          ...(agent.prompt ? { systemPrompt: agent.prompt } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.toolset ? { toolset: agent.toolset } : {}),
          ...(agent.skills ? { skills: agent.skills } : {}),
          ...(agent.permissions ? { permissions: agent.permissions } : {}),
          ...(agent.delegates !== undefined ? { delegates: agent.delegates } : {}),
        });
      } catch (err) {
        onRejected?.(agent.slug, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  return registry;
}
