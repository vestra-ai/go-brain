import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { itemAad, masterKeyOf, open, openJson, seal, sealJson } from './envelope.js';

const master = randomBytes(32);
const aad = itemAad('p_rahul', 'card', 'cd_1');

describe('envelope', () => {
  it('opens what it sealed', () => {
    const sealed = sealJson(master, aad, { pm: 'pm_card_visa' });
    expect(openJson<{ pm: string }>(master, aad, sealed)).toEqual({ pm: 'pm_card_visa' });
  });

  it('never keeps the plaintext in the sealed bytes', () => {
    const sealed = seal(master, aad, Buffer.from('pm_card_visa'));
    expect(sealed.includes(Buffer.from('pm_card_visa'))).toBe(false);
  });

  it('uses a fresh data key and nonce every time', () => {
    const a = seal(master, aad, Buffer.from('same'));
    const b = seal(master, aad, Buffer.from('same'));
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to open a row copied to another person', () => {
    const sealed = seal(master, aad, Buffer.from('pm_card_visa'));
    expect(() => open(master, itemAad('p_priya', 'card', 'cd_1'), sealed)).toThrow();
  });

  it('refuses to open under another item id, or under additional data that names another kind', () => {
    const sealed = seal(master, aad, Buffer.from('pm_card_visa'));
    expect(() => open(master, itemAad('p_rahul', 'card', 'cd_2'), sealed)).toThrow();
    expect(() => open(master, Buffer.from('go-vault|v1|p_rahul|other|cd_1', 'utf8'), sealed)).toThrow();
  });

  it('refuses a flipped byte anywhere', () => {
    const sealed = seal(master, aad, Buffer.from('pm_card_visa'));
    for (const at of [1, 20, 40, 70, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = (bad[at] ?? 0) ^ 0xff;
      expect(() => open(master, aad, bad)).toThrow();
    }
  });

  it('refuses another master key', () => {
    const sealed = seal(master, aad, Buffer.from('pm_card_visa'));
    expect(() => open(randomBytes(32), aad, sealed)).toThrow();
  });

  it('refuses an unknown version and a short blob', () => {
    const sealed = seal(master, aad, Buffer.from('x'));
    const v2 = Buffer.from(sealed);
    v2[0] = 2;
    expect(() => open(master, aad, v2)).toThrow(/not readable/);
    expect(() => open(master, aad, Buffer.alloc(10))).toThrow(/not readable/);
  });

  it('reads the master key from base64 and checks its size', () => {
    expect(masterKeyOf(master.toString('base64')).equals(master)).toBe(true);
    expect(() => masterKeyOf(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
