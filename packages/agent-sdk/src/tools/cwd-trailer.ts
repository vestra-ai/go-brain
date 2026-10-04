/**
 * The Bash [cwd: …] trailer — ONE owner for the format (file-tool senses,
 * kill-mission wave 3). bash-tool appends it to results when the session cwd
 * has drifted from the workspace root; any consumer that PARSES Bash output
 * bytes (the routine/item detection hooks whole-string JSON.parse the stdout)
 * must strip it with stripCwdTrailer before parsing — review #1588 finding 1:
 * an unstripped trailer poisons the JSON envelope exactly on drifted-cwd
 * sessions and silently suppresses the confirmation cards.
 *
 * Pure string logic, no I/O — exported from the package root so apps/sandbox
 * hooks can import it without the ./tools I/O entry.
 */

/** Matches exactly one engine-appended trailer on its own final line. */
const CWD_TRAILER_RE = /\n\[cwd: [^\n]*\]$/;

export function formatCwdTrailer(cwd: string): string {
  return `\n[cwd: ${cwd}]`;
}

/** Remove a trailing engine-appended [cwd: …] line, if present. Idempotent. */
export function stripCwdTrailer(output: string): string {
  return output.replace(CWD_TRAILER_RE, '');
}
