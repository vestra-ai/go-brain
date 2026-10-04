/**
 * result-shape.ts — T5: one error shape and one truncation marker for every tool result.
 *
 * The model reads tool results from many paths (the native tools, MCP, Composio, abilities,
 * subagents) and each grew its own way of saying "this failed" and "this was cut". A model
 * that has to learn eight error dialects and a dozen truncation notices misreads some of
 * them: a failure phrased as a plain string reads as a success, and an unfamiliar cut
 * notice reads as the end of the data. So there is one of each, minted here.
 *
 * THE ERROR SHAPE is the one the model already saw most: the message, then the taxonomy
 * code stamped at the tail, on the wire's error channel (`isError: true`):
 *
 *     <message> [error:<code>]
 *
 * A tool reaches it by returning `toolError(code, message)`; the dispatcher stamps it (and
 * `parseToolErrorCode` reads the code back off the tail). A path that builds its result
 * text itself (the harness's own refusals) stamps with `stampToolError`.
 *
 * THE TRUNCATION MARKER is the token-budget marker (C2, the one spill trigger once it is
 * on), whose envelope the command-output cap already shared:
 *
 *     ...[OUTPUT TRUNCATED: <n> <unit> omitted from the <where>, <what is> shown. <recovery>]...
 *
 * Every cut names what was dropped, where, and the exact next step to get it back.
 */
import { toolError, type ToolErrorCode, type ToolErrorSentinel } from './tool-types.js';
import { toolResultShapeEnabled } from '../policy/feature-flags.js';

/**
 * A tool failure that used to come back as a plain string (read as a SUCCESS), moved onto the
 * error channel only while TOOL_RESULT_SHAPE_V1 is on: `toolError(code, message)` then, today's
 * plain words off. The move is behaviour, not just bytes: the parent runaway guard counts the
 * failure, the UI shows it as an error, and inside execute_code the bridge answers it with
 * `ok:false`, so the script's function raises ToolError (a loop that carried on past a failed
 * item now has to catch it; the tool's description says so while the flag is on). The
 * harness's own answers, which were already on the error channel, stamp with `stampToolError`
 * unflagged.
 */
export function softFail(code: ToolErrorCode, message: string): string | ToolErrorSentinel {
  return toolResultShapeEnabled() ? toolError(code, message) : message;
}

/** The one error shape: the message, the code at the tail (`parseToolErrorCode` reads it). */
export function stampToolError(message: string, code: ToolErrorCode): string {
  return `${message} [error:${code}]`;
}

/**
 * The harness's answer to a call naming no tool in this run's catalog. With the taxonomy on
 * (every production run), the one error shape with `not_found`; off, today's bare words.
 */
export function unknownToolText(name: string, taxonomy: boolean | undefined): string {
  const text = `Unknown tool: ${name}`;
  return taxonomy === true ? stampToolError(text, 'not_found') : text;
}

/** Where a cut took its bytes from, and so what of the output is still shown. */
export type TruncatedFrom = 'middle' | 'end' | 'start';

const KEPT: Readonly<Record<TruncatedFrom, string>> = {
  middle: 'head and tail',
  end: 'head',
  start: 'tail',
};

/**
 * The one truncation marker. `omitted` is what was dropped ("1204 characters", "38 lines");
 * `budget`, when the cut is a budget's, names it ("10000-token budget"); `recovery` is the
 * exact next step. The C2 token-budget marker is this with a budget, byte for byte.
 */
export function truncationMarker(m: {
  omitted: string;
  from: TruncatedFrom;
  recovery: string;
  budget?: string;
}): string {
  const budget = m.budget !== undefined ? ` to the ${m.budget}` : '';
  return `...[OUTPUT TRUNCATED${budget}: ${m.omitted} omitted from the ${m.from}, ${KEPT[m.from]} shown. ${m.recovery}]...`;
}

/** Recovery: the full output was written to a file. */
export function spillRecovery(path: string): string {
  return `The output is in ${path}; Read it with offset/limit.`;
}

/** Recovery: nothing was kept, so narrow the call that produced it. */
export const NARROW_RECOVERY =
  'Re-run narrowed: a file, Read with offset/limit; a search, Grep with head_limit/offset; ' +
  'a command, redirect to a file and Read that.';

/** Recovery: a command's own output, which has no offset to page with. */
export const REDIRECT_RECOVERY =
  'To see all of it, re-run redirecting to a file (`<command> > out.txt 2>&1`) and Read that file with offset/limit.';
