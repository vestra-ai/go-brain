import { estimateTokens } from '../kernel/journal/token-ledger.js';
import { toolResultShapeEnabled } from '../policy/feature-flags.js';
import { truncationMarker, spillRecovery, NARROW_RECOVERY, REDIRECT_RECOVERY } from './result-shape.js';

/**
 * Cap a tool's text output to `capBytes`, keeping the head (40%) and tail (60%)
 * with a marker between. UTF-8 safe at the byte level (may trim one partial
 * multibyte char at each boundary — acceptable for log output).
 *
 * The marker names the RECOVERY, not just the loss. A bare "N bytes omitted"
 * leaves the model to invent a next step — usually re-running the same command
 * and truncating again. Unlike Read/Grep there is no offset to page with, so the
 * recovery is to redirect the command's own output to a file and read that.
 */
export function truncateOutput(
  text: string,
  capBytes = 50_000,
): { text: string; truncated: boolean; omittedBytes: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= capBytes) return { text, truncated: false, omittedBytes: 0 };
  const headBytes = Math.floor(capBytes * 0.4);
  const tailBytes = capBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.byteLength - tailBytes).toString('utf8');
  const omittedBytes = buf.byteLength - headBytes - tailBytes;
  // T5 (TOOL_RESULT_SHAPE_V1): the one truncation marker (result-shape.ts). Off: today's bytes.
  const marker = toolResultShapeEnabled()
    ? truncationMarker({ omitted: `${omittedBytes} bytes`, from: 'middle', recovery: REDIRECT_RECOVERY })
    : `...[OUTPUT TRUNCATED - ${omittedBytes} bytes omitted from the middle; ` +
      `head and tail shown. To see all of it, re-run redirecting to a file ` +
      `(\`<command> > out.txt 2>&1\`) and Read that file with offset/limit]...`;
  return {
    text: `${head}\n${marker}\n${tail}`,
    truncated: true,
    omittedBytes,
  };
}

/** Chars of room the head/tail cut leaves for the marker (the loop below verifies the fit). */
const TOKEN_MARKER_ROOM = 400;

/** True when `text` costs at most `budgetTokens` by `estimateTokens`. Its char half
 *  (round(chars/4)) settles an over-budget text without splitting it into words. */
export function withinTokenBudget(text: string, budgetTokens: number): boolean {
  return Math.round(text.length / 4) <= budgetTokens && estimateTokens(text) <= budgetTokens;
}

/**
 * C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1): hold a tool result to `budgetTokens`, measured with the
 * engine's one estimator (`estimateTokens`, the larger of chars/4 and words x 1.3, so it errs
 * high). Keeps the head (40%) and tail (60%, where a command's verdict sits) with a marker
 * between that names the recovery: the spill file when there is one, else the re-run narrowed.
 * The marker never calls the file "full": a tool may have capped its own output before the
 * spill (Bash at 2 MB, whose marker inside the file says so). The cut never splits a
 * surrogate pair.
 */
export function truncateToTokenBudget(
  text: string,
  budgetTokens: number,
  spillPath?: string,
): { text: string; truncated: boolean } {
  if (withinTokenBudget(text, budgetTokens)) return { text, truncated: false };
  let room = budgetTokens * 4;
  for (let i = 0; i < 8 && room > 0; i++) {
    const out = headAndTail(text, room, budgetTokens, spillPath);
    const tokens = estimateTokens(out);
    if (tokens <= budgetTokens) return { text: out, truncated: true };
    room = Math.floor((room * budgetTokens) / tokens) - 1;
  }
  return { text: headAndTail(text, 0, budgetTokens, spillPath), truncated: true };
}

function headAndTail(text: string, room: number, budgetTokens: number, spillPath?: string): string {
  const keep = Math.min(Math.max(0, room - TOKEN_MARKER_ROOM), text.length);
  let headEnd = Math.floor(keep * 0.4);
  let tailStart = text.length - (keep - headEnd);
  if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
  if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
  // The one truncation marker (result-shape.ts), with this budget named.
  const marker = truncationMarker({
    omitted: `${tailStart - headEnd} characters`,
    from: 'middle',
    budget: `${budgetTokens}-token budget`,
    recovery: spillPath ? spillRecovery(spillPath) : NARROW_RECOVERY,
  });
  return `${text.slice(0, headEnd)}\n${marker}\n${text.slice(tailStart)}`;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
