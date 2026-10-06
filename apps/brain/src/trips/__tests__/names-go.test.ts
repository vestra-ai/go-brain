import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { endsThought, plainlyNamesGo } from '../names-go.js';

const pack = { trip: goaSnapshot(), messages: [msg(2, null, 'Want a vote on the villa?')], seq: 2 };

describe('plainlyNamesGo: when "Go is typing..." shows at once', () => {
  it.each([
    ['@Go flights Friday?', true],
    ['Go, find us a villa', true],
    ['Go bhai abhi book kar de', true],
    ['thoughts, Go?', true],
    ['hey go what is the weather', true],
    ['thanks Go', true],
    ["let's go to the beach", false],
    ['go to sleep guys', false],
    ['goa is going to be hot', false],
    ['we should go', false],
    ['lol', false],
  ])('%s', (text, want) => {
    expect(plainlyNamesGo(msg(3, 'p_priya', text, { mentions_go: false }), pack)).toBe(want);
  });

  it('a reply to Go names Go, and so does the Server\'s mentions_go', () => {
    expect(plainlyNamesGo(msg(3, 'p_priya', 'yes please', { reply_to: 'm_2' }), pack)).toBe(true);
    expect(plainlyNamesGo(msg(3, 'p_priya', 'ok', { mentions_go: true }), pack)).toBe(true);
  });
});

describe('endsThought: a message to Go that needs no wait for more', () => {
  it.each([
    ['@Go flights Friday?', true],
    ['Go, put the dates to a vote please.', true],
    ['Go bhai abhi book kar de villa, Rahul ka card use kar le 😂', true],
    ['thanks Go 🙏🏽', true],
    ['Go, check the cab!  ', true],
    ['@Go can you', false],
    ['@Go one thing', false],
    ['Go wait', false],
    ['@Go can you also check...', false],
    ['@Go hmm…', false],
    ['', false],
  ])('%s', (text, want) => {
    expect(endsThought(text)).toBe(want);
  });

  it('reads no text as unfinished', () => {
    expect(endsThought(null)).toBe(false);
    expect(endsThought(undefined)).toBe(false);
  });
});
