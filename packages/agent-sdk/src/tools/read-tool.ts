import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { READ_CRITICAL_FILE_PATTERNS } from '../policy/index.js';
import { confinePath, confineSpillPath, isInWorkspace, rehomeSpillPath, WorkspaceEscapeError } from './fs-util.js';
import { toolDescription } from './descriptions/trimmed.js';
import { continuityJournalEnabled, toolDescTrimEnabled } from '../policy/feature-flags.js';
import { toolError } from './tool-types.js';
import { softFail } from './result-shape.js';
import type { RawToolOptions } from './tool-types.js';
import type { FileViewState } from './file-view-state.js';
import {
  mediaCandidate,
  detectImageMediaType,
  isPdfHeader,
  imageEnvelope,
  readMediaHeader,
} from './read-media.js';
import { fitReadImage, type ImageFitter } from './read-image-fit.js';

const MAX_LINES = 2000;
/** A whole-file read above this refuses with `too_large` and points at offset/limit or Grep. */
const MAX_READ_BYTES = 5 * 1024 * 1024;
/** Absolute ceiling — even an offset/limit read above this is refused (OOM guard). */
const HARD_MAX_READ_BYTES = 100 * 1024 * 1024;
const EN_DASH = '–';
const asMb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Read tool for the OpenAI arm. Returns cat -n style numbered output (6-char
 * right-aligned line number + tab + content). Mirrors Claude's Read semantics:
 * offset (1-based) + limit, blocks READ_CRITICAL_FILE_PATTERNS, confines paths
 * inside the injected workspace via resolveInWorkspace.
 *
 * Hardening-I truth contract:
 *   - Truncation honesty: a returned slice that is NOT the whole file ends with a
 *     `[showing lines X–Y of Z total; continue with offset=N]` marker, so a silent
 *     MAX_LINES cutoff can never pass for the full file.
 *   - Size guard: a `stat` precedes the read; a >5MB whole-file read is refused
 *     with `too_large` (use offset/limit or Grep); even a narrowed read is refused
 *     above a hard ceiling.
 *   - Read-state: a successful read records the file's mtime+size into the injected
 *     per-session store, so Edit/Write can enforce read-before-write + freshness.
 */
/** Read's parameter text, as the SDK's ReadInput words it. Flag-off builds advertise exactly this. */
const READ_PARAM_TEXT = {
  file_path: 'The absolute path to the file to read (relative to or absolute within the workspace).',
  offset: 'The line number to start reading from. Only provide if the file is too large to read at once.',
  limit: 'The number of lines to read. Only provide if the file is too large to read at once.',
};

/** TOOL_DESC_TRIM_V1 — the same meanings, said once. Read when the tool is built. */
const READ_PARAM_TEXT_TRIMMED: typeof READ_PARAM_TEXT = {
  file_path: 'Path in the workspace, relative or absolute.',
  offset: 'First line to read; only for a file too big to read at once.',
  limit: 'Lines to read; only for a file too big to read at once.',
};

/** SCREENSHOT_PRUNE_CACHE_V1: the host's image fitter (read-image-fit.ts). Absent: an image is returned as read. */
export interface ReadToolOptions {
  fitImage?: ImageFitter;
}

export function makeReadTool(getWorkingDir: () => string, viewState?: FileViewState, opts: ReadToolOptions = {}): RawToolOptions {
  const p = toolDescTrimEnabled() ? READ_PARAM_TEXT_TRIMMED : READ_PARAM_TEXT;
  return {
    name: 'Read',
    description: toolDescription('Read'),
    strict: true,
    // W3-2: read-only — no workspace writes, and the viewState record (mtime+size
    // per path, synchronous, idempotent per file) has no batch-sibling ordering
    // dependence, so consecutive Reads may execute concurrently.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    // Multimodal Read returns an image file as a `{ content: [{type:'image'}] }`
    // envelope; this flag makes the dispatcher unwrap it into an ImageBlock. A text
    // read still returns a plain string, which extractContentBlocks short-circuits —
    // so the utf8 path stays byte-identical.
    returnsContentBlocks: true,
    parameters: z.object({
      file_path: z
        .string()
        .describe(p.file_path),
      offset: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(p.offset),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(p.limit),
    }),
    execute: async (args: unknown) => {
      const { file_path, offset, limit } = args as {
        file_path: string;
        offset?: number | null;
        limit?: number | null;
      };

      // Path confinement first (lexical + realpath, defeats symlink escapes), then
      // run the sensitive-pattern check against the NORMALIZED rel/abs paths — so
      // tricks like `.ssh//id_rsa` or `.ssh/./id_rsa` (which dodge the raw regex
      // but collapse to the real secret) are caught.
      let abs: string;
      let rel: string;
      // Continue anywhere: a spill stub written on another computer names that computer's root; its
      // copy was fetched into this workspace (rehomeSpillPath). Only a path OUTSIDE this workspace is
      // rehomed, so a read on this computer is unchanged. The rehomed path is confined below like any
      // other, and every message still names the path the model gave.
      const target = continuityJournalEnabled() && !isInWorkspace(file_path, getWorkingDir())
        ? rehomeSpillPath(file_path, getWorkingDir())
        : file_path;
      try {
        // Tool-spill dirs (WebFetch/browser truncate-and-store) are readable when
        // their flag is on — realpath-hardened in confineSpillPath; everything
        // else confines to the workspace exactly as before.
        ({ abs, rel } = confineSpillPath(target) ?? confinePath(target, getWorkingDir()));
      } catch (e) {
        // Hardening-G: a workspace-escape / bad path is invalid input. The MESSAGE is
        // byte-identical to today, so the dispatcher's flag-OFF path is unchanged.
        return toolError('invalid_input', e instanceof WorkspaceEscapeError
          ? (target === file_path ? e.message : `Path escapes the workspace: ${file_path}`)
          : `Bad path: ${file_path}`);
      }

      // Security: block reading sensitive key/shadow files (resolved-path based).
      if (READ_CRITICAL_FILE_PATTERNS.some((re) => re.test(rel) || re.test(abs))) {
        // T5: a policy refusal is a failed call: the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1).
        return softFail('permission', `Blocked: reading "${file_path}" is not permitted (sensitive file).`);
      }

      // Stat first — the size guard must refuse a huge file BEFORE it is read into
      // memory, and the recorded read-state needs the file's mtime+size.
      let st: import('node:fs').Stats;
      try {
        st = await stat(abs);
      } catch (e) {
        // Hardening-G: a missing file is `not_found`; any other stat failure is
        // `unavailable`. The MESSAGE keeps the classic "Could not read" prefix.
        const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
        return toolError(code, `Could not read ${file_path}: ${(e as Error).message}`);
      }

      const narrowed = offset != null || limit != null;
      if (st.size > HARD_MAX_READ_BYTES) {
        return toolError('too_large',
          `File ${file_path} is ${asMb(st.size)} MB, over the ${asMb(HARD_MAX_READ_BYTES)} MB hard read limit. Search it with Grep instead.`);
      }

      // Multimodal Read — a file whose EXTENSION nominates it as an image/PDF and
      // whose MAGIC BYTES confirm it is diverted off the utf8 path (extension alone
      // is never trusted). A confirmed image returns the `returnsContentBlocks`
      // envelope the dispatcher unwraps into an ImageBlock; a confirmed PDF is
      // refused with extract-first guidance (no dependency-free PDF text/render path
      // exists in this package). A file whose bytes DON'T confirm its extension
      // falls through to the text path below, byte-identical.
      const candidate = mediaCandidate(file_path);
      if (candidate) {
        const header = await readMediaHeader(abs);
        const imageType = candidate === 'image' ? detectImageMediaType(header) : null;
        if (imageType) {
          // An image is always a whole-file read — reuse the whole-file size limit
          // (offset/limit and Grep don't apply, so the message doesn't cite them).
          if (st.size > MAX_READ_BYTES) {
            return toolError('too_large',
              `Image ${file_path} is ${asMb(st.size)} MB, over the ${asMb(MAX_READ_BYTES)} MB read limit — too large to return inline.`);
          }
          let bytes: Buffer;
          try {
            bytes = await readFile(abs);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
            return toolError(code, `Could not read ${file_path}: ${(e as Error).message}`);
          }
          // Record the read-state (the model has now seen this version), mirroring
          // the utf8 path so Edit/Write freshness works for an image too.
          viewState?.record(abs, { mtimeMs: st.mtimeMs, size: st.size });
          // Caption leads the envelope so arms that flatten a tool_result to text
          // (Chat Completions, Gemini) still learn what was read (see imageEnvelope).
          if (opts.fitImage) {
            // SCREENSHOT_PRUNE_CACHE_V1: the long edge held to 1568 px (never upscaled) before it is journaled.
            const img = await fitReadImage(bytes, imageType, opts.fitImage);
            const sent = img.fitted
              ? `; shown at ${img.fitted.to.width}x${img.fitted.to.height} (from ${img.fitted.from.width}x${img.fitted.from.height}) as ${img.mediaType}, ${img.data.length} bytes`
              : '';
            return imageEnvelope(`Image file ${file_path} (${imageType}, ${bytes.length} bytes${sent}).`, img.data.toString('base64'), img.mediaType);
          }
          const caption = `Image file ${file_path} (${imageType}, ${bytes.length} bytes).`;
          return imageEnvelope(caption, bytes.toString('base64'), imageType);
        }
        if (candidate === 'pdf' && isPdfHeader(header)) {
          return toolError('unavailable',
            `Reading PDF content directly is not supported. Extract the PDF to text or convert its pages to images first (for example with a PDF tool via Bash), then Read that output.`);
        }
        // Extension lied — fall through to the utf8 text path unchanged.
      }

      if (!narrowed && st.size > MAX_READ_BYTES) {
        return toolError('too_large',
          `File ${file_path} is ${asMb(st.size)} MB, over the ${asMb(MAX_READ_BYTES)} MB read limit. Read a section with offset/limit, or search it with Grep.`);
      }

      // Read the file.
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
        return toolError(code, `Could not read ${file_path}: ${(e as Error).message}`);
      }

      // Record the read-state (whole or slice — the model has now seen this version).
      viewState?.record(abs, { mtimeMs: st.mtimeMs, size: st.size });

      // Slice and number the lines (cat -n style: padStart(6) + '\t' + line).
      const allLines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const slice = allLines.slice(start, start + (limit ?? MAX_LINES));
      const numbered = slice
        .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
        .join('\n');

      // Truncation honesty: append the range marker only when content remains BELOW
      // the returned slice (the silent-cutoff danger). A tail read the model asked
      // for that already reaches EOF has nothing more to continue to — no marker.
      const moreBelow = slice.length > 0 && start + slice.length < allLines.length;
      if (!moreBelow) return numbered;
      const firstLine = start + 1;
      const lastLine = start + slice.length;
      const marker = `[showing lines ${firstLine}${EN_DASH}${lastLine} of ${allLines.length} total; continue with offset=${lastLine + 1}]`;
      return `${numbered}\n${marker}`;
    },
  };
}
