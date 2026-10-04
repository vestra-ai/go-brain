/**
 * PAUSED_HALT — the model-visible halt result returned for a paused gated tool
 * (the human-in-the-loop fire-and-halt sentinel). When a gated tool fires a
 * substrate interaction, the engine returns this string as the tool_result so
 * the model ends its turn (resumed later via [SYSTEM_RESUME]).
 *
 * BYTE-IDENTITY: this is the EXACT output of the product's historic
 * `toonStringify({ status: 'paused', message: '…' })`. The SDK ships no TOON
 * util (no I/O, no `@bash/*`), so the literal is hardcoded here as a pure
 * contract constant. The sandbox's `native-harness.paused-halt` conformance
 * test asserts `PAUSED_HALT === toonStringify({…})` so any drift fails CI.
 */
export const PAUSED_HALT: string =
  'status: paused\nmessage: "Awaiting user input. Your turn will be resumed via [SYSTEM_RESUME] when the user responds. End your turn now — do not interpret this result."';
