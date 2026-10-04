/**
 * The abilities frontmatter contract — the single source of truth for what a
 * skill/agent row's structured metadata must contain, and the normalizer every
 * mint site runs so content enters the catalog as (validated metadata, bare
 * body). Frontmatter on disk is EMITTED from metadata by ability-synthesis.ts —
 * never stored inline in `content`; this module is how inline frontmatter in
 * incoming markdown gets folded into metadata instead.
 *
 * YAML parsing is injected (`parseYaml`) so this ring stays YAML-dependency-free
 * (same reasoning as the hand-rolled emitter in ability-synthesis.ts).
 */
import { z } from 'zod';

export type FrontmatterIssueCode =
  | 'missing_frontmatter'
  | 'unparseable_yaml'
  | 'missing_name'
  | 'missing_description'
  | 'invalid_field'
  | 'unknown_key'
  | 'description_thin'
  | 'description_not_trigger_phrased'
  | 'inline_frontmatter_stripped'
  | 'derived_description';

export interface FrontmatterIssue {
  code: FrontmatterIssueCode;
  severity: 'error' | 'warn';
  field?: string;
  message: string;
}

export const DESCRIPTION_HARD_MIN = 16; // authoring floor (reject mode); ingest keeps any non-empty value
/**
 * Ceiling for a skill/agent description — and, by import, the catalog render cap
 * (`@bash/shared` format-catalog.ts). The description IS the trigger surface: the
 * model reads exactly this line per skill and picks by it, so the catalog shows it
 * whole and the authoring gate is the only place length is enforced. Over the
 * ceiling: reject mode (authoring surfaces, seed apply) refuses with the bounds
 * message — rewrite the frontmatter; derive mode (external ingest) falls through
 * its ladder as before. 2000 → 1000 on 2026-08-22 (founder call).
 */
export const DESCRIPTION_HARD_MAX = 1000;
export const DESCRIPTION_QUALITY_MIN = 60;
/** Ceiling for the joined `allowed-tools` string. Past it the list is CUT to whole
 *  names, never refused (founder 09-09, after a real 602-character skill was
 *  refused at the old 500 on prod). */
export const ALLOWED_TOOLS_HARD_MAX = 2000;

/** Stamped by mint sites from `frontmatterSource` — never accepted from inputs. */
export const RESERVED_METADATA_KEYS = ['frontmatter_source'] as const;

/** Past the ceiling the joined list is cut, never refused: whole names only, so a
 *  half-written name can never gate a tool. A single name longer than the ceiling
 *  is cut hard (it was never a real tool). */
function cutAllowedTools(joined: string): string {
  if (joined.length <= ALLOWED_TOOLS_HARD_MAX) return joined;
  let cut = joined.slice(0, ALLOWED_TOOLS_HARD_MAX);
  // The cut split a name unless the source continues with a separator.
  if (!/[,\s]/.test(joined.charAt(ALLOWED_TOOLS_HARD_MAX))) {
    const sep = cut.lastIndexOf(',');
    if (sep > 0) cut = cut.slice(0, sep);
  }
  return cut.replace(/[,\s]+$/, '');
}

const colorRe = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Accepts Claude's comma-string form ("Read, Grep") or a YAML list; canonical
 *  form is array — imported Claude-format content round-trips either way. */
const toolsField = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.string().min(1).max(80)).max(64),
  )
  .optional();

export const skillMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(DESCRIPTION_HARD_MAX),
    category: z.string().trim().min(1).max(40).optional(),
    icon: z.string().trim().min(1).max(120).optional(),
    color: z.string().regex(colorRe).optional(),
    // Claude Code's skill gating key. Accepts the comma-string form or a YAML
    // list (both appear in real content); canonical form is the comma string,
    // which the SDK consumes unchanged. An explicit empty marker ([] or '')
    // means "no restriction" and normalizes to absent.
    'allowed-tools': z.preprocess(
      (v) => {
        if (Array.isArray(v)) {
          const items = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
          return items.length ? cutAllowedTools(items.join(', ')) : undefined;
        }
        if (typeof v === 'string') return v.trim() === '' ? undefined : cutAllowedTools(v.trim());
        return v;
      },
      z.string().trim().min(1).max(ALLOWED_TOOLS_HARD_MAX).optional(),
    ),
    mcps: z.array(z.string().min(1).max(80)).max(32).optional(),
    tools: toolsField,
    args_schema: z.unknown().optional(),
  })
  .passthrough();
export type SkillFrontmatter = z.infer<typeof skillMetadataSchema>;

export const agentMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(DESCRIPTION_HARD_MAX),
    icon: z.string().trim().min(1).max(120).optional(),
    color: z.string().regex(colorRe).optional(),
    avatar_url: z.string().trim().max(500).optional(),
    model: z.string().trim().max(80).optional(),
    tools: toolsField,
  })
  .passthrough();
export type AgentFrontmatter = z.infer<typeof agentMetadataSchema>;

export const KNOWN_SKILL_METADATA_KEYS = [
  'name',
  'description',
  'category',
  'icon',
  'color',
  'allowed-tools',
  'mcps',
  'tools',
  'args_schema',
] as const;

export const KNOWN_AGENT_METADATA_KEYS = [
  'name',
  'description',
  'icon',
  'color',
  'avatar_url',
  'model',
  'tools',
] as const;

export interface FrontmatterSplit {
  /** Raw YAML between the fences; null when content carries no (closed) block. */
  rawYaml: string | null;
  /** Content with the block removed; one leading blank line stripped. */
  body: string;
  /** Set when an opening fence was found but never closed (malformed). */
  unclosed?: boolean;
}

const FENCE_OPEN = /^\uFEFF?---[ \t]*\r?\n/;
const FENCE_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/m;

export function splitFrontmatterBlock(content: string): FrontmatterSplit {
  const open = content.match(FENCE_OPEN);
  if (!open) return { rawYaml: null, body: content };
  const rest = content.slice(open[0].length);
  const close = rest.match(FENCE_CLOSE);
  if (!close || close.index === undefined) return { rawYaml: null, body: content, unclosed: true };
  const rawYaml = rest.slice(0, close.index).replace(/\r?\n$/, '');
  const afterFence = rest.slice(close.index).replace(/^(?:---|\.\.\.)[ \t]*\r?\n?/, '');
  return { rawYaml, body: afterFence.replace(/^\r?\n/, '') };
}

export type NormalizeMode = 'reject' | 'derive';

export interface NormalizeInput {
  /** Content as received — may carry inline frontmatter, or be a bare body. */
  content: string;
  slug: string;
  /** The row's current metadata when re-normalizing an existing item. */
  existingMetadata?: Record<string, unknown>;
  parseYaml: (src: string) => unknown;
  /**
   * reject: authoring surfaces — any error-severity issue fails the call.
   * derive: ingest surfaces (external installs) — fill gaps from body prose,
   * drop invalid optional fields with warns; fail only when the description
   * cannot be satisfied from any source.
   */
  mode: NormalizeMode;
}

export interface NormalizedAbilityItem<M> {
  metadata: M;
  /** Bare body — no frontmatter fence. For agents this is the system prompt. */
  body: string;
  issues: FrontmatterIssue[];
  /** Provenance of the winning description — the catalog's trigger surface. */
  frontmatterSource: 'inline' | 'metadata' | 'merged' | 'derived';
}

export type NormalizeResult<M> =
  | { ok: true; value: NormalizedAbilityItem<M> }
  | { ok: false; issues: FrontmatterIssue[] };

const warn = (code: FrontmatterIssueCode, message: string, field?: string): FrontmatterIssue => ({
  code,
  severity: 'warn',
  ...(field ? { field } : {}),
  message,
});

const error = (code: FrontmatterIssueCode, message: string, field?: string): FrontmatterIssue => ({
  code,
  severity: 'error',
  ...(field ? { field } : {}),
  message,
});

/** Drop reserved keys and empty/whitespace-only string values from a source. */
function sanitizeSource(source: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    if ((RESERVED_METADATA_KEYS as readonly string[]).includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** First prose paragraph of a markdown body — skips headings, quotes, lists,
 *  tables, fences, and rules; collapses whitespace; caps ~300 chars on a word
 *  boundary. Used to derive a description when no source provides one. */
export function firstProseParagraph(body: string): string | null {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (buf.length) break;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (t === '') {
      if (buf.length) break;
      continue;
    }
    if (
      /^#{1,6}\s/.test(t) ||
      t.startsWith('>') ||
      /^[-*+]\s/.test(t) ||
      /^\d+\.\s/.test(t) ||
      /^(?:-{3,}|_{3,}|\*{3,})$/.test(t) ||
      t.startsWith('|')
    ) {
      if (buf.length) break;
      continue;
    }
    buf.push(t);
  }
  if (!buf.length) return null;
  let s = buf.join(' ').replace(/\s+/g, ' ').replace(/[*_`]/g, '').trim();
  if (s.length > 300) {
    s = s.slice(0, 300);
    const cut = s.lastIndexOf(' ');
    if (cut > 200) s = s.slice(0, cut);
    s = `${s.trimEnd()}…`;
  }
  return s;
}

const TRIGGER_PHRASE_RE =
  /\buse (this|it|when|for|whenever|with)\b|\bwhen (the )?user\b|\bwhen you\b|\btrigger(s|ed)?\b|\binvoke\b|\basks? (to|for|about)\b/i;

/** Warn-level quality signals for a description — the auto-invocation surface. */
export function assessDescriptionQuality(description: string): FrontmatterIssue[] {
  const issues: FrontmatterIssue[] = [];
  if (description.trim().length < DESCRIPTION_QUALITY_MIN) {
    issues.push(warn('description_thin', `description under ${DESCRIPTION_QUALITY_MIN} chars reads as a label, not a trigger`, 'description'));
  }
  if (!TRIGGER_PHRASE_RE.test(description)) {
    issues.push(
      warn(
        'description_not_trigger_phrased',
        'description says what-it-is but not when-to-use — add "Use when …" phrasing',
        'description',
      ),
    );
  }
  return issues;
}

/** Boilerplate blocks that belong at harness level, never per-body. Exact,
 *  conservative shapes only — a miss is safe, a false strip is not. */
const KNOWN_BOILERPLATE: RegExp[] = [
  /^>\s*\*\*Tools in this skill are available via Composio MCP\.\*\*[^\n]*\n(?:>[^\n]*\n)*\r?\n?/m,
];

export function stripKnownBoilerplate(body: string): { body: string; stripped: boolean } {
  let out = body;
  let stripped = false;
  for (const re of KNOWN_BOILERPLATE) {
    if (re.test(out)) {
      out = out.replace(re, '');
      stripped = true;
    }
  }
  return { body: stripped ? out.replace(/^\n+/, '') : out, stripped };
}

interface NormalizeCoreConfig<M> {
  schema: z.ZodType<M>;
  knownKeys: readonly string[];
}

function normalizeCore<M extends Record<string, unknown>>(
  config: NormalizeCoreConfig<M>,
  input: NormalizeInput,
): NormalizeResult<M> {
  const issues: FrontmatterIssue[] = [];
  const split = splitFrontmatterBlock(input.content);

  let inline: Record<string, unknown> | null = null;
  if (split.rawYaml !== null) {
    try {
      const parsed = input.parseYaml(split.rawYaml);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inline = parsed as Record<string, unknown>;
        issues.push(warn('inline_frontmatter_stripped', 'inline frontmatter folded into metadata; body stored bare'));
      } else {
        issues.push(warn('unparseable_yaml', 'frontmatter yaml is not a mapping'));
      }
    } catch {
      issues.push(warn('unparseable_yaml', 'frontmatter yaml failed to parse'));
    }
  } else if (split.unclosed) {
    issues.push(warn('unparseable_yaml', 'unclosed frontmatter fence treated as body'));
  }

  const inlineClean = sanitizeSource(inline);
  const existingClean = sanitizeSource(input.existingMetadata);
  const body = split.body;

  const descCandidates: Array<{ value: string; source: 'inline' | 'metadata' | 'derived' }> = [];
  const inlineDesc = asNonEmptyString(inlineClean.description);
  if (inlineDesc) descCandidates.push({ value: inlineDesc, source: 'inline' });
  const existingDesc = asNonEmptyString(existingClean.description);
  if (existingDesc) descCandidates.push({ value: existingDesc, source: 'metadata' });

  const withinBounds = (s: string) => s.length >= DESCRIPTION_HARD_MIN && s.length <= DESCRIPTION_HARD_MAX;

  // Ladder: (1) an in-bounds candidate; (2) derived body prose (derive mode);
  // (3) a short-but-nonempty candidate as last resort (derive mode, thin-warned)
  // — blocking an external install over a third-party description's length is
  // the wrong teeth; the floor is an authoring gate. Reject mode stops at (1).
  let description: string | null = null;
  let descSource: 'inline' | 'metadata' | 'derived' | null = null;
  for (const candidate of descCandidates) {
    if (withinBounds(candidate.value)) {
      description = candidate.value;
      descSource = candidate.source;
      break;
    }
    if (input.mode === 'reject') {
      return {
        ok: false,
        issues: [
          ...issues,
          error('invalid_field', `description must be ${DESCRIPTION_HARD_MIN}–${DESCRIPTION_HARD_MAX} chars`, 'description'),
        ],
      };
    }
  }

  if (!description && input.mode === 'derive') {
    const derived = firstProseParagraph(body);
    if (derived && withinBounds(derived)) {
      description = derived;
      descSource = 'derived';
      issues.push(warn('derived_description', 'description derived from the first prose paragraph', 'description'));
    } else {
      const lastResort = descCandidates.find((c) => c.value.length > 0 && c.value.length <= DESCRIPTION_HARD_MAX);
      if (lastResort) {
        description = lastResort.value;
        descSource = lastResort.source;
        issues.push(warn('description_thin', 'below-floor description accepted at ingest; flagged for review', 'description'));
      }
    }
  }
  if (!description) {
    return {
      ok: false,
      issues: [...issues, error('missing_description', 'no usable description in frontmatter, metadata, or body prose', 'description')],
    };
  }

  const name = asNonEmptyString(inlineClean.name) ?? asNonEmptyString(existingClean.name) ?? input.slug;

  const merged: Record<string, unknown> = { ...existingClean, ...inlineClean, name, description };

  let parsed = config.schema.safeParse(merged);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map((zi) => {
      const field = String(zi.path[0] ?? '');
      const absent = merged[field] === undefined;
      const code: FrontmatterIssueCode =
        field === 'name' && absent ? 'missing_name' : field === 'description' && absent ? 'missing_description' : 'invalid_field';
      return { field, issue: error(code, zi.message, field) };
    });
    if (input.mode === 'reject') {
      return { ok: false, issues: [...issues, ...fieldErrors.map((fe) => fe.issue)] };
    }
    for (const fe of fieldErrors) {
      if (fe.field === 'name' || fe.field === 'description') {
        return { ok: false, issues: [...issues, fe.issue] };
      }
      delete merged[fe.field];
      issues.push(warn('invalid_field', `invalid ${fe.field} dropped`, fe.field));
    }
    parsed = config.schema.safeParse(merged);
    if (!parsed.success) {
      return { ok: false, issues: [...issues, ...parsed.error.issues.map((zi) => error('invalid_field', zi.message, String(zi.path[0] ?? '')))] };
    }
  }

  for (const key of Object.keys(parsed.data)) {
    if (!config.knownKeys.includes(key)) {
      issues.push(warn('unknown_key', `unknown frontmatter key carried through`, key));
    }
  }

  const existingContributed = config.knownKeys.some(
    (key) => key in parsed.data && !(key in inlineClean) && key in existingClean,
  );
  const frontmatterSource: NormalizedAbilityItem<M>['frontmatterSource'] =
    descSource === 'inline' ? (existingContributed ? 'merged' : 'inline') : descSource === 'metadata' ? 'metadata' : 'derived';

  return {
    ok: true,
    value: { metadata: parsed.data as M, body, issues, frontmatterSource },
  };
}

export function normalizeSkillSource(input: NormalizeInput): NormalizeResult<SkillFrontmatter> {
  return normalizeCore<SkillFrontmatter>({ schema: skillMetadataSchema, knownKeys: KNOWN_SKILL_METADATA_KEYS }, input);
}

export function normalizeAgentSource(input: NormalizeInput): NormalizeResult<AgentFrontmatter> {
  return normalizeCore<AgentFrontmatter>({ schema: agentMetadataSchema, knownKeys: KNOWN_AGENT_METADATA_KEYS }, input);
}
