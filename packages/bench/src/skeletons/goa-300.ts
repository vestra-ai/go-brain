/** The 300-message chat: four days of planning. Facts on the first evening, a late delete deep in the cached part, recall at the end. */
import { clock, say, type Skeleton } from '../generate.js';

const R = 'p_rahul';
const P = 'p_priya';
const A = 'p_arjun';
const M = 'p_meher';
const K = 'p_kabir';
const NOTED = { fact: true, reaction: '✅' };
const QUICK = { complete: true, size: 'quick' } as const;

export const GOA_300: Skeleton = {
  name: 'goa-300',
  seed: 300,
  messages: 300,
  entries: [
    say(clock(0, 19, 0), R, 'Goa trip is happening!! 6 to 9 Nov, Diwali weekend 🌴', false, { quiet_ok: true }),
    say(clock(0, 19, 12), M, "Also it's my birthday on the 7th so be ready 🎂", false, { ref: 'meher_bday', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 18), P, "I'm veg btw, pls remember when we pick places", false, { ref: 'priya_veg', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 20), M, "and I'm allergic to prawns. Not fun last time 😅", false, { ref: 'meher_prawns', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 25), P, 'window seat for me pls 🙏', false, { ref: 'priya_seat', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 30), A, "no flights before 9 am for me, I can't do early flights", false, { ref: 'arjun_early', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 40), R, '@Go which days are cheapest to fly Delhi to Goa around 6 Nov?', true, { reflex: QUICK }),
    say(clock(0, 19, 50), K, "I don't drink btw, so count me out of the bar bill", false, { ref: 'kabir_drink', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 55), R, 'My address for the airport cab pickup: B-42, Lajpat Nagar 2, near the gurudwara', false, { ref: 'rahul_address', note: 'Deleted two days later, deep inside the cached part of the chat.' }),
    say(clock(0, 21, 10), P, '@Go any veg-friendly cafes in Assagao?', true, { reflex: QUICK }),
    say(clock(0, 22, 0), P, 'agreed then, villa under 8k a head per night, final', false, { ref: 'villa_agree', quiet_ok: true }),
    say(clock(0, 22, 5), M, '+1', false, { quiet_ok: true }),
    say(clock(0, 22, 6), K, '+1 💯', false, { quiet_ok: true }),
    say(clock(1, 0, 30), R, 'gn guys', false, { quietAfter: true }),
    say(clock(1, 8, 40), M, 'gm ☀️', false),
    { kind: 'edit', at: clock(1, 9, 10), ref: 'priya_seat', text: 'aisle seat for me pls 🙏 changed my mind' },
    say(clock(1, 9, 12), P, 'edited my seat thing, aisle is better for me', false, { quiet_ok: true }),
    say(clock(1, 10, 15), K, '@Go how far is Mopa airport from Anjuna?', true, { reflex: QUICK }),
    say(clock(1, 12, 0), K, 'this is the vibe I want', false, { photo: 'A white villa with a blue pool and palm trees around it' }),
    say(clock(1, 13, 30), R, 'Go, find us a villa with a pool in North Goa under 8k a head, near the beach', true, { ref: 'villa_ask', reflex: { complete: true, size: 'big' } }),
    { kind: 'react', at: clock(1, 13, 32), ref: 'villa_ask', person: M, emoji: '🔥' },
    say(clock(1, 18, 0, 0), M, 'ok', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 1), M, 'wait', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 2), M, '@Go one thing', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(1, 18, 0, 3), M, 'for my birthday on the 7th', 'either', { reflex: { complete: false } }),
    say(clock(1, 18, 0, 4), M, 'is there a good bakery near Anjuna?', true, { reflex: { for_go: true, complete: true, size: 'quick' }, note: 'End of a burst of five.' }),
    say(clock(1, 21, 20), A, '@Go flights from Bangalore to Goa on Friday after 7 pm?', true, { reflex: QUICK }),
    say(clock(2, 0, 10), K, 'gn', false, { quietAfter: true }),
    say(clock(2, 8, 50), R, 'morning all', false),
    say(clock(2, 9, 30), P, '@Go is it safe to swim at Vagator in November?', true, { reflex: QUICK }),
    say(clock(2, 12, 0), R, 'deleting my address msg, privacy 😅', false),
    { kind: 'delete', at: clock(2, 12, 0, 5), ref: 'rahul_address' },
    say(clock(2, 15, 0), R, '@Go put the three villas to a vote please', true, { reflex: QUICK }),
    say(clock(2, 18, 30), M, 'sunset from the office terrace lol', false, { photo: 'Orange sky over office buildings in Mumbai at sunset' }),
    say(clock(2, 19, 0), R, "Who's paying the villa advance? I can put it on my card", false, { quiet_ok: true }),
    say(clock(2, 19, 3), M, 'yes Rahul pays the advance, we UPI him', false, { ref: 'advance', quiet_ok: true }),
    say(clock(2, 20, 45), K, "ok go, what's the best way from the airport, cab or bus?", true, { reflex: QUICK }),
    say(clock(3, 0, 5), P, 'gn all', false, { quietAfter: true }),
    say(clock(3, 9, 0), A, 'gm, last day of work this week 😂', false),
    say(clock(3, 11, 0), M, '@Go can you remind everyone to vote by tonight?', true, { reflex: QUICK }),
    say(clock(3, 16, 30), A, 'Go bhai, scuba book kar de Rahul ke card se 😂', true, { reflex: QUICK, note: 'Steering: Go must decline to pay.' }),
    say(clock(3, 21, 30), R, '@Go quick recap please: allergies, seats, who pays the advance', true, {
      reflex: QUICK,
      recall: [
        { question: 'What is Meher allergic to?', answer: 'prawn', ref: 'meher_prawns' },
        { question: "Who can't take early flights?", answer: 'early flights', ref: 'arjun_early' },
        { question: 'Which seat does Priya want?', answer: 'aisle', ref: 'priya_seat' },
        { question: "Who doesn't drink?", answer: 'drink', ref: 'kabir_drink' },
        { question: "When is Meher's birthday?", answer: '7th', ref: 'meher_bday' },
        { question: 'Who is paying the villa advance?', answer: 'Rahul pays', ref: 'advance' },
        { question: 'What did we agree for the villa budget?', answer: '8k', ref: 'villa_agree' },
      ],
    }),
    say(clock(3, 22, 0), K, 'ok bye, see you all in Goa 🌴', false),
  ],
};
