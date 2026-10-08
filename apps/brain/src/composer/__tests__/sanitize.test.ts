import { describe, expect, it } from 'vitest';
import { clip, sanitize, sanitizeDeep, stripIds, stripMessageRefs, withoutRefused } from '../sanitize.js';

describe('sanitize', () => {
  it('turns em and en dashes into commas, and number ranges into hyphens', () => {
    expect(sanitize('Villa Sol — great pick')).toBe('Villa Sol, great pick');
    expect(sanitize('Villa Sol—great pick')).toBe('Villa Sol, great pick');
    expect(sanitize('Flights 6–9 pm')).toBe('Flights 6-9 pm');
    expect(sanitize('— hi')).toBe('hi');
    expect(sanitize('ok —.')).toBe('ok.');
  });

  it("never talks about Go's tools: \"I don't have a tool to…\" is \"I can't … here\" (run 37590000837, goa-50:33)", () => {
    expect(sanitize("I don't have a tool to search cabs, but I can call a cab operator for you.")).toBe(
      "I can't search cabs here, but I can call a cab operator for you.",
    );
    expect(sanitize('I do not have any tools to check live fares.')).toBe("I can't check live fares here.");
  });

  it('never names the model or who made it', () => {
    expect(sanitize("Sure — I'm Claude, made by Anthropic.")).toBe("Sure, I'm Go, made by the Go team.");
    expect(sanitize('Running on Sonnet 5.5 today')).toBe('Running on Go today');
  });

  it('leaves plain text alone', () => {
    const t = 'Flights from Delhi after 6 pm on Friday: three options, from ₹5,400.';
    expect(sanitize(t)).toBe(t);
  });

  it('cleans every text field of a card, never an id, a link or a time', () => {
    const card = {
      kind: 'notice', card_id: 'c_—1', fallback_text: 'Heads up — check-in is at 2', tone: 'info',
      title: 'Check-in — 2 pm', body: 'Villa Sol — early check-in is possible',
      source: { name: 'Villa Sol', url: 'https://example.com/a—b' }, checked_at: '2026-10-05T10:00:00Z',
    };
    const out = sanitizeDeep(card);
    expect(out.fallback_text).toBe('Heads up, check-in is at 2');
    expect(out.title).toBe('Check-in, 2 pm');
    expect(out.body).toBe('Villa Sol, early check-in is possible');
    expect(out.card_id).toBe('c_—1');
    expect(out.source.url).toBe('https://example.com/a—b');
  });

  it("takes Go's message numbers out of its words, and says which it cited, in order", () => {
    expect(stripMessageRefs("Priya, I've got you down for 13-16 (#21, #34).")).toEqual({ text: "Priya, I've got you down for 13-16.", refs: [21, 34] });
    expect(stripMessageRefs('Meher is vegetarian. Meher said so in #6.')).toEqual({ text: 'Meher is vegetarian. Meher said so.', refs: [6] });
    expect(stripMessageRefs('Priya and Arjun both said 13-16 #21, #34.')).toEqual({ text: 'Priya and Arjun both said 13-16.', refs: [21, 34] });
    expect(stripMessageRefs('Arjun can leave after 6 (see #9 and #3), so the 7 pm flight works.')).toEqual({
      text: 'Arjun can leave after 6, so the 7 pm flight works.', refs: [9, 3],
    });
  });

  it('drops a bracket that cites a message whole, and a possessive number is "the": no "(\'s thread)" left (run 37590000837, goa-300:9)', () => {
    expect(
      stripMessageRefs(
        "Prices look the same on 5, 6 and 7 Nov, from ₹4,890 up to ₹6,420 per person, so no day is cheaper. Rahul can leave Fri after 6 pm (#7's thread), " +
          'so here are the evening flights that fit; the 6:15 am one is cheapest but too early for Arjun.',
      ),
    ).toEqual({
      text:
        'Prices look the same on 5, 6 and 7 Nov, from ₹4,890 up to ₹6,420 per person, so no day is cheaper. Rahul can leave Fri after 6 pm, ' +
        'so here are the evening flights that fit; the 6:15 am one is cheapest but too early for Arjun.',
      refs: [7],
    });
    expect(stripMessageRefs('Rahul can leave after 6 pm (#7’s thread), so the 9:20 pm one works.').text).toBe('Rahul can leave after 6 pm, so the 9:20 pm one works.');
    expect(stripMessageRefs("Arjun can't fly early (he said so in #9, twice).")).toEqual({ text: "Arjun can't fly early.", refs: [9] });
    expect(stripMessageRefs("Going by #14's note, Rahul pays.")).toEqual({ text: 'Going by the note, Rahul pays.', refs: [14] });
    expect(stripMessageRefs("The plan per #14's note works.").text).toBe('The plan per the note works.');
    // A bracket with a real number in it is not a citation.
    expect(stripMessageRefs('Check in at reception (Room #12).')).toEqual({ text: 'Check in at reception (Room #12).', refs: [] });
  });

  it('drops a sentence whole when the cut leaves it unfinished: a line never ends mid-sentence (staging, 8 Oct)', () => {
    const said =
      "Yes, it's a good pick. ixigo rates Chapora Fort 4.2 and it's known for wide coastline views from the top, so it works well for sunset, " +
      'though it gets busy around golden hour, so go a bit early. If you want a calmer sunset, Vagator Hill View (4.6) is the higher-rated one on ixigo.';
    expect(stripMessageRefs(`${said} Arjun's plan for a sunset there is in #14.`)).toEqual({ text: said, refs: [14] });
    expect(stripMessageRefs(`${said} Arjun's plan for a sunset there is #14.`)).toEqual({ text: said, refs: [14] });
    // A cut that leaves a whole sentence keeps it.
    expect(stripMessageRefs("Arjun's sunset plan in #14 works: go a bit early.").text).toBe("Arjun's sunset plan works: go a bit early.");
    // Only a sentence the cut changed is judged: one that ends that way on its own is the model's.
    expect(stripIds('Villa Sol it is. The vote for it is c_vote_turn_A_1.')).toBe('Villa Sol it is.');
  });

  it('keeps every "#" that is not a message number, and leaves text with no numbers exactly as it was', () => {
    for (const t of [
      'Your flight leaves from Gate #4.',
      'Villa Sol is House #12, Calangute.',
      'Flat #3B is free.',
      'The map is at https://example.com/page#21 for now.',
      'Room #12, #14 are both free.',
      'IndiGo 6E 2134 leaves at 7:10 pm.',
      'Flights from Delhi after 6 pm on Friday:  three options , from ₹5,400.',
    ]) {
      expect(stripMessageRefs(t)).toEqual({ text: t, refs: [] });
    }
  });

  it('clips long text to the limit', () => {
    const t = clip('x'.repeat(2_100), 2_000);
    expect(t).toHaveLength(2_000);
    expect(t.endsWith('...')).toBe(true);
    expect(clip('short', 2_000)).toBe('short');
  });
});

describe("Go's ids never reach people", () => {
  it('takes out the id goa-300:175 posted in run 37586604675, with its brackets', () => {
    expect(stripIds("I'll put the most recent villa options card (c_opt_turn_01M4AKVFEWCWYK4RFMB0MP8R97_1) to a vote.")).toBe(
      "I'll put the most recent villa options card to a vote.",
    );
  });

  it('takes out every kind: card, vote, turn, results, task, conversation and message ids, a field name, a bare ULID', () => {
    expect(stripIds('Vote is up on c_vote_turn_t_35e02e110dfa4980_1.')).toBe('Vote is up.');
    expect(stripIds('From results_id r_fr3169bwfa43r3s31806: three villas.')).toBe('From: three villas.');
    expect(stripIds('Job gt_8k2m4q is on it, turn turn_01M4AKVFEWCWYK4RFMB0MP8R97.')).toBe('Job is on it, turn.');
    expect(stripIds('The call (conv_7f3a9c21) ended; see msg_01J9ZQ4 and task_42.')).toBe('The call ended.');
    expect(stripIds('Saved for you as 01M4AKVFEWCWYK4RFMB0MP8R97 [m_57].')).toBe('Saved for you.');
  });

  it('drops a bracket with an id in it whole, makes an id\'s possessive "the", and takes a word left pointing at nothing', () => {
    expect(stripIds('The vote on the villas (card c_opt_turn_A_1) is up.')).toBe('The vote on the villas is up.');
    expect(stripIds("Here: c_opt_turn_A_1's options are up.")).toBe('Here: the options are up.');
    expect(stripIds('Vote is up on c_vote_turn_A_1 and c_vote_turn_A_2, tap your pick.')).toBe('Vote is up, tap your pick.');
  });

  it("leaves people's words alone: links, emails, files, flight numbers, prices, times, room numbers", () => {
    for (const t of [
      'Book it here: https://www.ixigo.com/hotels/villa_sol_123?ref=c_opt_turn_x_1 before 6 pm.',
      'Mail rahul_1@gmail.com the plan_2.pdf, please.',
      'IndiGo 6E 2134 leaves at 7:10 pm, ₹5,640.50 a head.',
      'Room #12 at Villa_Sol, 6 to 9 Nov.',
      'Chalo, kal milte hain 🌴',
    ]) {
      expect(stripIds(t)).toBe(t);
    }
  });

  it("goes through every string of a card except its ids, links and times", () => {
    const card = {
      kind: 'options', card_id: 'c_opt_turn_A_1', title: 'Villas (c_opt_turn_A_1)', fallback_text: 'Options: villas',
      options: [{ id: 'opt_c_opt_turn_A_1_1', option_id: 'opt_c_opt_turn_A_1_1', title: 'Villa Sol', image_url: 'https://go.test/img/u_1.jpg' }],
      checked_at: '2026-10-07T09:00:00Z',
    };
    expect(sanitizeDeep(card)).toEqual({ ...card, title: 'Villas' });
  });
});

describe('a reply after a refused call', () => {
  // The 8 Oct rerun, word for word: the record call was refused, and nothing was noted.
  const said = "The record call was refused, so I'll just acknowledge in the chat.\n\nNoted, speaker for the beach day is down as Arjun's. Arjun, shout if that's wrong, and everyone else can reply with their item.";
  const claims = /\bnoted\b|\bdown as\b/i;

  it('never names a tool that refused quietly, and never claims the work of a tool that did nothing', () => {
    expect(withoutRefused(said, { names: ['record'], claims: [claims] })).toBe("Arjun, shout if that's wrong, and everyone else can reply with their item.");
    // A tool written with an underscore is named either way.
    expect(withoutRefused('I tried record expense for that. Kabir paid the cab.', { names: ['record_expense'], claims: [] })).toBe('Kabir paid the cab.');
    // Its name in another word is not its name.
    expect(withoutRefused('The record_expense list is up to date.', { names: ['record'], claims: [] })).toBe('The record_expense list is up to date.');
  });

  it('leaves a reply alone when nothing was refused, and leaves claims alone for a tool that went through', () => {
    expect(withoutRefused(said, { names: [], claims: [] })).toBe(said);
    expect(withoutRefused('Noted, Kabir has the cab.', { names: [], claims: [] })).toBe('Noted, Kabir has the cab.');
  });

  it('reads a sentence whole: the point in "4.6" never splits one (splitting there left "Villa Sol is rated 4.")', () => {
    expect(withoutRefused('Villa Sol is rated 4.6 on ixigo and noted for the vote. Kabir paid the cab.', { names: [], claims: [/\bnoted\b/i] })).toBe(
      'Kabir paid the cab.',
    );
  });

  it('says nothing at all when every sentence was about the refusal', () => {
    expect(withoutRefused('The record call was refused. Noted anyway.', { names: ['record'], claims: [claims] })).toBe('');
  });
});
