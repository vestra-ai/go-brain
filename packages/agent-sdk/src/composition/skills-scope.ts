/**
 * skills-scope.ts — Phase 4 (§1.7 AC-R3) skills quarantine across the subagent
 * boundary.
 *
 * A node's visible tools = its declared toolset ∩ ⋃(skill.allowedTools) — the
 * SAME "allowed-tools frontmatter" restriction a Claude Code skill applies
 * while it is active, now enforced at the subagent-spawn boundary too. Custom
 * subagent types do NOT inherit the parent's skills (a fresh, explicit list —
 * possibly empty); the `general-purpose` inline-prompt path DOES inherit them
 * (it is trusted like the main turn, per §1.2.1).
 */

/** The minimal shape this module needs from a skill (matches SkillDefinition's
 *  `tools: string[]` field in @bash/shared). */
export interface ToolScopedSkill {
  slug: string;
  tools: readonly string[];
}

/**
 * Resolve the skill list a node actually carries. `general-purpose` inherits
 * the parent's full skill set (design §1.7: "the inline `general-purpose` path
 * does [inherit parent skills]"); every OTHER type gets ONLY its own declared
 * `skills` — an empty/absent list for a custom type is NOT an error, it just
 * means no skill-based narrowing applies (see {@link visibleToolset}).
 */
export function resolveNodeSkills<T extends ToolScopedSkill>(
  isGeneralPurpose: boolean,
  ownSkills: readonly T[],
  parentSkills: readonly T[],
): readonly T[] {
  return isGeneralPurpose ? parentSkills : ownSkills;
}

/**
 * The tool names actually visible to a node: `toolset ∩ ⋃(skill.tools)`, but
 * ONLY when the node has ≥1 skill attached — with NO skills attached there is
 * nothing to intersect against, so the declared toolset stands as-is (a
 * custom type with zero skills is not silently zeroed out; skills NARROW an
 * already-declared toolset, they don't gate whether it exists at all).
 */
export function visibleToolset(toolset: readonly string[], skills: readonly ToolScopedSkill[]): string[] {
  if (skills.length === 0) return [...toolset];
  const allowed = new Set<string>();
  for (const skill of skills) {
    for (const tool of skill.tools) allowed.add(tool);
  }
  return toolset.filter((tool) => allowed.has(tool));
}
