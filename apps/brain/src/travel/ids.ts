import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh id: the prefix, an underscore, 20 random characters. */
export function mintId(prefix: string): string {
  return `${prefix}_${base32(randomBytes(13)).slice(0, 20)}`;
}

/** The same parts always give the same id, so a retried step writes the same thing once. */
export function stableId(prefix: string, ...parts: Array<string | number>): string {
  const hash = createHash('sha256').update(parts.join('\u0000')).digest();
  return `${prefix}_${base32(hash).slice(0, 24)}`;
}
