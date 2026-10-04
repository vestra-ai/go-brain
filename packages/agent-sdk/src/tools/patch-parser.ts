// tools/patch-parser.ts
//
// Pure parser for the V4A apply-patch envelope (the codex/Claude format). NO line
// numbers: `@@` is a free-text CONTEXT HINT, not a `@@ -a,b +c,d @@` range. Hunk
// localization (fuzzy/exact matching) is the apply layer's job (patch-tool.ts) — this
// module only turns the envelope text into structured operations.
//
// PURE: no fs, no @bash/*, no host env. Unit-tested in isolation.

export type PatchOpKind = 'add' | 'update' | 'delete' | 'move';

export interface HunkLine {
  /** First char of the source line: ' ' context, '-' remove, '+' add. */
  prefix: ' ' | '-' | '+';
  content: string;
}

export interface Hunk {
  /** Free-text hint from `@@ <hint> @@`, or null. Used only to disambiguate. */
  contextHint: string | null;
  lines: HunkLine[];
}

export interface PatchOp {
  kind: PatchOpKind;
  /** Target path; for `move`, the SOURCE path. */
  path: string;
  /** `move` destination. */
  newPath?: string;
  /** `update` hunks. */
  hunks?: Hunk[];
  /** `add` file body. */
  content?: string;
}

export interface ParseResult {
  ops: PatchOp[];
  error?: string;
}

const BEGIN = /^\*\*\*\s*Begin Patch\s*$/;
const END = /^\*\*\*\s*End Patch\s*$/;
const FILE_VERB = /^\*\*\*\s*(Update|Add|Delete|Move)\s+File:\s*(.+?)\s*$/;
const MOVE = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$/;
const HUNK_BOTH = /^@@\s*(.*?)\s*@@\s*$/;

function err(message: string): ParseResult {
  return { ops: [], error: `Parse error: ${message}` };
}

/**
 * Parse a V4A patch envelope into ordered operations.
 * - `*** Begin Patch` / `*** End Patch` are optional (parse from line 0 / to EOF).
 * - Empty patch (no operations) → `{ ops: [] }` with NO error (a no-op patch).
 * - A structural problem (empty path, Update with no hunks, Move without dst) →
 *   `{ ops: [], error }`.
 */
export function parseV4APatch(text: string): ParseResult {
  // Normalize CRLF → LF so a CRLF-encoded patch doesn't carry a trailing \r into
  // every added/context line (which would then mismatch an LF disk file).
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  let end = rawLines.length;
  for (let i = 0; i < rawLines.length; i++) {
    if (BEGIN.test(rawLines[i])) {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < rawLines.length; i++) {
    if (END.test(rawLines[i])) {
      end = i;
      break;
    }
  }

  const ops: PatchOp[] = [];
  let cur: PatchOp | null = null;
  let curHunk: Hunk | null = null;
  const addContent: string[] = [];

  // Push the in-progress hunk only if it carries lines — an EMPTY hunk (two
  // consecutive `@@`, or a trailing `@@` with no body) is dropped so it can't reach
  // applyHunk as a phantom no-op (which would append a stray newline + mis-report
  // "modified").
  const pushHunk = (): void => {
    if (curHunk && curHunk.lines.length > 0) cur!.hunks!.push(curHunk);
    curHunk = null;
  };
  const finishUpdate = (): ParseResult | null => {
    if (cur && cur.kind === 'update') {
      pushHunk();
      if (!cur.hunks || cur.hunks.length === 0) {
        return err(`Update File '${cur.path}' has no hunks`);
      }
    }
    return null;
  };
  const finishAdd = (): void => {
    if (cur && cur.kind === 'add') {
      cur.content = addContent.join('\n');
      addContent.length = 0;
    }
  };
  const flush = (): ParseResult | null => {
    const e = finishUpdate();
    if (e) return e;
    finishAdd();
    if (cur) ops.push(cur);
    cur = null;
    return null;
  };

  for (let i = start; i < end; i++) {
    const line = rawLines[i];
    const verb = FILE_VERB.exec(line);
    if (verb) {
      const flushed = flush();
      if (flushed) return flushed;
      const kind = verb[1].toLowerCase() as PatchOpKind;
      if (kind === 'move') {
        const mv = MOVE.exec(line);
        if (!mv) return err('Move File requires "<src> -> <dst>"');
        const src = mv[1].trim();
        const dst = mv[2].trim();
        if (!src || !dst) return err('Move File has an empty source or destination');
        ops.push({ kind: 'move', path: src, newPath: dst });
        cur = null;
        continue;
      }
      const path = verb[2].trim();
      if (!path) return err(`${verb[1]} File has an empty path`);
      if (kind === 'delete') {
        ops.push({ kind: 'delete', path });
        cur = null;
        continue;
      }
      if (kind === 'add') {
        cur = { kind: 'add', path, content: '' };
        continue;
      }
      cur = { kind: 'update', path, hunks: [] };
      continue;
    }

    // `@@ hint @@` — only meaningful inside an update.
    if (line.startsWith('@@') && cur && cur.kind === 'update') {
      pushHunk();
      const m = HUNK_BOTH.exec(line);
      const hint = (m ? m[1] : line.slice(2)).trim();
      curHunk = { contextHint: hint || null, lines: [] };
      continue;
    }

    if (!cur) continue; // preamble / stray lines outside any op

    if (cur.kind === 'add') {
      // V4A add bodies prefix every line with '+'. Tolerate raw lines too.
      addContent.push(line.startsWith('+') ? line.slice(1) : line);
      continue;
    }

    if (cur.kind === 'update') {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file" marker
      if (!curHunk) curHunk = { contextHint: null, lines: [] };
      const c0 = line[0];
      if (c0 === '+' || c0 === '-' || c0 === ' ') {
        curHunk.lines.push({ prefix: c0, content: line.slice(1) });
      } else {
        // A non-marker line under an active hunk is an implicit context line.
        curHunk.lines.push({ prefix: ' ', content: line });
      }
    }
  }

  const flushed = flush();
  if (flushed) return flushed;
  return { ops };
}
