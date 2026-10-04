// tools/edit-normalize.ts
//
// EDIT_HARDEN_V1 — the pure half of Edit hardening: malformed-argument repair and
// a DETERMINISTIC fuzzy match. Every failed Edit is a billed round-trip, and open
// models (DeepSeek/GLM via Fireworks) burn them two ways: they corrupt copied text
// (smart quotes, dash substitution, trailing-whitespace drift) and they serialize
// arguments in shapes our schema does not declare.
//
// The fuzzy space is a FIXED transform set, never an edit-distance score: NFKC,
// smart quotes → ASCII, Unicode dashes → '-', Unicode spaces → ' ', trailing
// whitespace stripped per line, CR dropped. It targets exactly how a model corrupts
// text it copied, and it CANNOT match semantically different code — leading
// indentation and tabs are untouched, so a differently-indented block still misses.
//
// PURE: no fs, no env, no @bash/*. Unit-tested in isolation.

/** Split into lines that KEEP their terminator: `body\n`, or a final `body`. */
function splitLinesKeepingEndings(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// NFKC already folds most of these (NBSP, the U+2002-200A run, U+3000); the explicit
// passes cover what it does not (smart quotes, en/em dash, U+2212 minus) and keep the
// transform readable as a list of what a model actually corrupts.
const SMART_SINGLE_QUOTE = /[\u2018\u2019\u201A\u201B]/g;
const SMART_DOUBLE_QUOTE = /[\u201C\u201D\u201E\u201F]/g;
// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2013 en dash,
// U+2014 em dash, U+2015 horizontal bar, U+2212 minus sign.
const UNICODE_DASH = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
// U+00A0 NBSP, the U+2002-U+200A run, U+202F narrow NBSP, U+205F medium math
// space, U+3000 ideographic space.
const UNICODE_SPACE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalize ONE line body (terminator already removed). Trailing whitespace is
 * stripped LAST so a line ending in a non-breaking space is trimmed too, and the
 * `\s+$` pass also drops the CR of a CRLF line. LEADING whitespace is never touched.
 */
function normalizeLineBody(body: string): string {
  return body
    .normalize('NFKC')
    .replace(SMART_SINGLE_QUOTE, "'")
    .replace(SMART_DOUBLE_QUOTE, '"')
    .replace(UNICODE_DASH, '-')
    .replace(UNICODE_SPACE, ' ')
    .replace(/\s+$/, '');
}

function normalizeLine(line: string): string {
  const hasNewline = line.endsWith('\n');
  return normalizeLineBody(hasNewline ? line.slice(0, -1) : line) + (hasNewline ? '\n' : '');
}

interface LineSpan {
  start: number;
  end: number;
}

export interface NormalizedView {
  /** The normalized text. */
  text: string;
  /** The ORIGINAL lines, terminators included — the bytes unchanged lines keep. */
  originalLines: string[];
  /** Each normalized line's span in `text`; `spans.length === originalLines.length`. */
  spans: LineSpan[];
}

/**
 * Build the normalized view of a file. Normalizing PER LINE (rather than over the
 * whole string) is what makes the offset mapping tractable: the normalized text has
 * the same line COUNT as the original by construction, so a match's char offsets map
 * to original lines by span lookup with no alignment search.
 */
export function buildNormalizedView(text: string): NormalizedView {
  const originalLines = splitLinesKeepingEndings(text);
  const spans: LineSpan[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const line of originalLines) {
    const norm = normalizeLine(line);
    parts.push(norm);
    spans.push({ start: offset, end: offset + norm.length });
    offset += norm.length;
  }
  return { text: parts.join(''), originalLines, spans };
}

/** Normalize a needle through the SAME per-line transform, so both spaces agree. */
export function normalizeNeedle(needle: string): string {
  return splitLinesKeepingEndings(needle).map(normalizeLine).join('');
}

export type FuzzyEditResult =
  | { kind: 'ok'; text: string; count: number }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number };

interface Replacement {
  start: number;
  end: number;
}

interface Group {
  firstLine: number;
  lastLine: number;
  replacements: Replacement[];
}

/** The line ending this original line carries. */
function endingOf(line: string | undefined): '\r\n' | '\n' {
  return line?.endsWith('\r\n') ? '\r\n' : '\n';
}

/** Re-terminate a rebuilt block: LF-normalize first so a CRLF file never gets `\r\r\n`. */
function reterminate(block: string, ending: '\r\n' | '\n'): string {
  const lf = block.replace(/\r\n/g, '\n');
  return ending === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * Replace `oldStr` with `newStr` in `original`, matching in normalized space.
 *
 * Only the lines a match actually TOUCHES are rewritten (from the normalized text,
 * with the replacement applied and the original line ending restored); every other
 * line is copied back byte-for-byte from `original`. So a fuzzy match can never
 * silently re-normalize the rest of the file — the blast radius is the matched block.
 *
 * The caller is expected to have tried an exact match first; this is the fallback.
 */
export function fuzzyReplace(
  original: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): FuzzyEditResult {
  const view = buildNormalizedView(original);
  const needle = normalizeNeedle(oldStr);
  if (needle === '') return { kind: 'not_found' };

  // Non-overlapping scan — the same occurrence count `split(needle).length - 1` gives.
  const hits: number[] = [];
  for (let i = view.text.indexOf(needle); i !== -1; i = view.text.indexOf(needle, i + needle.length)) {
    hits.push(i);
  }
  if (hits.length === 0) return { kind: 'not_found' };
  if (hits.length > 1 && !replaceAll) return { kind: 'ambiguous', count: hits.length };

  const lineOf = (offset: number): number => {
    let i = 0;
    while (i < view.spans.length - 1 && view.spans[i].end <= offset) i++;
    return i;
  };

  // Widen each match to the lines it touches, merging matches that share a line.
  const groups: Group[] = [];
  for (const start of replaceAll ? hits : [hits[0]]) {
    const end = start + needle.length;
    const firstLine = lineOf(start);
    const lastLine = lineOf(end - 1);
    const current = groups[groups.length - 1];
    if (current && firstLine <= current.lastLine) {
      current.lastLine = Math.max(current.lastLine, lastLine);
      current.replacements.push({ start, end });
      continue;
    }
    groups.push({ firstLine, lastLine, replacements: [{ start, end }] });
  }

  const out: string[] = [];
  let cursor = 0;
  for (const group of groups) {
    out.push(view.originalLines.slice(cursor, group.firstLine).join(''));

    const blockStart = view.spans[group.firstLine].start;
    const blockEnd = view.spans[group.lastLine].end;
    let block = view.text.slice(blockStart, blockEnd);
    // Right-to-left so earlier offsets stay valid.
    for (let i = group.replacements.length - 1; i >= 0; i--) {
      const r = group.replacements[i];
      block = block.slice(0, r.start - blockStart) + newStr + block.slice(r.end - blockStart);
    }
    out.push(reterminate(block, endingOf(view.originalLines[group.firstLine])));
    cursor = group.lastLine + 1;
  }
  out.push(view.originalLines.slice(cursor).join(''));

  return { kind: 'ok', text: out.join(''), count: replaceAll ? hits.length : 1 };
}

/** Strip a UTF-8 BOM, returning it separately so the write can put it back. */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}

// ── Malformed-argument repair ────────────────────────────────────────────────

export interface EditArgs {
  file_path: unknown;
  old_string: unknown;
  new_string: unknown;
  replace_all?: unknown;
}

export type RepairResult =
  | { ok: true; args: EditArgs; repaired: boolean }
  | { ok: false; error: string };

// Only shapes a model plausibly produces: `path`/`old_str`/`new_str` are Anthropic's
// text_editor names, `oldText`/`newText` are the pi/OpenCode names, the camelCase
// pair is generic drift. A canonical key that is already present always wins.
const ALIASES: Record<string, readonly string[]> = {
  file_path: ['path', 'filePath', 'filepath'],
  old_string: ['old_str', 'oldText', 'oldString'],
  new_string: ['new_str', 'newText', 'newString'],
};

function parseJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function liftEdit(entry: unknown): { old: unknown; new: unknown } | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const oldValue = e.old_string ?? e.oldText ?? e.old_str ?? e.oldString;
  const newValue = e.new_string ?? e.newText ?? e.new_str ?? e.newString;
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return null;
  return { old: oldValue, new: newValue };
}

/**
 * Upgrade a malformed Edit argument object in place of erroring. Each repair here is
 * one billed round-trip the model does not have to spend re-issuing the call, so the
 * repairs are SILENT — the model gets the ordinary success string, not a correction.
 *
 * The one shape that must NOT be repaired silently is a multi-entry `edits` array:
 * Edit applies exactly one replacement, so applying only the first would drop the
 * rest without saying so. That returns an actionable error naming the count.
 */
export function repairEditArgs(input: unknown): RepairResult {
  let raw: unknown = input;
  let repaired = false;

  // The whole argument object arrived as a JSON string. (Field-level stringification
  // is already handled upstream by the dispatcher's coerceStringifiedToolArgs, but
  // that is schema-driven and Edit declares no structured field, so it never fires
  // here.)
  if (typeof raw === 'string') {
    const parsed = parseJsonish(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed;
      repaired = true;
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: true, args: raw as EditArgs, repaired };
  }

  const src = raw as Record<string, unknown>;
  const args: Record<string, unknown> = { ...src };

  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (args[canonical] !== undefined) continue;
    for (const alias of aliases) {
      if (typeof src[alias] === 'string') {
        args[canonical] = src[alias];
        delete args[alias];
        repaired = true;
        break;
      }
    }
  }

  // An `edits` array — sent whole as a JSON string by some models, or as a real array
  // by a model that learned a multi-edit tool elsewhere.
  let edits = args.edits;
  if (typeof edits === 'string') {
    const parsed = parseJsonish(edits);
    if (Array.isArray(parsed)) edits = parsed;
  }
  if (Array.isArray(edits)) {
    if (edits.length > 1) {
      return {
        ok: false,
        error:
          `Edit applies ONE replacement per call, but ${edits.length} edits were supplied. ` +
          'Issue one Edit per change, or use Patch to apply several at once.',
      };
    }
    const lifted = edits.length === 1 ? liftEdit(edits[0]) : null;
    if (lifted) {
      if (args.old_string === undefined) args.old_string = lifted.old;
      if (args.new_string === undefined) args.new_string = lifted.new;
      delete args.edits;
      repaired = true;
    }
  }

  if (typeof args.replace_all === 'string') {
    const v = args.replace_all.trim().toLowerCase();
    if (v === 'true' || v === '1') {
      args.replace_all = true;
      repaired = true;
    } else if (v === 'false' || v === '0') {
      args.replace_all = false;
      repaired = true;
    }
  }

  return { ok: true, args: args as unknown as EditArgs, repaired };
}
