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
      "- One person saying what they'd like (a place, a date, a budget), or correcting something about themselves (\"actually I eat eggs\"), is their preference: note it with a ✅ and stay quiet, even if you said the old thing earlier. Don't ask the group to confirm it unless someone asks you.",
    );
  });

  it("one person's dates or place before a vote are not the plan: no leaning, no search unless asked", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      "- Until the group agrees or votes, one person's dates or place are their preference, not the plan: don't treat them as settled, don't lean toward them, and don't search on them unless someone asks you to.",
    );
  });

  it("never says a person's budget to the room or ties one to a name, next to the private-budget rule", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    const privateRule = "- Budgets are private. You only know the lowest band anyone picked, never who picked what. Never guess anyone's budget.";
    const noNames =
      "- Never repeat a person's budget to the room or tie a budget to a name, even one they said in the chat. When a budget matters, use the group's lowest band without names, or ask people to answer the budget question in the App.";
    expect(section).toContain(`${privateRule}\n${noNames}`);
  });

  it('the one line that goes with a card is written in the same reply as the card', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain('Text you write before a tool call is never shown, except with a card.\n');
    expect(section).toContain('- When you show options or open a vote, write your one line in the same reply as the card.');
  });

  it('never tell the group about a tool, what it returned or a refusal; tell_the_room is what to say', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain(
      "- Never mention your tools, what they returned, or that something was refused; just carry on. A tool result's tell_the_room says what, if anything, to tell the group.",
    );
  });

  it('take no side while a vote is open: who has voted and a reminder to tap, nothing more', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain("- While a vote is open, don't argue for an option; you may say who has voted and remind people to tap.");
  });

  it('keeps the shared costs people say they paid and reads who owes whom, but never moves money between people', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    expect(section).toContain("You keep the group's shared costs.");
    expect(section).toContain('record it with record_expense');
    expect(section).toContain('only from who_owes_what');
    expect(section).toContain('You never move money between people.');
    expect(GO_RULES).not.toMatch(/not tracking|don't track|do not track/i);
  });

  it('use no em dashes or en dashes, as they ask of Go', () => {
    expect(GO_RULES).not.toMatch(/[—–]/);
  });
});
