import type { Ability, AbilityFile } from './ability.js';
import type { SkillForSynthesis, AgentForSynthesis } from './ability-synthesis.js';

/**
 * A reference file that lives inside a skill folder alongside SKILL.md.
 * Examples: pptxgenjs.md, reference.md, metadata.json, requirements.txt.
 *
 * Loaded by load.ts from skill_files; the materializer writes each one
 * under .forge/abilities/<ability-slug>/skills/<skill-slug>/<path>.
 * Content is pre-resolved by load.ts (inline content used as-is, storage-
 * backed content downloaded). Files we couldn't resolve (binary, failed
 * download) carry content=null and the materializer skips them.
 */
export interface ActiveSkillFile {
  /** Path relative to the skill folder, e.g. "reference.md" or "scripts/build.sh". */
  path: string;
  content: string | null;
  is_binary: boolean;
}

/**
 * A storage-backed asset reference on a skill row — structural twin of
 * `@bash/shared`'s `StorageAsset` (items/types.ts), inlined here to avoid the
 * `@bash/shared` → `@vestra/agent-sdk` package cycle (same pattern as
 * `ActiveMcp.connection_config`). `kind:'archive'` = a gzip tarball of the
 * whole skill dir, content-addressed by sha256, unpacked at the skill root.
 */
export interface StorageAssetRef {
  key: string;
  target_path: string;
  size: number;
  mime_type?: string;
  kind?: 'asset' | 'archive';
}

/** Skill row joined via ability_skills — only the fields needed to synthesize SKILL.md. */
export interface ActiveSkill extends SkillForSynthesis {
  id: string;
  files: ActiveSkillFile[];
  /**
   * Storage-backed assets (bucket-resident). A `kind:'archive'` entry is the
   * app bundle for a code-repo skill; the materializer fetches it by sha and
   * unpacks it into the skill dir. Absent for prose-skills (byte-identical).
   */
  storage_assets?: StorageAssetRef[];
}

/** Agent row joined via ability_agents — only the fields needed to synthesize agent.md. */
export interface ActiveAgent extends AgentForSynthesis {
  id: string;
  /** Orchestration walls: whether this agent may spawn helpers. Absent = false. */
  delegates?: boolean;
}

/**
 * MCP row joined via ability_mcps. Unlike skills/agents, carries a connection
 * descriptor.
 *
 * `connection_config` is a structural twin of `@bash/shared`'s
 * `McpConnectionConfig` (items/types.ts). It is inlined here rather than
 * imported because `@bash/shared` depends on `@vestra/agent-sdk`, never the
 * reverse — importing the type back would introduce a package cycle. `@bash/shared`
 * remains the parser owner (`parseMcpConnectionConfig`); load.ts populates this
 * field via that parser, whose output is structurally assignable to this union.
 * HTTP is the only transport wired today; stdio is declared for forward-compat.
 */
export interface ActiveMcp {
  id: string;
  slug: string;
  content: string;
  metadata: Record<string, unknown>;
  connection_config:
    | { transport: 'http'; url: string; headers?: Record<string, string>; secrets?: string[]; auth?: 'api_key' }
    | {
        transport: 'http';
        url: string;
        auth: 'oauth';
        oauth: { clientId?: string; clientSecretRef?: string; scopes?: string[]; authorizationServer?: string };
        headers?: Record<string, string>;
      }
    | { transport: 'http'; url: string; auth: 'vestra'; headers?: Record<string, string> }
    | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; secrets?: string[] }
    | null;
}

export interface ActiveAbility {
  ability: Ability;
  files: AbilityFile[];
  skills: ActiveSkill[];
  agents: ActiveAgent[];
  mcps: ActiveMcp[];
}

export interface MaterializedAbility {
  slug: string;
  dirPath: string;
  checksum: string;
}
