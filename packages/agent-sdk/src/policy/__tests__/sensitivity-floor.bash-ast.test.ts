import { describe, it, expect, afterEach } from 'vitest';
import { sensitivityFloorAsks } from '../../index.js';
import { DESTRUCTIVE_SHELL_VERBS } from '../command-analyzer.js';

const asks = (command: string) =>
  sensitivityFloorAsks({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });

/** The founder-preview cases judge in-workspace vs escape against this root. */
const ROOT = '/app/workspace';
const asksIn = (command: string, workspaceRoot: string = ROOT) =>
  sensitivityFloorAsks(
    { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
    { workspaceRoot },
  );

describe('sensitivity floor — DANGEROUS delete reachable in ANY command position', () => {
  // Position-coverage twins of the p0 bypass corpus: after the rm narrowing
  // (founder ruling 2026-07-06) the floor gates DANGEROUS deletes only, so the
  // position fixtures carry a recursive delete — a safe delete is admitted in
  // the same positions (see the narrowing block below).
  it('floors a backgrounded dangerous delete', () => { expect(asks('sleep 1 & rm -rf scratch')).toBe(true); });
  it('floors a dangerous delete inside process substitution', () => { expect(asks('cat <(rm -rf scratch)')).toBe(true); });
  it('floors a path-prefixed dangerous delete', () => { expect(asks('/bin/rm -rf scratch')).toBe(true); });
  it('floors a wrapper-invoked delete (targets come from stdin — unverifiable)', () => { expect(asks('xargs rm < list.txt')).toBe(true); });
  it('floors a dangerous delete in an sh -c body', () => { expect(asks(`sh -c "rm -rf scratch"`)).toBe(true); });
  it('asks on an unparseable command that carries a delete token', () => { expect(asks('rm $(cat $(echo x))')).toBe(true); });
  it('does not over-floor a benign command', () => { expect(asks('ls -la && echo hi')).toBe(false); });
  it('does not floor a documented rm in a heredoc body', () => {
    expect(asks("cat <<'EOF'\nrun rm to delete\nEOF")).toBe(false);
  });
});

describe('sensitivity floor — RM NARROWING (founder ruling: gate ONLY dangerous rm)', () => {
  // A parseable delete floors ONLY when it is DANGEROUS: a recursive/force
  // flag, a glob target, or a target that escapes the workspace. A plain
  // in-workspace specific-file delete runs SILENTLY.

  it('SILENT: a plain relative in-workspace delete', () => {
    expect(asksIn('rm bloom-check.png')).toBe(false);
  });

  it("SILENT: Bloom's real compound — absolute-but-under-workspace targets + redirect + echo", () => {
    expect(
      asksIn(
        'rm /app/workspace/files/bloom-desktop-check.png /app/workspace/files/bloom-mobile-check.png 2>/dev/null; echo "cleaned up"',
      ),
    ).toBe(false);
  });

  it('SILENT: a plain rmdir of a relative dir', () => {
    expect(asksIn('rmdir empty-dir')).toBe(false);
  });

  it('SILENT: a safe delete beside a redirect segment', () => {
    expect(asksIn('echo x > f && rm g')).toBe(false);
  });

  it('SILENT: end-of-options marker then a plain relative target', () => {
    expect(asksIn('rm -- build.log')).toBe(false);
  });

  it('ASK: recursive flag', () => {
    expect(asksIn('rm -rf build/')).toBe(true);
    expect(asksIn('rm -r build/')).toBe(true);
    expect(asksIn('rm --recursive build/')).toBe(true);
  });

  it('SILENT: a FORCE-only flag on a specific in-workspace file (founder ruling 2026-09-03)', () => {
    // Force suppresses the confirm prompt and ignores missing files but never
    // widens the target SET, so `rm -f <in-workspace file>` is as safe as the
    // unforced form. (An in-workspace asset pipeline's `rm -f scratch/x` was
    // asking on staging — the over-gating this ruling fixes.)
    expect(asksIn('rm -f x.txt')).toBe(false);
    expect(asksIn('rm --force x.txt')).toBe(false);
    expect(asksIn('rm -vf x.txt')).toBe(false); // f-only bundle (no r)
  });

  it('ASK: force never rescues a dangerous target — recursion, glob, or escape still gate', () => {
    expect(asksIn('rm -rf x.txt')).toBe(true); // recursion (bundle has r)
    expect(asksIn('rm -fr x.txt')).toBe(true); // recursion (bundle has r), order-independent
    expect(asksIn('rm -f *.txt')).toBe(true); // glob target
    expect(asksIn('rm -f /etc/hosts')).toBe(true); // target escapes the workspace
  });

  it('ASK: glob targets', () => {
    expect(asksIn('rm *.md')).toBe(true);
    expect(asksIn('rm shot-?.png')).toBe(true);
    expect(asksIn('rm shot-[12].png')).toBe(true);
  });

  it('ASK: absolute target outside the workspace', () => {
    expect(asksIn('rm /etc/hosts')).toBe(true);
  });

  it('ASK: ..-traversal in any form (relative, or hidden in an absolute path)', () => {
    expect(asksIn('rm ../../etc/passwd')).toBe(true);
    expect(asksIn('rm /app/workspace/../etc/passwd')).toBe(true);
  });

  it('ASK: $HOME / ~ targets', () => {
    expect(asksIn('rm ~/x.txt')).toBe(true);
    expect(asksIn('rm $HOME/x.txt')).toBe(true);
  });

  it('ASK: bare . or / target', () => {
    expect(asksIn('rm .')).toBe(true);
    expect(asksIn('rm /')).toBe(true);
  });

  it('ASK: an earlier segment moved the cwd — relative targets are unverifiable', () => {
    expect(asksIn('cd / && rm x')).toBe(true);
    expect(asksIn('cd sub && rm x')).toBe(true); // doubt → ask, even for an in-workspace cd
  });

  it('ASK: wrapper/assignment-prefixed delete (sudo/xargs/env) — argv is not the real target set', () => {
    expect(asksIn('sudo rm x')).toBe(true);
    expect(asksIn('env FOO=1 rm x')).toBe(true);
  });

  it('ASK: unresolvable $VAR target — cannot vouch it stays in the workspace', () => {
    expect(asksIn('rm $BLOOM/file.png')).toBe(true);
  });

  it('ASK: absolute in-workspace target but NO workspaceRoot threaded — cannot vouch', () => {
    expect(asks('rm /app/workspace/files/x.png')).toBe(true);
  });
});

describe('sensitivity floor — LIVE shell cwd (cross-call cwd persistence, security-review CRITICAL)', () => {
  // The shell cwd PERSISTS across Bash tool calls (TerminalSession): a `cd
  // /etc` in call 1 makes call 2's relative `rm hostname` delete OUTSIDE the
  // workspace even though call 2 contains no cd. Relative delete targets are
  // therefore resolved against the LIVE cwd the gate threads (shellCwd), not
  // the static root. shellCwd semantics: a string = the live persisted cwd;
  // null = the gate tried and could not determine it (ask); ABSENT = the
  // caller does not track a live cwd (relative targets are assumed to resolve
  // under the gate cwd — the pre-live-cwd posture; the production port always
  // supplies a value or null).
  const asksLive = (command: string, shellCwd: string | null) =>
    sensitivityFloorAsks(
      { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
      { workspaceRoot: ROOT, shellCwd },
    );

  it('ASK: relative delete while the persisted cwd is OUTSIDE the workspace (cd /etc happened last call)', () => {
    expect(asksLive('rm hostname', '/etc')).toBe(true);
  });

  it('SILENT: relative delete while the persisted cwd is a workspace SUBDIR', () => {
    expect(asksLive('rm bloom-check.png', '/app/workspace/files')).toBe(false);
  });

  it('SILENT: relative delete with the persisted cwd at the workspace root itself', () => {
    expect(asksLive('rm bloom-check.png', '/app/workspace')).toBe(false);
  });

  it('ASK: the live cwd could not be determined (null) — doubt goes to ask', () => {
    expect(asksLive('rm x.txt', null)).toBe(true);
  });

  it('SILENT: absolute in-workspace targets are cwd-independent (Bloom compound, cwd escaped)', () => {
    expect(
      asksLive(
        'rm /app/workspace/files/bloom-desktop-check.png /app/workspace/files/bloom-mobile-check.png 2>/dev/null; echo ok',
        '/etc',
      ),
    ).toBe(false);
  });

  it('ASK: absolute outside-workspace target regardless of live cwd', () => {
    expect(asksLive('rm /etc/hosts', '/app/workspace')).toBe(true);
  });

  it('ASK: within-command cwd moves the literal-cd detector missed (builtin/eval/source/dot)', () => {
    expect(asksIn('builtin cd /etc && rm x')).toBe(true);
    expect(asksIn('eval "cd /etc" && rm x')).toBe(true);
    expect(asksIn('source ./go.sh && rm x')).toBe(true);
    expect(asksIn('. ./go.sh && rm x')).toBe(true);
  });

  it('within-command cwd movers do NOT gate an ABSOLUTE in-workspace delete (cwd-independent)', () => {
    expect(asksIn('source ./go.sh && rm /app/workspace/files/x.png')).toBe(false);
  });

  it('ASK: a cd hidden in a BRACE GROUP gates a relative delete (both && and ; forms)', () => {
    // The analyzer parses a brace group as head `{` with the cd swallowed into
    // its argv, so the per-head mover check never saw the cd — `{ cd /etc &&
    // rm hostname; }` ran silently. `{` is itself a cwd-moving head now: any
    // relative delete in a command containing a brace group asks.
    expect(asksLive('{ cd /etc && rm hostname; }', '/app/workspace')).toBe(true);
    expect(asksLive('{ cd /etc; rm hostname; }', '/app/workspace')).toBe(true);
  });

  it('a cd-less brace group stays SILENT for an absolute in-workspace delete and for pure reads', () => {
    expect(asksLive('{ echo hi; rm /app/workspace/files/x.png; }', '/app/workspace')).toBe(false);
    expect(asksLive('{ cat a; cat b; }', '/app/workspace')).toBe(false);
  });
});

describe('sensitivity floor — unparseable commands ask on delete token, r/f flag, or glob', () => {
  // The analyzer could not enumerate the command ($(…)/backtick, unbalanced
  // quote). We cannot verify safety, so we ask when the heredoc-stripped
  // command carries a delete token OR a recursive/force flag token (the
  // fragmented-rm tell: `$(printf r)$(printf m) -rf /` has no rm token but
  // has -rf) OR a glob metachar. A benign read stays silent.
  it('does NOT floor a read that resolves its target via $(…)', () => {
    expect(asks('cat "$(ls skills/bloom/library)"')).toBe(false);
  });
  it('does NOT floor a skill-style loop read over $(ls …)', () => {
    expect(asks('for f in $(ls "$BLOOM/library"); do cat "$f"; done')).toBe(false);
  });
  it('does NOT floor a compound $VAR read (assignment-only position)', () => {
    expect(asks('BLOOM=infra/skills/bloom; cat "$BLOOM/INDEX.md"')).toBe(false);
  });
  it('floors an rm hidden inside $(…)', () => {
    expect(asks('cat "$(rm x)"')).toBe(true);
  });
  it('floors a fragmented rm carrying -rf (regression: the token scan alone missed it)', () => {
    expect(asks('$(printf r)$(printf m) -rf /')).toBe(true);
    expect(asks('`printf rm` -rf /')).toBe(true);
  });
  it('floors an unresolvable $VAR head carrying -rf on the PARSEABLE path too', () => {
    // `$RM_CMD -rf /` parses (variable expansion is not command substitution)
    // but the executable cannot be known statically — with a recursive/force
    // flag present, ask. The assignment-built variant routes via the
    // unparseable path (assignment-only positions mark unsafe) and is caught
    // by the same flag-token rule there.
    expect(asks('$RM_CMD -rf /')).toBe(true);
    expect(asks('R=r;M=m;$R$M -rf /')).toBe(true);
  });
  it('does NOT floor an unresolvable $VAR head with benign args', () => {
    expect(asks('$RM_CMD --version')).toBe(false);
    expect(asks('R=r;M=m;$R$M --version')).toBe(false);
  });
  it('floors an unparseable command containing a glob (cannot verify what expands)', () => {
    // The arithmetic expansion keeps this unparseable (the analyzer does not read
    // `$(( ))`). A `"$(pwd)"` no longer does (substitutions are read since
    // 2026-09-25), and neither does a bare assignment (since 2026-09-28).
    expect(asks('ls *.md "$((n+1))"')).toBe(true);
  });
  it('does NOT floor an rm-LIKE word (rm.txt / perform) on the unparseable path', () => {
    expect(asks('cat rm.txt "$(pwd)"')).toBe(false);
    expect(asks('echo perform "$(date)"')).toBe(false);
  });
  it('does NOT floor a benign unbalanced quote (no delete token, flag, or glob)', () => {
    expect(asks("echo 'unterminated")).toBe(false);
  });
  it('still floors a delete alongside an unbalanced quote (conservative)', () => {
    expect(asks("rm 'unterminated")).toBe(true);
  });
});

describe('sensitivity floor — flag OFF is byte-identical to the legacy head-only floor', () => {
  afterEach(() => { delete process.env.VESTRA_BASH_AST_GATE; });

  it('legacy still floors a plain rm at the command head', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(asks('rm scratch.txt')).toBe(true);
  });

  it('legacy does NOT floor a backgrounded delete (proves the head-only path is unchanged)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(asks('sleep 1 & rm -rf scratch')).toBe(false);
  });

  it('legacy reads no subshell or substitution (the 2026-09-25 reading is ON-path only)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(asks('(rm -rf scratch)')).toBe(false);
    expect(asks('echo $(rm -rf scratch)')).toBe(false);
    expect(asks('(npx remotion render src/index.ts V out.mp4 > r.log 2>&1; echo EXIT $? >> r.log)')).toBe(false);
  });
});

describe('sensitivity floor — verb-union invariant guard', () => {
  // The flag-ON floor predicate intersects the shared DESTRUCTIVE_SHELL_VERBS
  // union with the rm/rmdir baseline. The `.has()` conjunct is a no-op only while
  // rm/rmdir stay in the union; if a future edit dropped them the floor would
  // silently stop flooring rm/rmdir. Pin the invariant so that fails a test.
  it('keeps rm and rmdir in the shared DESTRUCTIVE_SHELL_VERBS union', () => {
    expect(DESTRUCTIVE_SHELL_VERBS.has('rm')).toBe(true);
    expect(DESTRUCTIVE_SHELL_VERBS.has('rmdir')).toBe(true);
  });
});
