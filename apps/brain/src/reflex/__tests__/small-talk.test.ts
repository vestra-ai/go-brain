import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { codeFacts } from '../jev-reflex.js';
import { isSmallTalk } from '../small-talk.js';

describe('isSmallTalk: lines that wake no model when Jev has no answer', () => {
  // Lines from the bench's Goa chats (goa-50, goa-300, goa-2000), all labelled not for Go.
  it.each(['gn 😴', '😴', '😂😂😂', 'haha 😂', 'gm all ☀️', 'gm ☀️', 'gn all', 'gn guys', 'gn', 'gm', 'morning', 'morning all', 'brb', 'ok ok', 'lol', '👍'])(
    '%s is small talk',
    (text) => {
      expect(isSmallTalk(text)).toBe(true);
    },
  );

  it.each([
    // Not for Go either, but more than small talk: still woken when Jev is away.
    'same', 'ok noted', 'done 👍', 'back', 'sorry was driving', 'kya baat hai', "can't wait 🌴", 'chalo goodnight', '+1', 'fine fine 😂',
    // A question, or a line that may be the start of one.
    'anyone up?', "who's awake", 'ok?', 'wait', 'one more thing', 'ok so',
    // Lines Go should answer, or may.
    'kitna paisa lagega total roughly?', 'window seat for me pls 🙏', 'is there a good bakery near Anjuna?',
  ])('%s is not', (text) => {
    expect(isSmallTalk(text)).toBe(false);
  });

  it('reads laughs and greetings in any case, with emoji and an "all"', () => {
    expect(isSmallTalk('Hahaha')).toBe(true);
    expect(isSmallTalk('LOL!!')).toBe(true);
    expect(isSmallTalk('Good night everyone 🌙')).toBe(true);
    expect(isSmallTalk('ha')).toBe(false);
    expect(isSmallTalk('')).toBe(false);
    expect(isSmallTalk(null)).toBe(false);
  });

  it('is one of the code facts the reflex reads', () => {
    const m = msg(2, 'p_meher', 'gn 😴');
    expect(codeFacts(m, { trip: goaSnapshot(), messages: [m], seq: 2 }, []).smallTalk).toBe(true);
  });
});
