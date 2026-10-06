// What the FakeServer saw from Go, read the way the end-to-end checks and the smoke run need it: times in ms.
import type { FakeServer, WriteRecord } from '@go/sim';

/** One of Go's writes as the FakeServer saw it. `applied` is true for the arrival that changed the trip. */
export interface Seen {
  method: string;
  request_id: string;
  params: Record<string, any>;
  applied: boolean;
  /** When it arrived, in ms since the epoch. */
  at: number;
}

const seen = (w: WriteRecord): Seen => ({
  method: w.method,
  request_id: w.request_id,
  params: w.params as Record<string, any>,
  applied: w.applied,
  at: Date.parse(w.at),
});

/** Every write Go sent, repeats included, in arrival order. */
export const writesOf = (fake: FakeServer): Seen[] => fake.writes.map(seen);

/** Waits for the first write that matches. */
export function waitWrite(fake: FakeServer, pred: (w: Seen) => boolean, timeoutMs = 10_000): Promise<Seen> {
  return fake.waitFor(() => writesOf(fake).find(pred), timeoutMs);
}

/** Go's typing notifications (requests, never writes), with their arrival times in ms. */
export function typingOf(fake: FakeServer): Array<{ tripId: string; on: boolean; at: number }> {
  return fake.requests
    .filter((r) => r.method === 'typing')
    .map((r) => ({ tripId: String(r.params.trip_id), on: r.params.on === true, at: Date.parse(r.at) }));
}

/** Waits for typing on (or off) that arrived at or after `since` (ms). */
export function waitTyping(fake: FakeServer, on: boolean, since: number, timeoutMs = 2_000): Promise<{ tripId: string; on: boolean; at: number }> {
  return fake.waitFor(() => typingOf(fake).find((t) => t.on === on && t.at >= since), timeoutMs);
}

/** How many arrivals of this write changed the trip: 1 means the Server did Go's write once, however often it arrived. */
export function appliedCount(fake: FakeServer, requestId: string): number {
  return fake.writes.filter((w) => w.params.request_id === requestId && w.applied).length;
}

/** Messages Go posted (each counted once, when it was applied) whose text contains `text`. */
export function postsWith(fake: FakeServer, text: string): Seen[] {
  return writesOf(fake).filter(
    (w) => w.method === 'post_message' && w.applied && typeof w.params.text === 'string' && w.params.text.includes(text),
  );
}
