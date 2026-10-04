/**
 * Tool-output safety guard. Runs at the single tool-dispatch boundary on the
 * stringified result of EVERY tool (Read, Bash `cat`, Grep, skill tools) before
 * it enters the append-only journal and gets replayed to the model each turn.
 *
 * Two failures it exists to prevent (root cause of the letterhead 413 incident):
 *  - A binary file (docx/pdf/image/zip) read as utf8 becomes a NUL-laced mojibake
 *    blob that (a) balloons the request body past the provider's size limit and
 *    (b) carries NUL bytes that crash the Postgres jsonb persist. We REFUSE such
 *    output rather than let it into context.
 *  - An enormous-but-text result. We TRUNCATE with a notice rather than refuse.
 *
 * Pure and provider-neutral, so it is trivially testable.
 */
import { toolResultShapeEnabled } from '../policy/feature-flags.js';
import { truncationMarker, NARROW_RECOVERY } from '../tools/result-shape.js';

/** Hard cap on a single tool result's text before truncation. */
export const TOOL_OUTPUT_MAX_CHARS = 256 * 1024;

/** Returned in place of binary content. Plain, non-branded, honest. */
export const BINARY_REFUSAL =
  'This looks like a binary file (for example a Word, PDF, image, or zip). ' +
  'Reading it as text produces unusable output, so it was not returned. ' +
  'Binary documents will be handled by the document pipeline in a later release.';

/** Number of leading chars sampled for the control/replacement-ratio heuristic. */
const SAMPLE_CHARS = 4096;
/** Above this fraction of control/replacement chars in the sample, treat as binary. */
const BINARY_RATIO = 0.3;

const NUL_CHAR = String.fromCharCode(0);
const REPLACEMENT_CHAR_CODE = 0xfffd;

/**
 * Exported (Phase 3, §1.5) so the FS context-offload chokepoint (context-offload.ts)
 * can skip offloading binary-refused content — no point writing a NUL-laced blob
 * to `.kernel-offload/` when guardToolOutput is about to refuse it anyway.
 */
export function looksBinary(text: string): boolean {
  // 1. A NUL anywhere is definitive — valid text never contains U+0000, and it is
  //    exactly what Postgres jsonb rejects.
  if (text.indexOf(NUL_CHAR) !== -1) return true;

  // 2. Leading magic signatures that survive a utf8 decode as ASCII.
  //    %PDF...  ->  PDF;   PK\x03\x04 / PK\x01\x02 / PK\x05\x06  ->  zip family (docx/xlsx/pptx).
  if (text.startsWith('%PDF')) return true;
  if (
    text.length > 2 &&
    text.charCodeAt(0) === 0x50 /* P */ &&
    text.charCodeAt(1) === 0x4b /* K */ &&
    text.charCodeAt(2) < 0x08
  ) {
    return true;
  }

  // 3. High ratio of control + replacement chars over the head sample (mojibake
  //    from utf8-decoding raw binary — PNG/JPG/legacy-Office headers land here).
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    const allowedControl = c === 0x09 || c === 0x0a || c === 0x0d; // tab, LF, CR
    if ((c < 0x20 && !allowedControl) || c === REPLACEMENT_CHAR_CODE) bad++;
  }
  return sample.length > 0 && bad / sample.length > BINARY_RATIO;
}

/**
 * Guard a tool's stringified output. Returns a refusal for binary content, a
 * truncated copy for oversized text, or the input unchanged.
 */
export function guardToolOutput(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (looksBinary(text)) return BINARY_REFUSAL;
  if (text.length > TOOL_OUTPUT_MAX_CHARS) {
    // T5 (TOOL_RESULT_SHAPE_V1): the one truncation marker (result-shape.ts). Off: below.
    if (toolResultShapeEnabled()) return capWithMarker(text);
    // Reserve room for the notice so the result is always <= the cap (and thus
    // strictly shorter than any input that exceeded it).
    //
    // The notice names the exact next call per tool shape. This is the LAST-resort
    // cap — the offload primitive normally shrinks an oversized result to a preview
    // that already carries its spill path, so reaching here means offload was
    // skipped or failed and there is no file to point at. With no path to give, the
    // one thing that must not happen is leaving the model to guess: a bare
    // "output was truncated" reliably buys a re-run of the identical call.
    const notice =
      `\n\n…[truncated: tool output exceeded ${TOOL_OUTPUT_MAX_CHARS} characters and the rest ` +
      `was dropped. Re-run narrowed: a file → Read with offset/limit; a search → Grep with ` +
      `head_limit/offset; a command → redirect to a file and Read that]`;
    return text.slice(0, TOOL_OUTPUT_MAX_CHARS - notice.length) + notice;
  }
  return text;
}

/**
 * T5 — the cap with the one marker, naming exactly how many characters were dropped. That
 * count depends on how much room the marker leaves, so it settles in a pass or two: each
 * pass keeps less, never more, and the result never exceeds the cap.
 */
function capWithMarker(text: string): string {
  let kept = TOOL_OUTPUT_MAX_CHARS;
  for (;;) {
    const notice = `\n${truncationMarker({ omitted: `${text.length - kept} characters`, from: 'end', recovery: NARROW_RECOVERY })}`;
    const fits = TOOL_OUTPUT_MAX_CHARS - notice.length;
    if (fits >= kept) return text.slice(0, kept) + notice;
    kept = fits;
  }
}
