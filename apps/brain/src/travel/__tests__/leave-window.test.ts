import { describe, expect, it } from 'vitest';
import { leaveWindow, spokenClock } from '../leave-window.js';

// The Goa trip flies on Friday 6 Nov 2026; Person.earliest_leave is a person's own words or a chip.
const FRIDAY = '2026-11-06';
const SATURDAY = '2026-11-07';

describe("a person's leaving words, as a flight's departure window", () => {
  it('reads a time and which side of it, in English and Hinglish', () => {
    for (const [words, after] of [
      ['Fri after 6 pm', '18:00'], ['6 ke baad', '18:00'], ['after 10 am', '10:00'], ['6:30pm', '18:30'], ['shaam 7 baje', '19:00'],
      ['raat 11 baje', '23:00'], ['subah 8 baje', '08:00'], ['13 Nov after 6', '18:00'], ['after 18:00', '18:00'],
    ] as const) {
      expect(leaveWindow(words, FRIDAY), words).toEqual({ kind: 'window', departAfter: after, words: `after ${spokenClock(after)}` });
    }
    expect(leaveWindow('before 2 pm', FRIDAY)).toEqual({ kind: 'window', departBefore: '14:00', words: 'before 2 pm' });
    expect(leaveWindow('2 baje se pehle', FRIDAY)).toEqual({ kind: 'window', departBefore: '14:00', words: 'before 2 pm' });
    expect(leaveWindow('between 2 and 6 pm', FRIDAY)).toEqual({ kind: 'window', departAfter: '14:00', departBefore: '18:00', words: '2 pm to 6 pm' });
  });

  it('reads a part of the day with no number', () => {
    expect(leaveWindow('Friday evening', FRIDAY)).toEqual({ kind: 'window', departAfter: '17:00', words: 'after 5 pm' });
    expect(leaveWindow('subah', FRIDAY)).toEqual({ kind: 'window', departBefore: '12:00', words: 'before noon' });
    expect(leaveWindow('office ke baad', FRIDAY)).toEqual({ kind: 'window', departAfter: '18:00', words: 'after 6 pm' });
    expect(leaveWindow('dopahar', FRIDAY)).toEqual({ kind: 'window', departAfter: '12:00', departBefore: '17:00', words: 'noon to 5 pm' });
  });

  it("sets no window for another day's limit, a day alone, any time, or nothing said", () => {
    expect(leaveWindow('Fri evening', SATURDAY)).toEqual({ kind: 'any' });
    expect(leaveWindow('shukrawar 6 ke baad', SATURDAY)).toEqual({ kind: 'any' });
    for (const words of ['Friday', 'whenever', 'jab bhi', 'kabhi bhi', 'anytime', '', null, undefined]) expect(leaveWindow(words, FRIDAY), String(words)).toEqual({ kind: 'any' });
  });

  it("says when it can't read the words, for the line to say so", () => {
    expect(leaveWindow('not sure yet', FRIDAY)).toEqual({ kind: 'unread', text: 'not sure yet' });
  });

  it('says a 24-hour time as people do', () => {
    expect(['12:00', '00:00', '18:00', '06:05', '23:30'].map(spokenClock)).toEqual(['noon', 'midnight', '6 pm', '6:05 am', '11:30 pm']);
  });
});
