/**
 * tool-ready.ts — L1 (TOOLS_MIDSTREAM_V1): when is one streamed tool call ready to run on?
 *
 * Every transport's accumulator asks this one question the moment the provider closes a
 * call, and reports EVERY closed call as a `tool_ready` stream event, in call order. The rule
 * is strict where each accumulator's own end-of-stream parse is forgiving: a torn stream
 * degrades to `{}` there (the call still reaches the tool, whose schema refuses it), but a
 * call nobody can read must never start early. So: no arguments at all reads as `{}`, exactly
 * as every accumulator reads it; a JSON object is ready; anything else (malformed JSON, an
 * array, a bare string) is reported with `input: undefined` and never starts early. It is
 * still reported, because the early starts must see every call in order: an unreadable
 * exclusive call shuts the door on everything after it, as a readable one does.
 */

/** One call the stream has closed: its arguments, or undefined when they do not parse. */
export interface ReadyToolUse {
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
}

/** A call's raw argument string, parsed strictly: the object, or undefined when unreadable. */
export function readyToolArgs(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
