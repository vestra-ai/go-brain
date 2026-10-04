/**
 * Compound-command-aware rule evaluation, moved VERBATIM out of decide-tool-gate.ts
 * (L6: that file sits at the file-size ratchet, and ratchets only go down). The
 * logic is byte-identical; the only change is the `export` keyword on the four
 * functions the gate calls. Not part of the public policy barrel: these were
 * private to the gate and stay internal to the package.
 */
import type { ToolCall } from '../contract/harness.js';
import type { PermissionRuleValue } from '../contract/permission.js';
import { matchRule, type PathAnchors } from './permission-rule-engine.js';
import { splitShellSegments } from './shell-split.js';
import { analyzeCommand } from './command-analyzer.js';
import { bashAstGateEnabled } from './feature-flags.js';


/**
 * The raw text of each COMMAND POSITION in a Bash command, plus whether the
 * parse can be vouched for. The SOURCE is flag-gated:
 *   - flag OFF → `splitShellSegments` (legacy operator-split: &&, ||, |, ;, \n —
 *                NOT `&`), byte-identical to the pre-analyzer gate.
 *   - flag ON  → `analyzeCommand`, which additionally enumerates a backgrounded
 *                `&` position, commands inside process substitution `<(…)`/`>(…)`,
 *                and `sh -c`/`bash -c` string bodies — so a deny like
 *                `Bash(rm:*)` catches an `rm` in ANY of those positions.
 * `parsedSafely` stays false on substitution, subshells (`nested`), bare assignments
 * (`assigns`) and unbalanced quotes: allow never covers one; deny/ask see inner positions.
 */
export function bashPositions(command: string): { positions: string[]; parsedSafely: boolean } {
  if (!bashAstGateEnabled()) {
    const r = splitShellSegments(command);
    return { positions: r.segments, parsedSafely: r.parsedSafely };
  }
  const a = analyzeCommand(command);
  return { positions: a.commands.map((c) => c.raw), parsedSafely: a.parsedSafely && !a.nested && !a.assigns };
}

/**
 * Does ANY of `rules` match the call? For a Bash call this matches if ANY
 * command POSITION matches the rule (so `deny Bash(rm:*)` catches `ls && rm x`).
 * For non-Bash calls it's a plain whole-call match. Used for DENY + ASK (the
 * "any position is dangerous → catch it" direction).
 *
 * Conservative: when a Bash command can't be parsed safely, we match the WHOLE
 * command string against each rule too (so a deny on the unsplit form still
 * fires). Total — matchRule swallows its own errors.
 */
export function anyRuleMatchesAnySegment(
  call: ToolCall,
  rules: PermissionRuleValue[],
  anchors?: PathAnchors,
): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return false;

  if (call.toolName === 'Bash' || call.toolName === 'PowerShell') {
    const command = getCommand(call.toolInput);
    if (typeof command === 'string' && command.length > 0) {
      const { positions, parsedSafely } = bashPositions(command);
      // Evaluate each command position as its own Bash call.
      for (const pos of positions) {
        const segCall = bashSegmentCall(call, pos);
        if (rules.some((r) => matchRule(segCall, r, anchors))) return true;
      }
      // Unparseable → also try the whole command (a deny shouldn't be evadable
      // by hiding behind an unbalanced quote).
      if (!parsedSafely && rules.some((r) => matchRule(call, r, anchors))) return true;
      return false;
    }
  }

  return rules.some((r) => matchRule(call, r, anchors));
}

/**
 * Does the ALLOW list COVER the call? For a Bash call EVERY command POSITION must
 * be matched by SOME allow rule (a chain is allowed only if all parts are). For
 * a non-Bash call it's a plain whole-call match.
 *
 * Conservative: an unparseable Bash command is NEVER fully covered (we can't
 * prove every hidden subcommand is allowed) → returns false.
 */
export function allowRuleCoversCall(
  call: ToolCall,
  rules: PermissionRuleValue[],
  anchors?: PathAnchors,
): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return false;

  if (call.toolName === 'Bash' || call.toolName === 'PowerShell') {
    const command = getCommand(call.toolInput);
    if (typeof command === 'string' && command.length > 0) {
      const { positions, parsedSafely } = bashPositions(command);
      if (!parsedSafely || positions.length === 0) return false; // can't vouch
      // EVERY command position must be allowed by some rule.
      return positions.every((pos) => {
        const segCall = bashSegmentCall(call, pos);
        return rules.some((r) => matchRule(segCall, r, anchors));
      });
    }
  }

  return rules.some((r) => matchRule(call, r, anchors));
}

/** A ToolCall for a single Bash segment (same name/id, command replaced). */
function bashSegmentCall(call: ToolCall, segment: string): ToolCall {
  return { toolName: call.toolName, toolInput: { command: segment }, toolCallId: call.toolCallId };
}

export function getCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).command;
    return typeof v === 'string' ? v : null;
  }
  return null;
}
