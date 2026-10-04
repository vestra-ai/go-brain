import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decideToolGate, sensitivityFloorAsks } from '../../index.js';

// The S1 capstone: an END-TO-END property test over the PUBLIC policy surface
// (`sensitivityFloorAsks`, `decideToolGate`), proving the locked P0 promise holds
// once — every KNOWN bypass CLASS routes a DANGEROUS delete to ask/block, benign
// controls are admitted, and an unparseable write is blocked in plan mode.
// Exercises the default-ON Bash AST gate (VESTRA_BASH_AST_GATE unset → on); env
// is left untouched so this asserts the PRODUCTION posture.
//
// THE LOCKED PROMISE (rm narrowing — founder ruling 2026-07-06, coordinator-
// ratified corpus upgrade): a DANGEROUS delete (recursive/force flag, glob, or
// escaping the workspace root) reachable through ANY shell position still asks
// or blocks; a safe in-workspace specific-file delete is admitted everywhere.
// The catastrophic BLOCK layer (security-gate.ts / security-patterns.ts) is
// unchanged and blocks `rm -rf /` etc. regardless.
//
// Each position fixture carries a DANGEROUS-shaped delete (`rm -rf scratch/` —
// recursive flag, still a non-catastrophic scratch target) so position coverage
// keeps proving the dangerous case asks in every position the legacy head-only
// scan missed. The previously-fixtured SAFE shape (`rm scratch.txt`) moved to
// the BENIGN controls: admitting it IS the ruling — the corpus documents BOTH
// sides of the dial.

const BYPASS: Record<string, string> = {
  'background operator':        'sleep 1 & rm -rf scratch/',
  'process substitution':       'cat <(rm -rf scratch/)',
  'path-prefixed executable':   '/bin/rm -rf scratch/',
  'wrapper invocation':         'xargs rm < list.txt',
  'sh -c string body':          `sh -c "rm -rf scratch/"`,
  'unparseable (nested subst)': 'rm $(cat $(echo x))',
};

// Benign controls the floor must ADMIT (false): two pure reads, a heredoc whose
// body merely DOCUMENTS an rm as prose (stripped before analysis → never floors),
// and the founder-ruled safe delete (plain, relative, flagless, specific file).
const BENIGN = ['ls -la', 'grep -r foo .', "cat <<'EOF'\nrm docs mention\nEOF", 'rm scratch.txt'];

// The founder's real-world silent case (Bloom's cleanup): absolute targets that
// resolve UNDER the workspace root, a stderr redirect, and a trailing echo. The
// under-root judgment needs the root, so this control threads the workspaceRoot
// exactly as the native gate does (decideToolGate forwards ctx.cwd).
const BENIGN_IN_WORKSPACE =
  'rm /app/workspace/files/a.png /app/workspace/files/b.png 2>/dev/null; echo ok';

const asks = (command: string) =>
  sensitivityFloorAsks({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });

// SECURITY_PATTERNS_V2 (S5b) swaps seven security regexes for catalogs; the promise holds
// in both states, through the floor alone and through the whole gate.
for (const v2 of [false, true]) describe(`P0 bypass corpus — the locked promise (SECURITY_PATTERNS_V2 ${v2 ? 'on' : 'off'})`, () => {
  beforeEach(() => { if (v2) process.env.SECURITY_PATTERNS_V2 = 'true'; else delete process.env.SECURITY_PATTERNS_V2; });
  afterEach(() => { delete process.env.SECURITY_PATTERNS_V2; });
  const gate = (command: string) =>
    decideToolGate(
      { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
      { mode: 'default', cwd: '/app/workspace', shellCwd: '/app/workspace', permissionRules: { allow: [], ask: [], deny: [] } },
    ).decision;

  for (const [name, cmd] of Object.entries(BYPASS)) {
    it(`the gate never runs the bypass class silently: ${name}`, () => {
      expect(gate(cmd)).not.toBe('allow');
    });
  }

  it('a path-prefixed recursive delete of a scratch folder still ASKS (it is no catalog member)', () => {
    expect(gate('/bin/rm -rf scratch/')).toBe('needs_human');
  });

  for (const [name, cmd] of Object.entries(BYPASS)) {
    it(`asks/blocks the bypass class: ${name}`, () => {
      expect(asks(cmd)).toBe(true);
    });
  }

  for (const cmd of BENIGN) {
    it(`admits the benign control: ${cmd.slice(0, 20)}`, () => {
      expect(asks(cmd)).toBe(false);
    });
  }

  it('admits the benign control: workspace-absolute compound delete (with root threaded)', () => {
    expect(
      sensitivityFloorAsks(
        { toolName: 'Bash', toolInput: { command: BENIGN_IN_WORKSPACE }, toolCallId: 't' },
        { workspaceRoot: '/app/workspace' },
      ),
    ).toBe(false);
    // Without the root the same command ASKS (absolute targets cannot be
    // vouched for) — the admission depends on the threading, not on a loophole.
    expect(asks(BENIGN_IN_WORKSPACE)).toBe(true);
  });

  it('plan-mode blocks an unparseable write', () => {
    const r = decideToolGate(
      { toolName: 'Bash', toolInput: { command: 'rm $(cat $(echo x))' }, toolCallId: 't' },
      { mode: 'plan', permissionRules: { allow: [], ask: [], deny: [] } },
    );
    expect(r.decision).toBe('deny');
  });
});
