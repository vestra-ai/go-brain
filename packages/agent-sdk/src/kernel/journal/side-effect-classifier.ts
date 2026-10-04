/**
 * side-effect-classifier.ts — Weave Phase 2b F1 (design §6.2 / §8-F1).
 *
 * A CONSERVATIVE, best-effort answer to one narrow question: could this orphaned tool_use
 * have fired an EXTERNAL, non-idempotent side effect (a network POST, an email send) before
 * the process died? It is used ONLY to choose the crash-heal MESSAGE — a fail-closed
 * "verify before retrying" card vs the neutral empty stub — so a re-fired side effect is
 * never silently invited on resume.
 *
 * ⚠️ NOT a security boundary and NOT exhaustive. A subagent with Bash has a thousand egress
 * paths (python/perl/ruby/git-over-https/…); this matches the common, OBVIOUS shapes. Real
 * network-egress isolation is a Loom-era sandbox-boundary prereq (there is no Blaxel egress
 * API today — see apps/sandbox `subagent-permissions.ts` for the sibling best-effort denylist).
 * A false negative just degrades to today's neutral stub; a false positive just shows a
 * harmless extra "verify" note. It classifies from the journaled tool NAME + INPUT, so it
 * needs no schema change and runs only on the (rare) crash-heal path.
 */

/** Bash sub-commands whose presence means the command likely made an OUTBOUND request or an
 *  external mutation — re_execute-bound and non-idempotent on replay. Volume-FS writes
 *  (Write/Edit, `echo > file`) are idempotent-on-overwrite (§6.2) and are NOT flagged. */
const BASH_EGRESS = /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet|gh)\b/;

/** execute_code egress shapes — a request-making API in the interpreted body. */
const CODE_EGRESS = /(fetch\s*\(|https?:\/\/|requests\.|urllib|http\.client|axios|XMLHttpRequest|WebSocket|socket\.)/i;

function readStr(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * True when an orphaned `toolName`(`input`) MAY have fired an external, non-idempotent side
 * effect. Used by the journal crash-heal to pick the fail-closed "may-have-run" message.
 */
export function mayHaveRunSideEffect(toolName: string, input: unknown): boolean {
  // External-app tools (Composio & co.) are send-shaped by construction (email/deploy/post).
  if (toolName.startsWith('mcp__') || /composio/i.test(toolName)) return true;
  // mcp_invoke is the native arm's one route to a user-connected MCP server: send-shaped wholesale,
  // like an mcp__ tool. github_pull_request opens or edits a pull request.
  if (toolName === 'mcp_invoke' || toolName === 'github_pull_request') return true;
  if (toolName === 'Bash') return BASH_EGRESS.test(readStr(input, 'command'));
  if (toolName === 'execute_code') return CODE_EGRESS.test(readStr(input, 'code') || readStr(input, 'command'));
  return false;
}

/** The fail-closed crash-heal message for a may-have-run side effect (design §8-F1). Non-empty
 *  text (the journal→provider converter keeps text blocks) so the model is warned, not fed a
 *  bare error that invites a blind retry. */
export const MAY_HAVE_RUN_MESSAGE =
  'This action MAY HAVE run before the session was interrupted, but its result was not recorded. ' +
  'Do NOT blindly repeat it — a second run could duplicate an external side effect (a sent message, ' +
  'a posted request). Verify whether it already took effect before retrying.';
