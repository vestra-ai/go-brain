// tools/code-exec/scrub-env.ts
export const SECRET_SUBSTRINGS = [
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'AUTH', 'DSN', 'WEBHOOK',
] as const;

export const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'XDG_', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA',
] as const;

function isSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_SUBSTRINGS.some((s) => upper.includes(s));
}
function isSafe(name: string): boolean {
  return SAFE_ENV_PREFIXES.some((p) => (p.endsWith('_') ? name.startsWith(p) : name === p || name.startsWith(p)));
}

/**
 * Build the child env for a code-exec subprocess: block secrets by substring,
 * then keep only safe-prefixed names, then merge `inject` last (always wins).
 * So model-generated code can never read API keys; it can only reach tools via RPC.
 *
 * CONFINEMENT CAVEAT (read before relying on this for isolation): this is HYGIENE,
 * NOT a confinement boundary. It keeps secrets out of the child's OWN environment
 * block, so accidental/library env reads (`os.environ`, a dependency that auto-reads
 * `OPENAI_API_KEY`, an inadvertent `print(os.environ)`) cannot leak host secrets. It
 * does NOT confine deliberately hostile code: a same-uid child can still read another
 * process's environment via `/proc/<pid>/environ`, read on-disk secret files, or call
 * the whitelisted in-code `Bash` to `env`/`cat` them — the same reach the user's own
 * `Bash` already has. The real isolation boundary for untrusted/multi-tenant code is
 * the single-tenant sandbox today, and the deferred Docker/namespaced
 * `ExecutionEnvironment` adapter tomorrow — never this scrub.
 */
export function scrubChildEnv(
  source: Record<string, string | undefined>,
  inject: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (isSecret(k)) continue;
    if (!isSafe(k)) continue;
    out[k] = v;
  }
  return { ...out, ...inject };
}
