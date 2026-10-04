import { describe, it, expect } from 'vitest';
import {
  resolveAccountSelection,
  describeAccountRoster,
  type AccountRoster,
} from '../composio-account-selection.js';
import type { ToolCall } from '../../contract/harness.js';

const MULTI = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const call = (toolInput: unknown, toolName = MULTI): ToolCall =>
  ({ toolName, toolInput, toolCallId: 'tc_1' } as ToolCall);

const twoGmail: AccountRoster = new Map([
  ['gmail', [
    { id: 'ca_work', alias: 'work', status: 'active' },
    { id: 'ca_personal', alias: 'personal', status: 'active' },
  ]],
  ['slack', [{ id: 'ca_s', alias: null, status: 'active' }]],
  ['notion', [{ id: 'ca_n', alias: null, status: 'expired' }]],
]);

describe('resolveAccountSelection', () => {
  it('no roster (legacy mode) → pass', () => {
    expect(resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }), undefined))
      .toEqual({ kind: 'pass' });
  });

  it('non-multi-execute tools → pass, roster or not', () => {
    expect(resolveAccountSelection(call({}, 'mcp__composio__COMPOSIO_SEARCH_TOOLS'), twoGmail))
      .toEqual({ kind: 'pass' });
    expect(resolveAccountSelection(call({}, 'Bash'), twoGmail)).toEqual({ kind: 'pass' });
  });

  it('single-account toolkit: fills account id into the item, without mutating the original', () => {
    const input = { tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hi' } }] };
    const verdict = resolveAccountSelection(call(input), twoGmail);
    expect(verdict.kind).toBe('fill');
    const updated = (verdict as unknown as { updatedInput: { tools: Array<Record<string, unknown>> } })
      .updatedInput;
    expect(updated.tools[0].account).toBe('ca_s');
    expect(updated.tools[0].arguments).toEqual({ text: 'hi' });
    expect((input.tools[0] as Record<string, unknown>).account).toBeUndefined(); // no mutation
  });

  it('multi-account toolkit without account → block naming both accounts', () => {
    const verdict = resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }), twoGmail);
    expect(verdict.kind).toBe('block');
    const message = (verdict as { message: string }).message;
    expect(message).toContain('"work" (ca_work)');
    expect(message).toContain('"personal" (ca_personal)');
    expect(message).toContain('account');
    // A lookup looks in each account before anything is asked: the connected_accounts layer's rule
    // (apps/sandbox connected-accounts-affordance.ts) and the composer's, in the gate's words.
    const lookup = 'To look something up, add one item per account and go with the one that finds it. ';
    expect(message).toContain(lookup);
    expect(message.indexOf(lookup)).toBeLessThan(message.indexOf('If it is genuinely unclear'));
  });

  it('multi-account toolkit with a valid id or alias → pass unchanged', () => {
    expect(resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'ca_work' }] }), twoGmail))
      .toEqual({ kind: 'pass' });
    expect(resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: ' Personal ' }] }), twoGmail))
      .toEqual({ kind: 'pass' }); // alias match is trimmed + case-insensitive
  });

  it('unknown account value → block naming the value and the roster', () => {
    const verdict = resolveAccountSelection(
      call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'school' }] }), twoGmail);
    expect(verdict.kind).toBe('block');
    expect((verdict as { message: string }).message).toContain('school');
    expect((verdict as { message: string }).message).toContain('"work" (ca_work)');
  });

  it('unconnected / zero-active toolkits → pass (auth gate + router backstop own those)', () => {
    expect(resolveAccountSelection(call({ tools: [{ tool_slug: 'NOTION_CREATE_PAGE' }] }), twoGmail))
      .toEqual({ kind: 'pass' });
    expect(resolveAccountSelection(call({ tools: [{ tool_slug: 'LINEAR_CREATE_ISSUE' }] }), twoGmail))
      .toEqual({ kind: 'pass' });
  });

  it('mixed items: one block anywhere wins over fills elsewhere', () => {
    const verdict = resolveAccountSelection(call({ tools: [
      { tool_slug: 'SLACK_SEND_MESSAGE' },
      { tool_slug: 'GMAIL_SEND_EMAIL' },
    ] }), twoGmail);
    expect(verdict.kind).toBe('block');
  });

  it('single-account item that ALREADY carries any account value → untouched (no fill)', () => {
    expect(resolveAccountSelection(
      call({ tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', account: 'ca_s' }] }), twoGmail))
      .toEqual({ kind: 'pass' });
  });

  it('unreadable payloads are total-pass, never a throw', () => {
    expect(resolveAccountSelection(call(undefined), twoGmail)).toEqual({ kind: 'pass' });
    expect(resolveAccountSelection(call({ tools: 'nope' }), twoGmail)).toEqual({ kind: 'pass' });
    expect(resolveAccountSelection(call({ tools: [42] }), twoGmail)).toEqual({ kind: 'pass' });
    const stringItem = resolveAccountSelection(call({ tools: ['GMAIL_SEND_EMAIL'] }), twoGmail);
    expect(stringItem.kind).toBe('block');
    expect((stringItem as { message: string }).message).toContain('object items only');
    // ^ a STRING item names a readable slug (innerSlugOf accepts strings) but cannot
    //   carry an account field: on a multi-account toolkit that is a block, and the
    //   message must SAY so — "object items only" is the model's only route out
    //   (adding an account to a bare string is impossible).
  });

  it('a bare STRING item on a SINGLE-active toolkit passes (nothing to fill it into)', () => {
    // The other side of the branch above: with one active account there is no
    // ambiguity to resolve, so the router takes the string as-is — no block, and
    // no fill (a string cannot carry the field).
    expect(resolveAccountSelection(call({ tools: ['SLACK_SEND_MESSAGE'] }), twoGmail))
      .toEqual({ kind: 'pass' });
  });

  it('an INHERITED `account` never counts as selected (own-property read)', () => {
    // Prototype-borrowed values are not the model's choice. Reading them as one
    // would route a multi-account call to whatever the prototype happened to
    // carry — exactly the silent mis-routing the block exists to prevent.
    const item = Object.create({ account: 'ca_work' }) as Record<string, unknown>;
    item.tool_slug = 'GMAIL_SEND_EMAIL';
    expect(resolveAccountSelection(call({ tools: [item] }), twoGmail).kind).toBe('block');
  });

  it('describeAccountRoster falls back to positional labels for null aliases', () => {
    expect(describeAccountRoster('slack', [{ id: 'ca_s', alias: null, status: 'active' }]))
      .toBe('slack: slack account 1 (ca_s)');
  });

  it('describeAccountRoster numbers off the FULL list when one is passed', () => {
    // The positional label must count hidden (expired/pending) siblings, because
    // that is what the server's displayAccountName does for the wire label the
    // user sees ("gmail #3") and what the prompt's connected_accounts layer says.
    // Shown list = active only; numbering basis = the whole roster entry.
    const all = [
      { id: 'ca_work', alias: 'work', status: 'active' },
      { id: 'ca_dead', alias: null, status: 'expired' },
      { id: 'ca_third', alias: null, status: 'active' },
    ];
    const active = all.filter((a) => a.status === 'active');
    expect(describeAccountRoster('gmail', active, all))
      .toBe('gmail: "work" (ca_work), gmail account 3 (ca_third)');
  });

  it('the BLOCK message numbers off the full roster, not the active-only slice', () => {
    const withHole: AccountRoster = new Map([
      ['gmail', [
        { id: 'ca_work', alias: 'work', status: 'active' },
        { id: 'ca_dead', alias: null, status: 'expired' },
        { id: 'ca_third', alias: null, status: 'active' },
      ]],
    ]);
    const missing = resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }), withHole);
    expect(missing.kind).toBe('block');
    expect((missing as { message: string }).message).toContain('gmail account 3 (ca_third)');
    expect((missing as { message: string }).message).not.toContain('gmail account 2');

    const unknown = resolveAccountSelection(
      call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'nope' }] }),
      withHole,
    );
    expect(unknown.kind).toBe('block');
    expect((unknown as { message: string }).message).toContain('gmail account 3 (ca_third)');
    expect((unknown as { message: string }).message).not.toContain('gmail account 2');
  });

  it('the block message still never names a non-active sibling', () => {
    const withHole: AccountRoster = new Map([
      ['gmail', [
        { id: 'ca_work', alias: 'work', status: 'active' },
        { id: 'ca_dead', alias: 'retired', status: 'expired' },
        { id: 'ca_third', alias: null, status: 'active' },
      ]],
    ]);
    const verdict = resolveAccountSelection(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }), withHole);
    expect((verdict as { message: string }).message).not.toContain('ca_dead');
    expect((verdict as { message: string }).message).not.toContain('retired');
  });
});
