import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeliverLedger,
  extractDeliveries,
  findExpiringSignedUrl,
} from '../deliver-ledger.js';
import type { ToolCall } from '../../contract/harness.js';

// The ledger's ONE job: a destination that already received a SUCCESSFUL
// delivery this turn never receives a second one — whether as a verbatim retry
// (R1) or re-delivered through a different verb of the same toolkit (R2, the
// upload-then-send double-post: prod task 832d60fd, 2026-08-12, where Slack
// #marketing got the same announcement twice 8 seconds apart).

const TASK = 'task-832d60fd';
const CHANNEL = 'C07NRRP8DD0';

const call = (toolName: string, toolInput: unknown): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't',
});

/** COMPOSIO_MULTI_EXECUTE_TOOL envelope around one inner tool (incident shape). */
const meta = (tool_slug: string, args: Record<string, unknown>): ToolCall =>
  call('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug, arguments: args }],
    session_id: 'more',
  });

/** The incident's two writes, verbatim fields that matter. */
const UPLOAD = meta('SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK', {
  file: { name: 'vestra-branding-messaging-meeting.png', s3key: 'project/pr_x/_A-vk', mimetype: 'image/png' },
  title: 'Vestra Branding & Messaging Meeting',
  channels: CHANNEL,
  initial_comment: 'Branding & messaging meeting — Wednesday, August 12, 2026 at 9:00 PM.',
});
const SEND = meta('SLACK_SEND_MESSAGE', {
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Vestra Branding & Messaging Meeting*' } }],
  channel: CHANNEL,
  fallback_text: 'Vestra Branding & Messaging Meeting — Wednesday, August 12, 2026 at 9:00 PM.',
});

/** A successful MULTI_EXECUTE result body for one inner slug (double-encoded, as on the wire). */
const okResult = (tool_slug: string) =>
  JSON.stringify([
    {
      type: 'text',
      text: JSON.stringify({
        data: {
          results: [{ response: { successful: true, data: {} }, tool_slug, index: 0 }],
          total_count: 1,
          success_count: 1,
          error_count: 0,
        },
        successful: true,
      }),
    },
  ]);

const failedResult = (tool_slug: string) =>
  JSON.stringify([
    {
      type: 'text',
      text: JSON.stringify({
        data: {
          results: [{ response: { successful: false, error: 'channel_not_found' }, tool_slug, index: 0 }],
          total_count: 1,
          success_count: 0,
          error_count: 1,
        },
        successful: true,
      }),
    },
  ]);

// ── extraction ────────────────────────────────────────────────────────────────

describe('extractDeliveries', () => {
  it('unwraps a MULTI_EXECUTE inner delivery with destination + toolkit', () => {
    const d = extractDeliveries(SEND);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      slug: 'SLACK_SEND_MESSAGE',
      toolkit: 'slack',
      destinations: [CHANNEL.toLowerCase()],
    });
  });

  it('treats an upload WITH a channel as a delivery', () => {
    const d = extractDeliveries(UPLOAD);
    expect(d).toHaveLength(1);
    expect(d[0].slug).toBe('SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK');
    expect(d[0].destinations).toEqual([CHANNEL.toLowerCase()]);
  });

  it('reads a direct (non-meta) composio tool call', () => {
    const d = extractDeliveries(
      call('mcp__composio__GMAIL_SEND_EMAIL', { to: 'a@b.com', subject: 'hi', body: 'x' }),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ toolkit: 'gmail', destinations: ['a@b.com'] });
  });

  it('array destinations normalize per-recipient', () => {
    const d = extractDeliveries(
      call('mcp__composio__GMAIL_SEND_EMAIL', { to: ['A@b.com', ' c@d.com '] }),
    );
    expect(d[0].destinations).toEqual(['a@b.com', 'c@d.com']);
  });

  it('a deliver-verb slug WITHOUT a destination field is not a delivery (drive upload)', () => {
    expect(
      extractDeliveries(call('mcp__composio__GOOGLEDRIVE_UPLOAD_FILE', { folder_id: 'f1', file: 'x' })),
    ).toEqual([]);
  });

  it('a destination WITHOUT a deliver verb is not a delivery (find channels)', () => {
    expect(
      extractDeliveries(meta('SLACK_FIND_CHANNELS', { query: 'marketing', channel: 'x' })),
    ).toEqual([]);
  });

  it('non-composio tools and unreadable entries are skipped, never poisoning', () => {
    expect(extractDeliveries(call('Bash', { command: 'ls' }))).toEqual([]);
    const mixed = call('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ nonsense: true }, { tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'c1', text: 'x' } }],
    });
    const d = extractDeliveries(mixed);
    expect(d).toHaveLength(1);
    expect(d[0].destinations).toEqual(['c1']);
  });
});

// ── signed-URL lint ───────────────────────────────────────────────────────────

describe('findExpiringSignedUrl', () => {
  it('finds a Supabase signed URL anywhere in the args', () => {
    const url =
      'https://osmnkeveyeexthlsdvts.supabase.co/storage/v1/object/sign/outputs/u/f.png?token=eyJ';
    expect(findExpiringSignedUrl({ blocks: [{ image_url: url }] })).toBe(url);
  });
  it('null on public/permanent URLs', () => {
    expect(
      findExpiringSignedUrl({ image_url: 'https://x.supabase.co/storage/v1/object/public/outputs/f.png' }),
    ).toBeNull();
  });
});

// ── the ledger ────────────────────────────────────────────────────────────────

describe('DeliverLedger', () => {
  let ledger: DeliverLedger;
  beforeEach(() => {
    ledger = new DeliverLedger();
  });

  it('R2 — the incident: upload ok, then send_message to the same channel is denied', () => {
    expect(ledger.check(TASK, UPLOAD)).toBeNull();
    ledger.record(TASK, UPLOAD, okResult('SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK'));
    const deny = ledger.check(TASK, SEND);
    expect(deny).toBeTruthy();
    expect(deny).toContain('SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK');
  });

  it('R1 — an identical retry after success is denied', () => {
    ledger.record(TASK, SEND, okResult('SLACK_SEND_MESSAGE'));
    expect(ledger.check(TASK, SEND)).toBeTruthy();
  });

  it('same slug, same channel, DIFFERENT payload is allowed (post 3 updates)', () => {
    ledger.record(TASK, SEND, okResult('SLACK_SEND_MESSAGE'));
    const second = meta('SLACK_SEND_MESSAGE', { channel: CHANNEL, text: 'update 2 of 3' });
    expect(ledger.check(TASK, second)).toBeNull();
  });

  it('different destinations are independent (DM fan-out)', () => {
    ledger.record(TASK, meta('SLACK_SEND_MESSAGE', { channel: 'D1', text: 'x' }), okResult('SLACK_SEND_MESSAGE'));
    expect(ledger.check(TASK, meta('SLACK_SEND_MESSAGE', { channel: 'D2', text: 'x' }))).toBeNull();
  });

  it('a FAILED delivery is not recorded — retry allowed', () => {
    ledger.record(TASK, SEND, failedResult('SLACK_SEND_MESSAGE'));
    expect(ledger.check(TASK, SEND)).toBeNull();
  });

  it('an unreadable result records the delivery (fail toward no-duplicate)', () => {
    ledger.record(TASK, SEND, 'garbage <<<');
    expect(ledger.check(TASK, SEND)).toBeTruthy();
  });

  it('intra-call batch dupe: one MULTI_EXECUTE carrying upload+send to the same channel denies', () => {
    const batched = call('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [
        { tool_slug: 'SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK', arguments: { channels: CHANNEL, file: {} } },
        { tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: CHANNEL, text: 'again' } },
      ],
    });
    expect(ledger.check(TASK, batched)).toBeTruthy();
  });

  it('bumpTurn resets — "send it again" next turn works', () => {
    ledger.record(TASK, SEND, okResult('SLACK_SEND_MESSAGE'));
    expect(ledger.check(TASK, SEND)).toBeTruthy();
    ledger.bumpTurn(TASK);
    expect(ledger.check(TASK, SEND)).toBeNull();
  });

  it('tasks are isolated (multi-session sandbox)', () => {
    ledger.record(TASK, SEND, okResult('SLACK_SEND_MESSAGE'));
    expect(ledger.check('other-task', SEND)).toBeNull();
  });

  it('signed-URL lint denies a delivery embedding an expiring signed URL', () => {
    const withSigned = meta('SLACK_SEND_MESSAGE', {
      channel: CHANNEL,
      blocks: [{ image_url: 'https://x.supabase.co/storage/v1/object/sign/outputs/f.png?token=e' }],
    });
    const deny = ledger.check(TASK, withSigned);
    expect(deny).toBeTruthy();
    expect(deny).toMatch(/signed URL|expire/i);
    // A person gets the file's Vestra link, the absolute `link` a tool already returned
    // (the box has no web origin, so it never builds one by hand).
    expect(deny).toMatch(/\/v\//);
    expect(deny).toMatch(/`link`/);
    expect(deny).toContain('/api/box/files/<file id>?as=pass');
    expect(deny).toMatch(/never build one by hand/);
    // Uploading the bytes is still a valid way (M9).
    expect(deny).toMatch(/upload the file bytes/i);
    // The agent cannot see a sharing label: it tells the user what to do if the link
    // does not open, and never changes sharing itself.
    expect(deny).toMatch(/if the recipient cannot open the link, tell the user they may need to share it from Vestra/i);
    expect(deny).not.toMatch(/Restricted/);
    expect(deny).toMatch(/never change a file's sharing yourself/);
    expect(deny).not.toMatch(/public URL/);
    expect(deny).not.toContain('—');
    expect(deny).not.toMatch(/claude/i);
  });

  it('a signed URL in a NON-delivery call is untouched (curl download)', () => {
    expect(
      ledger.check(TASK, call('Bash', { command: 'curl https://x.supabase.co/storage/v1/object/sign/f?token=e' })),
    ).toBeNull();
  });

  it('clearTask drops state', () => {
    ledger.record(TASK, SEND, okResult('SLACK_SEND_MESSAGE'));
    ledger.clearTask(TASK);
    expect(ledger.check(TASK, SEND)).toBeNull();
  });
});
