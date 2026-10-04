/**
 * Anthropic lane wire-pass: url image sources → Files API file_id (media-refs
 * S1, spec §Rule 3). Runs inside callModel on the provider-shaped messages —
 * the canonical history (journal + in-memory) keeps the url form; only the
 * wire copy is substituted. Clone-only-touched-nodes (the media-rail pattern):
 * when nothing resolves, the ORIGINAL array reference is returned, so the
 * flag-off/no-image path is reference-identical, and repeated calls over a
 * grown history substitute the SAME cached file_id for the same url —
 * deterministic substitution keeps the provider prompt-cache prefix stable.
 * Per-image fallback: an unresolved url keeps its url source (never throws).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { anthropicFileIdFor } from './provider-file-ids.js';

// Local structural types — deliberately NOT intersected with the SDK's block
// unions (whose narrower tool_result content union collapses predicate
// intersections to `never`); all narrowing starts from `unknown`.
interface UrlImageBlock {
  type: 'image';
  source: { type: 'url'; url: string };
}
interface ToolResultWithBlocks {
  type: 'tool_result';
  content: unknown[];
}

function isUrlImage(b: unknown): b is UrlImageBlock {
  const img = b as { type?: string; source?: { type?: string; url?: string } };
  return (
    img?.type === 'image' && img.source?.type === 'url' && typeof img.source.url === 'string'
  );
}

function isToolResultWithBlocks(b: unknown): b is ToolResultWithBlocks {
  const tr = b as { type?: string; content?: unknown };
  return tr?.type === 'tool_result' && Array.isArray(tr.content);
}

/** Collect every distinct url that appears as an image source in user messages. */
function collectUrls(messages: Anthropic.MessageParam[]): string[] {
  const urls = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content as unknown[]) {
      if (isUrlImage(block)) urls.add(block.source.url);
      else if (isToolResultWithBlocks(block)) {
        for (const inner of block.content) if (isUrlImage(inner)) urls.add(inner.source.url);
      }
    }
  }
  return [...urls];
}

/** True when the history carries ≥1 url-sourced image (top-level or tool_result). */
export function hasUrlImageSources(messages: Anthropic.MessageParam[]): boolean {
  return collectUrls(messages).length > 0;
}

export async function materializeAnthropicFileIds(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
): Promise<{ messages: Anthropic.MessageParam[]; usedFileIds: boolean }> {
  const urls = collectUrls(messages);
  if (urls.length === 0) return { messages, usedFileIds: false };

  const resolutions = await Promise.all(
    urls.map(async (url) => [url, await anthropicFileIdFor(url, client)] as const),
  );
  const fileIds = new Map(resolutions.filter(([, id]) => id !== null) as Array<[string, string]>);
  if (fileIds.size === 0) return { messages, usedFileIds: false };

  const substitute = (b: unknown): unknown => {
    if (isUrlImage(b)) {
      const id = fileIds.get(b.source.url);
      if (id) {
        return { type: 'image', source: { type: 'file', file_id: id } };
      }
      return b;
    }
    if (isToolResultWithBlocks(b)) {
      let touched = false;
      const inner = b.content.map((c) => {
        const next = substitute(c);
        if (next !== c) touched = true;
        return next;
      });
      return touched ? { ...b, content: inner } : b;
    }
    return b;
  };

  let anyTouched = false;
  const out = messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as unknown[]).map((block) => {
      const next = substitute(block);
      if (next !== block) touched = true;
      return next;
    });
    if (!touched) return m;
    anyTouched = true;
    return { ...m, content: content as Anthropic.ContentBlockParam[] };
  });

  return anyTouched
    ? { messages: out, usedFileIds: true }
    : { messages, usedFileIds: false };
}

/**
 * Lazy stream facade — lets the sync `callModel` defer the async materialize +
 * stream start to the first read. Mirrors the engine's retry contract exactly:
 * "callModel's stream surfaces its 429 on the first read" — materialization
 * errors surface the same way. Only the two surfaces `readStream` consumes are
 * provided: async iteration and `finalMessage()`.
 */
export function deferredAnthropicStream<
  T extends AsyncIterable<unknown> & { finalMessage(): Promise<unknown> },
>(start: () => Promise<T>): AsyncIterable<unknown> & { finalMessage(): Promise<unknown> } {
  let started: Promise<T> | undefined;
  const get = () => (started ??= start());
  return {
    async *[Symbol.asyncIterator]() {
      yield* await get();
    },
    async finalMessage() {
      return (await get()).finalMessage();
    },
  };
}
