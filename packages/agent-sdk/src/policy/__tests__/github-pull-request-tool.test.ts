/**
 * The pull-request tool in the gate (engineer teammates, Git train G3).
 *
 * Opening a pull request, or commenting on one, follows the person's access level exactly like
 * a push to a feature branch (the git catalog's `external`): it asks at Careful and Balanced and
 * runs at Relaxed and Autopilot. It is never an always-ask (the founder's Relaxed ruling). view
 * and list only read, merge does nothing (the server answers with a sentence), and connect
 * only checks and shows the Connect GitHub card, so none of those four ever asks. The card says what it does in plain words.
 *
 * Fails if a tier moves for any action, the tool stops matching `git push origin feature/x`
 * level for level, or the card loses its plain headline, its details or its button.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { classifySideEffect, decideToolGate, describePermissionAsk, describeToolCall, permissionAskFloor } from '../../index.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessLevel } from '../access-level.js';

const WS = '/app/workspace';
const LEVELS: AccessLevel[] = ['careful', 'balanced', 'relaxed', 'autopilot'];

const pr = (input: Record<string, unknown>): ToolCall => ({ toolName: 'github_pull_request', toolInput: { repository: 'acme/site', ...input }, toolCallId: 't' });
const bash = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });

function gate(call: ToolCall, level: AccessLevel) {
  process.env.ACCESS_LEVELS_V1 = '1';
  return decideToolGate(call, { mode: 'bypassPermissions', cwd: WS, shellCwd: WS, accessLevel: level, permissionRules: { allow: [], ask: [], deny: [] } }).decision;
}

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

const CREATE = pr({ action: 'create', head: 'fix/signup', base: 'main', title: 'Fix the signup form', body: 'Why' });
const COMMENT = pr({ action: 'comment', number: 7, body: 'Ready for a look: the form now validates the email first.' });

describe('tiers', () => {
  it.each([
    ['create', CREATE],
    ['comment', COMMENT],
    ['an unknown action (the safe default)', pr({ action: 'close', number: 7 })],
  ])('%s asks at Careful and Balanced, runs at Relaxed and Autopilot', (_what, call) => {
    expect(classifySideEffect(call, { workspaceRoot: WS })).toBe('external_mutation');
    expect(LEVELS.map((level) => gate(call, level))).toEqual(['needs_human', 'needs_human', 'allow', 'allow']);
  });

  it('opening a pull request is exactly as gated as pushing the branch it comes from', () => {
    const push = bash('git push origin fix/signup');
    expect(LEVELS.map((level) => gate(CREATE, level))).toEqual(LEVELS.map((level) => gate(push, level)));
  });

  it.each([
    ['view', pr({ action: 'view', number: 7 })],
    ['list', pr({ action: 'list', head: 'fix/signup' })],
    ['merge (answered with a sentence, never done)', pr({ action: 'merge', number: 7 })],
    ['connect (a check, and at most the Connect GitHub card)', pr({ action: 'connect' })],
  ])('%s never asks', (_what, call) => {
    expect(classifySideEffect(call, { workspaceRoot: WS })).toBe('readonly');
    expect(LEVELS.map((level) => gate(call, level))).toEqual(['allow', 'allow', 'allow', 'allow']);
  });
});

describe('the card', () => {
  it('a new pull request: what, where, the title, the branches, and the button', () => {
    const ask = describePermissionAsk(CREATE, { family: 'external_mutation', floor: permissionAskFloor('external_mutation', 'balanced'), level: 'balanced' });
    expect(ask.headline).toBe('Open a pull request on github.com/acme/site');
    expect(ask.details).toEqual([
      { label: 'Title', value: 'Fix the signup form' },
      { label: 'Branch', value: 'fix/signup into main' },
    ]);
    expect(ask.actionLabel).toBe('Open pull request');
    expect(ask.reasonLine).toBe('Balanced checks with you before anything leaves your accounts.');
  });

  it('a comment: the words, quoted, and the button', () => {
    const ask = describePermissionAsk(COMMENT, { family: 'external_mutation', floor: 'soft', level: 'careful' });
    expect(ask.headline).toBe('Comment on pull request #7 on github.com/acme/site');
    expect(ask.details).toEqual([{ label: 'Comment', value: '"Ready for a look: the form now validates the email first."', tone: 'quote' }]);
    expect(ask.actionLabel).toBe('Comment');
  });

  it('with no base, the branch row says the default branch; the one-liners read plainly', () => {
    const ask = describePermissionAsk(pr({ action: 'create', head: 'f', title: 't' }), { family: 'external_mutation', floor: 'soft', level: 'careful' });
    expect(ask.details).toContainEqual({ label: 'Branch', value: 'f into the default branch' });
    expect(describeToolCall(pr({ action: 'view', number: 3 }))).toBe('Look at pull request #3 on github.com/acme/site');
    expect(describeToolCall(pr({ action: 'list' }))).toBe('List the open pull requests on github.com/acme/site');
    expect(describeToolCall(pr({ action: 'connect' }))).toBe('Ask to connect GitHub for github.com/acme/site');
  });
});
