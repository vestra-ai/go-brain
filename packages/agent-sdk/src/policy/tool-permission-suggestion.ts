/**
 * K6 P3 C2 — the tool_permission SUGGESTION producer.
 *
 * When the ASK step or the SENSITIVITY FLOOR routes a call to
 * `needs_human(tool_permission)`, the interaction card offers an "Always allow
 * this" affordance. This module builds the PermissionSuggestion[] payload that
 * the gateway's existing `tool_permission` request builder renders (it already
 * reads `extras.suggestions` → `ToolPermissionRequest.suggestions`). When the
 * user clicks it, C5 writes the rule back via `addRules`.
 *
 * The suggested rule is SCOPED, not exact-everything:
 *   - Bash      → the head command + `:*` (e.g. `git push:*`), so "always allow"
 *                 means this command family, not just this exact argv line.
 *   - Write/Edit/path tools → the exact `file_path`.
 *   - anything else → a bare tool rule (matches any input for that tool).
 *
 * CONSERVATIVE: an unparseable Bash command falls back to a bare `Bash` rule
 * (we don't suggest a glob we can't trust). PURE / TOTAL / NEVER-THROWS.
 */

import type { ToolCall } from '../contract/harness.js';
import type { PermissionSuggestion } from '../contract/interaction.js';
import { splitShellSegments } from './shell-split.js';
import { isComposioExecutorMetaTool } from './composio-naming.js';

const PATH_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'Read']);

/**
 * Build the "always allow this" suggestion(s) for a tool_permission prompt.
 * Returns at least one suggestion (a bare tool rule as the floor) — EXCEPT for
 * a Composio meta-EXECUTOR, which gets none: a durable allow rule on the
 * wrapper would silence every future inner tool it might run (a send, a
 * charge, a delete) forever. The per-call Allow flows are untouched.
 */
export function buildToolPermissionSuggestion(call: ToolCall): PermissionSuggestion[] {
  if (typeof call?.toolName === 'string' && isComposioExecutorMetaTool(call.toolName)) return [];
  const rule = suggestedRule(call);
  return [
    {
      type: 'addRules',
      rules: [rule],
      behavior: 'allow',
      destination: 'session',
    },
  ];
}

function suggestedRule(call: ToolCall): { toolName: string; ruleContent?: string } {
  try {
    const toolName = typeof call?.toolName === 'string' ? call.toolName : '';

    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const command = getString(call.toolInput, 'command');
      if (!command) return { toolName };
      const { segments, parsedSafely } = splitShellSegments(command);
      // A single, safely-parsed segment → scope to its head command + `:*`.
      if (parsedSafely && segments.length === 1) {
        const head = headCommand(segments[0]);
        return head ? { toolName, ruleContent: `${head}:*` } : { toolName };
      }
      // Compound or unparseable → conservative bare tool rule (no glob we can't
      // vouch for; the user can still hand-edit later).
      return { toolName };
    }

    if (PATH_TOOLS.has(toolName)) {
      const filePath = getString(call.toolInput, 'file_path');
      if (!filePath) return { toolName };
      // Rule-DSL anchor grammar (permission-rule-engine matchPath): a single
      // leading `/` is PROJECT-ROOT-relative; filesystem-absolute is `//`. The
      // tool's file_path is a real filesystem path, so an absolute one MUST be
      // emitted `//`-prefixed or the generated rule resolves to
      // `<cwd>/<abs-path>` and can never match its own call (drill C2: the
      // accepted Allow-for-this-task rule never silenced the identical Write).
      const ruleContent = filePath.startsWith('/') ? `/${filePath}` : filePath;
      return { toolName, ruleContent };
    }

    return { toolName };
  } catch {
    return { toolName: typeof call?.toolName === 'string' ? call.toolName : '' };
  }
}

/**
 * The leading command of a single shell segment, for a `<cmd>:*` allow rule.
 * `git push origin main` → `git push` (keeps a known subcommand for git-like
 * tools); a single-token command → that token. Conservative: returns null on
 * anything odd (a leading flag, a var assignment, an empty segment).
 */
function headCommand(segment: string): string | null {
  const words = segment.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const first = words[0];
  // A leading env-var assignment or a path-y/flag-y first token → don't guess.
  if (first.includes('=') || first.startsWith('-')) return null;

  // For known sub-command CLIs, keep the first two tokens so the rule is useful
  // (`git push:*` not `git:*`). Otherwise just the first token.
  const SUBCOMMAND_CLIS = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'gh', 'cargo']);
  if (SUBCOMMAND_CLIS.has(first) && words.length >= 2 && !words[1].startsWith('-')) {
    return `${first} ${words[1]}`;
  }
  return first;
}

function getString(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}
