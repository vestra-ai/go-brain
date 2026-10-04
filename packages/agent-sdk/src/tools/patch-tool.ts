import { z } from 'zod';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkSensitiveFile } from '../policy/index.js';
import { confinePath, WorkspaceEscapeError } from './fs-util.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import type { RawToolOptions, ToolErrorCode } from './tool-types.js';
import { softFail } from './result-shape.js';
import { parseV4APatch, type Hunk } from './patch-parser.js';

/**
 * `Patch` — apply a structured multi-file V4A patch atomically. The one in-code tool
 * deferred from code-exec Slice 2a (the model writes `patch(input=...)` to edit many
 * files/locations in a single call). Beyond `Edit` (one exact string, one file), a
 * patch carries multiple files × multiple hunks and is **all-or-nothing**: if ANY
 * hunk fails to locate (or any path is blocked), ZERO files are touched.
 *
 * Hunk localization is our flavor (predictable, not Hermes's fuzzy engine): exact
 * block match first, then a trailing-whitespace-tolerant match, with an `@@ hint @@`
 * used only to disambiguate multiple matches. Returns a STRING (tool contract);
 * failures are surfaced as `[patch failed: ...]`, never silently.
 */
export function makePatchTool(getWorkingDir: () => string): RawToolOptions {
  return {
    name: 'Patch',
    description: TOOL_DESCRIPTIONS.Patch,
    parameters: z.object({
      input: z
        .string()
        .describe(
          'A V4A apply-patch envelope: `*** Begin Patch` … `*** End Patch`, with ' +
            '`*** Update File: <p>` / `*** Add File: <p>` / `*** Delete File: <p>` / ' +
            '`*** Move File: <src> -> <dst>` sections. Update hunks use ` ` (context), ' +
            '`-` (remove), `+` (add) line prefixes and an optional `@@ context hint @@`.',
        ),
    }),
    execute: async (rawArgs: unknown): Promise<ReturnType<typeof softFail>> => {
      // Never-throw contract: a non-string `input` must not throw out of execute
      // (the dispatcher would surface isError:true instead of a clean marker).
      const raw = (rawArgs ?? {}) as { input?: unknown };
      const input = typeof raw.input === 'string' ? raw.input : '';
      const { ops, error } = parseV4APatch(input);
      // T5: every failure in the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1); the words are unchanged.
      const failed = (code: ToolErrorCode, why: string) => softFail(code, `[patch failed: ${why}]`);
      if (error) return failed('invalid_input', error);
      if (ops.length === 0) return '[patch: no operations]';

      const wd = getWorkingDir();

      // confine + sensitive-file check (mirrors edit-tool.ts). Returns abs or an error.
      const resolve = (p: string): { abs: string } | { err: string; code: ToolErrorCode } => {
        let abs: string;
        let rel: string;
        try {
          ({ abs, rel } = confinePath(p, wd));
        } catch (e) {
          return { err: e instanceof WorkspaceEscapeError ? e.message : `Bad path: ${p}`, code: 'invalid_input' };
        }
        const sensitive = checkSensitiveFile(rel).blocked ? checkSensitiveFile(rel) : checkSensitiveFile(abs);
        if (sensitive.blocked) {
          return {
            err: `editing "${p}" is not permitted (${sensitive.description ?? sensitive.pattern ?? 'sensitive file'})`,
            code: 'permission',
          };
        }
        return { abs };
      };

      // In-memory overlay so later hunks see earlier edits and NOTHING hits disk until
      // every op validates. `null` = staged-deleted.
      const mem = new Map<string, string | null>();
      const onDisk = new Map<string, string | null>(); // cache of ORIGINAL state (for rollback)
      const readContent = async (abs: string): Promise<string | null> => {
        if (mem.has(abs)) return mem.get(abs)!;
        if (onDisk.has(abs)) return onDisk.get(abs)!;
        let v: string | null;
        try {
          v = await readFile(abs, 'utf8');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          // ONLY a genuine "not there" is `null`. EISDIR / EACCES / etc. mean the
          // path exists-but-unwritable: throw so validation FAILS (else an Add would
          // pass validation then explode mid-write — a partial-apply footgun).
          if (code === 'ENOENT') v = null;
          else throw new Error(`cannot read ${abs}: ${code ?? (e as Error).message}`);
        }
        onDisk.set(abs, v);
        return v;
      };

      const modified: string[] = [];
      const created: string[] = [];
      const deleted: string[] = [];
      const moved: string[] = [];

      // ── Phase 1: validate + stage into `mem`. Any failure → no writes. The whole
      //    loop is wrapped: a readContent throw (EISDIR/EACCES) aborts cleanly. ──
      try {
        for (const op of ops) {
          const r = resolve(op.path);
          if ('err' in r) return failed(r.code, r.err);
          const abs = r.abs;

          if (op.kind === 'add') {
            if ((await readContent(abs)) !== null) return failed('invalid_input', `${op.path} already exists`);
            mem.set(abs, op.content ?? '');
            created.push(op.path);
            continue;
          }
          if (op.kind === 'delete') {
            if ((await readContent(abs)) === null) return failed('not_found', `${op.path} not found`);
            mem.set(abs, null);
            deleted.push(op.path);
            continue;
          }
          if (op.kind === 'move') {
            const rd = resolve(op.newPath!);
            if ('err' in rd) return failed(rd.code, rd.err);
            const src = await readContent(abs);
            if (src === null) return failed('not_found', `${op.path} not found`);
            if ((await readContent(rd.abs)) !== null) return failed('invalid_input', `${op.newPath} already exists`);
            mem.set(abs, null);
            mem.set(rd.abs, src);
            moved.push(`${op.path} -> ${op.newPath}`);
            continue;
          }
          // update
          let content = await readContent(abs);
          if (content === null) return failed('not_found', `${op.path} not found`);
          for (const hunk of op.hunks ?? []) {
            content = applyHunk(content, hunk);
          }
          mem.set(abs, content);
          modified.push(op.path);
        }
      } catch (e) {
        return failed('exec_failed', e instanceof Error ? e.message : String(e));
      }

      // ── Phase 2: commit. Snapshot-restore keeps it ALL-OR-NOTHING: onDisk holds
      //    every touched path's ORIGINAL state (every op readContent'd its targets),
      //    so a mid-write failure rolls back the writes already committed. ──
      const committed: string[] = [];
      try {
        for (const [abs, content] of mem) {
          if (content === null) {
            await rm(abs, { force: true });
          } else {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, content, 'utf8');
          }
          committed.push(abs);
        }
      } catch (e) {
        for (const abs of committed.reverse()) {
          const orig = onDisk.get(abs) ?? null;
          try {
            if (orig === null) {
              await rm(abs, { force: true });
            } else {
              await mkdir(dirname(abs), { recursive: true });
              await writeFile(abs, orig, 'utf8');
            }
          } catch {
            /* best-effort restore — if even this fails, the marker below warns */
          }
        }
        return softFail('exec_failed', `[patch failed during write — rolled back: ${e instanceof Error ? e.message : String(e)}]`);
      }

      const parts: string[] = [];
      if (modified.length) parts.push(`  modified: ${modified.join(', ')}`);
      if (created.length) parts.push(`  created: ${created.join(', ')}`);
      if (deleted.length) parts.push(`  deleted: ${deleted.join(', ')}`);
      if (moved.length) parts.push(`  moved: ${moved.join(', ')}`);
      return `Applied patch:\n${parts.join('\n')}`;
    },
  };
}

/**
 * Apply one hunk to `content`, returning the new content (throws on failure).
 * - search block = context + removed lines; replacement = context + added lines.
 * - empty search (addition-only) → insert after the unique hint line, else append.
 * - otherwise locate the block (exact, then trailing-whitespace-tolerant); a hint
 *   disambiguates multiple matches.
 */
export function applyHunk(content: string, hunk: Hunk): string {
  const search = hunk.lines.filter((l) => l.prefix === ' ' || l.prefix === '-').map((l) => l.content);
  const lines = content.split('\n');

  // Addition-only hunk (no context/removed lines): place by hint, else append.
  if (search.length === 0) {
    const added = hunk.lines.filter((l) => l.prefix === '+').map((l) => l.content);
    if (hunk.contextHint) {
      const hits = hintHits(lines, hunk.contextHint);
      if (hits.length === 1) {
        lines.splice(hits[0] + 1, 0, ...added);
        return lines.join('\n');
      }
      // A present-but-unmatched / ambiguous hint is an ERROR — never silently append
      // to EOF (that would misplace inserted code where the author pointed elsewhere).
      if (hits.length === 0) throw new Error(`addition hint "${hunk.contextHint}" not found`);
      throw new Error(`addition hint "${hunk.contextHint}" matches ${hits.length} lines (ambiguous)`);
    }
    // No hint → append at EOF, preserving the file's trailing-newline state.
    const body = added.join('\n');
    if (content === '') return body;
    return content.endsWith('\n') ? `${content}${body}\n` : `${content}\n${body}`;
  }

  // Locate the search block: exact first, then trailing-whitespace tolerant.
  const indices = locate(lines, search);
  let chosen: number;
  if (indices.length === 1) {
    chosen = indices[0];
  } else if (indices.length === 0) {
    throw new Error(`could not find the context to update${hunk.contextHint ? ` near "${hunk.contextHint}"` : ''}`);
  } else if (hunk.contextHint) {
    // Disambiguate by the match CLOSEST to the hint line (a block whose own range
    // contains the hint has distance 0). This fixes the naive "first index >= hint"
    // rule, which wrongly excluded block #1 when the hint sat inside it. A tie (e.g.
    // two equidistant identical blocks) is a genuine ambiguity → error.
    const h = lines.findIndex((l) => l.includes(hunk.contextHint!));
    if (h < 0) {
      throw new Error(`context matches ${indices.length} locations; hint "${hunk.contextHint}" not found`);
    }
    const dist = (i: number) =>
      h >= i && h < i + search.length ? 0 : Math.min(Math.abs(i - h), Math.abs(i + search.length - 1 - h));
    let best = indices[0];
    let bestD = dist(best);
    let tie = false;
    for (const i of indices.slice(1)) {
      const d = dist(i);
      if (d < bestD) {
        best = i;
        bestD = d;
        tie = false;
      } else if (d === bestD) {
        tie = true;
      }
    }
    if (tie) {
      throw new Error(`context matches ${indices.length} locations; hint "${hunk.contextHint}" did not uniquely disambiguate`);
    }
    chosen = best;
  } else {
    throw new Error(`context matches ${indices.length} locations; add an @@ hint @@ to disambiguate`);
  }

  // Build the replacement from the MATCHED DISK lines so a trailing-whitespace-
  // tolerant match preserves unchanged context bytes VERBATIM (it must not rewrite
  // a context line just because the patch trimmed its trailing whitespace).
  const diskSlice = lines.slice(chosen, chosen + search.length);
  const out: string[] = [];
  let p = 0;
  for (const hl of hunk.lines) {
    if (hl.prefix === '+') {
      out.push(hl.content);
    } else if (hl.prefix === ' ') {
      out.push(diskSlice[p] ?? hl.content); // preserve the original context line
      p++;
    } else {
      p++; // '-' removed: consume a disk line, emit nothing
    }
  }
  lines.splice(chosen, search.length, ...out);
  return lines.join('\n');
}

function hintHits(lines: string[], hint: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(hint)) out.push(i);
  return out;
}

/** Start indices where `search` matches `lines`: exact first; if none, trailing-ws-tolerant. */
function locate(lines: string[], search: string[]): number[] {
  const exact = starts(lines, search, false);
  if (exact.length >= 1) return exact;
  return starts(lines, search, true);
}

function starts(lines: string[], search: string[], trimTrailing: boolean): number[] {
  const norm = (s: string) => (trimTrailing ? s.replace(/\s+$/, '') : s);
  const out: number[] = [];
  for (let i = 0; i + search.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) {
      if (norm(lines[i + j]) !== norm(search[j])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
