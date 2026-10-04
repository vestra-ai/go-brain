/**
 * The box's GitHub credential is never the agent's (engineer teammates, Git train G2).
 *
 * The box's git gets a one-hour, one-repo token through vestra-git-credential while GITHUB_APP_V1
 * is on. Then every way a command could hand that token to the agent is REFUSED by the security
 * gate, at every access level, under bypassPermissions and past an allow rule: never asked. The
 * near misses below are ordinary git and shell work that must keep its usual verdict.
 *
 * Dark means no change: with the flag off there is no token to take, and a person may be pushing
 * with their own (`credential.helper store` and a token they gave the agent). Every row then keeps
 * its pre-G2 verdict.
 *
 * Fails if, with the flag on, any row stops being refused or any near miss starts being refused;
 * or if, with it off, any row is refused or the two pinned rows leave their earlier verdicts.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { decideToolGate } from '../../index.js';
import { gitCredentialExtraction } from '../git-command-catalog.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessLevel } from '../access-level.js';

const WS = '/app/workspace';
const LEVELS: AccessLevel[] = ['careful', 'balanced', 'relaxed', 'autopilot'];
const bash = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });

function gate(command: string, level: AccessLevel, extra: Partial<ToolGateContext> = {}) {
  process.env.ACCESS_LEVELS_V1 = '1';
  return decideToolGate(bash(command), {
    mode: 'bypassPermissions',
    cwd: WS,
    shellCwd: WS,
    accessLevel: level,
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  });
}

beforeEach(() => { process.env.GITHUB_APP_V1 = 'true'; });
afterEach(() => { delete process.env.ACCESS_LEVELS_V1; delete process.env.GITHUB_APP_V1; });

const REFUSED: Array<[string, string]> = [
  // git asking for, storing or forgetting a credential
  ['git credential fill', 'the plumbing that prints the token'],
  ['printf "protocol=https\\nhost=github.com\\npath=acme/site.git\\n\\n" | git credential fill', 'fed its request on stdin'],
  ['git credential approve', 'approve'],
  ['git credential reject', 'reject'],
  ['git credential capability', 'any credential subcommand'],
  ['git -C /app/workspace/files/apps/site credential fill', 'behind git -C'],
  ['git --no-pager credential fill', 'behind a global flag'],
  ['"git" credential fill', 'a quoted head is still git'],
  ['git credential-store get', 'a stock helper by its git name'],
  ['git credential-cache get', 'the cache helper'],
  ['/usr/lib/git-core/git-credential-store get', 'a helper program run directly'],
  ['$G credential fill', 'a command word we cannot name reads as git'],
  // the helper itself
  ['vestra-git-credential get', 'by name'],
  ['/usr/local/bin/vestra-git-credential get', 'by path'],
  ['"/usr/local/bin/vestra-git-credential" get', 'quoted path'],
  ['echo "protocol=https" | /usr/local/bin/vestra-git-credential get', 'fed on stdin'],
  ['env GITHUB_APP_V1=true vestra-git-credential get', 'behind env'],
  ['sudo vestra-git-credential get', 'behind sudo'],
  ['bash /usr/local/bin/vestra-git-credential get', 'as the script a shell runs'],
  ['node /usr/local/bin/vestra-git-credential get', 'as the script node runs'],
  ['python3 /usr/local/bin/vestra-git-credential get', 'as the script python runs'],
  ['sh -c "vestra-git-credential get"', 'inside sh -c'],
  // inside code the command builds or feeds a shell
  ["bash -c 'git credential fill'", 'inside bash -c'],
  ['x=$(git credential fill); echo "$x"', 'inside a substitution'],
  ["eval 'git credential fill'", 'inside eval'],
  ['echo "git credential fill" | sh', 'code a shell reads from stdin'],
  ['bash <<EOF\ngit credential fill\nEOF', 'a here-document fed to a shell'],
  ['cat <<EOF | sh\nvestra-git-credential get\nEOF', 'a here-document piped into a shell'],
  ['eval "$(echo git credential fill)"', 'text the analyzer cannot enumerate, naming credential access'],
  // a helper of the agent's own, for one command or from the environment
  ['git -c credential.helper= push origin feature/x', 'the helper list reset for one command'],
  ["git -c credential.helper='!f() { cat; }; f' push origin feature/x", 'a shell helper that would be handed the token'],
  ['git -c Credential.Helper=store fetch', 'keys are case-insensitive'],
  ['git -c credential.https://github.com.helper=/tmp/h push', 'the URL-scoped helper key'],
  ['git --config-env=credential.helper=H push', '--config-env'],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=/tmp/h git push', 'the same through git config env vars'],
  ['export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=/tmp/h', 'exported for later commands'],
  // git config naming the credential section
  ['git config --get credential.https://github.com.helper', 'a read of the helper'],
  ['git config --get-all credential.helper', '--get-all'],
  ['git config get credential.helper', 'the new-style read'],
  ['git config --get-regexp credential', 'a name pattern for the section'],
  ['git config --get-urlmatch credential.helper https://github.com', '--get-urlmatch'],
  ['git config --global credential.helper "!f() { cat > /tmp/t; }; f"', 'a helper of its own, kept'],
  ['git config --global --add credential.helper store', '--add'],
  ['git config --local credential.helper store', 'any scope (this one asked before G2)'],
  ['git config --system --unset credential.https://github.com.helper', 'unsetting ours'],
  ['git config --remove-section credential', 'the whole section'],
  ['git config set credential.useHttpPath false', 'the new-style write'],
];

const NEAR_MISSES: Array<[string, string]> = [
  ['git push origin feature/x', 'a push uses the helper; it never sees the token'],
  ['git clone https://github.com/acme/site.git', 'a clone'],
  ['git fetch origin', 'a fetch'],
  ['git commit -m "fix the credential form"', 'the word in a message'],
  ["bash -c \"git commit -m 'update credential docs'\"", 'the word in a message inside bash -c'],
  ['git log --grep credential', 'the word as a search'],
  ['git config --global user.email me@example.com', 'another key'],
  ['git config --get user.name', 'another read'],
  ['git config --list', 'a listing shows only the helper path, which is public'],
  ['git -c user.name=x commit -m y', 'another -c'],
  ['git credentials', 'not a git subcommand'],
  ['cat /usr/local/bin/vestra-git-credential', 'reading the script is not running it'],
  ['ls -l /usr/local/bin/vestra-git-credential', 'listing it'],
  ['grep -n helper /etc/gitconfig', 'reading the system config file'],
  ['cat > notes.md <<EOF\ngit credential fill is refused here\nEOF', 'a here-document written to a file is data'],
  ['npm run credential-check', 'another program'],
];

describe('refused outright: the security gate, at every level', () => {
  it.each(REFUSED)('%s (%s)', (command) => {
    expect(gitCredentialExtraction(command)).not.toBeNull();
    for (const level of LEVELS) {
      const r = gate(command, level);
      expect(r.decision, `${level}: ${command}`).toBe('deny');
      expect((r as { reasonType?: string }).reasonType).toBe('security');
    }
  });

  it('an allow rule changes nothing', () => {
    const r = gate('git credential fill', 'autopilot', { permissionRules: { allow: [{ toolName: 'Bash', ruleContent: 'git credential *' }, { toolName: 'Bash' }], ask: [], deny: [] } });
    expect(r.decision).toBe('deny');
  });

  it("the refusal says what it refused, in plain words", () => {
    const r = gate('git credential fill', 'relaxed') as { message?: string };
    expect(r.message).toContain('Asking git for a stored credential');
    expect(gitCredentialExtraction('vestra-git-credential get')).toBe("Running the box's GitHub credential helper");
    expect(gitCredentialExtraction('git -c credential.helper=x push')).toBe('Setting a git credential helper for one command');
    expect(gitCredentialExtraction('git config --get credential.helper')).toBe("Reading or changing git's credential settings");
  });
});

describe('near misses keep their usual verdict', () => {
  it.each(NEAR_MISSES)('%s (%s)', (command) => {
    expect(gitCredentialExtraction(command)).toBeNull();
    for (const level of LEVELS) {
      const r = gate(command, level) as { decision: string; reasonType?: string };
      expect(r.decision === 'deny' && r.reasonType === 'security', `${level}: ${command}`).toBe(false);
    }
  });
});

describe('dark (GITHUB_APP_V1 off): every row keeps its pre-G2 verdict', () => {
  beforeEach(() => { process.env.GITHUB_APP_V1 = 'false'; });

  it.each(REFUSED)('%s is never refused by this rule (%s)', (command) => {
    for (const level of LEVELS) {
      const r = gate(command, level) as { decision: string; message?: string };
      expect(r.decision === 'deny' && /credential/i.test(r.message ?? ''), `${level}: ${command}`).toBe(false);
    }
  });

  it.each(['1', '', 'TRUE', 'yes'])("only the exact 'true' arms it (%j does not)", (value) => {
    process.env.GITHUB_APP_V1 = value;
    expect(gate('git credential fill', 'autopilot').decision).not.toBe('deny');
  });

  it('a helper of the person\'s own (`credential.helper store`) asks at every level, as it did before', () => {
    for (const level of LEVELS) expect(gate('git config --global credential.helper store', level).decision, level).toBe('needs_human');
  });

  it('`git credential fill` keeps the verdict it had: it asks only at Careful', () => {
    expect(LEVELS.map((level) => gate('git credential fill', level).decision)).toEqual(['needs_human', 'allow', 'allow', 'allow']);
  });
});
