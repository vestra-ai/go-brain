/** Wraps the real model client for the live bench: records each body, the first text, the end and the provider's usage. */
import type { MessageBody, ProviderUsage, RequestLog } from './requests.js';

export interface StreamLike extends AsyncIterable<unknown> {
  finalMessage(): Promise<{ usage: ProviderUsage; content?: unknown }>;
  abort?(): void;
}
export interface ClientLike {
  messages: {
    stream(body: MessageBody, opts?: unknown): StreamLike;
    /** Side passes (P2's notes and fold) call create. */
    create?(body: MessageBody, opts?: unknown): Promise<{ usage: ProviderUsage; content?: unknown }>;
  };
}

/** The names of the tool_use blocks in a model's answer. */
function toolsOut(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: { type?: unknown; name?: unknown }) => (b?.type === 'tool_use' && typeof b.name === 'string' ? [b.name] : []));
}

function isTextDelta(ev: unknown): boolean {
  if (ev === null || typeof ev !== 'object') return false;
  const e = ev as { type?: unknown; delta?: { type?: unknown } };
  return e.type === 'content_block_delta' && e.delta?.type === 'text_delta';
}

export function recordingClient(real: ClientLike, log: RequestLog, simNow: () => number): ClientLike {
  const create = real.messages.create;
  return {
    messages: {
      stream(body, opts) {
        const rec = log.add(body, Date.now(), simNow());
        let inner: StreamLike;
        try {
          inner = real.messages.stream(body, opts);
        } catch (e) {
          rec.error = (e as Error).message;
          throw e;
        }
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const ev of inner) {
                if (rec.firstTokenMs === undefined && isTextDelta(ev)) rec.firstTokenMs = Date.now();
                yield ev;
              }
            } catch (e) {
              rec.error = (e as Error).message;
              throw e;
            }
            rec.doneMs ??= Date.now();
          },
          async finalMessage() {
            try {
              const m = await inner.finalMessage();
              rec.usage = m.usage;
              rec.toolsOut = toolsOut(m.content);
              rec.doneMs ??= Date.now();
              return m;
            } catch (e) {
              rec.error = (e as Error).message;
              throw e;
            }
          },
          abort() {
            inner.abort?.();
          },
        };
      },
      ...(create === undefined
        ? {}
        : {
            async create(body: MessageBody, opts?: unknown) {
              const rec = log.add(body, Date.now(), simNow());
              try {
                const m = await create.call(real.messages, body, opts);
                rec.usage = m.usage;
                rec.firstTokenMs = Date.now();
                rec.doneMs = rec.firstTokenMs;
                return m;
              } catch (e) {
                rec.error = (e as Error).message;
                throw e;
              }
            },
          }),
    },
  };
}
