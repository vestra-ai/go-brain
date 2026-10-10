import { describe, expect, it } from 'vitest';
import { GO_RULES } from '../rules.js';

describe("Go's rules", () => {
  it("read a travel fact ixigo shows from ixigo, never from memory, and say when an answer is general advice (EXAM, 10 Oct)", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain('- A fact of a train, bus, flight or stay that ixigo shows is read from ixigo in this turn, never from memory:');
    expect(section).toContain('tatkal times and charges');
    expect(section).toContain('Only general advice comes from what you know, and then say it is ("usually", "from what I know").');
  });

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
    // Agreed dates on a trip with a place get stays shown, not offered (lead, 8 Oct); an agreed place gets one offer of the
    // next step; a disagreement gets a vote offered.
    expect(section).toContain(
      "- A plan point you can move: when the group agrees dates on a trip that has a place, show stays for those dates with search_stays, the card and not an offer line (the trip's head start often has them already). When it agrees a place, offer the next step in one line (stays, how everyone gets there). When people disagree, offer a vote.",
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

  // The Server team, 10 Oct (GO-TEAM-ASKS-REV4 A3): no private budgets any more, one budget per person for the group.
  it("the trip has one budget, the group's; a person's own is never said to the room or tied to a name", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    const groupRule =
      "- The trip has one budget per person, the group's: set in the App, or settled in the chat and kept with set_budget. Never guess a person's own budget. " +
      "Suggesting what the group could plan for, when someone asks, is not guessing anyone's.";
    const noNames =
      "- Never repeat a person's budget to the room or tie a budget to a name, even one they said in the chat. When a budget matters, use the group's, without names.";
    expect(section).toContain(`${groupRule}\n${noNames}`);
    expect(section).not.toMatch(/lowest band|budget question/);
  });

  // Keshav's Go Live room, 9 Oct: "what should we keep the budget for the Goa trip?" got "I can't say": no check, no number,
  // and "never guess anyone's budget", read as covering the group's plan.
  it('a budget to plan for gets an answer like a well-travelled friend: ranges, grounded in stays when it can, and an offer to put it in the plan', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    const rule = section.split('\n').find((l) => l.startsWith('- When someone asks what budget to plan'))!;
    expect(rule).toBeDefined();
    // Never a refusal; per person and for the group, as typical ranges.
    expect(rule).toContain('never with "I can\'t say"');
    expect(rule).toContain('per person and for the whole group');
    expect(rule).toContain('ranges you call typical');
    // Grounded: with a place and dates, a stays search first and its prices with their age.
    expect(rule).toContain('with a place and dates, call search_stays first and use its prices, saying how old they are');
    expect(rule).toContain("getting there from each person's city, food a day and things to do");
    expect(rule).toContain('Say your assumptions');
    // The group's budget is said as the group's, never whose it was (GO-TEAM-ASKS-REV4 A3: no private bands any more),
    // and a yes goes into the plan through the record tool.
    expect(rule).toContain('When the group\'s budget is in "Right now", say whether the plan fits it.');
    expect(section).toContain("- Never repeat a person's budget to the room or tie a budget to a name, even one they said in the chat.");
    expect(rule).toContain('keep it with set_budget (the top of your range) and save it with record as one agreed line');
    expect(rule).toContain('with their yes as the proof (their own message, never yours).');
    // The rules it sits beside no longer forbid it: live prices only, and a person's own budget only.
    expect(section).toContain('No check, no live number. A budget to plan for is not a live price');
    expect(section).toContain("Never guess a person's own budget. Suggesting what the group could plan for, when someone asks, is not guessing anyone's.");
    expect(section).not.toContain('No check, no number.');
  });

  // Keshav, 9 Oct: "go should be super flexible, if users decide the budget it should stick to that, if they rather not and
  // genuinely have no idea it should gather that from context and intent".
  it('a budget the group decided sticks until they change it; with none, Go reads a working band from the group and never asks', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nTruth and money\n'), GO_RULES.indexOf('\nForget me\n'));
    const decided = section.split('\n').find((l) => l.startsWith('- A budget the group decided sticks'))!;
    expect(decided).toContain('keep it with set_budget');
    expect(decided).toContain('set the new one');
    expect(decided).toContain('when they drop it, clear it');
    // Keshav, 9 Oct: "no enforcement, rather it should be naturally decided": context, never a filter.
    expect(decided).toContain('strong context, never a hard filter');
    expect(decided).toContain('pick mostly within it');
    expect(decided).toContain('a standout a little over, shown and said plainly');
    expect(decided).toContain('when nothing good fits, say so and show the closest');
    expect(decided).toContain("One person's number alone is their wish");
    // Staging drill, 10 Oct: "picked to sit inside Rahul's 7.5k a head". The group's budget is never named for who said it.
    expect(decided).toContain('Say it as the group\'s ("your 7.5k a head"), never by who said it ("Rahul\'s 7.5k")');
    const none = section.split('\n').find((l) => l.startsWith('- With no budget decided'))!;
    expect(none).toContain('never ask the group for one');
    expect(none).toContain('the vibe');
    expect(none).toContain('what they liked or picked');
    expect(none).toContain('move it as they react');
    expect(none).toContain('never set_budget on a guess');
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

  it('never writes a message number: people never see them, and cutting one out left half a sentence (staging, 8 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain('- Never write a message number ("#57") in what you say: people don\'t see them. Say whose message it was, or leave it out.\n');
  });

  it('an offer follows from the message it answers: a birthday answer gets no villa offer (staging, 8 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nWhen you speak\n'), GO_RULES.indexOf('\nHow you write\n'));
    expect(section).toContain(
      '- An offer must follow from the message you are answering. Answer what was asked and stop: never add an offer about something else ("when is Meher\'s birthday?" gets the birthday, never "want me to pull up villas?").',
    );
  });

  it('brings up an open vote only when the message is about it, or once before it closes unseen: never as a tail, never on a refusal (staging, 8 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain(
      "- Bring up an open vote only when the message you are answering is about it or what it decides, or once when it is about to close with people who haven't voted. Never add it to a reply about something else, and never to a refusal.",
    );
  });

  it('never tells the room who used Forget me, nor that anyone asked Go to forget them (staging, 8 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nForget me\n'), GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain(
      "- Never tell the room that someone used Forget me or asked you to forget them. If someone asks about a thing you no longer know, say you don't have it, and never name the person or tie them to it yourself: never \"Meher can tell us directly if that matters\".",
    );
  });

  it('asks the group to pick with quick replies, never a list in its words (1.1 A3)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain(
      '- When you ask the group to pick between a few things (beach or mountains, North or South Goa), give the choices with offer_replies and ask the question in one line. Never list the choices in your words: they show as buttons.',
    );
  });

  it("never asks someone who said they're flexible to pick (1.1 A5)", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nVotes and the trip\n'));
    expect(section).toContain("- Someone who said they're flexible on a vote has voted: never ask them to pick.");
  });

  // The Server team, 10 Oct (GO-TEAM-ASKS-REV4 A2): expense approval was withdrawn, so every expense counts once added.
  it('says nothing of approving or disputing an expense: the App no longer asks', () => {
    expect(GO_RULES).not.toMatch(/disputed|pending|approve it/);
  });

  // The Server team, 10 Oct (GO-TEAM-ASKS-REV4 A4): the Server's own lines (money moved, a photo added) are a record;
  // on 8 Oct Go commented on one.
  it("reads the App's own lines as a record, never a message to answer", () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow to read what you are given\n'), GO_RULES.indexOf('\nWhen you speak\n'));
    expect(section).toContain(
      '- Lines from "App" are the App\'s own record of something that happened (an expense added, changed or removed, a payback, a photo added). ' +
        'They are facts you may use, never a message to you: never answer, thank or comment on one.',
    );
  });

  it('writes plain text, no markdown: the App shows it as it is (staging, 10 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow you write\n'), GO_RULES.indexOf('\nTruth and money\n'));
    expect(section).toContain('- Plain text only: no markdown, so no bold, no asterisks, no headings. A list someone asks for is one short line per item, starting with "- ".');
  });

  it('reads Prefers, Dislikes and Wants as leans, never rules (implicit signals, 10 Oct)', () => {
    const section = GO_RULES.slice(GO_RULES.indexOf('\nHow to read what you are given\n'), GO_RULES.indexOf('\nWhen you speak\n'));
    expect(section).toContain(
      "- A person's fact that starts with Prefers, Dislikes or Wants is a lean, not a rule: lean your picks toward it and mention it when it helps, but never drop an option over one.",
    );
  });

  it('use no em dashes or en dashes, as they ask of Go', () => {
    expect(GO_RULES).not.toMatch(/[—–]/);
  });
});
