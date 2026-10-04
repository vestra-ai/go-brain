/**
 * The two read-only probe loops the founder ran on staging (task 564a0462,
 * 2026-08-10, native arm, relaxed) — pinned VERBATIM.
 *
 * Both were HTTP probe loops that delete nothing: the first issues four GETs
 * (no `-X` at all), the second four POSTs. Both were shown to him as
 * `dangerous_delete` behind a hard floor, captioned "Run for". His words:
 * "woah got this permission request for what exactly... why am I getting these
 * stupid permissions".
 *
 * ROOT CAUSE, established by running the predicate against every version in
 * range rather than by reading it. The runner was executing policy code from
 * BEFORE #2480 (commit 24eeaae56, 2026-08-09 18:11 UTC), where the unparseable
 * path's glob proxy was a quote-BLIND character test over the whole command:
 *
 *     return /[*?[{]/.test(stripped);
 *
 * Vector 1 tripped it on the `{` inside curl's single-quoted `'%{http_code}'`;
 * vector 2 on `'{"name":"stuff"}'` and the `[` inside `sed 's/[[:space:]]…'`.
 * Every one of those sits inside single quotes, where bash expands nothing.
 * #2480 replaced that proxy with the quote- and word-aware containsUnquotedGlob,
 * which is why current code is already silent on both.
 *
 * These are therefore REGRESSION PINS, not a red-green cycle: they hold on
 * current source and go red the moment the quote-blind proxy comes back
 * (verified by reverting it — see the PR body). The guard is untouched: the
 * delete-operations suite still owns what MUST floor.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { ToolCall } from '../../contract/harness.js';
import { sensitivityFloorAsks, classifyBashCommand } from '../sensitivity-floor.js';
import { describeToolCall, describePermissionAsk } from '../describe-tool.js';

const bash = (command: string): ToolCall => ({
  toolName: 'Bash',
  toolInput: { command },
  toolCallId: 't1',
});

const WORKSPACE = '/app/workspace';

/**
 * Interaction 2d55fee0, 10:05:47Z. Four GET probes for an OpenAPI document,
 * then four more under /api. There is no `-X` anywhere: every request is a GET.
 */
const GET_PROBE_LOOP = String.raw`for path in openapi.json api-json docs-json swagger-json; do code=$(curl -sS -o /tmp/vestra-$path.out -w '%{http_code}' -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/$path"); printf '%s %s\n' "$path" "$code"; done; for path in api/openapi.json api/api-json api/docs-json api/swagger-json; do code=$(curl -sS -o /tmp/vestra-$(echo "$path" | tr / _).out -w '%{http_code}' -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/$path"); printf '%s %s\n' "$path" "$code"; done`;

/**
 * Interaction aba799c0, 10:06:25Z. Four POST probes hunting for the
 * folder-create route. `-X POST` is a creation, not a deletion.
 */
const POST_PROBE_LOOP = String.raw`for path in /api/files/create-folder /api/files/folder /api/folders /api/files/new-folder; do code=$(curl -sS -o /tmp/vestra-route.out -w '%{http_code}' -X POST -H "Authorization: Bearer $VESTRA_API_TOKEN" -H "Content-Type: application/json" --data '{"name":"stuff"}' "$VESTRA_SERVER_URL$path"); printf '%s %s ' "$path" "$code"; sed 's/[[:space:]]\+/ /g' /tmp/vestra-route.out | cut -c1-120; printf '\n'; done`;

describe('founder probe loops — byte fidelity to staging', () => {
  // The pins are only worth anything if they are the bytes the founder ran.
  // These digests are `md5(request->'toolInput'->>'command')` read back from the
  // staging interactions table.
  it('matches interaction 2d55fee0 byte for byte', () => {
    expect(createHash('md5').update(GET_PROBE_LOOP).digest('hex')).toBe(
      '57784233ac836cf66850c8a4cd289553',
    );
  });

  it('matches interaction aba799c0 byte for byte', () => {
    expect(createHash('md5').update(POST_PROBE_LOOP).digest('hex')).toBe(
      '6d8a6819f7468cb7c286fdf113f2a7b3',
    );
  });
});

describe('founder probe loops — a read-only probe is not a deletion', () => {
  it('does not floor the GET loop', () => {
    expect(
      sensitivityFloorAsks(bash(GET_PROBE_LOOP), {
        workspaceRoot: WORKSPACE,
        shellCwd: WORKSPACE,
      }),
    ).toBe(false);
  });

  it('does not floor the POST loop', () => {
    expect(
      sensitivityFloorAsks(bash(POST_PROBE_LOOP), {
        workspaceRoot: WORKSPACE,
        shellCwd: WORKSPACE,
      }),
    ).toBe(false);
  });

  it('does not call the GET loop a dangerous delete', () => {
    expect(classifyBashCommand(GET_PROBE_LOOP, WORKSPACE, WORKSPACE)).not.toBe('dangerous_delete');
  });

  it('does not call the POST loop a dangerous delete', () => {
    expect(classifyBashCommand(POST_PROBE_LOOP, WORKSPACE, WORKSPACE)).not.toBe('dangerous_delete');
  });

  it('leaves a single-quoted curl format string alone', () => {
    // The exact fragment that fired the old proxy, on its own.
    expect(
      sensitivityFloorAsks(bash(String.raw`code=$(curl -sS -w '%{http_code}' "$URL")`), {
        workspaceRoot: WORKSPACE,
        shellCwd: WORKSPACE,
      }),
    ).toBe(false);
  });

  it('leaves a single-quoted sed character class alone', () => {
    expect(
      sensitivityFloorAsks(bash(String.raw`out=$(sed 's/[[:space:]]\+/ /g' notes.txt)`), {
        workspaceRoot: WORKSPACE,
        shellCwd: WORKSPACE,
      }),
    ).toBe(false);
  });
});

describe('founder probe loops — the card says something a person can read', () => {
  it('never captions the GET loop with the loop keyword', () => {
    expect(describeToolCall(bash(GET_PROBE_LOOP))).not.toBe('Run for');
  });

  it('never captions the POST loop with the loop keyword', () => {
    expect(describeToolCall(bash(POST_PROBE_LOOP))).not.toBe('Run for');
  });

  it('falls back to the generic sentence for the GET loop', () => {
    expect(describeToolCall(bash(GET_PROBE_LOOP))).toBe('Run a shell command');
  });

  it('speaks from the family when such a loop reaches a card', () => {
    const ask = describePermissionAsk(bash(POST_PROBE_LOOP), {
      family: 'workspace_write',
      floor: 'rule',
    });
    expect(ask.headline).toBe('Update files in your workspace');
  });
});
