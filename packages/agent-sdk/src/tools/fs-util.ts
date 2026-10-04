import { resolve, relative, isAbsolute, dirname, sep, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { webFetchStoreEnabled } from '../policy/feature-flags.js';

/**
 * Workspace-confinement: resolve `p` (absolute or relative-to-workspace) and
 * reject anything that escapes `workingDir`. Returns the absolute path
 * or throws a WorkspaceEscapeError (callers convert to a model-visible string).
 */
export class WorkspaceEscapeError extends Error {}

/**
 * LEXICAL workspace-confinement. Resolves `p` and rejects `..`/absolute escapes
 * purely by string math (no fs touch). This is the cheap first pass; it does NOT
 * defend against symlinks planted inside the workspace — use {@link confinePath}
 * for the realpath-hardened result the fs tools actually consume.
 */
export function resolveInWorkspace(p: string, workingDir: string): string {
  const root = resolve(workingDir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  // rel === '' means abs IS the workspace root (allowed); rel starting with '..'
  // or being absolute (Windows-style absolute after relative()) means escape.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceEscapeError(`Path escapes the workspace: ${p}`);
  }
  return abs;
}

/**
 * Read-only tool-spill dirs: where truncate-and-store features park full text
 * for the model to page back with Read. Each dir is admitted only while its
 * owning feature flag is on, so flag-OFF remains byte-identical per surface.
 * The browser gate mirrors apps/sandbox/src/browser/browser-flags.ts
 * (`!== 'false'`) — keep them in sync.
 */
function readableSpillDirs(): string[] {
  const dirs: string[] = [];
  if (webFetchStoreEnabled()) dirs.push(join(tmpdir(), 'vestra-web'));
  if (process.env.BROWSER_SNAPSHOT_V1 !== 'false') dirs.push(join(tmpdir(), 'vestra-browser'));
  return dirs;
}

/**
 * Confine `p` to a read-only tool-spill dir. Returns `{abs, rel}` only when the
 * REAL (symlink-resolved) path sits inside an enabled spill dir; `null` otherwise
 * so the caller falls through to normal workspace confinement. Same realpath
 * hardening as {@link confinePath}: a symlink planted inside a spill dir that
 * points elsewhere resolves outside and is NOT admitted. READ-ONLY by design —
 * only the Read tool consults this; Write/Edit stay workspace-confined.
 */
export function confineSpillPath(p: string): { abs: string; rel: string } | null {
  if (!isAbsolute(p)) return null;
  const abs = resolve(p);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null; // missing/unreadable — let workspace confinement produce the error
  }
  for (const dir of readableSpillDirs()) {
    let realRoot: string;
    try {
      realRoot = realpathSync(dir);
    } catch {
      continue; // spill dir doesn't exist yet
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) {
      // rel = abs on purpose: the sensitive-file regexes run against both forms.
      return { abs, rel: abs };
    }
  }
  return null;
}

/** Whether `p` sits inside `workingDir` by the lexical check {@link resolveInWorkspace} makes (no fs touch). */
export function isInWorkspace(p: string, workingDir: string): boolean {
  try {
    resolveInWorkspace(p, workingDir);
    return true;
  } catch {
    return false;
  }
}

const SPILL_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Continue anywhere (CONTINUITY_JOURNAL_V1): a spill stub names its file by an ABSOLUTE path
 * (context-offload.ts), and a task continued on another computer has its spills fetched into THIS
 * workspace (apps/sandbox spill-sync.ts), whose root may differ. So an absolute path whose LAST
 * `.kernel-offload` segment is followed by exactly `<taskId>/<id>.txt` (both ids `[A-Za-z0-9_-]{1,64}`)
 * is read at `<workingDir>/.kernel-offload/<taskId>/<id>.txt`. Anything else is `p` unchanged, and the
 * caller still confines what this returns (Read only; Write and Edit never rehome). The caller asks it only
 * for a path OUTSIDE the workspace (isInWorkspace), so a read on the same computer is never redirected.
 */
export function rehomeSpillPath(p: string, workingDir: string): string {
  if (!isAbsolute(p)) return p;
  const parts = p.split(sep);
  const at = parts.lastIndexOf('.kernel-offload');
  if (at < 0 || parts.length !== at + 3) return p;
  const [taskId, file] = [parts[at + 1], parts[at + 2]];
  if (!SPILL_SEGMENT.test(taskId) || !file.endsWith('.txt') || !SPILL_SEGMENT.test(file.slice(0, -4))) return p;
  return join(workingDir, '.kernel-offload', taskId, file);
}

/** Assert that an already-resolved real path sits inside `realRoot`. */
function assertInside(realRoot: string, candidate: string, original: string): void {
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) {
    throw new WorkspaceEscapeError(`Path escapes the workspace: ${original}`);
  }
}

/**
 * realpath-resolve the nearest EXISTING ancestor of `abs` (including `abs`
 * itself if it exists). Used so write targets that don't exist yet still get
 * their real parent dir resolved (defeats symlinked parent dirs). Returns the
 * realpath of the deepest existing ancestor, or `null` if none up the chain
 * resolves (which cannot happen in practice — the root always exists).
 */
function realpathNearestExisting(abs: string): string | null {
  let current = abs;
  // Walk up until realpathSync succeeds (the path exists) or we hit the fs root.
  for (;;) {
    try {
      return realpathSync(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(current);
      if (parent === current) return null; // reached fs root without resolving
      current = parent;
    }
  }
}

/**
 * Realpath-hardened workspace confinement. Builds on {@link resolveInWorkspace}'s
 * lexical check, then follows symlinks via `realpath` and asserts the REAL target
 * is inside the REAL workspace root — closing the "symlink planted inside the
 * workspace points outside" escape that pure lexical resolution misses.
 *
 *  - `isWriteTarget: false` (default): the path itself must exist; realpath it.
 *    (Read/Edit confine the file they're about to open.)
 *  - `isWriteTarget: true`: the path may not exist yet; realpath the nearest
 *    existing ancestor instead (Write confines the dir it's about to create into).
 *
 * Returns the lexically-resolved absolute path plus its workspace-relative form
 * (callers run the sensitive-file regexes against BOTH `rel` and `abs` so that
 * normalization tricks like `.ssh//id_rsa` can't dodge the pattern).
 *
 * Throws WorkspaceEscapeError on any escape (lexical OR realpath).
 */
export function confinePath(
  p: string,
  workingDir: string,
  opts: { isWriteTarget?: boolean } = {},
): { abs: string; rel: string } {
  // 1) Lexical pass (rejects ../ and absolute escapes before any fs touch).
  const abs = resolveInWorkspace(p, workingDir);

  // 2) Realpath pass — defeats symlinks inside the workspace.
  const realRoot = realpathSync(resolve(workingDir));
  const real = opts.isWriteTarget
    ? realpathNearestExisting(abs)
    : (() => {
        try {
          return realpathSync(abs);
        } catch (e) {
          // Missing file on a read/edit is fine — confine its parent dir instead
          // (so a symlinked parent is still caught; ENOENT surfaces later as a
          // normal "could not read" from the caller's fs op).
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return realpathNearestExisting(dirname(abs)) ?? realRoot;
          }
          throw e;
        }
      })();

  if (real !== null) assertInside(realRoot, real, p);

  // `rel` is computed against the LEXICAL root (not realRoot) so it is a clean
  // workspace-relative path for the sensitive-file regexes. `abs` is already
  // normalized by resolveInWorkspace (collapses `//`, `/./`), so forms like
  // `.ssh//id_rsa` surface here as `.ssh/id_rsa` and can no longer dodge the
  // pattern. macOS tmpdir realpath quirks (/var → /private/var) only affect the
  // containment assertion above, never this relative form.
  const rel = relative(resolve(workingDir), abs);
  return { abs, rel };
}
