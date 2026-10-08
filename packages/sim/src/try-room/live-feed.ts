// openLiveFeed: one trip's live view from Go (/v1/live on Go's port): every recipe run as it happens, and the pictures of
// each page it opened. Signed on the server side with GO_SIGNING_SECRET, as the Server's socket is, so the secret never
// reaches a browser. Each open is signed fresh with a random n in its query: Go takes a signature once, and two tabs of
// one visit can open in the same second. While it is wanted, a dropped feed dials again, slower each time.
import { randomBytes } from 'node:crypto';
import * as C from '@go/contract';
import WebSocket from 'ws';

/** Told to the page when Go refuses the feed or is not reachable: the room's live column says it is off. */
export interface LiveOff {
  type: 'off';
  why: string;
}

export interface LiveFeedOptions {
  /** Go's base URL, as GO_URL. */
  goUrl: string;
  secret: string;
  tripId: string;
  /** Each message Go sends, parsed; and `off` while there is no feed. */
  onMessage: (m: unknown) => void;
  log?: (line: string) => void;
  /** Waits between dials after a drop, the last repeating. */
  waitsMs?: number[];
}

const WAITS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** The feed's address for a trip, with a fresh n. */
export function liveTarget(tripId: string): string {
  return `/v1/live?trip_id=${encodeURIComponent(tripId)}&n=${randomBytes(6).toString('hex')}`;
}

export function openLiveFeed(o: LiveFeedOptions): { close(): void } {
  const base = new URL(o.goUrl.replace(/^http/, 'ws'));
  const waits = o.waitsMs ?? WAITS_MS;
  let ws: WebSocket | null = null;
  let closed = false;
  let fails = 0;
  let timer: NodeJS.Timeout | null = null;

  const again = (why: string): void => {
    if (closed) return;
    o.onMessage({ type: 'off', why } satisfies LiveOff);
    const wait = waits[Math.min(fails, waits.length - 1)]!;
    fails += 1;
    timer = setTimeout(dial, wait);
    timer.unref();
  };

  function dial(): void {
    if (closed) return;
    const target = liveTarget(o.tripId);
    const sock = new WebSocket(`${base.protocol}//${base.host}${target}`, {
      headers: { [C.SIGNATURE_HEADER]: C.signRequest({ method: 'GET', target, body: '' }, o.secret) },
      maxPayload: 8 * 1024 * 1024,
    });
    ws = sock;
    let opened = false;
    sock.on('open', () => {
      opened = true;
      fails = 0;
    });
    sock.on('message', (data) => {
      try {
        o.onMessage(JSON.parse(data.toString()) as unknown);
      } catch {
        // not one of Go's messages: dropped
      }
    });
    sock.on('unexpected-response', (_req, res) => {
      o.log?.(`the live view of ${o.tripId} was refused: ${res.statusCode ?? 0}`);
      res.resume();
      sock.terminate();
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (ws === sock) ws = null;
      again(opened ? 'The live view dropped. Dialling again.' : "Go's live view is not answering.");
    });
  }

  dial();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.terminate();
      ws = null;
    },
  };
}
