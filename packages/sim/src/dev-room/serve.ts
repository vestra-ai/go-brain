// serveDevRoom: the dev room, a one-page App for the simulator and the emergency demo surface. It serves the
// page and a live WebSocket at /live: the page gets the room's state after every change and sends what people
// do (say, tap, vote, react, the payer's yes or no, "Forget me in this trip"), which the FakeServer turns into
// events and requests for Go.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FakeServer } from '../fake-server.js';
import { PAGE_HTML } from './page.js';

export interface DevRoomOptions {
  fake: FakeServer;
  /** 0 picks a free port. */
  port: number;
  /** Default 127.0.0.1. Use 0.0.0.0 to open it from a phone on the same network. */
  host?: string;
  /** Default: the trip created last. */
  tripId?: string;
}

export interface DevRoom {
  url: string;
  close(): Promise<void>;
}

/** What the page may send. Anything else is ignored. */
type Action =
  | { type: 'say'; personId: string; text: string }
  | { type: 'tap'; cardId: string; actionId: string; personId: string; optionId?: string }
  | { type: 'vote'; decisionId: string; personId: string; optionIndex: number }
  | { type: 'react'; personId: string; messageId: string; emoji: string }
  | { type: 'confirm'; decisionId: string }
  | { type: 'decline'; decisionId: string }
  | { type: 'forget'; personId: string };

/** The App's words when a forget did not go through: never tell the person they were forgotten (guide 05). */
const FORGET_FAILED = "Go couldn't forget you just now. Try again.";

/** "Forget me in this trip", as the App does it, and the toast the person sees. */
async function forget(fake: FakeServer, personId: string, tripId: string): Promise<string> {
  const name = fake.trip(tripId).people.find((p) => p.person_id === personId)?.name;
  if (!name) throw new Error(`personId: ${personId} is not in this trip`);
  try {
    // Go's ForgetResult only parses with remaining_facts 0: it checked that nothing is left.
    await fake.forgetPerson(personId, tripId);
    return `Done. Nothing about ${name} is left.`;
  } catch {
    return FORGET_FAILED;
  }
}

/** What the page draws: the trip, the room, Go's typing, and each person's "needs you" list. */
export function roomState(fake: FakeServer, tripId: string) {
  const trip = fake.trip(tripId);
  return {
    type: 'state' as const,
    connected: fake.isOpen(),
    trip,
    messages: fake.messages(tripId),
    typing: fake.typingOn(tripId),
    needs: Object.fromEntries(trip.people.map((p) => [p.person_id, fake.needsYou(p.person_id, tripId)])),
  };
}

export async function serveDevRoom(o: DevRoomOptions): Promise<DevRoom> {
  const tripId = o.tripId ?? o.fake.tripIds().at(-1);
  if (!tripId) throw new Error('create a trip first: fake.createTrip(goaFreshTrip())');
  const host = o.host ?? '127.0.0.1';

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  const wss = new WebSocketServer({ noServer: true });

  const push = (ws: WebSocket): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(roomState(o.fake, tripId)));
  };
  const pushAll = (): void => {
    for (const c of wss.clients) push(c);
  };

  const act = async (ws: WebSocket, text: string): Promise<void> => {
    let a: Action;
    try {
      a = JSON.parse(text) as Action;
    } catch {
      return;
    }
    try {
      switch (a.type) {
        case 'say': {
          const words = typeof a.text === 'string' ? a.text.trim() : '';
          if (words) await o.fake.say(a.personId, words, { tripId });
          break;
        }
        case 'tap':
          ws.send(JSON.stringify({ type: 'tap_result', result: await o.fake.tap(a.cardId, a.actionId, a.personId, a.optionId) }));
          break;
        case 'vote':
          await o.fake.vote(a.decisionId, a.personId, a.optionIndex);
          break;
        case 'react':
          await o.fake.react(a.personId, a.messageId, a.emoji);
          break;
        case 'confirm':
          await o.fake.confirmMandate(a.decisionId);
          break;
        case 'decline':
          await o.fake.declineMandate(a.decisionId);
          break;
        case 'forget':
          ws.send(JSON.stringify({ type: 'forget_result', personId: a.personId, toast: await forget(o.fake, a.personId, tripId) }));
          break;
        default:
          break;
      }
    } catch (err) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    }
  };

  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      push(ws);
      ws.on('message', (data) => void act(ws, data.toString()));
      ws.on('error', () => {});
    });
  });

  let queued = false;
  const off = o.fake.onChange(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      pushAll();
    }, 30); // a burst of changes is one update
  });
  // A redraw every second as well, so "Go is typing..." goes away when it runs out.
  const tick = setInterval(pushAll, 1000);

  await new Promise<void>((resolve) => http.listen(o.port, host, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    close: async () => {
      off();
      clearInterval(tick);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
