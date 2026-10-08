import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { z } from 'zod';
import { toolDefs } from '../loop.js';
import { NAMES_ONLY_FROM_IXIGO } from '../../travel/book/tool.js';
import { travelTools } from '../../travel/tools.js';
import { roomTools } from '../room-tools.js';
import { CARD_LINE, GO_RULES } from '../rules.js';

// The words posted with a card are the card tool's own `line`. A reply's free text is written before the card goes up
// and read after it, so it was the model's working. Run 37586604675:
//   goa-300:73  "Casa Mareia is above the cap (₹16,900 a night is over ₹40,000 for 5? No, it fits), so all four fit the 8k a
//                head limit. I'll show the best three by rating and value."
//   goa-300:175 "I'll put the most recent villa options card (c_opt_turn_01M4AKVFEWCWYK4RFMB0MP8R97_1) to a vote."
//   goa-50:24   "Five people at under 8k a head is ₹40,000 a night, so everything fits the cap. "Near the beach" rules out
//                the 15 and 20 minute ones. I'll show the best-rated villas that are close to the beach."
const cardTools = () =>
  [...travelTools({} as Parameters<typeof travelTools>[0]), ...roomTools({ now: () => new Date('2026-10-07T09:00:00Z'), pool: {} as Pool })].filter((t) =>
    ['show_options', 'put_to_vote', 'open_vote'].includes(t.name),
  );

describe('the line that goes out with a card', () => {
  it('is the card tool\'s line, the only words posted: the finished answer, no reasoning, no "I\'ll", no options listed or counted', () => {
    expect(CARD_LINE).toContain("The card tool's line is the message posted with the card, and the only words posted with it");
    expect(CARD_LINE).toContain('your finished answer to whoever asked, in one or two sentences, said to them, never about them by name');
    expect(CARD_LINE).toContain('never your reasoning or what you are about to do ("Picking the best few…", "I\'ll open the vote")');
    expect(CARD_LINE).toContain("Don't list or count the card's options: the card shows them.");
    expect(CARD_LINE).not.toMatch(/[—–]/);
  });

  it('is in the rules, and text before a tool call is never shown, a card or not', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain("- When you show options or open a vote, say it in the card tool's line, not in your reply's text. " + `${CARD_LINE}\n`);
    expect(section).toContain('Text you write before a tool call is never shown.\n');
    expect(section).not.toContain('except with a card');
  });

  it('is a required argument of show_options, put_to_vote and open_vote, and each description says how it reads', () => {
    const tools = cardTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['open_vote', 'put_to_vote', 'show_options']);
    for (const def of toolDefs(tools)) {
      expect(def.description, def.name).toContain(CARD_LINE);
      expect((def.input_schema as { required?: string[] }).required, def.name).toContain('line');
      expect((def.input_schema.properties as Record<string, { description?: string }>)['line']?.description, def.name).toMatch(/^The message posted with the card/);
    }
    for (const t of tools) expect(() => (t.input as z.ZodType).parse({ results_id: 'r_1', title: 'x', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }), t.name).toThrow(/line/);
  });
});

describe('what Go knows without a check', () => {
  // Run 37586604675: "I can't check live cafe listings from here, so I won't name specific places and risk a wrong one."
  // Drill 7 Oct: "Perch Coffee" and "Plum by Bohemian Cafe" in Assagao, which don't exist: a venue's name comes from ixigo.
  it('says distances, the area, tips and seasonal weather plainly; names a venue only from ixigo or the group', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    expect(section).toContain(
      '- Prices, availability and opening hours: only give what you checked in this turn, or say how old it is ("checked 10 min ago"). No check, no number.\n' +
        '- Everything else a well-travelled friend knows, say plainly, with no "I can\'t check live" caveat: distances and travel times, what an area is like, ' +
        'local tips, and the usual weather for the season.\n' +
        '- Name a particular cafe, restaurant, bar, beach or sight only when it came from ixigo in this turn (the destination guide through the ixigo tool, ' +
        'or search results) or someone in the group named it. Without that, talk about the area, never a name from memory, and offer what ixigo has. ' +
        'Do this quietly and never say why you can or can\'t name a place (never "Chapora Fort was named by Priya, so I can talk about it"): ' +
        'just name it, or talk about the area. When ixigo\'s places don\'t match the ask exactly, offer the nearest ones it has, with no word about what it lacks ' +
        '(never "ixigo doesn\'t have an Anjuna shack guide, so I can\'t say which one").\n',
    );
  });

  // p5's robustness drill, 8 Oct: "Chapora Fort was named by Priya, so I can talk about it." The venue rule, said to the room.
  it('applies the venue rule quietly: never says why it may or may not name a place, nor do the ixigo tool\'s notes invite it', () => {
    const venue = GO_RULES.split('\n').find((l) => l.startsWith('- Name a particular cafe'))!;
    expect(venue).toContain('never say why');
    expect(venue).toContain('just name it, or talk about the area.');
    expect(NAMES_ONLY_FROM_IXIGO).toContain("never say why you can or can't name one");
    // Nothing the room is told asks Go to give a reason for a name.
    expect(NAMES_ONLY_FROM_IXIGO).not.toMatch(/\b(explain|because|tell (them|the group) why)\b/i);
  });

  // p1-a's facts pass, 8 Oct: "ixigo doesn't have an Anjuna shack guide, Kabir, so I can't say which one has the best seafood."
  it('offers the nearest places ixigo has, with no word about what it lacks', () => {
    const venue = GO_RULES.split('\n').find((l) => l.startsWith('- Name a particular cafe'))!;
    expect(venue).toContain('offer the nearest ones it has, with no word about what it lacks');
    expect(NAMES_ONLY_FROM_IXIGO).toContain("offer the nearest ones in them, with no word about what ixigo doesn't have.");
  });
});
