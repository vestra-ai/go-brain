/**
 * PushQueue — a minimal single-consumer async fan-out (K5-T7).
 *
 * The native loop drives the model and, when a tool batch runs, awaits each
 * tool's `gateAndDispatchTool`. Before T7 that await was a single suspension
 * point: a tool could not emit anything until it returned, so a long-running
 * watcher (Monitor) had no way to stream per-line output mid-turn.
 *
 * This queue closes that gap WITHOUT breaking K3's "the loop owns emission"
 * invariant. The tool is handed a `pushEvent` callback that calls `push(ev)`;
 * the loop concurrently drains the queue with `for await … of`, **yielding** each
 * event itself (the loop is the syntactic emitter → the driver/sink does the
 * real socket emit). When the dispatch promise settles it `close()`s the queue,
 * the drain completes, and the loop proceeds to yield the tool_result.
 *
 * Design:
 *  - Single consumer (the loop). Multiple producers are fine (the tool's
 *    listeners), but only ONE async-iterator is consumed.
 *  - push() before next() buffers (FIFO). next() before push() parks a resolver
 *    that push()/close() settles.
 *  - close() is idempotent; pushes after close() are ignored (the drain has
 *    already been told to end — never deliver post-close items).
 *  - Never throws. Inert for tools that never push: the queue stays empty and
 *    close() ends the (already-empty) iteration immediately → byte-identical to
 *    the pre-T7 single-await behavior.
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private pendingNext: ((res: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** Enqueue an item. Ignored once closed. Wakes a parked consumer immediately. */
  push(item: T): void {
    if (this.closed) return;
    if (this.pendingNext) {
      const resolve = this.pendingNext;
      this.pendingNext = null;
      resolve({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  /** End the stream. Idempotent. Settles a parked consumer as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingNext) {
      const resolve = this.pendingNext;
      this.pendingNext = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Deliver any buffered item first (FIFO), regardless of closed state, so
        // a close() that races a pending push still drains what was enqueued.
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.pendingNext = resolve;
        });
      },
    };
  }
}
