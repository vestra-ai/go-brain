/**
 * replace_card for working cards: at most one update every 6 seconds per card, the updates in between folded into the
 * newest; a new picture of the screen may go 1 second after the last update, so the card's window looks live. A change
 * of state (needs you, done, didn't work, stopped) goes out at once. Updates to one card go in order.
 */
import type { ServerLink } from '../door/server-link.js';
import type { WorkingCardT } from './working-card.js';

export const CARD_GAP_MS = 6_000;
/** The gap before an update that carries a new picture of the screen. */
export const FRAME_GAP_MS = 1_000;
/** A failed update is tried once more after this long: a card that rides with a turn's message may not be posted yet. */
export const CARD_RETRY_MS = 3_000;

export interface CardUpdater {
  push(tripId: string, card: WorkingCardT, opts?: { now?: boolean; gapMs?: number }): void;
  /** Sends every waiting update now and waits for all of them. */
  flush(): Promise<void>;
}

interface Slot {
  /** The card has been pushed done or failed: a job never comes back, so a later live card is a stale one. */
  ended: boolean;
  lastAt: number;
  pending: { tripId: string; card: WorkingCardT } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the waiting timer fires. */
  dueAt: number;
  chain: Promise<void>;
}

export function createCardUpdater(d: {
  link: Pick<ServerLink, 'request'>;
  log: { warn(obj: object, msg: string): void };
  gapMs?: number;
  retryMs?: number;
  nowMs?: () => number;
}): CardUpdater {
  const gap = d.gapMs ?? CARD_GAP_MS;
  const retryMs = d.retryMs ?? CARD_RETRY_MS;
  const clock = d.nowMs ?? Date.now;
  const slots = new Map<string, Slot>();

  const send = (slot: Slot, cardId: string, retried = false): void => {
    const p = slot.pending;
    if (!p) return;
    slot.pending = null;
    slot.lastAt = clock();
    slot.chain = slot.chain
      .then(() => d.link.request('replace_card', { trip_id: p.tripId, card: p.card }))
      .then(
        () => undefined,
        (err: unknown) => {
          d.log.warn({ err, cardId, retried }, 'tasks: a working card update failed');
          // Once more, a little later, unless a newer update is already waiting.
          if (retried || slot.pending || slot.timer) return;
          slot.pending = p;
          slot.timer = setTimeout(() => {
            slot.timer = null;
            send(slot, cardId, true);
          }, retryMs);
          slot.timer.unref?.();
        },
      );
  };

  return {
    push(tripId, card, opts) {
      let slot = slots.get(card.card_id);
      if (!slot) {
        slot = { ended: false, lastAt: Number.NEGATIVE_INFINITY, pending: null, timer: null, dueAt: 0, chain: Promise.resolve() };
        slots.set(card.card_id, slot);
      }
      const ends = card.state === 'done' || card.state === 'failed';
      if (slot.ended && !ends) return;
      if (ends) slot.ended = true;
      slot.pending = { tripId, card };
      const wait = slot.lastAt + (opts?.gapMs ?? gap) - clock();
      if (opts?.now || wait <= 0) {
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
        send(slot, card.card_id);
        return;
      }
      // A waiting update goes no later than the newest one asks: a new picture brings a step update's 6 s forward.
      if (slot.timer && clock() + wait < slot.dueAt) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (!slot.timer) {
        const s = slot;
        s.dueAt = clock() + wait;
        s.timer = setTimeout(() => {
          s.timer = null;
          send(s, card.card_id);
        }, wait);
        s.timer.unref?.();
      }
    },
    async flush() {
      for (const [cardId, slot] of slots) {
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
          send(slot, cardId);
        }
      }
      await Promise.all([...slots.values()].map((s) => s.chain));
    },
  };
}
