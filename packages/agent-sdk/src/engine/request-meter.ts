/**
 * Media-refs S0 — per-request byte/image metering (spec Rule 5). Byte overflows
 * are invisible to token metrics (a failed call reports ZERO usage; images are
 * token-cheap/byte-fat), so the killer payload of a 413 appears in no metric we
 * keep. These measures ride the per-round usage event → AGENT_USAGE →
 * agent_turns (request_bytes / image_count / image_bytes, MAX-folded per turn).
 *
 * Lane-agnostic: one recursive walk recognizes all four wire dialects' image
 * shapes (Anthropic source blocks, OpenAI Responses input_image, Chat
 * Completions image_url parts, Gemini inlineData). Never throws — metering must
 * never break a round.
 */

export interface WireMediaMeta {
  imageCount: number;
  imageBytes: number;
}

function nodeImageBytes(node: Record<string, unknown>): number | undefined {
  // Anthropic: { type:'image', source:{ type:'base64', data } | { type:'url', url }
  //             | { type:'file', file_id } (S1 materialization) }
  if (node.type === 'image' && typeof node.source === 'object' && node.source !== null) {
    const src = node.source as { data?: unknown; url?: unknown; file_id?: unknown };
    if (typeof src.data === 'string') return src.data.length;
    if (typeof src.url === 'string') return src.url.length;
    if (typeof src.file_id === 'string') return src.file_id.length;
    return 0;
  }
  // OpenAI Responses: { type:'input_image', image_url: string } or
  // { type:'input_image', file_id: string } (S1 materialization)
  if (node.type === 'input_image') {
    if (typeof node.image_url === 'string') return node.image_url.length;
    if (typeof node.file_id === 'string') return node.file_id.length;
    return 0;
  }
  // Chat Completions: { type:'image_url', image_url: { url } }
  if (node.type === 'image_url' && typeof node.image_url === 'object' && node.image_url !== null) {
    const u = (node.image_url as { url?: unknown }).url;
    return typeof u === 'string' ? u.length : 0;
  }
  // Gemini: { inlineData: { data } }
  if (typeof node.inlineData === 'object' && node.inlineData !== null) {
    const d = (node.inlineData as { data?: unknown }).data;
    if (typeof d === 'string') return d.length;
  }
  return undefined;
}

export function measureWireMedia(history: unknown): WireMediaMeta {
  const meta: WireMediaMeta = { imageCount: 0, imageBytes: 0 };
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const bytes = nodeImageBytes(node as Record<string, unknown>);
    if (bytes !== undefined) {
      meta.imageCount += 1;
      meta.imageBytes += bytes;
      return; // an image node has no nested images
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  try {
    walk(history);
  } catch {
    /* never throw */
  }
  return meta;
}

/** Serialized size of the request skeleton — within ~200 bytes of the real HTTP
 *  body every lane sends (model/stream knobs excluded). 0 on any serialize error. */
export function measureRequestBytes(system: string, tools: unknown, history: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify({ system, tools, messages: history }));
  } catch {
    return 0;
  }
}
