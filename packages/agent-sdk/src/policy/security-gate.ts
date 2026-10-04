import type { GateResult, ToolCall } from '../contract/harness.js';
import { checkDangerousBashCommand, checkSensitiveFile } from './security-patterns.js';
import type { CommandContext } from './command-catalogs.js';
import { securityPatternsV2Enabled } from './feature-flags.js';

/**
 * SPINE-3 — arg-aware security gate, the SHARED contract-level enforcement of
 * the dangerous-command / sensitive-file patterns.
 *
 * Today security is enforced per-arm in different layers: Claude via the
 * PreToolUse hook, OpenAI inside each tool's execute(). Neither runs through the
 * unified `gateTool()` contract — `classifyToolCall` deliberately ignores args
 * (name-based only). This routes the SAME `security-patterns` engine through
 * gateTool so EVERY harness (incl. a future one) denies these through the one
 * contract, with a MODEL-VISIBLE reason on `deny.message`.
 *
 * Additive: the existing hook + per-tool checks stay as defense-in-depth — this
 * adds the contract-level gate (for the OpenAI arm, whose wrapper calls gateTool
 * BEFORE execute, it becomes the primary block). Returns a deny GateResult when
 * the parsed args trip a pattern, else null (no security concern). `ctx` (the live shell
 * cwd and $HOME, from decideToolGate) lets the SECURITY_PATTERNS_V2 catalogs resolve a
 * relative or `~` target; without it such a target is not judged here and the floor asks.
 */
export function gateSecurity(call: ToolCall, ctx?: CommandContext): GateResult | null {
  const input = (call.toolInput ?? {}) as Record<string, unknown>;

  if (call.toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return null;
    const check = checkDangerousBashCommand(command, ctx);
    if (check.blocked) {
      // SECURITY_PATTERNS_V2 also words the refusal without a dash (it can reach the denied card).
      const tail = securityPatternsV2Enabled()
        ? 'This command is blocked for safety. Do not retry it.'
        : 'This command is blocked for safety — do not retry it.';
      return {
        decision: 'deny',
        message: `Security: ${check.description ?? 'this command pattern is blocked'}. ${tail}`,
      };
    }
    return null;
  }

  if (call.toolName === 'Write' || call.toolName === 'Edit') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath) return null;
    const check = checkSensitiveFile(filePath);
    if (check.blocked) {
      return {
        decision: 'deny',
        message: `Security: ${check.description ?? 'this file path is protected'}. Writing this file is blocked for safety — do not retry it.`,
      };
    }
    return null;
  }

  return null;
}
