import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 10 characters of time in milliseconds, then 16 random ones. Sorts by time. */
export function newUlid(nowMs: number = Date.now()): string {
  let time = '';
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (const b of randomBytes(16)) rand += ALPHABET.charAt(b % 32);
  return time + rand;
}
