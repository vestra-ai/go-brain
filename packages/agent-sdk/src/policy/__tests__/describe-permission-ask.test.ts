import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { describePermissionAsk, permissionAskFloor } from '../describe-tool.js';
import type { PermissionAsk } from '../describe-tool.js';

const call = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't1',
});

const REASON = {
  payment:
    'Payments always need your OK. On every level, including Autopilot. Money never moves without you.',
  delete: 'Deletions always check with you. Only Autopilot runs them alone.',
  softBalanced: 'Balanced checks with you before anything leaves your accounts.',
  softCareful: 'Careful checks with you before anything changes.',
  rule: 'You asked me to check before this.',
} as const;

// ── permissionAskFloor — which floor a family/level lands on ─────────────────
describe('permissionAskFloor', () => {
  it('payment is always a hard floor, at every level', () => {
    expect(permissionAskFloor('payment', 'autopilot')).toBe('hard');
    expect(permissionAskFloor('payment', 'relaxed')).toBe('hard');
    expect(permissionAskFloor('payment', undefined)).toBe('hard');
  });

  it('a dangerous delete is a hard floor below Autopilot (and when flag-off)', () => {
    expect(permissionAskFloor('dangerous_delete', 'relaxed')).toBe('hard');
    expect(permissionAskFloor('dangerous_delete', 'balanced')).toBe('hard');
    expect(permissionAskFloor('dangerous_delete', undefined)).toBe('hard');
  });

  it('a soft level ask when the level asks about that family', () => {
    expect(permissionAskFloor('external_send', 'balanced')).toBe('soft');
    expect(permissionAskFloor('external_mutation', 'balanced')).toBe('soft');
    expect(permissionAskFloor('workspace_write', 'careful')).toBe('soft');
  });

  it('falls back to a rule floor when neither hard nor a level ask fired', () => {
    // A send at Relaxed runs (no level ask), so a prompt here came from a rule.
    expect(permissionAskFloor('external_send', 'relaxed')).toBe('rule');
    expect(permissionAskFloor('workspace_write', 'balanced')).toBe('rule');
    // Flag-off (no level) send does not floor — a prompt is a rule ask.
    expect(permissionAskFloor('external_send', undefined)).toBe('rule');
  });
});

// ── describePermissionAsk — the rich card producer ───────────────────────────
describe('describePermissionAsk — Gmail send (soft, Balanced)', () => {
  const ask = describePermissionAsk(
    call('mcp__composio__GMAIL_SEND_EMAIL', {
      recipient_email: 'keshav.led@gmail.com',
      subject: 'Balanced mode drill',
      body: 'Hey! This is a quick test of the new permission system.',
    }),
    { family: 'external_send', floor: 'soft', level: 'balanced' },
  );

  it('leads with the verb + app headline', () => {
    expect(ask.headline).toBe('Send an email from your Gmail');
  });

  it('extracts To / Subject / Message rows from the real args', () => {
    expect(ask.details).toEqual([
      { label: 'To', value: 'keshav.led@gmail.com' },
      { label: 'Subject', value: 'Balanced mode drill' },
      {
        label: 'Message',
        value: '"Hey! This is a quick test of the new permission system."',
        tone: 'quote',
      },
    ]);
  });

  it('names the action on the primary button', () => {
    expect(ask.actionLabel).toBe('Send email');
  });

  it('names the dial on the why-line', () => {
    expect(ask.reasonLine).toBe(REASON.softBalanced);
  });
});

describe('describePermissionAsk — Gmail send, message preview truncation', () => {
  it('caps the body preview and marks the truncation with an ellipsis', () => {
    const long = 'A'.repeat(200);
    const ask = describePermissionAsk(
      call('mcp__composio__GMAIL_SEND_EMAIL', { to: 'a@b.com', subject: 'S', body: long }),
      { family: 'external_send', floor: 'soft', level: 'balanced' },
    );
    const msg = ask.details.find((d) => d.label === 'Message');
    expect(msg).toBeDefined();
    // Opening quote + <=90 body chars + ellipsis + closing quote.
    expect(msg!.value.startsWith('"AAAA')).toBe(true);
    expect(msg!.value.endsWith('…"')).toBe(true);
    expect(msg!.value.length).toBeLessThanOrEqual(93);
  });
});

describe('describePermissionAsk — Gmail permanent delete (hard)', () => {
  it('renders a counted headline, quoted subject, sender, and a red irreversibility note', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__GMAIL_DELETE_MESSAGE', {
        message_id: '18f2a',
        subject: 'How Cursor deploys AI inside the enterprise',
        sender: 'AINews (swyx+ainews@substack.com)',
      }),
      { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' },
    );
    expect(ask.headline).toBe('Permanently delete 1 email from your Gmail');
    expect(ask.details).toEqual([
      {
        label: 'Email',
        value: '"How Cursor deploys AI inside the enterprise"',
        tone: 'quote',
      },
      { label: 'From', value: 'AINews (swyx+ainews@substack.com)' },
      { label: 'Note', value: 'Skips the Trash. This cannot be undone.', tone: 'danger' },
    ]);
    expect(ask.actionLabel).toBe('Delete 1 email');
    expect(ask.reasonLine).toBe(REASON.delete);
  });

  it('omits missing rows and still shows the note (delete by id only)', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__GMAIL_DELETE_MESSAGE', { message_id: '18f2a' }),
      { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' },
    );
    expect(ask.details).toEqual([
      { label: 'Note', value: 'Skips the Trash. This cannot be undone.', tone: 'danger' },
    ]);
    expect(ask.actionLabel).toBe('Delete 1 email');
  });
});

describe('describePermissionAsk — Stripe charge (payment)', () => {
  it('formats the amount, names the customer/description, and puts the amount on the button', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__STRIPE_CREATE_CHARGE', {
        amount: 50000,
        currency: 'usd',
        customer: 'cus_9x2AbC',
        description: 'Vestra Pro, annual plan',
      }),
      { family: 'payment', floor: 'hard' },
    );
    expect(ask.headline).toBe('Charge a customer $500.00 through Stripe');
    expect(ask.details).toEqual([
      { label: 'Amount', value: '$500.00 USD' },
      { label: 'Customer', value: 'cus_9x2AbC' },
      { label: 'For', value: '"Vestra Pro, annual plan"', tone: 'quote' },
    ]);
    expect(ask.actionLabel).toBe('Pay $500.00');
    expect(ask.reasonLine).toBe(REASON.payment);
  });

  it('never fabricates an amount: missing amount falls back to Approve payment', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__STRIPE_CREATE_CHARGE', { customer: 'cus_1', description: 'x' }),
      { family: 'payment', floor: 'hard' },
    );
    expect(ask.headline).toBe('Charge a customer through Stripe');
    expect(ask.actionLabel).toBe('Approve payment');
    expect(ask.details.find((d) => d.label === 'Amount')).toBeUndefined();
  });
});

describe('describePermissionAsk — Notion update (external mutation)', () => {
  it('names the action verb from the slug on the button', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__NOTION_UPDATE_PAGE', { page_id: 'p1', title: 'Roadmap' }),
      { family: 'external_mutation', floor: 'soft', level: 'balanced' },
    );
    expect(ask.headline).toBe('Update page on Notion');
    expect(ask.actionLabel).toBe('Update page');
    expect(ask.reasonLine).toBe(REASON.softBalanced);
  });
});

describe('describePermissionAsk — MULTI_EXECUTE laundered send', () => {
  it('unwraps the inner tool args and renders it as the equivalent direct send', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [
          {
            tool_slug: 'GMAIL_SEND_EMAIL',
            arguments: { to: 'a@b.com', subject: 'Hi', body: 'Hello there' },
          },
        ],
      }),
      { family: 'external_send', floor: 'soft', level: 'balanced' },
    );
    expect(ask.headline).toBe('Send an email from your Gmail');
    expect(ask.actionLabel).toBe('Send email');
    expect(ask.details).toEqual([
      { label: 'To', value: 'a@b.com' },
      { label: 'Subject', value: 'Hi' },
      { label: 'Message', value: '"Hello there"', tone: 'quote' },
    ]);
  });
});

describe('describePermissionAsk — workbench (opaque code executor)', () => {
  it('proxied send: generic-by-family copy without inventing the slug', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__COMPOSIO_REMOTE_WORKBENCH', {
        code_to_execute: 'run_composio_tool("GMAIL_SEND_EMAIL", {...})',
      }),
      { family: 'external_send', floor: 'soft', level: 'balanced' },
    );
    expect(ask.headline).toBe('Send a message');
    expect(ask.actionLabel).toBe('Send message');
    expect(ask.details).toEqual([]);
  });

  it('opaque (fail-closed to payment): generic payment copy', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__COMPOSIO_REMOTE_WORKBENCH', {
        code_to_execute: 'do_something_dynamic()',
      }),
      { family: 'payment', floor: 'hard' },
    );
    expect(ask.headline).toBe('Approve a payment');
    expect(ask.actionLabel).toBe('Approve payment');
    expect(ask.details).toEqual([]);
    expect(ask.reasonLine).toBe(REASON.payment);
  });
});

describe('describePermissionAsk — reason lines by floor', () => {
  it('a workspace write at Careful reads the change-framed soft line', () => {
    const ask = describePermissionAsk(call('Write', { file_path: '/app/report.md' }), {
      family: 'workspace_write',
      floor: 'soft',
      level: 'careful',
    });
    expect(ask.reasonLine).toBe(REASON.softCareful);
  });

  it('a rule-floor ask reads the you-asked-me line', () => {
    const ask = describePermissionAsk(call('Bash', { command: 'git push' }), {
      family: 'workspace_write',
      floor: 'rule',
    });
    expect(ask.reasonLine).toBe(REASON.rule);
  });
});

describe('describePermissionAsk — generic fallback', () => {
  it('an unknown family/tool falls back to the neutral Allow once button', () => {
    const ask = describePermissionAsk(call('Bash', { command: 'ls' }), {
      family: 'readonly',
      floor: 'rule',
    });
    expect(ask.actionLabel).toBe('Allow once');
    expect(ask.details).toEqual([]);
  });

  it('never throws on a malformed call', () => {
    const ask = describePermissionAsk(
      { toolName: undefined as unknown as string, toolInput: null, toolCallId: '' },
      { family: 'workspace_write', floor: 'rule' },
    );
    expect(typeof ask.headline).toBe('string');
    expect(ask.actionLabel).toBe('Allow once');
    expect(Array.isArray(ask.details)).toBe(true);
  });
});

// ── copy-rule conformance sweep ──────────────────────────────────────────────
describe('describePermissionAsk — copy rules', () => {
  const samples: Array<{ call: ToolCall; ctx: Parameters<typeof describePermissionAsk>[1] }> = [
    {
      call: call('mcp__composio__GMAIL_SEND_EMAIL', {
        to: 'a@b.com',
        subject: 'Weekly — status update',
        body: 'x'.repeat(300),
      }),
      ctx: { family: 'external_send', floor: 'soft', level: 'balanced' },
    },
    {
      call: call('mcp__composio__GMAIL_DELETE_MESSAGE', { message_id: 'm1' }),
      ctx: { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' },
    },
    {
      call: call('mcp__composio__STRIPE_CREATE_CHARGE', { amount: 12345, currency: 'usd' }),
      ctx: { family: 'payment', floor: 'hard' },
    },
    {
      call: call('mcp__composio__NOTION_UPDATE_PAGE', { page_id: 'p' }),
      ctx: { family: 'external_mutation', floor: 'soft', level: 'careful' },
    },
    {
      call: call('Bash', { command: 'rm -rf build' }),
      ctx: { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' },
    },
  ];

  // The copy rules govern PRODUCER-AUTHORED strings (headline, button, why-line,
  // row labels). Row VALUES are pass-through user content (a real email subject,
  // a description) and must NOT be sanitized — see the pass-through test below.
  const authored = (ask: PermissionAsk): string[] => [
    ask.headline,
    ask.actionLabel,
    ask.reasonLine,
    ...ask.details.map((d) => d.label),
  ];

  it('never emits an em dash, never the word "Claude", headline <= 80 chars', () => {
    for (const s of samples) {
      const ask = describePermissionAsk(s.call, s.ctx);
      expect(ask.headline.length).toBeLessThanOrEqual(80);
      for (const str of authored(ask)) {
        expect(str.includes('—')).toBe(false);
        expect(/claude/i.test(str)).toBe(false);
      }
    }
  });

  it('passes user content through faithfully (does not scrub the real subject)', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__GMAIL_SEND_EMAIL', { to: 'a@b.com', subject: 'Weekly — status update', body: 'hi' }),
      { family: 'external_send', floor: 'soft', level: 'balanced' },
    );
    expect(ask.details.find((d) => d.label === 'Subject')?.value).toBe('Weekly — status update');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 'unknown' — the family for a call the gate CANNOT READ (prod 2026-09-20, task
// 46f85398). Before it existed, unreadable fell back to 'payment', the one
// family that hard-asks everywhere, so a Notion write reached the person as
// "Approve a payment" with "Money never moves without you" under it. Unreadable
// keeps the payment-strength floor and loses the payment WORDS: the card says
// what is actually true, that Bash cannot tell what the step does.
// ─────────────────────────────────────────────────────────────────────────────
describe("the unreadable family", () => {
  it('is a hard floor at every level, exactly like payment', () => {
    for (const level of ['careful', 'balanced', 'relaxed', 'autopilot'] as const) {
      expect(permissionAskFloor('unknown', level)).toBe('hard');
    }
  });

  it('never says payment, or money: it says the gate cannot read the call', () => {
    const ask = describePermissionAsk(
      call('mcp__composio__COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: 'run_composio_tool(slug_from_a_variable, {})' }),
      { family: 'unknown', floor: 'hard', level: 'balanced' },
    );
    expect(`${ask.headline} ${ask.reasonLine} ${ask.actionLabel}`).not.toMatch(/payment|money|charge/i);
    expect(ask.headline).toMatch(/can.?t tell|cannot tell/i);
    expect(ask.reasonLine).toMatch(/read/i);
  });

  it('a real payment still says payment (the words are not lost, only moved off unreadable)', () => {
    const ask = describePermissionAsk(call('mcp__composio__STRIPE_CREATE_CHARGE', {}), {
      family: 'payment', floor: 'hard', level: 'balanced',
    });
    expect(ask.reasonLine).toBe(REASON.payment);
  });
});

// ── L16 D5: a company's client tool asks only on a company rule ──────────────
describe('describePermissionAsk: a company client tool', () => {
  it('names the tool plainly and gives the rule reason, never a level line', () => {
    const c = call('lookup_pnr', { pnr: 'ABC123' });
    for (const floor of ['soft', 'rule'] as const) {
      const ask = describePermissionAsk(c, { family: 'workspace_write', floor, level: 'careful', clientTool: true });
      expect(ask).toEqual({ headline: 'Use the tool lookup_pnr', details: [], actionLabel: 'Allow once', reasonLine: REASON.rule });
      expect(JSON.stringify(ask)).not.toMatch(/[–—]|Claude|workspace|Careful/);
    }
  });

  it('a person\'s tool of the same name keeps today\'s card', () => {
    const ask = describePermissionAsk(call('lookup_pnr'), { family: 'workspace_write', floor: 'soft', level: 'careful' });
    expect(ask).toEqual({ headline: 'Use lookup_pnr', details: [], actionLabel: 'Allow once', reasonLine: REASON.softCareful });
  });
});
