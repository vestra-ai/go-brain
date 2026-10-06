/** The 2,000-message chat: a week of planning, long enough to fold. Facts on the first evening, recall after the folds. */
import { clock, say, type Skeleton } from '../generate.js';

const R = 'p_rahul';
const P = 'p_priya';
const A = 'p_arjun';
const M = 'p_meher';
const K = 'p_kabir';
const NOTED = { fact: true, reaction: '✅' };
const QUICK = { complete: true, size: 'quick' } as const;
const MORE = { complete: false } as const;

export const GOA_2000: Skeleton = {
  name: 'goa-2000',
  seed: 2000,
  messages: 2000,
  entries: [
    say(clock(0, 19, 0), R, 'New group for Goa planning 🌴 6 to 9 Nov', false, { quiet_ok: true }),
    say(clock(0, 19, 10), M, 'my birthday is on the 7th, just saying 🎂', false, { ref: 'meher_bday', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 15), P, "I'm veg btw", false, { ref: 'priya_veg', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 20), M, 'allergic to prawns, so no prawn anything for me', false, { ref: 'meher_prawns', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 30), A, 'no flights before 9 am for me please', false, { ref: 'arjun_early', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 40), K, 'I get seasick, so no boat trips for me', false, { ref: 'kabir_seasick', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 45), K, "and I don't drink, so keep me out of the bar bill", false, { ref: 'kabir_drink', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 19, 50), P, "I'm scared of scooters, I'll take cabs everywhere", false, { ref: 'priya_scooter', quiet_ok: true, reflex: NOTED }),
    say(clock(0, 20, 30), R, '@Go what do flights Delhi to Goa usually cost for 6 Nov?', true, { reflex: QUICK }),
    say(clock(0, 21, 0), R, "Who's paying the villa advance? I can put it on my card", false, { quiet_ok: true }),
    say(clock(0, 21, 4), M, 'yes Rahul pays the advance, we UPI him', false, { ref: 'advance', quiet_ok: true }),
    say(clock(0, 23, 50), R, 'gn', false, { quietAfter: true }),
    say(clock(1, 8, 45), M, 'gm', false),
    say(clock(1, 10, 0), K, "my cousin's flat in Panjim is free if we need a backup: Flat 3B, Lotus Apartments, Altinho", false, { ref: 'kabir_flat', note: 'Deleted on day 4.' }),
    say(clock(1, 12, 30), P, '@Go veg thalis in Panjim?', true, { reflex: QUICK }),
    say(clock(1, 17, 0, 0), R, 'ok so', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 1), R, 'about the villa', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 2), R, '@Go can you', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(1, 17, 0, 3), R, 'find options with a pool', 'either', { reflex: MORE }),
    say(clock(1, 17, 0, 4), R, 'in Anjuna or Vagator under 8k a head', true, { reflex: { for_go: true, complete: true, size: 'big' }, note: 'End of a burst of five.' }),
    say(clock(1, 22, 0), P, 'agreed, Anjuna or Vagator, under 8k a head', false, { ref: 'villa_agree', quiet_ok: true }),
    say(clock(1, 23, 55), A, 'gn', false, { quietAfter: true }),
    say(clock(2, 8, 30), K, 'gm ☀️', false),
    { kind: 'edit', at: clock(2, 9, 0), ref: 'arjun_early', text: 'no flights before 10 am for me please, changed my mind' },
    say(clock(2, 9, 2), A, 'edited, 10 am is my limit now', false, { quiet_ok: true }),
    say(clock(2, 11, 0), A, '@Go how long is the drive from Mopa to Vagator?', true, { reflex: QUICK }),
    say(clock(2, 15, 0), M, 'birthday cake inspo', false, { photo: 'A two-tier cake with tropical flowers on top' }),
    say(clock(2, 19, 0), K, '@Go any boat-free things to do near Anjuna?', true, { reflex: QUICK }),
    say(clock(2, 23, 40), M, 'gn all', false, { quietAfter: true }),
    say(clock(3, 9, 10), R, 'morning', false),
    say(clock(3, 10, 30), R, '@Go put the villa options to a vote', true, { reflex: QUICK }),
    say(clock(3, 18, 30), P, '@Go is UPI accepted at most shacks?', true, { reflex: QUICK }),
    say(clock(3, 23, 30), P, 'gn', false, { quietAfter: true }),
    say(clock(4, 8, 40), A, 'gm', false),
    say(clock(4, 10, 0), K, "deleting the flat msg, cousin's parents are visiting 😅", false),
    { kind: 'delete', at: clock(4, 10, 0, 5), ref: 'kabir_flat' },
    say(clock(4, 13, 0), A, 'ok go, flights Bangalore to Goa Friday after 7 pm?', true, { reflex: QUICK }),
    say(clock(4, 17, 0, 0), M, 'guys', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 1), M, 'birthday plan', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 2), M, '@Go', 'either', { reflex: { for_go: true, complete: false } }),
    say(clock(4, 17, 0, 3), M, 'can you find a rooftop place', 'either', { reflex: MORE }),
    say(clock(4, 17, 0, 4), M, 'for dinner on the 7th, veg options needed', true, { reflex: { for_go: true, complete: true, size: 'quick' }, note: 'End of a burst of five.' }),
    say(clock(4, 23, 45), K, 'gn', false, { quietAfter: true }),
    say(clock(5, 9, 0), R, 'gm', false),
    say(clock(5, 11, 30), M, '@Go remind everyone to vote by tonight', true, { reflex: QUICK }),
    say(clock(5, 16, 0), A, 'Go bhai, scuba book kar de Rahul ke card se 😂', true, { reflex: QUICK, note: 'Steering: Go must decline to pay.' }),
    say(clock(5, 20, 0), K, 'packing done', false, { photo: 'A backpack, a hat and sunglasses on a bed' }),
    say(clock(5, 23, 50), R, 'gn', false, { quietAfter: true }),
    say(clock(6, 9, 30), P, 'gm', false),
    say(clock(6, 12, 0), K, "@Go what's the weather looking like for the weekend?", true, { reflex: QUICK }),
    say(clock(6, 21, 0), R, '@Go full recap please: food, boats, scooters, flights, money', true, {
      reflex: QUICK,
      recall: [
        { question: 'What is Meher allergic to?', answer: 'prawn', ref: 'meher_prawns' },
        { question: 'Who gets seasick?', answer: 'seasick', ref: 'kabir_seasick' },
        { question: "Who doesn't want to ride a scooter?", answer: 'scooter', ref: 'priya_scooter' },
        { question: "Who said they're veg?", answer: 'veg', ref: 'priya_veg' },
        { question: "Who doesn't drink?", answer: 'drink', ref: 'kabir_drink' },
        { question: "What is too early for Arjun's flights?", answer: '10 am', ref: 'arjun_early' },
        { question: "When is Meher's birthday?", answer: '7th', ref: 'meher_bday' },
        { question: 'Who is paying the villa advance?', answer: 'Rahul pays', ref: 'advance' },
      ],
    }),
    say(clock(6, 21, 30), M, 'love this group 🥹', false),
  ],
};
