import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { travelTools } from '../../travel/tools.js';
import { roomTools } from '../room-tools.js';
import { CARD_LINE, GO_RULES } from '../rules.js';

// The line that goes out with a card is written before the card tool runs and read with the card up (re-drill 5 on
// staging): "Priya said 4, so I'll show the options as searched. Picking the best few by rating and fit: …" with five
// on the card, and "I'll open the vote on the villa card from earlier" for a vote already open.
describe('the line that goes out with a card', () => {
  it('is the finished answer to whoever asked: one or two sentences, no reasoning, no "I\'ll", no options listed or counted', () => {
    expect(CARD_LINE).toContain('goes out with the card, once the card is up');
    expect(CARD_LINE).toContain('your finished answer to whoever asked, in one or two sentences, said to them, never about them by name');
    expect(CARD_LINE).toContain('never your reasoning or what you are about to do ("Picking the best few…", "I\'ll open the vote")');
    expect(CARD_LINE).toContain("Don't list or count the card's options: the card shows them.");
    expect(CARD_LINE).not.toMatch(/[—–]/);
  });

  it('is in the rules, right after the rule that writes it in the same reply as the card', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain(`- When you show options or open a vote, write your one line in the same reply as the card. ${CARD_LINE}\n`);
  });

  it('is in every card tool the line is written with: show_options, put_to_vote and open_vote', () => {
    const tools = [
      ...travelTools({} as Parameters<typeof travelTools>[0]),
      ...roomTools({ now: () => new Date('2026-10-07T09:00:00Z'), pool: {} as Pool }),
    ];
    for (const name of ['show_options', 'put_to_vote', 'open_vote']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(CARD_LINE);
    }
  });
});
