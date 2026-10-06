/** One event from a /v1 stream: `id` is the resume point, `event` the type, `data` the parsed JSON (the whole event object). */
export interface SseFrame { id: number | null; event: string; data: unknown }

/** Splits an SSE buffer into complete frames and the unfinished rest. Comment lines are skipped. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let id: number | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'id') id = value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) continue;
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    frames.push({ id, event, data: parsed });
  }
  return { frames, rest };
}
