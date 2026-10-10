import type { ToGoHandler } from './handlers.js';
import type { ToGoMethod } from './methods.js';
import { SocketCallError } from './rpc.js';

/**
 * A Server-to-Go method of contract 1.3 (rev 5) whose answer Go has not built yet: answered 409 conflict, "not available
 * yet", as 1.1's add_documents was, so the Server falls back cleanly (place_info: the idea keeps its own image;
 * get_option_details: the option's Details show what the card carries). The door answers so for any of NOT_YET with no
 * handler: the lane that builds one registers its handler as usual, and this answer stops.
 */
export function notYet<M extends ToGoMethod>(method: M): ToGoHandler<M> {
  return async () => {
    throw new SocketCallError(409, `${method} is not available yet.`, 'conflict');
  };
}

/** The 1.3 methods answered "not available yet" until their lanes answer them. */
export const NOT_YET: ReadonlySet<string> = new Set<ToGoMethod>(['place_info', 'get_option_details']);
