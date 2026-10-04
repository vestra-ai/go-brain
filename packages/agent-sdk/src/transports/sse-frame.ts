/**
 * SILENT_DEATHS_V1 (L5, #3332 e) — one SSE `data:` frame, or the lane's severance. Shared
 * by both Gemini lanes (generateContent and Interactions), each passing its own sentinel.
 *
 * A frame that does not parse is a stream error, not a frame to skip: skipping could run a
 * tool on args with a function call missing, with no signal to anyone. It throws the lane's
 * severed-stream sentinel (matched EXACTLY by the shared recognizer, engine/severed-
 * recognizer.ts, so the existing rail re-issues the round), with the torn bytes on the error
 * for the log; the reader is released first. The caller keeps the parse apart from its
 * `yield`, so an error thrown INTO the generator at the yield is never mistaken for a torn
 * frame (the OFF shape swallows that too).
 */
export function parseSseFrameOrSever<T>(
  json: string,
  reader: { cancel(): Promise<void> },
  severedMessage: string,
): T {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw Object.assign(new Error(severedMessage), { cause: err, tornFrame: json.slice(0, 200) });
  }
}
