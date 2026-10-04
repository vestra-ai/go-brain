/**
 * The forward-resume breadcrumb is worded by what the person did. Live 28edef30
 * (2026-09-28): a stale APPROVAL card wrote "The connection for the earlier Bash request
 * is now available", a sentence written for composio_auth.
 */
import { describe, it, expect } from 'vitest';
import { forwardResumeBreadcrumbText, type ResolvedPause } from '../resume-breadcrumb.js';

const allow = { behavior: 'allow' } as const;
const declined = { behavior: 'deny', reason: 'user_declined' } as const;
const pause = (kind: ResolvedPause['kind'], toolName: string, outcome: ResolvedPause['outcome'] = allow): ResolvedPause =>
  ({ kind, toolName, outcome });

describe('forwardResumeBreadcrumbText', () => {
  it('an approved tool_permission says the PERSON approved it, not that a connection arrived', () => {
    const text = forwardResumeBreadcrumbText([pause('tool_permission', 'Bash')]);
    expect(text).toBe(
      '[System] The person approved the earlier Bash step. Continue that request, taking into account everything discussed since.',
    );
    // A user-role slot: "You approved" could read as the model approving its own step.
    expect(text).not.toContain('You approved');
  });

  it('composio_auth keeps the historic sentence byte for byte', () => {
    expect(forwardResumeBreadcrumbText([pause('composio_auth', 'GMAIL_SEND_EMAIL')])).toBe(
      '[System] The connection for the earlier GMAIL_SEND_EMAIL request is now available. ' +
        'Continue that request, taking into account everything discussed since.',
    );
  });

  it('an answered question says the answer is NOT here (the deferred slot drops it), and to ask again', () => {
    expect(forwardResumeBreadcrumbText([pause('ask_question', 'AskUserQuestion', { behavior: 'allow', updatedInput: { answers: { q: 'blue' } } })])).toBe(
      '[System] The person answered the earlier AskUserQuestion question after you had moved on; ' +
        'that answer is not in this conversation. If you still need it, ask again.',
    );
  });

  it('any other answered kind is just as honest about the missing answer', () => {
    const text = forwardResumeBreadcrumbText([pause('exit_plan', 'ExitPlanMode')]);
    expect(text).toContain('The person answered the earlier ExitPlanMode request after you had moved on');
    expect(text).toContain('that answer is not in this conversation');
    expect(text).not.toContain('Continue that request');
  });

  it('a declined card never tells the model to continue the refused step', () => {
    const text = forwardResumeBreadcrumbText([pause('tool_permission', 'Bash', declined)]);
    expect(text).toBe(
      '[System] The earlier Bash request was declined, so do not run it. Carry on, taking into account everything discussed since.',
    );
    expect(text).not.toContain('approved');
    expect(text).not.toContain('Continue that request');
  });

  it('one combined entry names every resolved tool, one sentence per kind', () => {
    const text = forwardResumeBreadcrumbText([
      pause('tool_permission', 'Bash'),
      pause('composio_auth', 'GMAIL_SEND_EMAIL'),
      pause('tool_permission', 'Write'),
    ]);
    expect(text).toBe(
      '[System] The person approved the earlier Bash, Write step. ' +
        'The connection for the earlier GMAIL_SEND_EMAIL request is now available. ' +
        'Continue that request, taking into account everything discussed since.',
    );
  });

  it('is model-facing copy: no em dashes, never "Claude"', () => {
    for (const p of [pause('tool_permission', 'Bash'), pause('composio_auth', 'X'), pause('custom', 'Y'), pause('exit_plan', 'Z', declined)]) {
      const text = forwardResumeBreadcrumbText([p]);
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/claude/i);
    }
  });
});
