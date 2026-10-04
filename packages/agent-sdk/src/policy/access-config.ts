/**
 * ACCESS CONFIG — the "Custom" position on the permissions dial (permissions v2, B1b).
 *
 * An `AccessConfig` is either a preset level or a custom shape: per-side-effect-family
 * Ask/Allow toggles plus per-app (Composio toolkit) Ask/Allow/Block pins. `compileAccessConfig`
 * lowers it to the ONE artifact the gate consumes: a silent-family set (families that do NOT
 * ask at the soft step; dangerous_delete membership = the delete floor is lifted) and a
 * normalized lowercase toolkit → family → action map.
 *
 * Frozen semantics (plan 2026-07-09-perm-b1b):
 *   - Preset silence derives purely from `!(levelAsks || hardFloors)` — never a second table.
 *   - Custom base = the RELAXED column; `families` toggles override it in both directions.
 *   - Payment is NEVER configurable: excluded from `families` at the type level, never
 *     silent, and any `payment` key inside `apps.*` is dropped at compile. The same holds
 *     for `unknown` and `protected_remote` (a force push, a remote branch delete).
 *   - Compile is TOTAL: unknown family keys, unknown values, malformed stored jsonb — all
 *     dropped, never thrown (forward compat with configs written by newer code).
 *   - `clampConfig` is tighten-only: child silence ∩ parent silence; parent app blocks are
 *     unremovable; a child already within its parent is returned by reference.
 *   - `bashChats` (a chat-born task's own chats with Bash, 2026-10-03) are never configurable
 *     by the person: the server writes them at birth, the gate refuses any write into them
 *     made as the owner (bash-chats.ts), and a clamp keeps the union of child and parent.
 *     `slackBornConfig` builds the config such a task runs at.
 *
 * PURE / TOTAL. No I/O, no state.
 */

import {
  ACCESS_LEVELS,
  hardFloors,
  levelAsks,
  type AccessLevel,
} from './access-level.js';
import type { SideEffectFamily } from './side-effect-classifier.js';

export type FamilyToggle = 'ask' | 'allow';
export type AppAction = 'ask' | 'allow' | 'block';

export interface AccessConfig {
  level: AccessLevel | 'custom';
  families?: Partial<Record<ConfigurableFamily, FamilyToggle>>;
  apps?: Record<string, Partial<Record<SideEffectFamily, AppAction>>>;
  /**
   * The conversations Bash itself answers this task in, by the app's own ids: for a task asked for
   * in Slack, the owner's DM channel with Bash (D…) and Bash's bot user (U…) in that workspace. Bash
   * delivers there, so nothing is ever written into them as the owner (the gate's step 1c): a post as
   * them would come back to Bash as their own words. Written by the server at a chat birth, never by
   * the person. Absent on every other task.
   */
  bashChats?: string[];
}

export interface CompiledAccessConfig {
  /** Families that do NOT ask at the soft step (8b). dangerous_delete membership = floor lifted. */
  silentFamilies: ReadonlySet<SideEffectFamily>;
  /** Toolkit (lowercase) → family → action. payment keys never present. */
  apps: ReadonlyMap<string, Partial<Record<SideEffectFamily, AppAction>>>;
  /** `bashChats`, lowercased. Absent when the config names none. */
  bashChats?: ReadonlySet<string>;
}

/** The families a user may toggle: every family except the never-configurable always-ask ones. */
export type ConfigurableFamily = Exclude<SideEffectFamily, 'payment' | 'unknown' | 'protected_remote'>;

const CONFIGURABLE_FAMILIES: readonly ConfigurableFamily[] = Object.freeze([
  'readonly', 'workspace_write', 'external_send', 'external_mutation', 'dangerous_delete',
]);

const APP_FAMILIES: ReadonlySet<string> = new Set<string>(CONFIGURABLE_FAMILIES);
const APP_ACTIONS: ReadonlySet<string> = new Set<string>(['ask', 'allow', 'block']);

function isConfigurableFamily(key: string): key is ConfigurableFamily {
  return APP_FAMILIES.has(key);
}

function isPresetLevel(level: unknown): level is AccessLevel {
  return typeof level === 'string' && (ACCESS_LEVELS as readonly string[]).includes(level);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The non-blank string entries of a stored `bashChats`, trimmed; [] for anything else. Total. */
function chatIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim());
}

/**
 * Lower an AccessConfig to the artifact the gate consumes. Presets derive their silence
 * from the level matrix; `custom` (and any unrecognized level in stored jsonb) starts from
 * the Relaxed column. TOTAL — garbage shapes compile to the base, never throw.
 */
export function compileAccessConfig(cfg: AccessConfig): CompiledAccessConfig {
  const raw: unknown = cfg;
  const level = isPlainObject(raw) && isPresetLevel(raw.level) ? raw.level : 'relaxed';

  const silentFamilies = new Set<SideEffectFamily>();
  for (const family of CONFIGURABLE_FAMILIES) {
    if (!(levelAsks(family, level) || hardFloors(family, level))) silentFamilies.add(family);
  }

  const families = isPlainObject(raw) ? raw.families : undefined;
  if (isPlainObject(families)) {
    for (const [key, toggle] of Object.entries(families)) {
      if (!isConfigurableFamily(key)) continue;
      if (toggle === 'ask') silentFamilies.delete(key);
      else if (toggle === 'allow') silentFamilies.add(key);
    }
  }

  const apps = new Map<string, Partial<Record<SideEffectFamily, AppAction>>>();
  const rawApps = isPlainObject(raw) ? raw.apps : undefined;
  if (isPlainObject(rawApps)) {
    for (const [toolkit, entry] of Object.entries(rawApps)) {
      if (!isPlainObject(entry)) continue;
      const normalized: Partial<Record<SideEffectFamily, AppAction>> = {};
      for (const [key, action] of Object.entries(entry)) {
        if (!isConfigurableFamily(key)) continue; // drops the always-ask families (payment, unknown, protected_remote)
        if (typeof action !== 'string' || !APP_ACTIONS.has(action)) continue;
        normalized[key] = action as AppAction;
      }
      if (Object.keys(normalized).length === 0) continue;
      const slug = toolkit.toLowerCase();
      apps.set(slug, { ...apps.get(slug), ...normalized });
    }
  }

  const chats = new Set(chatIds(isPlainObject(raw) ? raw.bashChats : undefined).map((c) => c.toLowerCase()));
  return chats.size > 0 ? { silentFamilies, apps, bashChats: chats } : { silentFamilies, apps };
}

/**
 * Does `compiled` run `family` SILENTLY for `toolkit`? The per-cell posture: an app pin
 * beats the global toggle (block/ask pin ⇒ gated, allow pin ⇒ silent — the config
 * precedence rule), else the global silent set decides.
 */
function cellSilent(compiled: CompiledAccessConfig, toolkit: string, family: SideEffectFamily): boolean {
  const appAction = compiled.apps.get(toolkit)?.[family];
  if (appAction !== undefined) return appAction === 'allow';
  return compiled.silentFamilies.has(family);
}

/**
 * Tighten a CHILD config (subagent / weave node / teammate) so it is never LOOSER than
 * its parent, at CALL level: no (toolkit, family) cell the parent gates may run silent
 * under the child. The clamped silence is the intersection of both silences (any family
 * the parent asks for, the child asks for — which also gates the dangerous_delete lift on
 * the parent having lifted it); a child app `allow` survives only where the parent's own
 * per-cell posture is silent (so a per-app dangerous_delete lift is gated the same way);
 * parent app `ask` and `block` pins union into the clamped child (block wins over ask
 * where both apply; a child `block` survives over a parent ask-pin — blocking is
 * stricter). Parent app allows do NOT propagate; child asks/blocks always survive. A
 * child already within its parent is returned unchanged (by reference). Pure + total.
 */
export function clampConfig(child: AccessConfig, parent: AccessConfig): AccessConfig {
  const childCompiled = compileAccessConfig(child);
  const parentCompiled = compileAccessConfig(parent);

  const silent = new Set<SideEffectFamily>(
    [...childCompiled.silentFamilies].filter((f) => parentCompiled.silentFamilies.has(f)),
  );

  const apps = new Map<string, Partial<Record<SideEffectFamily, AppAction>>>();
  let appsChanged = false;
  for (const [toolkit, entry] of childCompiled.apps) {
    const kept: Partial<Record<SideEffectFamily, AppAction>> = {};
    for (const family of CONFIGURABLE_FAMILIES) {
      const action = entry[family];
      if (action === undefined) continue;
      if (action === 'allow' && !cellSilent(parentCompiled, toolkit, family)) {
        appsChanged = true; // strip: the parent gates this cell
        continue;
      }
      kept[family] = action;
    }
    if (Object.keys(kept).length > 0) apps.set(toolkit, kept);
  }
  for (const [toolkit, entry] of parentCompiled.apps) {
    for (const family of CONFIGURABLE_FAMILIES) {
      const pin = entry[family];
      if (pin !== 'block' && pin !== 'ask') continue; // allow-pins never propagate
      const existing = apps.get(toolkit);
      const current = existing?.[family];
      // parent block wins over everything; a child block outranks a parent ask-pin
      const next: AppAction = pin === 'block' || current === 'block' ? 'block' : 'ask';
      if (current === next) continue;
      apps.set(toolkit, { ...existing, [family]: next });
      appsChanged = true;
    }
  }

  // A parent's own chats with Bash stay closed to the child (a teammate of a Slack-born task).
  const childChats = chatIds(child.bashChats);
  const chats = [...new Set([...childChats, ...chatIds(parent.bashChats)])];
  const chatsChanged = chats.length !== childChats.length;

  if (!appsChanged && !chatsChanged && silent.size === childCompiled.silentFamilies.size) return child;
  if (!appsChanged && silent.size === childCompiled.silentFamilies.size) return { ...child, bashChats: chats };

  const families: NonNullable<AccessConfig['families']> = {};
  for (const family of CONFIGURABLE_FAMILIES) {
    families[family] = silent.has(family) ? 'allow' : 'ask';
  }
  const clamped: AccessConfig = { level: 'custom', families };
  if (apps.size > 0) clamped.apps = Object.fromEntries(apps);
  if (chats.length > 0) clamped.bashChats = chats;
  return clamped;
}

/** The families a write made as the owner in Slack falls in: a message is a send, an upload or an edit a change. */
const SLACK_ACTS_AS_OWNER: readonly SideEffectFamily[] = ['external_send', 'external_mutation'];

/**
 * The config a task asked for in Slack runs at (2026-10-03): `own` (the owner's config, or `{ level }` when they have
 * none) with every Slack cell of SLACK_ACTS_AS_OWNER pinned to `ask` unless it is a `block`, and `chats` (their chats
 * with Bash) named. Toolkit keys fold to lowercase first, as compile does, so a stored "Slack" pin is read, never
 * shadowed. The server computes it from the owner's live dials on every read, so it lives here beside the clamp. Pure.
 */
export function slackBornConfig(own: AccessConfig | null, level: AccessLevel, chats: string[]): AccessConfig {
  const base: AccessConfig = own ?? { level };
  const apps: NonNullable<AccessConfig['apps']> = {};
  let slack: Partial<Record<SideEffectFamily, AppAction>> = {};
  for (const [toolkit, entry] of Object.entries(base.apps ?? {})) {
    if (toolkit.toLowerCase() === 'slack') slack = { ...slack, ...entry };
    else apps[toolkit] = entry;
  }
  for (const family of SLACK_ACTS_AS_OWNER) if (slack[family] !== 'block') slack[family] = 'ask';
  apps.slack = slack;
  const named = [...new Set([...(base.bashChats ?? []), ...chats])];
  return { ...base, apps, ...(named.length ? { bashChats: named } : {}) };
}

/**
 * Validate raw stored jsonb into an AccessConfig. TOTAL: null on garbage. Strict on
 * structure (a real object, a known level, `families`/`apps` plain objects when present);
 * lenient on entries (unknown family keys, unknown values, and non-object app entries are
 * dropped, not fatal — forward compat). `payment` keys are dropped everywhere, including
 * inside `apps.*` — defense-in-depth matching compile (payments are never configurable).
 * Toolkit-key lowercasing stays compile's job; parse otherwise preserves valid entries.
 */
export function parseAccessConfig(raw: unknown): AccessConfig | null {
  if (!isPlainObject(raw)) return null;
  if (raw.level !== 'custom' && !isPresetLevel(raw.level)) return null;
  const out: AccessConfig = { level: raw.level };

  if (raw.families !== undefined) {
    if (!isPlainObject(raw.families)) return null;
    const families: NonNullable<AccessConfig['families']> = {};
    for (const [key, toggle] of Object.entries(raw.families)) {
      if (!isConfigurableFamily(key)) continue;
      if (toggle !== 'ask' && toggle !== 'allow') continue;
      families[key] = toggle;
    }
    out.families = families;
  }

  if (raw.apps !== undefined) {
    if (!isPlainObject(raw.apps)) return null;
    const apps: NonNullable<AccessConfig['apps']> = {};
    for (const [toolkit, entry] of Object.entries(raw.apps)) {
      if (!isPlainObject(entry)) continue;
      const kept: Partial<Record<SideEffectFamily, AppAction>> = {};
      for (const [key, action] of Object.entries(entry)) {
        if (!isConfigurableFamily(key)) continue; // drops the always-ask families (payment, unknown, protected_remote)
        if (typeof action !== 'string' || !APP_ACTIONS.has(action)) continue;
        kept[key] = action as AppAction;
      }
      if (Object.keys(kept).length > 0) apps[toolkit] = kept;
    }
    out.apps = apps;
  }

  if (raw.bashChats !== undefined) {
    const chats = chatIds(raw.bashChats);
    if (chats.length > 0) out.bashChats = chats;
  }

  return out;
}
