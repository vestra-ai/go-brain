/**
 * Synthesize the SKILL.md / agent.md files the SDK loads from a plugin
 * folder out of the joined skills/agents rows already attached to an
 * ActiveAbility.
 *
 * --- Q6: duplicate-name policy (resolved 2026-05-18) ---
 *
 * Scenario: a user installs `cron` standalone (writes
 * .claude/skills/cron/SKILL.md) AND adds `cron` to a user-owned ability
 * (writes .forge/abilities/daily-ops/skills/cron/SKILL.md). Both files
 * carry `name: cron` in frontmatter.
 *
 * Decision: ACCEPT THE DUPLICATION. Both copies are synthesized from the
 * SAME `skills.content` in the DB, so they are byte-identical (modulo
 * frontmatter ordering). The SDK loads them as separate entries scoped to
 * different plugin contexts; the agent invokes one or the other depending
 * on where the call site lives, but the behavior is the same either way.
 *
 * Rejected alternatives:
 *   (b) namespace ability-bundled skills (e.g. `daily-ops.cron`) — breaks
 *       the SDK's expectation that a `/<skill>` invocation resolves by
 *       name; would require a separate routing layer.
 *   (c) skip ability materialization when standalone exists — the ability's
 *       folder would look incomplete (DB has the row, disk doesn't) and an
 *       uninstall of the standalone copy would silently break the ability.
 *
 * Cost of (a): a few extra KB on disk per duplicated skill, negligible.
 *
 * Spec: docs/superpowers/specs/2026-05-17-abilities-skills-agents-design.md §9 Q6
 */

import type { AbilityHookConfig } from './ability-hooks.js';

export interface SkillForSynthesis {
  slug: string;
  description: string;
  icon: string | null;
  content: string | null;
  /**
   * Optional catalog/runtime metadata — each key is emitted only when present,
   * so a legacy input stays byte-identical (same contract as `hooks`).
   * `allowed_tools` round-trips the `allowed-tools` frontmatter key (Claude's
   * skill gating field, comma-separated string, consumed by the SDK loader).
   */
  category?: string;
  color?: string;
  allowed_tools?: string;
  tools?: string[];
  mcps?: string[];
  args_schema?: unknown;
  /**
   * K6-P2 B6 — declared shell-command hooks (Claude Code shape). When present,
   * `buildSkillMd` emits a `hooks:` YAML block in the frontmatter (parity with
   * Claude Code's plugin SKILL.md). ABSENT → no `hooks:` line → byte-identical to
   * the pre-B6 output. Whether these REGISTER is the sandbox layer's trust gate.
   */
  hooks?: AbilityHookConfig;
}

export interface AgentForSynthesis {
  slug: string;
  description: string;
  avatar_url: string | null;
  color: string | null;
  prompt: string | null;
  /** Optional — emitted only when present (byte-identical-when-absent, and the
   *  load mapping spreads-when-truthy so these are never null). `tools` is
   *  emitted in Claude's comma-string form, the shape the SDK loader reads;
   *  `model` feeds the subagent-type registry's floor check (ProjectableAgent). */
  icon?: string;
  model?: string;
  tools?: string[];
}

export function buildSkillMd(skill: SkillForSynthesis): string {
  const cleanDesc = (skill.description ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const lines: string[] = ['---', `name: ${skill.slug}`, `description: ${cleanDesc}`];
  if (skill.category) lines.push(`category: ${yamlScalar(skill.category)}`);
  if (skill.icon) lines.push(`icon: ${skill.icon}`);
  if (skill.color) lines.push(`color: ${yamlScalar(skill.color)}`);
  if (skill.allowed_tools) lines.push(`allowed-tools: ${yamlScalar(skill.allowed_tools)}`);
  if (skill.tools?.length) lines.push(`tools: [${skill.tools.map(yamlScalar).join(', ')}]`);
  if (skill.mcps?.length) lines.push(`mcps: [${skill.mcps.map(yamlScalar).join(', ')}]`);
  // Single-line JSON is valid YAML flow syntax — parses back structurally equal.
  if (skill.args_schema !== undefined) lines.push(`args_schema: ${JSON.stringify(skill.args_schema)}`);
  // K6-P2 B6: emit the declared hooks block (Claude Code shape) when present.
  // Absent → no lines added → byte-identical to the pre-B6 output.
  if (skill.hooks) lines.push(...serializeAbilityHooksYaml(skill.hooks));
  lines.push('---', '', skill.content ?? '', '');
  return lines.join('\n');
}

/**
 * Serialize an {@link AbilityHookConfig} to the Claude-Code `hooks:` YAML block
 * (a small deterministic emitter — no YAML dependency so `@bash/shared` stays
 * dependency-free and the byte-identical-when-absent guarantee is trivially held).
 * Emits ONLY the well-formed structure the parser produces; the inert
 * `attenuation` seam is NOT emitted (it is registration metadata, not authoring).
 */
function serializeAbilityHooksYaml(hooks: AbilityHookConfig): string[] {
  const out: string[] = ['hooks:'];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups || groups.length === 0) continue;
    out.push(`  ${event}:`);
    for (const group of groups) {
      const head = group.matcher !== undefined ? `    - matcher: ${yamlScalar(group.matcher)}` : '    -';
      out.push(head);
      out.push('      hooks:');
      for (const cmd of group.hooks) {
        out.push(`        - type: command`);
        out.push(`          command: ${yamlScalar(cmd.command)}`);
        if (cmd.timeout !== undefined) out.push(`          timeout: ${cmd.timeout}`);
      }
    }
  }
  return out;
}

/** Quote a YAML scalar only when it could otherwise be mis-parsed (contains a
 *  colon, leading/trailing space, or YAML special chars). Double-quoted + escaped. */
function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9_./${}-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildAgentMd(agent: AgentForSynthesis): string {
  const cleanDesc = (agent.description ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const lines: string[] = ['---', `name: ${agent.slug}`, `description: ${cleanDesc}`];
  if (agent.avatar_url) lines.push(`avatar: ${agent.avatar_url}`);
  if (agent.color) lines.push(`color: ${agent.color}`);
  if (agent.icon) lines.push(`icon: ${agent.icon}`);
  if (agent.model) lines.push(`model: ${yamlScalar(agent.model)}`);
  if (agent.tools?.length) lines.push(`tools: ${agent.tools.join(', ')}`);
  lines.push('---', '', agent.prompt ?? '', '');
  return lines.join('\n');
}
