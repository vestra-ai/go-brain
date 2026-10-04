/**
 * THE GIT COMMAND CATALOG — what one `git` or `gh` command position does to a shared repository.
 *
 * The write taxonomy files every git subcommand that is not a read as a workspace write, so until
 * this module `git push --force origin main` and `gh pr merge` asked only at Careful: on Balanced
 * and Relaxed they ran without asking. That was harmless only while the box held no git
 * credentials, and a GitHub App credential helper is coming (engineer-teammates spec, piece 4).
 *
 * The argv is read EXACTLY. Every option and refspec shape below is a member of a list, and a push
 * whose words are not all understood asks. There is no pattern over free text (a safety check is
 * catalog membership, never a word denylist: the R1a recipe lint leaked for four review rounds).
 *
 * Verdicts, which the floor and the side-effect classifier map (gitCommandFamily below):
 *   - protected → protected_remote: asks at EVERY access level, Autopilot included, and no
 *       Always-allow silences it. Only what DELETES shared history or refs, which is inside the
 *       founder's Relaxed ruling (2026-07-15, verbatim: "in relaxed mode only and only deletes and
 *       payments need permission nothing else"): a force (--force, -f, --force-with-lease,
 *       --force-if-includes, a `+refspec`), a remote delete (--delete, -d, a `:ref` refspec,
 *       --prune), --mirror (it deletes remote refs), `gh repo delete`, `gh release delete`, a
 *       merge with `--delete-branch`, and their API forms: any write to `repos/{o}/{r}/git/refs…`
 *       (a `force=true` PATCH is a force push), a DELETE of a repository or a release.
 *       `git send-pack` is push's plumbing and reads the same.
 *   - unread → unknown: anything it cannot fully read (an expansion, an unknown option, --repo, a
 *       `-c` of a key that can redirect a push, an inline `-c alias.*`, a subcommand not in the
 *       text, a request body from a file, a GraphQL mutation), and the definitions a later argv
 *       could not read: `git config` of an alias, remote, url, credential or include key,
 *       `gh alias set|import`, `gh extension install|upgrade`. The "cannot read it" class (#3779)
 *       already asks at every level.
 *   - delete → dangerous_delete: gh's other `delete` subcommands, `gh api -X DELETE`,
 *       `pr close --delete-branch`. A delete, like any other.
 *   - external → external_mutation: a push of named branches; `git subtree push`, `lfs push`,
 *       `svn dcommit`, `p4 submit`; gh commands that change GitHub;
 *       and, PENDING THE FOUNDER'S RULING (spec question 2), the shared-branch writes: a push to
 *       main or master, a push that names no branch (bare, HEAD, a pattern), --all / --branches /
 *       --tags, `gh pr merge`, `gh api` writes other than DELETE. One constant flips them.
 *   - readonly: gh commands that only read.
 *   - null: not git or gh, or a subcommand this catalog does not cover. Today's verdict stands.
 * And one class that is never asked, only refused: what would hand the box's GitHub credential
 * to the agent (gitCredentialExtraction, at the end of this file; the security gate denies it).
 *
 * What an argv cannot show: config written as a FILE (`.git/config`, an `include.path` target)
 * or set in the environment (`GIT_CONFIG_*`), after which `git p` reads as an unknown subcommand.
 * Defining it with `git config` asks (above). The stop for the rest is on the server: the
 * credential helper's token and the repo's branch protection.
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

import {
  analyzeCommand,
  expandsUnquoted,
  headUnresolvable,
  isRedirectionWord,
  normalizeHead,
  removeQuotes,
  runsUnreadCode,
  SHELL_WORD_DELIMITERS,
  type CommandAnalysis,
  type CommandNode,
} from './command-analyzer.js';
import { containsUnquotedGlob } from './unquoted-glob.js';
import { decodes, escapesLiteral, readsCodeFromStdin, shellStdinCode } from './shell-stdin-code.js';
import { stripHeredocBodies } from './heredoc-bodies.js';

/**
 * PENDING FOUNDER RULING (engineer-teammates spec, question 2: "Should pushing to main or merging
 * always ask, even on Autopilot?"). While false, a push to main, a push that names no branch,
 * --all / --tags, `gh pr merge` and `gh api` writes other than DELETE follow the access level like
 * any external action (Careful and Balanced ask). If he says yes, flip this one line: they ask at
 * every level, like a force push.
 */
const SHARED_BRANCH_WRITES_ALWAYS_ASK = false;

export type GitVerdictKind = 'protected' | 'unread' | 'delete' | 'external' | 'readonly';

/** The kind the shared-branch writes get: see SHARED_BRANCH_WRITES_ALWAYS_ASK. */
const SHARED_WRITE: GitVerdictKind = SHARED_BRANCH_WRITES_ALWAYS_ASK ? 'protected' : 'external';

export interface GitVerdict {
  kind: GitVerdictKind;
  /** The card's headline in plain words ("Push to main on github.com/acme/site"). */
  headline: string;
  /** The card's button ("Push to main", "Force-push", "Merge"). */
  actionLabel: string;
}

/** The branches a push to is a shared-branch write. The remote's real default is not in the argv. */
const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * The verdict for one command position, given its normalized head and its raw argv tokens (as
 * the command analyzer hands them: quotes still on). Null for anything that is not git or gh.
 */
export function gitCatalogVerdict(head: string, argv: readonly string[]): GitVerdict | null {
  try {
    // `2>&1`, `> log.txt` and `&> log.txt` are the shell's, not the program's: never a refspec.
    const args = argv.filter((t, i) => !isRedirectionWord(t, i, argv) && !/^&>>?/.test(t) && !(i > 0 && /^&>>?$/.test(argv[i - 1])));
    if (head === 'git') return readGit(args);
    if (head === 'gh') return readGh(args);
    return null;
  } catch {
    return head === 'git' || head === 'gh' ? unreadable(head) : null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A COMMAND, as the floor and its classifier twin read it (sensitivity-floor.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The verdict for one enumerated position. A command word we cannot name (`$G push -f`) is read
 * as git and as gh too, the way the floor's `$`-head recursion tell reads it as a delete: if either
 * reading deletes on its LITERAL words, it asks. Doubt about an unknown program is not a push.
 */
export function positionGitVerdict(c: CommandNode): GitVerdict | null {
  const direct = gitCatalogVerdict(c.head, c.argv);
  if (direct !== null || !(headUnresolvable(c) || expandsUnquoted(c.rawHead))) return direct;
  for (const reading of ['git', 'gh']) {
    const read = gitCatalogVerdict(reading, c.argv);
    if (read?.kind === 'protected' || read?.kind === 'delete') return read;
  }
  return null;
}

/** The side-effect families the catalog gives a command, strictest last. */
export type GitFamily = 'external_mutation' | 'dangerous_delete' | 'unknown' | 'protected_remote';

const FAMILY_OF: Record<Exclude<GitVerdictKind, 'readonly'>, GitFamily> = {
  external: 'external_mutation',
  delete: 'dangerous_delete',
  unread: 'unknown',
  protected: 'protected_remote',
};
const FAMILY_RANK: Record<GitFamily, number> = { external_mutation: 0, dangerous_delete: 1, unknown: 2, protected_remote: 3 };

/**
 * The strictest family any git or gh position of the command carries, or null when it has none.
 * The floor asks for all but external_mutation, and the classifier never rates the command below
 * it, whatever else the command does (an early delete verdict must not undercut a force push).
 *
 * Where the text cannot be enumerated, or a substitution or interpreter runs code no position
 * shows (`eval "$(…)"`), the WORDS of a git action (`git` with `push`, `gh` with `merge`, `delete`
 * or `api`) make it unread, exactly as the floor's unparseable scan reads a delete verb. So does a
 * decoder's output run as code (shell-stdin-code `decodes`): `echo Z2l0… | base64 -d | sh`.
 */
export function gitCommandFamily(analysis: CommandAnalysis, text: string): GitFamily | null {
  let worst: GitFamily | null = null;
  for (const c of analysis.commands) {
    const v = positionGitVerdict(c);
    if (v === null || v.kind === 'readonly') continue;
    if (worst === null || FAMILY_RANK[FAMILY_OF[v.kind]] > FAMILY_RANK[worst]) worst = FAMILY_OF[v.kind];
  }
  const codeUnread = !analysis.parsedSafely || ((analysis.nested || analysis.assigns) && analysis.commands.some(runsUnreadCode));
  // A decoder's output run as code (a shell reading stdin, or code run unread) hides its payload on purpose,
  // and so does an escape-encoded literal fed to a shell or made into a command word.
  const stdinShell = analysis.commands.some(readsCodeFromStdin);
  const decodedPayload = ((codeUnread || stdinShell) && analysis.commands.some(decodes))
    || ((!analysis.parsedSafely || stdinShell) && analysis.commands.some(escapesLiteral));
  if ((decodedPayload || (codeUnread && namesAGitAction(text))) && (worst === null || FAMILY_RANK[worst] < FAMILY_RANK.unknown)) worst = 'unknown';
  return worst;
}

const GH_ACTION_TELLS: ReadonlySet<string> = new Set(['merge', 'delete', 'api']);

/** `git` beside `push`, or `gh` beside `merge`/`delete`/`api`, as whole words anywhere in the text. */
function namesAGitAction(text: string): boolean {
  const words = text.split(SHELL_WORD_DELIMITERS).filter((w) => w.length > 0).map(removeQuotes);
  const heads = new Set(words.map((w) => normalizeHead(w)));
  return (heads.has('git') && words.includes('push')) || (heads.has('gh') && words.some((w) => GH_ACTION_TELLS.has(w)));
}

// ── words ──────────────────────────────────────────────────────────────────────

/** A token whose value the text does not show: an expansion, a substitution, or an unquoted glob. */
function isDynamic(token: string): boolean {
  return token.includes('$') || token.includes('`') || containsUnquotedGlob(token);
}

/** The word the program receives (bash's quote removal). */
const word = (token: string): string => removeQuotes(token);

function unreadable(head: 'git' | 'gh'): GitVerdict {
  return head === 'git'
    ? { kind: 'unread', headline: 'Push code, with a command that cannot be fully read', actionLabel: 'Push' }
    : { kind: 'unread', headline: 'Run a GitHub command that cannot be fully read', actionLabel: 'Allow once' };
}

// ═══════════════════════════════════════════════════════════════════════════
// git
// ═══════════════════════════════════════════════════════════════════════════

/** git's own options that take the NEXT word as their value (`git -C dir`, `git -c k=v`). */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source',
]);

/** git's own options that take no value (or carry it after `=`). */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--exec-path', '--html-path', '--man-path', '--info-path', '--version', '-v',
  '--help', '-h', '--list-cmds',
]);

/**
 * The config keys that can redirect or change what a git command or a push does: an alias makes any
 * name any command; `push.*`, `remote.*` and `url.*` decide what a push sends and where; credentials,
 * `http.*`, `core.sshCommand` and `core.askPass` decide how it authenticates; `core.hooksPath` runs
 * code at push time; `include.*` / `includeIf.*` pull in any of the above from a file. Exact list:
 * `core.pager`, `user.name` and the rest stay readable.
 */
const REDIRECTING_CONFIG_KEY = /^(?:(?:alias|push|remote|url|credential|http|include|includeif)\.|core\.(?:sshcommand|hookspath|askpass)(?:=|$))/i;

/** A `-c name=value` / `--config-env=name=envvar` whose key redirects (or whose text does not show it). */
function redirectingOverride(raw: string, setting: string): boolean {
  return isDynamic(raw) || REDIRECTING_CONFIG_KEY.test(setting);
}

function readGit(argv: readonly string[]): GitVerdict | null {
  let i = 0;
  let configOverride = false;
  let aliasOverride = false;
  let unknownOption = false;
  while (i < argv.length) {
    const t = word(argv[i]);
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) {
      if ((t === '-c' || t === '--config-env') && redirectingOverride(argv[i + 1] ?? '', word(argv[i + 1] ?? ''))) {
        configOverride = true;
        if (isDynamic(argv[i + 1] ?? '') || /^alias\./i.test(word(argv[i + 1] ?? ''))) aliasOverride = true;
      }
      i += 2;
      continue;
    }
    if (t.startsWith('--') && t.includes('=')) {
      const name = t.slice(0, t.indexOf('='));
      const setting = t.slice(t.indexOf('=') + 1);
      if (name === '--config-env') {
        if (redirectingOverride(argv[i], setting)) configOverride = true;
        if (isDynamic(argv[i]) || /^alias\./i.test(setting)) aliasOverride = true;
      } else if (!GIT_GLOBAL_VALUE_OPTIONS.has(name) && !GIT_GLOBAL_FLAGS.has(name)) unknownOption = true;
      i++;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(t)) { i++; continue; }
    if (t.startsWith('-')) { unknownOption = true; i++; continue; }
    break;
  }
  if (i >= argv.length) return null;             // `git`, `git --version`: help and versions
  if (isDynamic(argv[i])) return unreadable('git'); // `git $SUB …`: which command runs is not in the text
  if (aliasOverride) return unreadable('git');   // `git -c alias.x='push -f' x`: any name can be a push
  const sub = word(argv[i]);
  const rest = argv.slice(i + 1);
  // `send-pack` is push's plumbing: the same options and refspecs.
  if (sub === 'push' || sub === 'send-pack') return readPush(rest, configOverride || unknownOption);
  if (sub === 'config') return readGitConfig(rest);
  const other = OTHER_REMOTE_WRITERS.get(sub);
  if (other !== undefined && rest.some((t) => word(t) === other.op)) return { kind: 'external', headline: other.headline, actionLabel: 'Push' };
  // An option we do not know may have taken a value, and then the real subcommand comes later.
  if (unknownOption && rest.some((t) => word(t) === 'push')) return unreadable('git');
  return null;
}

/** The other git commands that write to a remote (by their operation word): they follow the access level, like a named push. */
const OTHER_REMOTE_WRITERS: ReadonlyMap<string, { op: string; headline: string }> = new Map([
  ['subtree', { op: 'push', headline: 'Push a subtree to a remote repository' }],
  ['lfs', { op: 'push', headline: 'Push large files to a remote repository' }],
  ['svn', { op: 'dcommit', headline: 'Commit to the Subversion repository' }],
  ['p4', { op: 'submit', headline: 'Submit to the Perforce server' }],
]);

/** `git config` options whose value is the next word. */
const GIT_CONFIG_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
/** `git config` reads, as flags (anywhere, as git parses them). */
const GIT_CONFIG_READ_FLAGS: ReadonlySet<string> = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l',
]);
/** New-style `git config <subcommand>` words (the first word only); the key follows the writing ones. */
const GIT_CONFIG_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['get', 'list']);
const GIT_CONFIG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['set', 'unset', 'rename-section', 'remove-section']);

/**
 * `git config` that DEFINES a redirecting key (REDIRECTING_CONFIG_KEY: an alias, a push refspec, a
 * remote, a credential helper, …) in any scope is the first step of a two-step bypass: define
 * `alias.p = push -f`, then run `git p`, which no argv can read. So the definition is unread and
 * asks. A read (`--get`, `list`), and any other key (`user.name`), keep today's verdict.
 */
function readGitConfig(args: readonly string[]): GitVerdict | null {
  const words = args.map(word);
  if (words.some((w) => GIT_CONFIG_READ_FLAGS.has(w))) return null;
  if (words.some((w) => w === '--edit' || w === '-e')) return unreadable('git');
  let first = true;
  for (let i = 0; i < args.length; i++) {
    const w = words[i];
    if (GIT_CONFIG_VALUE_OPTIONS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    if (first && GIT_CONFIG_READ_SUBCOMMANDS.has(w)) return null;
    if (first && w === 'edit') return unreadable('git');
    if (first && GIT_CONFIG_WRITE_SUBCOMMANDS.has(w)) { first = false; continue; }
    // The key (or, for a section rename or removal, the section).
    const key = /^(?:alias|push|remote|url|credential|http|include|includeif)$/i.test(w) ? `${w}.` : w;
    if (isDynamic(args[i]) || REDIRECTING_CONFIG_KEY.test(key)) {
      return { kind: 'unread', headline: `Change the git setting ${w}, which can change what a command or a push does`, actionLabel: 'Allow once' };
    }
    return null;
  }
  return null;
}

/** `git push` options that take the NEXT word as their value (unless it follows `=`). */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--push-option', '--recurse-submodules']);

/** `git push` long options that change nothing about where refs land or whether they are forced. */
const PUSH_PLAIN_OPTIONS: ReadonlySet<string> = new Set([
  '--verbose', '--quiet', '--set-upstream', '--dry-run', '--porcelain', '--progress', '--no-progress',
  '--thin', '--no-thin', '--atomic', '--no-atomic', '--verify', '--no-verify', '--follow-tags',
  '--no-follow-tags', '--signed', '--no-signed', '--ipv4', '--ipv6', '--no-recurse-submodules',
  '--no-force-with-lease', '--no-force-if-includes', '--push-option', '--recurse-submodules',
]);

const PUSH_FORCE_OPTIONS: ReadonlySet<string> = new Set(['--force', '--force-with-lease', '--force-if-includes']);
const PUSH_EVERYTHING_OPTIONS: ReadonlySet<string> = new Set(['--all', '--branches', '--mirror', '--tags']);

/** `git push` one-letter options that change nothing; `f` forces, `d` deletes, `o` takes a value. */
const PUSH_SHORT_PLAIN: ReadonlySet<string> = new Set(['v', 'q', 'u', 'n', '4', '6']);

interface PushShape {
  force: boolean;
  remove: boolean;
  prune: boolean;
  everything: string | null;
  /** A word whose value is not in the text (it can split into more refspecs), or an option not listed. */
  unread: boolean;
  positionals: string[];
}

function readPushArgs(args: readonly string[]): PushShape {
  const shape: PushShape = { force: false, remove: false, prune: false, everything: null, unread: false, positionals: [] };
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (isDynamic(raw)) { shape.unread = true; continue; }
    const t = word(raw);
    if (optionsEnded || !t.startsWith('-') || t === '-') { shape.positionals.push(t); continue; }
    if (t === '--') { optionsEnded = true; continue; }
    if (t.startsWith('--')) {
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (PUSH_FORCE_OPTIONS.has(name)) shape.force = true;
      else if (name === '--delete') shape.remove = true;
      else if (name === '--prune') shape.prune = true;
      else if (PUSH_EVERYTHING_OPTIONS.has(name)) shape.everything = name;
      else if (!PUSH_PLAIN_OPTIONS.has(name)) shape.unread = true; // --repo, --receive-pack, --exec, anything new
      if (PUSH_VALUE_OPTIONS.has(name) && !t.includes('=')) i++;
      continue;
    }
    for (let k = 1; k < t.length; k++) {
      const ch = t[k];
      if (ch === 'f') shape.force = true;
      else if (ch === 'd') shape.remove = true;
      else if (ch === 'o') { if (k === t.length - 1) i++; break; } // -o <option>, or -o<option>
      else if (!PUSH_SHORT_PLAIN.has(ch)) shape.unread = true;
    }
  }
  return shape;
}

/**
 * Where one refspec lands, and whether it forces or deletes. A null target names no one branch: a
 * pattern, or `HEAD` / `@`, which push the current branch to its own name (`current`), and which
 * branch that is the argv does not say.
 */
interface Refspec { force: boolean; remove: boolean; current: boolean; target: string | null }

function readRefspec(spec: string): Refspec {
  const force = spec.startsWith('+');
  const body = force ? spec.slice(1) : spec;
  const colon = body.indexOf(':');
  if (colon === 0) return { force, remove: true, current: false, target: branchName(body.slice(1)) };
  if (colon < 0 && (body === 'HEAD' || body === '@')) return { force, remove: false, current: true, target: null };
  return { force, remove: false, current: false, target: branchName(colon < 0 ? body : body.slice(colon + 1)) };
}

/** A refspec destination as the branch name a person knows, or null when it names no one branch. */
function branchName(ref: string): string | null {
  if (ref === '' || ref === 'HEAD' || ref === '@' || ref.includes('*') || ref.startsWith('@{')) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function readPush(args: readonly string[], configOverride: boolean): GitVerdict {
  const shape = readPushArgs(args);
  const [remote, ...specs] = shape.positionals;
  const on = remote !== undefined ? ` on ${remoteLabel(remote)}` : '';
  const refspecs = specs.map(readRefspec);
  const named = refspecs.map((r) => r.target).filter((t): t is string => t !== null);

  if (shape.force || refspecs.some((r) => r.force)) {
    const where = named.length === 1 ? ` to ${named[0]}` : '';
    return { kind: 'protected', headline: `Force-push (rewrites history)${where}${on}`, actionLabel: 'Force-push' };
  }
  if (shape.remove || refspecs.some((r) => r.remove)) {
    const what = named.length === 1 ? `branch ${named[0]}` : named.length > 1 ? `${named.length} branches` : 'a branch';
    return { kind: 'protected', headline: `Delete ${what}${on}`, actionLabel: 'Delete branch' };
  }
  if (shape.prune) {
    return { kind: 'protected', headline: `Delete the branches${on} that are gone here`, actionLabel: 'Delete branches' };
  }
  if (shape.everything === '--mirror') {
    return { kind: 'protected', headline: `Mirror this repository${on}, overwriting it`, actionLabel: 'Mirror' };
  }
  if (shape.unread || configOverride) {
    return { kind: 'unread', headline: `Push code${on}, with options that cannot be fully read`, actionLabel: 'Push' };
  }
  // The shared-branch writes: SHARED_WRITE, pending the founder's ruling.
  if (shape.everything === '--tags') {
    return { kind: SHARED_WRITE, headline: `Push every tag${on}`, actionLabel: 'Push tags' };
  }
  if (shape.everything !== null) {
    return { kind: SHARED_WRITE, headline: `Push every branch${on}`, actionLabel: 'Push all' };
  }
  const toDefault = named.find((t) => DEFAULT_BRANCHES.has(t.toLowerCase()));
  if (toDefault !== undefined) {
    return { kind: SHARED_WRITE, headline: `Push to ${toDefault}${on}`, actionLabel: `Push to ${toDefault}` };
  }
  if (remote === undefined || specs.length === 0 || refspecs.some((r) => r.current)) {
    return { kind: SHARED_WRITE, headline: `Push the current branch${remote !== undefined ? ` to ${remoteLabel(remote)}` : ''}`, actionLabel: 'Push' };
  }
  if (named.length < specs.length) {
    return { kind: SHARED_WRITE, headline: `Push to ${remoteLabel(remote)}, to branches the command does not name`, actionLabel: 'Push' };
  }
  const what = named.length === 1 ? named[0] : `${named.length} branches`;
  return { kind: 'external', headline: `Push ${what} to ${remoteLabel(remote)}`, actionLabel: 'Push' };
}

/**
 * A remote as a person reads it: `github.com/acme/site` for a URL (https, ssh, or scp-style
 * `git@host:owner/repo`), else its name (`origin`). Display only: no verdict depends on it.
 */
export function remoteLabel(remote: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(remote)
    ?? /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  return url ? `${url[1]}/${url[2]}` : remote;
}

// ═══════════════════════════════════════════════════════════════════════════
// gh
// ═══════════════════════════════════════════════════════════════════════════

/** gh commands that only read. `gh search …` reads too, whatever it searches. */
const GH_READS: ReadonlySet<string> = new Set([
  'pr view', 'pr list', 'pr status', 'pr diff', 'pr checks',
  'issue view', 'issue list', 'issue status',
  'repo view', 'repo list',
  'release view', 'release list',
  'run view', 'run list', 'run watch',
  'workflow view', 'workflow list',
  'auth status',
]);

/** gh commands that change GitHub, and what each does in plain words. */
const GH_CHANGES: ReadonlyMap<string, string> = new Map([
  ['pr create', 'Open a pull request'],
  ['pr edit', 'Edit a pull request'],
  ['pr comment', 'Comment on a pull request'],
  ['pr review', 'Review a pull request'],
  ['pr close', 'Close a pull request'],
  ['pr reopen', 'Reopen a pull request'],
  ['pr ready', 'Mark a pull request ready for review'],
  ['issue create', 'Open an issue'],
  ['issue edit', 'Edit an issue'],
  ['issue comment', 'Comment on an issue'],
  ['issue close', 'Close an issue'],
  ['issue reopen', 'Reopen an issue'],
  ['repo create', 'Create a repository'],
  ['repo fork', 'Fork a repository'],
  ['repo edit', 'Change the settings of a repository'],
  ['repo rename', 'Rename a repository'],
  ['repo archive', 'Archive a repository'],
  ['release create', 'Publish a release'],
  ['release edit', 'Edit a release'],
  ['release upload', 'Upload files to a release'],
  ['workflow run', 'Start a workflow'],
  ['run rerun', 'Re-run a workflow'],
  ['run cancel', 'Cancel a workflow run'],
]);

const EXTENSION_GROUPS: ReadonlySet<string> = new Set(['extension', 'extensions', 'ext']);

/** `--delete-branch` (not `=false`), or `-d` alone or in a bundle of pr merge/close's bare flags (`-sd`). */
function deletesBranch(w: string): boolean {
  return (w.startsWith('--delete-branch') && w !== '--delete-branch=false') || /^-[dmrs]*d[dmrs]*$/.test(w);
}

/** gh flags whose value is the next word, as far as naming the target on the card goes. */
const GH_NAMING_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email',
  '--match-head-commit',
]);

/** The words of what a gh command acts on (`12`, `v1.2.0`), skipping flags and their values. Display only. */
function ghPositionals(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (GH_NAMING_VALUE_FLAGS.has(words[i])) { i++; continue; }
    if (!words[i].startsWith('-')) out.push(words[i]);
  }
  return out;
}

/** The `owner/repo` of gh's `-R`/`--repo`, or null. Display only. */
function ghRepo(words: readonly string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    if ((words[i] === '-R' || words[i] === '--repo') && words[i + 1]) return words[i + 1];
    if (words[i].startsWith('--repo=')) return words[i].slice('--repo='.length);
  }
  return null;
}

/** The subcommand words whose presence, in a gh command we cannot place, might mean a merge, delete or write. */
const GH_UNPLACED_TELLS: ReadonlySet<string> = new Set(['merge', 'delete', 'api']);

/** The gh groups with a merge or a repository/release delete: a subcommand not in the text could be it. */
const GH_PROTECTED_GROUPS: ReadonlySet<string> = new Set(['pr', 'repo', 'release']);

function readGh(argv: readonly string[]): GitVerdict | null {
  if (argv.length === 0) return null;
  if (isDynamic(argv[0])) return unreadable('gh');
  if (argv.length > 1 && isDynamic(argv[1]) && GH_PROTECTED_GROUPS.has(word(argv[0]))) return unreadable('gh');
  const group = word(argv[0]);
  // gh takes no options before its command; one there leaves the command unplaced.
  if (group.startsWith('-')) return argv.some((t) => GH_UNPLACED_TELLS.has(word(t))) ? unreadable('gh') : null;
  if (group === 'api') return readGhApi(argv.slice(1));
  const sub = word(argv[1] ?? '');
  const rest = argv.slice(2).map(word);
  const repo = ghRepo(rest);
  const on = repo !== null ? ` on ${repo}` : '';
  const [first] = ghPositionals(rest);

  // A definition no argv can read later: `gh alias set rd 'repo delete'`, then `gh rd o/r`; an extension is any code.
  if ((group === 'alias' && (sub === 'set' || sub === 'import')) || (EXTENSION_GROUPS.has(group) && (sub === 'install' || sub === 'upgrade'))) {
    return { kind: 'unread', headline: group === 'alias' ? 'Define a GitHub CLI shortcut, which can stand for any command' : 'Install a GitHub CLI extension, which can run any code', actionLabel: 'Allow once' };
  }
  // `--delete-branch` / `-d` (alone or in a bundle: `-sd`) deletes the remote branch: a remote delete.
  if (group === 'pr' && sub === 'merge' && rest.some(deletesBranch)) {
    return { kind: 'protected', headline: `Merge ${first !== undefined ? `pull request ${first}` : 'a pull request'}${on} and delete its branch`, actionLabel: 'Merge and delete branch' };
  }
  if (group === 'pr' && sub === 'merge') {
    return { kind: SHARED_WRITE, headline: `Merge ${first !== undefined ? `pull request ${first}` : 'a pull request'}${on}`, actionLabel: 'Merge' };
  }
  if (group === 'repo' && sub === 'delete') {
    const name = first ?? repo;
    return { kind: 'protected', headline: name ? `Delete the repository ${name}` : 'Delete this repository', actionLabel: 'Delete repository' };
  }
  if (group === 'release' && sub === 'delete') {
    return { kind: 'protected', headline: `Delete ${first !== undefined ? `release ${first}` : 'a release'}${on}`, actionLabel: 'Delete release' };
  }
  if (sub === 'delete' || sub === 'delete-asset') {
    return { kind: 'delete', headline: `Delete ${first !== undefined ? `${group} ${first}` : `a ${group}`} on GitHub`, actionLabel: 'Delete' };
  }
  if (group === 'pr' && sub === 'close' && rest.some(deletesBranch)) {
    return { kind: 'delete', headline: 'Close a pull request and delete its branch', actionLabel: 'Delete branch' };
  }
  if (group === 'search' || GH_READS.has(`${group} ${sub}`)) {
    return { kind: 'readonly', headline: 'Read from GitHub', actionLabel: 'Allow once' };
  }
  const change = GH_CHANGES.get(`${group} ${sub}`);
  if (change !== undefined) return { kind: 'external', headline: `${change} on GitHub`, actionLabel: 'Allow once' };
  return null;
}

/** `gh api` options that take the NEXT word as their value, and those that send a request body. */
const GH_API_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '-q', '--jq', '-t', '--template',
  '--input', '--hostname', '--cache', '-p', '--preview',
]);
const GH_API_BODY_OPTIONS: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field', '--input']);
const GH_API_FLAGS: ReadonlySet<string> = new Set(['-i', '--include', '--paginate', '--slurp', '--silent', '--verbose']);
const GH_API_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * `gh api` reads with GET (its default) and with HEAD. It becomes a POST by itself when fields
 * or a body are given (-f, -F, --input), so a request whose method is not written out and that
 * carries a body writes. The endpoint decides what a write is, by EXACT path family:
 *   - any write to `repos/{o}/{r}/git/refs…` moves or deletes a branch or tag (a `force=true`
 *     PATCH is a force push): protected;
 *   - a DELETE of `repos/{o}/{r}` or `repos/{o}/{r}/releases/{id}` deletes the repository or a
 *     release, as `gh repo delete` / `gh release delete` do: protected;
 *   - any other DELETE is a delete, as `curl -X DELETE` is;
 *   - any other write is a shared-branch write (SHARED_WRITE).
 * A body from a file (`--input`, `-F x=@file`), a GraphQL mutation, a method, option or endpoint
 * this cannot read: unread.
 */
function readGhApi(args: readonly string[]): GitVerdict {
  let method: string | null = null;
  let body = false;
  let unread = false;
  let endpoint: string | null = null;
  let endpointRaw = '';
  const fieldValues: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const t = word(raw);
    if (!t.startsWith('-')) { if (endpoint === null) { endpoint = t; endpointRaw = raw; } continue; }
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    const attached = !t.startsWith('--') && t.length > 2;
    const name = eq > 0 ? t.slice(0, eq) : attached ? t.slice(0, 2) : t;
    const inline = eq > 0 ? t.slice(eq + 1) : attached ? t.slice(2) : null;
    if (GH_API_FLAGS.has(name)) continue;
    if (!GH_API_VALUE_OPTIONS.has(name)) { unread = true; continue; }
    const valueRaw = inline !== null ? raw : (args[++i] ?? '');
    if (GH_API_BODY_OPTIONS.has(name)) body = true;
    if (name === '--input') unread = true; // the body is a file (or stdin) this cannot read
    if (name === '-f' || name === '--raw-field' || name === '-F' || name === '--field') fieldValues.push(inline ?? word(valueRaw));
    if (name === '-X' || name === '--method') {
      if (isDynamic(valueRaw)) unread = true;
      else method = (inline ?? word(valueRaw)).toUpperCase();
    }
  }
  const effective = method ?? (body ? 'POST' : 'GET');
  // GitHub's REST paths match case-insensitively (`REPOS/o/r` is `repos/o/r`), so the families are matched lowercased.
  const path = (endpoint ?? '').toLowerCase().replace(/^https:\/\/api\.github\.com\//, '').replace(/^\/+/, '').replace(/\?.*$/, '');
  if (path === 'graphql') {
    // A field from a file (`-F query=@q.graphql`) or a mutation writes; the operation type is GraphQL's own keyword.
    if (args.some(isDynamic) || fieldValues.some((v) => /^query=@/.test(v) || (/^query=/.test(v) && /\bmutation\b/.test(v)))) unread = true;
  } else if (!GH_API_READ_METHODS.has(effective) && isDynamic(endpointRaw)) unread = true;
  if (!unread && GH_API_READ_METHODS.has(effective)) return { kind: 'readonly', headline: 'Read from GitHub', actionLabel: 'Allow once' };
  if (unread) return { kind: 'unread', headline: 'Change data on GitHub, with a request that cannot be fully read', actionLabel: 'Send request' };
  const shown = endpoint === null ? '' : ` (${effective} ${endpoint.length > 40 ? `${endpoint.slice(0, 40)}...` : endpoint})`;
  const segs = path.split('/');
  if (segs[0] === 'repos' && segs[3] === 'git' && (segs[4] ?? '').startsWith('refs')) {
    return { kind: 'protected', headline: `Move or delete a branch on GitHub${shown}`, actionLabel: 'Change branch' };
  }
  if (effective === 'DELETE' && segs[0] === 'repos' && (segs.length === 3 || (segs.length === 5 && segs[3] === 'releases'))) {
    return { kind: 'protected', headline: segs.length === 3 ? `Delete the repository ${segs[1]}/${segs[2]}` : `Delete a release on GitHub${shown}`, actionLabel: 'Delete' };
  }
  if (effective === 'DELETE') return { kind: 'delete', headline: `Delete data on GitHub${shown}`, actionLabel: 'Delete' };
  return { kind: SHARED_WRITE, headline: `Change data on GitHub${shown}`, actionLabel: 'Send request' };
}

// ═══════════════════════════════════════════════════════════════════════════
// REFUSED: the box's GitHub credential (engineer teammates, Git train G2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The box's git gets a one-hour, one-repo GitHub token from the Vestra server through a credential
 * helper (apps/sandbox/bin/vestra-git-credential, named in /etc/gitconfig for github.com). The agent
 * pushes WITH it and must never hold it: a token in hand is a push no row above reads (a request to
 * GitHub's API can force a branch the `git push` rows would ask about). So, while GITHUB_APP_V1 is
 * on (the only time there is such a token), what would hand it to the agent is refused outright, at
 * every level, and never asked (the security gate, security-patterns checkDangerousBashCommand,
 * which reads the flag; this function stays pure). Off, each keeps its earlier verdict. Refused:
 *   - `git credential …` and any `git credential-<helper> …` (fill, approve, reject, get, …), and a
 *     `git-credential-<helper>` program run directly;
 *   - the helper itself, by name or by path, or as the script a shell or an interpreter runs;
 *   - a credential setting for one command or from the environment: `-c credential.*`,
 *     `--config-env=credential.*`, `GIT_CONFIG_KEY_<n>=credential.*`. A helper of the agent's own
 *     would be handed the token when git stores it after a push;
 *   - `git config` naming the credential section, to read it or to change it (a change asked
 *     before; a helper of the agent's own, kept, would catch every later push's token).
 * Each is read inside `sh -c`, `eval`, a substitution, and code a shell reads from its stdin
 * (shellStdinCode). A command the analyzer cannot enumerate at all is refused when its words name
 * `git` with a credential subcommand, or the helper (fail closed). Membership is exact: the
 * credential section and subcommand namespace are git's own (`credential.*`,
 * `git credential-<helper>`).
 *
 * Out of reach, and named: a renamed copy of the helper, a request straight to the server's
 * credential door with the box's own token, git's curl trace with redaction off, a `git config`
 * listing or pattern that does not name the section (it shows only the helper's path, which is
 * public), and config written as a FILE. There the token's own scope is the stop: one repo, one
 * hour, contents and pull requests only, and minted only for a person with write access.
 */
export const GIT_CREDENTIAL_HELPER = 'vestra-git-credential';

/** Programs that run the script file they are given (a version suffix is the same program: python3.12). */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'fish', 'source', '.', 'node', 'nodejs', 'python', 'perl', 'ruby',
]);

/** Builtins whose words are assignments the shell exports. */
const EXPORTING_HEADS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset']);

const isCredentialKey = (key: string): boolean => {
  const k = key.toLowerCase();
  return k === 'credential' || k.startsWith('credential.');
};
const isCredentialSubcommand = (sub: string): boolean => sub === 'credential' || sub.startsWith('credential-');
/** The key of a `name=value` setting. */
const settingKey = (setting: string): string => (setting.includes('=') ? setting.slice(0, setting.indexOf('=')) : setting);

/** git's argv: the `-c` / `--config-env` settings before the subcommand, the subcommand, and its words. */
function gitParts(argv: readonly string[]): { settings: string[]; sub: string | null; rest: readonly string[] } {
  const settings: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const t = word(argv[i]);
    if (t === '-c' || t === '--config-env') { settings.push(word(argv[i + 1] ?? '')); i += 2; continue; }
    if (t.startsWith('--config-env=')) { settings.push(t.slice('--config-env='.length)); i++; continue; }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    break;
  }
  return { settings, sub: i < argv.length ? word(argv[i]) : null, rest: argv.slice(i + 1) };
}

/** Does this `git config` name the credential section (its key, name pattern or section)? */
function gitConfigNamesCredential(args: readonly string[]): boolean {
  const words = args.map(word);
  let first = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (GIT_CONFIG_VALUE_OPTIONS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    if (first && (GIT_CONFIG_READ_SUBCOMMANDS.has(w) || GIT_CONFIG_WRITE_SUBCOMMANDS.has(w) || w === 'edit')) { first = false; continue; }
    return isCredentialKey(w);
  }
  return false;
}

/** `GIT_CONFIG_KEY_<n>=credential.…` among these words. */
const setsCredentialKeyInEnv = (words: readonly string[]): boolean =>
  words.some((w) => {
    const t = removeQuotes(w);
    const eq = t.indexOf('=');
    return eq > 0 && /^GIT_CONFIG_KEY_\d+$/.test(t.slice(0, eq)) && isCredentialKey(t.slice(eq + 1));
  });

/** Why this one position would hand out the box's GitHub credential, or null. */
function credentialPosition(c: CommandNode): string | null {
  const prefix = c.raw.slice(0, Math.max(0, c.raw.indexOf(c.rawHead))).split(/\s+/);
  if (setsCredentialKeyInEnv(prefix)) return 'Setting a git credential helper for one command';
  if (EXPORTING_HEADS.has(c.head) && setsCredentialKeyInEnv(c.argv)) return 'Setting a git credential helper for later commands';
  if (c.head === GIT_CREDENTIAL_HELPER || c.head.startsWith('git-credential-')) return "Running the box's GitHub credential helper";
  if (SCRIPT_RUNNERS.has(c.head.replace(/(?<=[a-z])[\d.]+$/, '')) && c.argv.some((w) => normalizeHead(w) === GIT_CREDENTIAL_HELPER)) {
    return "Running the box's GitHub credential helper";
  }
  // A command word we cannot name is read as git too (as positionGitVerdict reads it).
  if (c.head !== 'git' && !headUnresolvable(c) && !expandsUnquoted(c.rawHead)) return null;
  const { settings, sub, rest } = gitParts(c.argv);
  if (settings.some((s) => isCredentialKey(settingKey(s)))) return 'Setting a git credential helper for one command';
  if (sub !== null && isCredentialSubcommand(sub)) return 'Asking git for a stored credential';
  if (sub === 'config' && gitConfigNamesCredential(rest)) return "Reading or changing git's credential settings";
  return null;
}

/** The words of git asking for a credential, or of the helper, anywhere in the text. */
function namesCredentialAccess(text: string): boolean {
  const words = text.split(SHELL_WORD_DELIMITERS).filter((w) => w.length > 0).map(removeQuotes);
  const heads = new Set(words.map((w) => normalizeHead(w)));
  return heads.has(GIT_CREDENTIAL_HELPER) || (heads.has('git') && words.some(isCredentialSubcommand));
}

/**
 * Why this command would hand the box's GitHub credential to the agent, or null. The security gate
 * refuses it outright (see above). Total and never throws: a command it could not read fails closed
 * when its words name credential access.
 */
export function gitCredentialExtraction(command: string): string | null {
  try {
    for (const text of [command, ...shellStdinCode(command)]) {
      const analysis = analyzeCommand(stripHeredocBodies(text), { wrapperOptions: true });
      for (const c of analysis.commands) {
        const why = credentialPosition(c);
        if (why !== null) return why;
      }
      if (!analysis.parsedSafely && namesCredentialAccess(text)) return 'A command that cannot be fully read, asking git for a credential';
    }
    return null;
  } catch {
    return namesCredentialAccess(command) ? 'A command that cannot be fully read, asking git for a credential' : null;
  }
}
