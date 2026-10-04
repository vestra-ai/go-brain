import { z } from 'zod';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { checkSensitiveFile } from '../policy/index.js';
import { confinePath, WorkspaceEscapeError } from './fs-util.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import { toolError } from './tool-types.js';
import { softFail } from './result-shape.js';
import type { RawToolOptions } from './tool-types.js';
import { checkFreshness, MSG_UNREAD, MSG_STALE } from './file-view-state.js';
import type { FileViewState } from './file-view-state.js';
import { editHardenEnabled } from '../policy/feature-flags.js';
import { repairEditArgs, fuzzyReplace, stripBom } from './edit-normalize.js';

/**
 * Ambiguity is the one error where the model's next move depends on intent: it may
 * want every occurrence (replace_all) or one specific one (more context). Today's
 * text offers only the first, which sends a model that wanted the second into a
 * blind retry; under EDIT_HARDEN_V1 it is offered both. The count-naming prefix is
 * unchanged so the OFF string stays byte-identical.
 */
function ambiguousMessage(count: number, filePath: string, hardened: boolean): string {
  const base = `old_string found ${count} times in ${filePath} — use replace_all:true to replace all occurrences`;
  return hardened ? `${base}, or add surrounding context to make old_string unique.` : `${base}.`;
}

/**
 * Edit tool for the OpenAI arm. Performs exact-string replacement with the
 * same fidelity contract Claude uses:
 *   - old_string absent → error, no write.
 *   - old_string occurs >1× without replace_all → error naming the count, no write.
 *   - replace_all:true → replace every occurrence.
 *   - Blocks checkSensitiveFile paths. Confines paths to the injected workspace.
 *
 * Hardening-I: every failure path returns a typed toolError SENTINEL (never-throw)
 * so isError:true reaches the wire (the "Blocked:" security refusal stays a plain
 * string, mirroring Read). When a per-session read-state store is injected, editing
 * a file that was never Read this session, or one that changed on disk since the
 * last Read, is refused (read-before-edit + lost-update guard); a successful edit
 * refreshes the store. With NO store injected the tool behaves exactly as today.
 */
export function makeEditTool(getWorkingDir: () => string, viewState?: FileViewState): RawToolOptions {
  return {
    name: 'Edit',
    description: TOOL_DESCRIPTIONS.Edit,
    strict: true,
    parameters: z.object({
      file_path: z
        .string()
        .describe('Path to the file to edit (relative to the workspace or absolute within it).'),
      old_string: z.string().describe('The exact string to replace.'),
      new_string: z.string().describe('The replacement string.'),
      replace_all: z
        .boolean()
        .nullable()
        .optional()
        .describe('If true, replace all occurrences of old_string.'),
    }),
    execute: async (args: unknown) => {
      // EDIT_HARDEN_V1 OFF (default): `args` is destructured as-is and every path
      // below is today's, error strings included.
      const hardened = editHardenEnabled();

      let input = args;
      if (hardened) {
        const repair = repairEditArgs(args);
        if (!repair.ok) return toolError('invalid_input', repair.error);
        input = repair.args;
      }

      const { file_path, old_string, new_string, replace_all } = input as {
        file_path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean | null;
      };

      // Empty old_string would interleave new_string between every character
      // (corrupting the file under replace_all). Reject up front — no fs touch.
      if (old_string === '') {
        return toolError('invalid_input', 'old_string must not be empty');
      }

      // Path confinement first (lexical + realpath, defeats symlink escapes).
      let abs: string;
      let rel: string;
      try {
        ({ abs, rel } = confinePath(file_path, getWorkingDir()));
      } catch (e) {
        return toolError('invalid_input', e instanceof WorkspaceEscapeError
          ? e.message
          : `Bad path: ${file_path}`);
      }

      // Security: block sensitive files against the NORMALIZED rel/abs paths so
      // normalization tricks like `.aws//credentials` cannot dodge the regex. T5: the
      // policy refusal is a failed call, in the one error shape (as Read's "Blocked:").
      const sensitive = checkSensitiveFile(rel).blocked
        ? checkSensitiveFile(rel)
        : checkSensitiveFile(abs);
      if (sensitive.blocked) {
        return softFail('permission', `Blocked: editing "${file_path}" is not permitted (${sensitive.description ?? sensitive.pattern ?? 'sensitive file'}).`);
      }

      // Stat first — existence + the freshness comparison need the on-disk mtime/size.
      let st: import('node:fs').Stats;
      try {
        st = await stat(abs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
        return toolError(code, `Could not read ${file_path}: ${(e as Error).message}`);
      }

      // Read-before-edit + freshness (only when a per-session store is wired in).
      if (viewState) {
        const freshness = checkFreshness(viewState.get(abs), { mtimeMs: st.mtimeMs, size: st.size });
        if (freshness === 'unread') return toolError('invalid_input', MSG_UNREAD);
        if (freshness === 'stale') return toolError('invalid_input', MSG_STALE);
      }

      // Read the file.
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
        return toolError(code, `Could not read ${file_path}: ${(e as Error).message}`);
      }

      // A BOM is invisible to the model, so it never appears in old_string. Matching
      // on the stripped text and writing the BOM back is byte-identical for every
      // edit that would have succeeded anyway (a match at index 0 would have to start
      // WITH the BOM char), and it stops the BOM from being a silent match failure.
      const { bom, text } = hardened ? stripBom(content) : { bom: '', text: content };

      // Count occurrences via split (avoids regex special-char issues with literal strings).
      const count = text.split(old_string).length - 1;

      let updated: string;
      let replaced = count;

      if (count > 0) {
        // EXACT-MATCH FAST PATH — identical under both flag states.
        if (count > 1 && !replace_all) {
          return toolError('invalid_input', ambiguousMessage(count, file_path, hardened));
        }
        replaced = replace_all ? count : 1;
        updated = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      } else if (!hardened || typeof old_string !== 'string') {
        // A non-string old_string survives repair when the model sent nothing
        // recognizable. There is no needle to normalize, so report the miss exactly
        // as today rather than handing `undefined` to the matcher (never-throw).
        return toolError('invalid_input', `old_string not found in ${file_path}`);
      } else {
        // Exact matching already failed, so nothing below can change the outcome of
        // an edit that would have worked. Retry ONCE in the fixed normalized space.
        const fuzzy = fuzzyReplace(text, old_string, new_string, replace_all === true);
        if (fuzzy.kind === 'not_found') {
          return toolError('invalid_input', `old_string not found in ${file_path}`);
        }
        if (fuzzy.kind === 'ambiguous') {
          return toolError('invalid_input', ambiguousMessage(fuzzy.count, file_path, hardened));
        }
        updated = fuzzy.text;
        replaced = fuzzy.count;
      }

      try {
        await writeFile(abs, bom + updated, 'utf8');
      } catch (e) {
        return toolError('unavailable', `Could not write ${file_path}: ${(e as Error).message}`);
      }

      // Refresh the read-state to the post-edit file so a follow-up edit in the same
      // session needs no re-Read (its own write is not a stale external change).
      if (viewState) {
        try {
          const post = await stat(abs);
          viewState.record(abs, { mtimeMs: post.mtimeMs, size: post.size });
        } catch { /* best-effort — a follow-up edit will simply re-check */ }
      }

      return `Edited ${file_path} (${replaced} replacement${replaced !== 1 || replace_all ? 's' : ''})`;
    },
  };
}
