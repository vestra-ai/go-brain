import type { AbilityManifest } from '../contract/ability.js';

/** A standalone skill (the SDK's first-class skill primitive — §14 peers). */
export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  files?: Record<string, string>;
}

/** A standalone agent/subagent (the SDK's first-class agent primitive — §14). */
export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}

/** An ability bundle resolved for loading: its manifest + relative-path files. */
export interface LoadedAbility {
  manifest: AbilityManifest;
  files: Record<string, string>;
}

/**
 * CatalogLoaderPort — yields the active skills, agents, and abilities (the
 * three first-class peers) for a session. Mirrors the Claude SDK's three load
 * paths. The host backs it (Supabase + volume); the SDK ships an empty default.
 */
export interface CatalogLoaderPort {
  loadSkills(): Promise<SkillDefinition[]>;
  loadAgents(): Promise<AgentDefinition[]>;
  loadAbilities(): Promise<LoadedAbility[]>;
}

/** SDK default: an empty catalog. */
export class EmptyCatalogLoader implements CatalogLoaderPort {
  async loadSkills(): Promise<SkillDefinition[]> {
    return [];
  }
  async loadAgents(): Promise<AgentDefinition[]> {
    return [];
  }
  async loadAbilities(): Promise<LoadedAbility[]> {
    return [];
  }
}
