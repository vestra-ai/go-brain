import { z } from 'zod';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkSensitiveFile } from '../policy/index.js';
import { confinePath, WorkspaceEscapeError } from './fs-util.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import { toolError } from './tool-types.js';
import { softFail } from './result-shape.js';
import type { RawToolOptions } from './tool-types.js';
import { checkFreshness, MSG_UNREAD, MSG_STALE } from './file-view-state.js';
import type { FileViewState } from './file-view-state.js';

/**
 * Write tool for the OpenAI arm. Creates (or overwrites) a file, creating
 * parent directories as needed. Mirrors Claude's Write semantics: blocks
 * checkSensitiveFile paths, confines paths to the injected workspace.
 *
 * Hardening-I: creating a NEW file needs no prior Read; OVERWRITING an existing
 * file follows Edit's read-before-write + freshness rule (a lost-update guard),
 * enforced only when a per-session read-state store is injected. A successful write
 * refreshes the store. With NO store injected the tool behaves exactly as today.
 */
export function makeWriteTool(getWorkingDir: () => string, viewState?: FileViewState): RawToolOptions {
  return {
    name: 'Write',
    description: TOOL_DESCRIPTIONS.Write,
    strict: true,
    parameters: z.object({
      file_path: z
        .string()
        .describe('Path to write (relative to the workspace or absolute within it).'),
      content: z.string().describe('Content to write to the file.'),
    }),
    execute: async (args: unknown) => {
      const { file_path, content } = args as { file_path: string; content: string };

      // Path confinement first (lexical + realpath of the nearest existing
      // ancestor — the target may not exist yet — which defeats symlinked parent
      // dirs). Escape attempts must never reach the filesystem.
      let abs: string;
      let rel: string;
      try {
        ({ abs, rel } = confinePath(file_path, getWorkingDir(), { isWriteTarget: true }));
      } catch (e) {
        // T5: a workspace escape / bad path is invalid input, as on Read and Edit.
        return softFail('invalid_input', e instanceof WorkspaceEscapeError
          ? e.message
          : `Bad path: ${file_path}`);
      }

      // Security: block sensitive files against the NORMALIZED rel/abs paths so
      // normalization tricks like `.aws//credentials` cannot dodge the regex.
      const sensitive = checkSensitiveFile(rel).blocked
        ? checkSensitiveFile(rel)
        : checkSensitiveFile(abs);
      if (sensitive.blocked) {
        // T5: a policy refusal is a failed call: the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1).
        return softFail('permission', `Blocked: writing "${file_path}" is not permitted (${sensitive.description ?? sensitive.pattern ?? 'sensitive file'}).`);
      }

      // Read-before-overwrite + freshness: only an EXISTING file is gated (a new
      // file has nothing to lose), and only when a per-session store is wired in.
      if (viewState) {
        let existing: import('node:fs').Stats | undefined;
        try { existing = await stat(abs); } catch { existing = undefined; } // ENOENT ⇒ new file
        if (existing) {
          const freshness = checkFreshness(viewState.get(abs), { mtimeMs: existing.mtimeMs, size: existing.size });
          if (freshness === 'unread') return toolError('invalid_input', MSG_UNREAD);
          if (freshness === 'stale') return toolError('invalid_input', MSG_STALE);
        }
      }

      // Create parent directories, then write.
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
      } catch (e) {
        return softFail('exec_failed', `Could not write ${file_path}: ${(e as Error).message}`);
      }

      // Refresh the read-state to the just-written file so a follow-up overwrite in
      // the same session needs no re-Read (its own write is not a stale change).
      if (viewState) {
        try {
          const post = await stat(abs);
          viewState.record(abs, { mtimeMs: post.mtimeMs, size: post.size });
        } catch { /* best-effort */ }
      }

      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${file_path}`;
    },
  };
}
