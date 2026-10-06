import { describe, expect, it } from 'vitest';
import { addressesGo, chatCounts, loadChat, type SayLine } from '../chat.js';

const chat = loadChat('goa-50');
const says = chat.lines.filter((l): l is SayLine => l.kind === 'say');
const HINGLISH = /\b(bhai|yaar|haan|toh|bhi|wala|wali|mein|kar|gaye|ghar|ka|na)\b/i;

/** The lines by the same person ending at line n, each at most 5 s after the one before. */
function burstEndingAt(n: number): SayLine[] {
  const last = chat.lines[n] as SayLine;
  const out: SayLine[] = [last];
  for (let k = n - 1; k >= 0; k--) {
    const p = chat.lines[k];
    const first = out[0] as SayLine;
    if (p === undefined || p.kind !== 'say' || p.person !== last.person || first.at - p.at > 5) break;
    out.unshift(p);
  }
  return out;
}

/** The text each message ends with, after edits. */
function finalText(): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of chat.lines) {
    if (l.kind === 'say') m.set(l.i, l.text);
    if (l.kind === 'edit') m.set(l.of, l.text);
  }
  return m;
}

describe('the Goa chat, 50 messages', () => {
  it('has 50 messages, one edit, one delete, one reaction and one photo, from all five people, inside an hour', () => {
    expect(chatCounts(chat)).toMatchObject({
      lines: 53, messages: 50, peopleMessages: 50, edits: 1, deletes: 1, reactions: 1, photos: 1,
      people: ['p_arjun', 'p_kabir', 'p_meher', 'p_priya', 'p_rahul'],
    });
    expect(chat.lines[chat.lines.length - 1]?.at).toBeLessThanOrEqual(3600);
  });

  it('mixes English and Hinglish', () => {
    expect(says.filter((l) => HINGLISH.test(l.text)).length).toBeGreaterThanOrEqual(8);
  });

  it('labels every line that calls Go as a place Go speaks (or may)', () => {
    for (const l of says) if (addressesGo(l.text)) expect(l.go_should_speak, l.text).not.toBe(false);
  });

  it('every ask calls Go itself or ends a burst that does', () => {
    const asks = says.filter((l) => l.go_should_speak === true);
    expect(asks.length).toBe(6);
    for (const a of asks) expect(burstEndingAt(a.i).some((l) => addressesGo(l.text)), a.text).toBe(true);
  });

  it('has a burst of five lines in under five seconds that ends in an ask', () => {
    const bursts = says.map((l) => burstEndingAt(l.i)).filter((b) => b.length >= 5);
    expect(bursts.length).toBe(1);
    const b = bursts[0] as SayLine[];
    expect((b[b.length - 1] as SayLine).at - (b[0] as SayLine).at).toBeLessThan(5);
    expect((b[b.length - 1] as SayLine).go_should_speak).toBe(true);
    expect(b.slice(0, -1).every((l) => l.reflex?.complete === false)).toBe(true);
  });

  it('marks a quiet reaction as fine on every line the reflex should react to', () => {
    const reacted = says.filter((l) => l.reflex?.reaction !== undefined);
    expect(reacted.length).toBeGreaterThanOrEqual(6);
    for (const l of reacted) expect(l.quiet_ok, l.text).toBe(true);
  });

  it('has quick asks, one big job and one attempt to make Go pay', () => {
    expect(says.filter((l) => l.reflex?.size === 'big').length).toBe(1);
    expect(says.filter((l) => l.reflex?.size === 'quick').length).toBe(5);
    expect(says.some((l) => l.go_should_speak === true && /card/i.test(l.text) && /book/i.test(l.text))).toBe(true);
  });

  it('has chatter where "go" is an ordinary word, labelled quiet', () => {
    const line = says.find((l) => l.text === 'we need to go back there this time');
    expect(line?.go_should_speak).toBe(false);
  });

  it('asks memory five questions at the end, about facts said early, answered by the text after edits', () => {
    const last = says[says.length - 1] as SayLine;
    expect(last.recall?.length).toBe(5);
    const text = finalText();
    for (const p of last.recall ?? []) {
      expect(p.line).toBeLessThan(40);
      expect(text.get(p.line)?.toLowerCase(), p.question).toContain(p.answer.toLowerCase());
    }
  });

  it('deletes a wrong-group message right away and edits an early fact much later', () => {
    const del = chat.lines.find((l) => l.kind === 'delete');
    const edit = chat.lines.find((l) => l.kind === 'edit');
    expect(del?.kind === 'delete' && chat.lines[del.of]?.kind === 'say' && del.i - del.of <= 3).toBe(true);
    expect(edit?.kind === 'edit' && edit.i - edit.of >= 20).toBe(true);
  });
});
