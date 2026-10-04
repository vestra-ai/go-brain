/**
 * Ability types — see docs/superpowers/specs/2026-05-14-abilities-design.md
 *
 * An Ability is a bundle of skills + agents + MCPs + hooks (with optional
 * CLAUDE.md voice and assets/ escape hatch) addressable by a slug. Maps 1:1
 * to the Anthropic SDK plugin shape with two Vestra extensions.
 */

// TODO(oss): Vestra ability/eval concept — convert to an injected port at ring 4 (see spec §12.2).

import type { AbilityEval } from './ability-evals.js';

export type AbilityScope = 'system' | 'user' | 'marketplace' | 'customer';

/**
 * Manifest shape (plugin.json) — three tiers.
 * Tier 1 required, Tier 2 required for marketplace publication, Tier 3 optional.
 */
export interface AbilityManifest {
  // Tier 1 — required core
  name: string;
  slug: string;
  version: string;
  description: string;

  // Tier 2 — agent legibility (required for marketplace publish)
  when_to_use?: string;
  examples?: string[];

  // Tier 3 — optional metadata
  author?: { id: string; name: string; url?: string };
  category?: string;
  icon?: string;
  color?: string;
  tags?: string[];
  pinned?: boolean;
  requires?: {
    abilities?: string[];
    secrets?: string[];
    min_vestra_version?: string;
  };
  permissions?: {
    tools?: { allow?: string[]; deny?: string[] };
  };
  ui?: {
    home_route?: string;
    sidebar?: { label: string; icon?: string };
  };
  /**
   * Eval declarations for the ability Stop-gate scaffold (K4-T10).
   * When present, `runAbilityEvals` executes each eval before the ability
   * is considered shippable. Failing evals cause the ability to be FLAGGED,
   * not shipped. Optional — absent or empty → unconditional pass.
   *
   * The harness wiring (invoking runAbilityEvals at ability-ship time) is
   * deferred; this field has no effect in production until that wiring lands.
   */
  evals?: AbilityEval[];
}

export interface Ability {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  manifest: AbilityManifest;
  scope: AbilityScope;
  owner_id: string | null;
  customer_id: string | null;
  source_ability_id: string | null;
  storage_path: string | null;
  checksum: string | null;
  published: boolean;
  installed_count: number;
  created_at: string;
  updated_at: string;
}

export interface AbilityFile {
  id: string;
  ability_id: string;
  /** Relative path within the ability dir, e.g. "skills/invoice-parser/SKILL.md". */
  path: string;
  filename: string;
  content: string | null;
  storage_path: string | null;
  content_type: string | null;
  size_bytes: number | null;
  is_binary: boolean;
  checksum: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserAbility {
  user_id: string;
  ability_id: string;
  installed_at: string;
  pinned_version: string | null;
  config: Record<string, unknown>;
}

/** The Essentials ability slug — referenced from many places. */
export const ESSENTIALS_SLUG = 'essentials' as const;
