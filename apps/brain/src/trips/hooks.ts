import type { Message } from '../door/methods.js';
import type { Log } from '../log.js';
import type { ReflexRead } from '../reflex/reflex.js';
import type { TripPack } from './pack.js';

export interface MessageHooks {
  /** Runs after the door has answered, in seq order per trip. P2 saves facts and quiet ✅ reactions; P6 looks for openings. */
  onRead(fn: (msg: Message, read: ReflexRead, pack: TripPack) => Promise<void>): void;
}

export type HooksImpl = MessageHooks & { run(msg: Message, read: ReflexRead, pack: TripPack): Promise<void> };

export function createMessageHooks(log: Log): HooksImpl {
  const fns: Array<(msg: Message, read: ReflexRead, pack: TripPack) => Promise<void>> = [];
  return {
    onRead(fn) {
      fns.push(fn);
    },
    async run(msg, read, pack) {
      for (const fn of fns) {
        try {
          await fn(msg, read, pack);
        } catch (e) {
          log.error({ err: e, message: msg.message_id }, 'a message hook failed');
        }
      }
    },
  };
}
