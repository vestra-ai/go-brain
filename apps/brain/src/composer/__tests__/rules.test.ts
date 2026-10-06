import { describe, expect, it } from 'vitest';
import { GO_RULES } from '../rules.js';

describe("Go's rules", () => {
  it('send "forget me" to the App: Go cannot forget from the chat and never says it did', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nForget me\n'), GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain("You cannot forget anyone from the chat. If someone asks you in the chat to forget them or what you know about them, say you can't do that from here");
    expect(section).toContain('"Forget me in this trip" on their You screen in the App');
    expect(section).toContain('Never say you forgot or deleted anything about a person yourself.');
  });

  it("one person's preference gets a ✅ and quiet, not a question to the group", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      "- One person saying what they'd like (a place, a date, a budget) is their preference: note it with a ✅ and stay quiet. Don't ask the group to confirm it unless someone asks you.",
    );
  });

  it('never tell the group about a tool, what it returned or a refusal; tell_the_room is what to say', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain(
      "- Never mention your tools, what they returned, or that something was refused; just carry on. A tool result's tell_the_room says what, if anything, to tell the group.",
    );
  });

  it('use no em dashes or en dashes, as they ask of Go', () => {
    expect(GO_RULES).not.toMatch(/[—–]/);
  });
});
