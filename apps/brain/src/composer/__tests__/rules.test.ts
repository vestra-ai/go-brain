import { describe, expect, it } from 'vitest';
import { GO_RULES } from '../rules.js';

describe("Go's rules", () => {
  it('send "forget me" to the App: Go cannot forget from the chat and never says it did', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nForget me\n'), GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain("You cannot forget anyone from the chat. If someone asks you in the chat to forget them or what you know about them, say you can't do that from here");
    expect(section).toContain('"Forget me in this trip" on their You screen in the App');
    expect(section).toContain('Never say you forgot or deleted anything about a person yourself.');
  });

  it("one person's preference gets a ✅ and at most one short offer, never a search on it and not a question to the group", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      "- One person saying what they'd like (a place, a date, a budget), or correcting something about themselves (\"actually I eat eggs\"), is their preference: note it with a ✅ and make at most one short offer (\"want me to pull up North Goa stays?\"), even if you said the old thing earlier. Never search on it unless someone asks you to, and don't ask the group to confirm it.",
    );
    expect(section).not.toContain('stay quiet');
  });

  it('is proactive (Keshav, 2026-10-08): helps whenever it can add something real, even unnamed', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).not.toContain('quiet is the default');
    expect(section).toContain('- Help whenever you can add something real, even when nobody names you.');
    // A question Go can answer gets answered without an @, unless a person already did.
    expect(section).toContain(
      '- A question you can answer: someone in the chat asks something you can answer with facts from ixigo or the trip (the record, votes, money, places). Answer it, unless a person already did.',
    );
    // Agreed dates or a place get one offer of the next step; a disagreement gets a vote offered.
    expect(section).toContain(
      '- A plan point you can move: when the group agrees dates or a place, offer the next step in one line (stays for those dates, how everyone gets there). When people disagree, offer a vote.',
    );
    expect(section).toContain('- Something wrong or at risk: say so.');
  });

  it('stays silent only for banter, reactions, side talk, what a person handled, and never posts twice in a row without a person', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      '- Stay silent (call stay_silent) only for banter and greetings, reactions, a side conversation not about the trip, something a person already handled, or when your last message has had no reply from a person since: never two messages in a row, unless the second is a result you promised.',
    );
    expect(section).toContain('- One reply per burst: when several messages came together, answer them in one message.');
  });

  it('a line marked as answering Go\'s question is a reply to Go, right under "speak when someone replies to you"', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      'and when a vote closed or a decision is ready to move.\n- A line marked "(answers Go\'s question #N)" is that person answering what you asked them in #N: it is a reply to you, even without @Go and even much later.\n',
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

  it("the one line that goes with a card is the card tool's line", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain('Text you write before a tool call is never shown.\n');
    expect(section).toContain("- When you show options or open a vote, say it in the card tool's line, not in your reply's text.");
  });

  it('never tell the group about a tool, what it returned or a refusal; tell_the_room is what to say', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain(
      "- Never mention your tools, what they returned, or that something was refused; just carry on. A tool result's tell_the_room says what, if anything, to tell the group.",
    );
  });

  it('take no side while a vote is open: who has voted, only from the vote line, and a reminder to tap; a secret ballot is counts only', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain(
      "- While a vote is open, don't argue for an option; you may say who has voted and who hasn't, only as the vote's line in \"right now\" names them, and remind people to tap. A secret ballot is counts only: never say who has or hasn't voted.",
    );
  });

  it('keeps the shared costs people say they paid and reads who owes whom, but never moves money between people', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    expect(section).toContain("You keep the group's shared costs.");
    expect(section).toContain('record it with record_expense');
    expect(section).toContain('only from who_owes_what');
    expect(section).toContain('You never move money between people.');
    expect(GO_RULES).not.toMatch(/not tracking|don't track|do not track/i);
  });

  it("never narrates its own steps, reasons or tools, nor announces a card: \"I'll show the options card now\" is the case that reached the room", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    const line =
      "- Never describe your own steps, reasons or tools, and never announce a card or a vote (\"I'll show the options card now\", \"I'll open a vote\"): the card shows itself. Say only what the group needs: the answer, the card, the next step.";
    expect(section).toContain(line);
  });

  it('use no em dashes or en dashes, as they ask of Go', () => {
    expect(GO_RULES).not.toMatch(/[—–]/);
  });
});
