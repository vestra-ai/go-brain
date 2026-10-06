/**
 * The only file that calls @go/sim's FakeServer. P1's startRoom creates, connects and stops it; the replay
 * talks to this small port over it; if the FakeServer changes a name, only this file changes.
 */
import type { TripSnapshot } from '@go/contract';
import { goaFreshTrip, type FakeServer } from '@go/sim';
import type { GoFrame } from './score.js';

/** Photos in a replay point here; Go only reads their captions. */
export const BENCH_PHOTO_URL = 'https://cdn.go.example/bench/photo.jpg';

export interface SimPort {
  trip(): TripSnapshot;
  createTrip(trip: TripSnapshot): Promise<void>;
  say(tripId: string, personId: string, text: string, opts: { photoCaption?: string; replyTo?: string }): Promise<{ messageId: string; seq: number }>;
  edit(personId: string, messageId: string, text: string): Promise<void>;
  remove(personId: string, messageId: string): Promise<void>;
  react(personId: string, messageId: string, emoji: string): Promise<void>;
  /** Every request and notification Go sent about this trip, in arrival order, `at` in wall-clock ms. */
  frames(tripId: string): GoFrame[];
  /** Wall clock of Go's latest frame for this trip, 0 before any. */
  lastFrameAt(tripId: string): number;
}

/** Wraps the FakeServer startRoom already connected (room.fake); room.stop() stops it. */
export function simPort(fs: FakeServer): SimPort {
  const frames = (tripId: string): GoFrame[] =>
    fs.requests.filter((r) => r.params['trip_id'] === tripId).map((r) => ({ method: r.method, params: r.params, at: Date.parse(r.at) }));
  return {
    trip: () => goaFreshTrip(),
    createTrip: async (trip) => {
      await fs.createTrip(trip);
    },
    say: async (tripId, personId, text, so) => {
      const m = await fs.say(personId, text, {
        tripId,
        ...(so.photoCaption !== undefined ? { attachments: [{ kind: 'photo' as const, url: BENCH_PHOTO_URL, caption: so.photoCaption }] } : {}),
        ...(so.replyTo !== undefined ? { replyTo: so.replyTo } : {}),
      });
      return { messageId: m.message_id, seq: m.seq };
    },
    edit: async (personId, messageId, text) => {
      await fs.edit(personId, messageId, text);
    },
    remove: async (personId, messageId) => {
      await fs.delete(personId, messageId);
    },
    react: async (personId, messageId, emoji) => {
      await fs.react(personId, messageId, emoji);
    },
    frames,
    lastFrameAt: (tripId) => frames(tripId).reduce((latest, f) => Math.max(latest, f.at), 0),
  };
}
