import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ToGoMethod, ToGoParams, ToGoResult } from './methods.js';
import type { ServerLink } from './server-link.js';

/**
 * The socket a request came on: instance is the replica's own name (?instance=, 'default' when none), server the name
 * every replica of one Server shares (?server=), absent when the Server names none.
 */
export interface SocketFrom {
  instance: string;
  server?: string;
}

/** How a lane answers one of the Server's requests. */
export type ToGoHandler<M extends ToGoMethod> = (
  params: ToGoParams<M>,
  meta: SocketFrom & { frameId: string },
) => Promise<ToGoResult<M>>;

/** Takes over one WebSocket upgrade on Go's port: the handler checks its own auth and finishes (or refuses) the upgrade. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface Door {
  /** One handler per method; P1 registers send_event and card_tap. A method with no handler answers -32601. */
  handle<M extends ToGoMethod>(method: M, handler: ToGoHandler<M>): void;
  /** Other WebSocket paths on Go's port (P6: Twilio's media stream at /calls/media/:callId). Checked before the /v1/socket rule. */
  onUpgrade(path: RegExp, handle: UpgradeHandler): void;
  link: ServerLink;
}
