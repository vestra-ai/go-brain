import type { Message } from '../door/methods.js';
import type { Log } from '../log.js';
import type { ReflexRead } from '../reflex/reflex.js';
import type { TripPack } from './pack.js';

/** What a hook may say back about the message. */
export interface HookAnswer {
  /** The message is a whole ask (P4's travel search): the turn starts now, without the wait for more lines. */
  dueNow?: boolean;
}

type ReadHook = (msg: Message, read: ReflexRead, pack: TripPack) => Promise<void | HookAnswer>;

export interface MessageHooks {
  /** Runs after the door has answered, in seq order per trip. P2 saves facts and quiet ✅ reactions; P6 looks for openings. */
  onRead(fn: ReadHook): void;
}

export type HooksImpl = MessageHooks & { run(msg: Message, read: ReflexRead, pack: TripPack): Promise<HookAnswer> };

export function createMessageHooks(log: Log): HooksImpl {
  const fns: ReadHook[] = [];
  return {
    onRead(fn) {
      fns.push(fn);
    },
    async run(msg, read, pack) {
      let dueNow = false;
      for (const fn of fns) {
        try {
          if ((await fn(msg, read, pack))?.dueNow === true) dueNow = true;
        } catch (e) {
          log.error({ err: e, message: msg.message_id }, 'a message hook failed');
        }
      }
      return { dueNow };
    },
  };
}
