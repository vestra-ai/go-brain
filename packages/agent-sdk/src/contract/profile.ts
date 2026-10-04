/**
 * HarnessProfile — per-arm instruction costume (K4 §4).
 *
 * Two arm-specific knobs the InstructionStack assembler reads:
 *  - `instructionFilename`: the per-workspace instruction file the arm reads
 *    (Claude/native read CLAUDE.md; OpenAI/Codex read AGENTS.md).
 *  - `armSteering(workingDir)`: the layer-6 `arm_steering` disclosure costume —
 *    the Codex `.agents/skills/` on-disk steering for the OpenAI arms, EMPTY for
 *    the Claude/native arms (they use standard tool definitions, not a disk scan).
 *
 * The OpenAI steering is ported VERBATIM from the legacy openai-system-prompt.ts
 * (the `.agents/skills/` discovery note) so the OpenAI arm's behavior is unchanged.
 */
import type { HarnessId } from './ids.js';

export interface HarnessProfile {
  instructionFilename: 'CLAUDE.md' | 'AGENTS.md';
  /** Layer-6 disclosure costume for this arm. Empty for arms with no disk steering. */
  armSteering: (workingDir: string) => string;
}

/**
 * The Codex `.agents/skills/` on-disk steering — what makes the OpenAI arm treat
 * abilities as supreme like Claude does (true progressive disclosure: it reads
 * SKILL.md bodies off disk on demand instead of mapping a prose catalog to a
 * slug, the under-selection root cause). Ported verbatim from
 * openai-system-prompt.ts:49-57.
 */
function openaiArmSteering(workingDir: string): string {
  return (
    `Your installed skills live as SKILL.md files under ${workingDir}/.agents/skills/ ` +
    '(one folder per skill, named `<ability>__<skill>`). For ANY task an installed skill ' +
    'covers, your FIRST move is to discover and follow it: Glob/list that directory, read the ' +
    'short `description` frontmatter of the candidates, then Read the matching SKILL.md body in ' +
    'full and follow its steps. Only if no skill matches do you fall back to the `Skill` tool ' +
    '(load by slug), then `search_abilities`, then built-in tools. Reach into your installed ' +
    'skills FIRST — do not improvise a deliverable a skill already knows how to produce.'
  );
}

const NO_STEERING = (): string => '';

export const HARNESS_PROFILES: Record<HarnessId, HarnessProfile> = {
  claude: { instructionFilename: 'CLAUDE.md', armSteering: NO_STEERING },
  native: { instructionFilename: 'CLAUDE.md', armSteering: NO_STEERING },
  openai: { instructionFilename: 'AGENTS.md', armSteering: openaiArmSteering },
  openai_responses: { instructionFilename: 'AGENTS.md', armSteering: openaiArmSteering },
  // The Claude Code CLI reads CLAUDE.md — the honest value for an exhaustive
  // table, though inert for this arm: we launch it with `--setting-sources ""`,
  // so it reads no instruction file at all.
  claude_code: { instructionFilename: 'CLAUDE.md', armSteering: NO_STEERING },
};
