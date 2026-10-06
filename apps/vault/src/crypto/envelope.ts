import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for one vault item.
 *
 * Sealed layout: version (1) | wrap nonce (12) | wrap tag (16) | wrapped data key (32) | nonce (12) | tag (16) | ciphertext.
 * The data key is random per item and wrapped by the master key. Both layers use the same additional
 * authenticated data, which names the person and the item, so a copied row does not open.
 */
const VERSION = 1;
const MIN_LENGTH = 1 + 12 + 16 + 32 + 12 + 16;

/** Cards only this week (vault logins are cut, master §9). */
export type ItemKind = 'card';

export function itemAad(personId: string, kind: ItemKind, itemId: string): Buffer {
  return Buffer.from(`go-vault|v1|${personId}|${kind}|${itemId}`, 'utf8');
}

export function masterKeyOf(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('VAULT_MASTER_KEY must be 32 bytes');
  return key;
}

function lock(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function unlock(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function seal(master: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  if (master.length !== 32) throw new Error('VAULT_MASTER_KEY must be 32 bytes');
  const dataKey = randomBytes(32);
  try {
    const inner = lock(dataKey, plaintext, aad);
    const wrap = lock(master, dataKey, aad);
    return Buffer.concat([Buffer.from([VERSION]), wrap.iv, wrap.tag, wrap.ct, inner.iv, inner.tag, inner.ct]);
  } finally {
    dataKey.fill(0);
  }
}

export function open(master: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < MIN_LENGTH || sealed[0] !== VERSION) throw new Error('sealed item is not readable');
  let at = 1;
  const take = (n: number): Buffer => {
    const part = sealed.subarray(at, at + n);
    at += n;
    return part;
  };
  const wrapIv = take(12);
  const wrapTag = take(16);
  const wrapped = take(32);
  const iv = take(12);
  const tag = take(16);
  const ct = sealed.subarray(at);
  const dataKey = unlock(master, wrapIv, wrapTag, wrapped, aad);
  try {
    return unlock(dataKey, iv, tag, ct, aad);
  } finally {
    dataKey.fill(0);
  }
}

export function sealJson(master: Buffer, aad: Buffer, value: unknown): Buffer {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    return seal(master, aad, plain);
  } finally {
    plain.fill(0);
  }
}

export function openJson<T>(master: Buffer, aad: Buffer, sealed: Buffer): T {
  const plain = open(master, aad, sealed);
  try {
    return JSON.parse(plain.toString('utf8')) as T;
  } finally {
    plain.fill(0);
  }
}
