import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { FrameLog } from '../frames.js';
import { Link } from '../link.js';

/** A stand-in socket that keeps what is sent on it. */
function socket(): WebSocket & { sent: any[] } {
  const sent: any[] = [];
  return { sent, send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket & { sent: any[] };
}

function twoSockets() {
  const link = new Link(new FrameLog());
  const a = socket();
  const b = socket();
  link.attach(a, 'a');
  link.attach(b, 'b'); // b is the newest
  return { link, a, b };
}

describe('which socket a request goes on', () => {
  it('goes on the socket the event came on, not the newest', () => {
    const { link, a, b } = twoSockets();
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    link.notify('typing', { trip_id: 't_goa', on: true }, a);
    expect(a.sent.map((f) => f.method)).toEqual(['read_trip', 'typing']);
    expect(b.sent).toEqual([]);
  });

  it('goes on the newest open socket when the event came on a socket that has closed', () => {
    const { link, a, b } = twoSockets();
    link.detach(a);
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    link.notify('typing', { trip_id: 't_goa', on: true }, a);
    expect(a.sent).toEqual([]);
    expect(b.sent.map((f) => f.method)).toEqual(['read_trip', 'typing']);
  });

  it('goes again on the newest open socket, with the same id, when its socket closes before the answer', () => {
    const { link, a, b } = twoSockets();
    void link.request('read_trip', { trip_id: 't_goa' }, { via: a, timeoutMs: 50 }).catch(() => {});
    const [sent] = a.sent;
    link.detach(a);
    expect(b.sent).toEqual([sent]);
  });
});
