import { describe, expect, it } from 'vitest';
import { addressesGo, chatCounts, parseChat } from '../chat.js';

const say = (i: number, at: number, person: string, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ i, at, kind: 'say', person, text, go_should_speak: false, ...extra });
const ev = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('recorded chats', () => {
  it('reads every kind of line and counts them', () => {
    const text = [
      say(0, 0, 'p_rahul', 'Goa is on'),
      say(1, 5, 'p_priya', '@Go flights on Friday?', { go_should_speak: true, reflex: { for_go: true } }),
      ev({ i: 2, at: 9, kind: 'edit', of: 0, text: 'Goa is ON' }),
      ev({ i: 3, at: 12, kind: 'react', of: 1, person: 'p_meher', emoji: '🔥' }),
      say(4, 20, 'p_kabir', 'Dinner at home on Sunday', { photo: { caption: 'A plate of rajma chawal' } }),
      ev({ i: 5, at: 21, kind: 'delete', of: 4 }),
      say(6, 30, 'p_meher', 'so we are going', { recall: [{ question: 'Is Goa on?', answer: 'ON', line: 0 }] }),
      '',
    ].join('\n');
    const chat = parseChat('tiny', text);
    expect(chat.lines.map((l) => l.kind)).toEqual(['say', 'say', 'edit', 'react', 'say', 'delete', 'say']);
    expect(chatCounts(chat)).toEqual({
      lines: 7, messages: 4, peopleMessages: 4, goLines: 0, edits: 1, deletes: 1, reactions: 1, photos: 1,
      asks: 1, either: 0, probes: 1, people: ['p_kabir', 'p_meher', 'p_priya', 'p_rahul'],
    });
  });

  it("keeps the message number a trip export writes on a line, and refuses one that is not a positive whole number", () => {
    const chat = parseChat('exported', [say(0, 0, 'p_rahul', 'Goa is on', { seq: 12 }), say(1, 4, 'p_priya', 'yes!')].join('\n'));
    const [first, second] = chat.lines;
    expect(first).toMatchObject({ kind: 'say', seq: 12 });
    expect(second).not.toHaveProperty('seq');
    expect(() => parseChat('bad', say(0, 0, 'p_rahul', 'hi', { seq: 0 }))).toThrow(/bad:1:/);
    expect(() => parseChat('bad', say(0, 0, 'p_rahul', 'hi', { seq: 2.5 }))).toThrow(/bad:1:/);
  });

  it('names the row that is not JSON', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'hi')}\n{oops`)).toThrow(/bad:2: not JSON/);
  });

  it('names the row that breaks the schema', () => {
    expect(() => parseChat('bad', say(0, 0, 'rahul', 'hi'))).toThrow(/bad:1:/);
    expect(() => parseChat('bad', ev({ i: 0, at: 0, kind: 'shout', text: 'hi' }))).toThrow(/bad:1:/);
  });

  it('refuses a line whose number is not its position', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'a')}\n${say(5, 1, 'p_rahul', 'b')}`)).toThrow(/line 1 says i=5/);
  });

  it('refuses time going backwards', () => {
    expect(() => parseChat('bad', `${say(0, 10, 'p_rahul', 'a')}\n${say(1, 9, 'p_rahul', 'b')}`)).toThrow(/line 1 goes back in time/);
  });

  it('refuses an edit or reaction that points forward, at itself or at a deleted message', () => {
    expect(() => parseChat('bad', `${say(0, 0, 'p_rahul', 'a')}\n${ev({ i: 1, at: 1, kind: 'edit', of: 1, text: 'b' })}`)).toThrow(/edit 1 is not an earlier message/);
    const deletedThenEdited = [say(0, 0, 'p_rahul', 'a'), ev({ i: 1, at: 1, kind: 'delete', of: 0 }), ev({ i: 2, at: 2, kind: 'edit', of: 0, text: 'b' })].join('\n');
    expect(() => parseChat('bad', deletedThenEdited)).toThrow(/edit 0 was deleted/);
    const reactToEdit = [say(0, 0, 'p_rahul', 'a'), ev({ i: 1, at: 1, kind: 'edit', of: 0, text: 'b' }), ev({ i: 2, at: 2, kind: 'react', of: 1, person: 'p_priya', emoji: '👍' })].join('\n');
    expect(() => parseChat('bad', reactToEdit)).toThrow(/react 1 is not an earlier message/);
  });

  it('refuses a recall proof that is deleted anywhere in the chat, or is not earlier', () => {
    const later = [
      say(0, 0, 'p_meher', 'allergic to prawns'),
      say(1, 1, 'p_rahul', 'ok', { recall: [{ question: 'What is Meher allergic to?', answer: 'prawn', line: 0 }] }),
      ev({ i: 2, at: 2, kind: 'delete', of: 0 }),
    ].join('\n');
    expect(() => parseChat('bad', later)).toThrow(/recall proof 0 is deleted/);
    expect(() => parseChat('bad', say(0, 0, 'p_rahul', 'x', { recall: [{ question: 'who?', answer: 'x', line: 0 }] }))).toThrow(/recall proof 0 is not an earlier message/);
  });

  it('a line Go said must be labelled "either" and is not a person\'s message', () => {
    expect(() => parseChat('bad', say(0, 0, 'go', 'Hi all', { go_should_speak: true }))).toThrow(/a line Go said must be "either"/);
    const onlyGo = parseChat('only-go', [say(0, 0, 'go', 'Hi all', { go_should_speak: 'either' }), say(1, 4, 'go', 'Who is coming?', { go_should_speak: 'either' })].join('\n'));
    expect(chatCounts(onlyGo)).toMatchObject({ messages: 2, peopleMessages: 0, goLines: 2, asks: 0, people: [] });
  });

  it('knows when a line calls Go, and when "go" is an ordinary word', () => {
    for (const t of ['@Go flights Delhi to Goa Friday evening?', 'Go, find us a villa', 'go: what about hotels', 'ok go, check trains', 'Go bhai abhi book kar de', 'hey @go can you check'])
      expect(addressesGo(t), t).toBe(true);
    for (const t of ['we need to go back there this time', "let's go to Thalassa", 'go karte hain kal', 'Guys Goa is ON', 'Goa, finally!', 'I will go with Priya', 'email me at go@vestra.ai'])
      expect(addressesGo(t), t).toBe(false);
  });
});
