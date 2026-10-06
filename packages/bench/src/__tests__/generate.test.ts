import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addressesGo, CHATS_DIR, chatCounts, checkChat, loadChat, type SayLine } from '../chat.js';
import { expandSkeleton, FILLER, rng, say, serializeChat, type Skeleton } from '../generate.js';
import { GOA_2000 } from '../skeletons/goa-2000.js';
import { GOA_300 } from '../skeletons/goa-300.js';

const saysOf = (lines: readonly { kind: string }[]): SayLine[] => lines.filter((l): l is SayLine => l.kind === 'say');

describe('the chat generator', () => {
  it('has a seeded random source that stays in [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(rng(8)()).not.toBe(rng(7)());
  });

  it('has no filler that calls Go', () => {
    for (const f of FILLER) expect(addressesGo(f.text), f.text).toBe(false);
  });

  it('expands the 300 skeleton to exactly 300 messages that pass every check, the same bytes every time', () => {
    const a = expandSkeleton(GOA_300);
    expect(chatCounts(a).messages).toBe(300);
    expect(checkChat(a.lines)).toEqual([]);
    expect(serializeChat(expandSkeleton(GOA_300))).toBe(serializeChat(a));
    expect(serializeChat(expandSkeleton({ ...GOA_300, seed: 301 }))).not.toBe(serializeChat(a));
  });

  it('matches the committed chats byte for byte (regenerate with: pnpm --filter @go/bench gen-chats)', () => {
    for (const sk of [GOA_300, GOA_2000])
      expect(readFileSync(new URL(`${sk.name}.jsonl`, CHATS_DIR), 'utf8'), sk.name).toBe(serializeChat(expandSkeleton(sk)));
  });

  it('keeps only the skeleton\'s calls to Go, and its asks are at least a minute apart', () => {
    for (const sk of [GOA_300, GOA_2000]) {
      const says = saysOf(expandSkeleton(sk).lines);
      const skeletonCalls = sk.entries.filter((e) => e.kind === 'say' && addressesGo(e.text)).length;
      expect(says.filter((l) => addressesGo(l.text)).length, sk.name).toBe(skeletonCalls);
      const asks = says.filter((l) => l.go_should_speak === true);
      for (let k = 1; k < asks.length; k++) expect((asks[k] as SayLine).at - (asks[k - 1] as SayLine).at, sk.name).toBeGreaterThanOrEqual(60);
    }
  });

  it('the 300 chat deletes a message deep in the cached part of the chat and keeps its burst whole', () => {
    const chat = loadChat('goa-300');
    const del = chat.lines.find((l) => l.kind === 'delete');
    expect(del?.kind === 'delete' ? del.i - del.of : 0).toBeGreaterThanOrEqual(50);
    const end = chat.lines.findIndex((l) => l.kind === 'say' && l.text === 'is there a good bakery near Anjuna?');
    const burst = chat.lines.slice(end - 4, end + 1);
    expect(burst.every((l) => l.kind === 'say' && l.person === 'p_meher')).toBe(true);
    expect((burst[4]?.at ?? 0) - (burst[0]?.at ?? 0)).toBeLessThan(5);
  });

  it('the 2,000 chat asks eight recall questions near the end, seven about facts from the first evening', () => {
    const chat = loadChat('goa-2000');
    expect(chatCounts(chat).messages).toBe(2000);
    const asker = saysOf(chat.lines).find((l) => l.recall !== undefined);
    expect(asker?.i).toBeGreaterThan(1500);
    expect(asker?.recall?.length).toBe(8);
    // Seven facts were said on the first evening; who pays the villa advance was agreed on day 3. All of them long before the end.
    const proofs = (asker?.recall ?? []).map((p) => p.line);
    expect(proofs.filter((n) => n < 300)).toHaveLength(7);
    for (const n of proofs) expect(n).toBeLessThan(1000);
  });

  it('puts no chatter into a night marked quiet', () => {
    const lines = expandSkeleton(GOA_300).lines;
    const gn = lines.findIndex((l) => l.kind === 'say' && l.text === 'gn guys');
    const next = lines[gn + 1];
    expect(next?.kind === 'say' ? next.text : '').toBe('gm ☀️');
  });

  it('refuses a skeleton with a broken name or more lines than the chat', () => {
    const bad: Skeleton = { name: 'x', seed: 1, messages: 1, entries: [say(0, 'p_rahul', 'a', false), { kind: 'delete', at: 10, ref: 'nope' }] };
    expect(() => expandSkeleton(bad)).toThrow(/unknown ref nope/);
    expect(() => expandSkeleton({ name: 'x', seed: 1, messages: 0, entries: [say(0, 'p_rahul', 'a', false)] })).toThrow(/more messages than the chat/);
  });
});
