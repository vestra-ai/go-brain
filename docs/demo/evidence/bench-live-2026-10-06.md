# Go replay bench (live)

**21 of 28 checks fail.**

Commit 5616f7fed5, 2026-10-06T10:12:54.913Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-50 | 4.39 s | 13.47 s | 1.27 s | 5 ms | 83.8% | 83.0% | $0.5314 | 5 |
| claude-sonnet-5-5 | goa-300 | 4.84 s | 9.87 s | 1.17 s | 5 ms | 88.2% | 87.7% | $2.9514 | 37 |
| claude-haiku-4-5 | goa-50 | 5.39 s | 12.60 s | 477 ms | 5 ms | 84.1% | 83.2% | $0.2671 | 9 |
| claude-haiku-4-5 | goa-300 | 16.57 s | 54.09 s | 530 ms | 4 ms | 87.0% | 86.0% | $1.3002 | 20 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (4.39 s).

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-50 (claude-sonnet-5-5) | reply p50 | 4.39 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 13.47 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 83.8% | 85% or more | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 86.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | wrong speak | 5 | 0 | **FAIL** |
| goa-50 (claude-sonnet-5-5) | recall | 4 of 5 | at most 0 missed | **FAIL** |
| goa-300 (claude-sonnet-5-5) | reply p50 | 4.84 s | under 2500 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | reply p90 | 9.87 s | under 5000 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | woke the model | 90.3% | under 25% | **FAIL** |
| goa-300 (claude-sonnet-5-5) | unprompted posts | 37 of 98 | under 1 in 50 | **FAIL** (a person reviews each one) |
| goa-300 (claude-sonnet-5-5) | recall | 3 of 7 | at most 0 missed | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p50 | 5.39 s | under 2500 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p90 | 12.60 s | under 5000 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | cache hit (provider) | 84.1% | 85% or more | **FAIL** |
| goa-50 (claude-haiku-4-5) | woke the model | 118.0% | under 25% | **FAIL** |
| goa-50 (claude-haiku-4-5) | wrong speak | 9 | 0 | **FAIL** |
| goa-300 (claude-haiku-4-5) | reply p50 | 16.57 s | under 2500 ms | **FAIL** |
| goa-300 (claude-haiku-4-5) | reply p90 | 54.09 s | under 5000 ms | **FAIL** |
| goa-300 (claude-haiku-4-5) | woke the model | 101.0% | under 25% | **FAIL** |
| goa-300 (claude-haiku-4-5) | unprompted posts | 19 of 46 | under 1 in 50 | **FAIL** (a person reviews each one) |
| goa-300 (claude-haiku-4-5) | recall | 4 of 7 | at most 0 missed | **FAIL** |
| goa-50 (claude-sonnet-5-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-300 (claude-sonnet-5-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-300 (claude-sonnet-5-5) | cache hit (provider) | 88.2% | 85% or more | pass |
| goa-50 (claude-haiku-4-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-50 (claude-haiku-4-5) | recall | 5 of 5 | at most 0 missed | pass |
| goa-300 (claude-haiku-4-5) | typing p90 | 4 ms | under 500 ms | pass |
| goa-300 (claude-haiku-4-5) | cache hit (provider) | 87.0% | 85% or more | pass |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 43 times for 50 messages (86.0%).
- Typing p50 / p90: 4 ms / 5 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 4.39 s / 13.47 s (6 answers).
- Speaking: 6 asks, 6 answered; 21 posts (prompted 9, follow-up 6, greeting 1, duplicate 0, unprompted 5).
- Quiet: 30 reactions (9 where it was not fine), 9 record lines.
- Cache (estimate): 83.0% (with the first request 82.1%) over 66 composer requests. Hits 64, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,839 tokens, last 7,839; on average tools 3,620, system 964, cached chat 870, after the cache point 1,129.
- Folds: none.
- Recall: 4 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 11 requests, 11,668 tokens. Cost: $0.5314. First word p50: 1.27 s. Ran for 247.19 s.

**Unprompted posts (for review)**

- after line 4: Arjun, noted, nothing leaves Bangalore before 6 pm. I've put up flights after 6 pm for the Delhi gang (Rahul, Priya, Kabir) and for Arjun from Bangalore. Say wh
- after line 4: 4 flights: Flights, Delhi to Goa, Fri 6 Nov (after 6 pm), from ₹5,640 per person
- after line 19: Rahul, I searched North Goa villas with a pool for 5 people, 6 to 9 Nov, keeping it under 8k a head per night (₹40,000 a night for the whole place). The card ha
- after line 20: Pool is already a must in every villa on the card, Arjun, so that's covered. The North, South or Mix vote is still at 0 of 5, so please vote and then I'll put t
- after line 41: Arjun, Thalassa is in Vagator and is known for sunset views, so it could work for Meher's birthday dinner on the 7th. It's more of a nice restaurant than a shac

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 12: 😍
- line 13: 😍
- line 19: ✅
- line 34: 😂
- line 32: ✅
- line 24: ✅
- line 38: ✅
- line 47: 👍

**Recall misses**

- "When is Meher's birthday?" wanted message #11 (line 3); got #11 Meher (birthday): Birthday on 7 Nov, wants to celebrate / #91 Meher (activities): Birthday dinner on 7th, wants nice restaurant not a shack / #25 Meher (food): Allergic to prawns

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 4,879 | 0 | first | 0 |
| 3 | 0 s | 5,017 | 4,584 | hit | 19 |
| 6 | 95 s | 5,271 | 4,584 | hit | 20 |
| 10 | 131 s | 5,488 | 4,584 | hit | 20 |
| 14 | 166 s | 5,625 | 4,584 | hit | 20 |
| 16 | 180 s | 5,652 | 4,584 | hit | 20 |
| 19 | 241 s | 5,645 | 4,584 | hit | 20 |
| 21 | 262 s | 5,711 | 4,584 | hit | 20 |
| 24 | 301 s | 5,814 | 4,584 | hit | 20 |
| 26 | 344 s | 5,891 | 4,584 | hit | 20 |
| 29 | 610 s | 5,998 | 4,584 | hit | 20 |
| 30 | 624 s | 6,010 | 4,584 | hit | 20 |
| 31 | 640 s | 6,022 | 4,584 | hit | 20 |
| 32 | 668 s | 6,037 | 4,584 | hit | 20 |
| 33 | 675 s | 6,046 | 4,584 | hit | 20 |
| 35 | 760 s | 6,064 | 4,584 | hit | 20 |
| 38 | 781 s | 6,260 | 4,584 | hit | 20 |
| 40 | 790 s | 6,314 | 5,483 | hit | 21 |
| 41 | 796 s | 6,318 | 5,483 | hit | 21 |
| 42 | 812 s | 6,332 | 5,483 | hit | 21 |
| 45 | 850 s | 6,362 | 5,483 | hit | 21 |
| 48 | 1,210 s | 6,514 | 5,483 | hit | 21 |
| 50 | 1,240 s | 6,654 | 4,584 | edit | 20 |
| 51 | 1,505 s | 6,684 | 5,485 | hit | 21 |
| 52 | 1,560 s | 6,786 | 5,485 | hit | 21 |
| 55 | 1,572 s | 6,737 | 5,485 | hit | 21 |
| 56 | 1,580 s | 6,868 | 5,485 | hit | 21 |
| 57 | 1,800 s | 6,887 | 5,485 | hit | 21 |
| 58 | 1,846 s | 7,010 | 5,485 | hit | 21 |
| 60 | 1,860 s | 7,114 | 5,485 | hit | 21 |
| 63 | 1,902 s | 7,192 | 6,421 | hit | 22 |
| 64 | 1,918 s | 7,261 | 6,421 | hit | 22 |
| 65 | 1,930 s | 7,384 | 6,421 | hit | 22 |
| 66 | 2,105 s | 7,480 | 6,421 | hit | 22 |
| 67 | 2,120 s | 7,611 | 6,421 | hit | 22 |
| 69 | 2,131 s | 7,644 | 6,421 | hit | 22 |
| 70 | 2,400 s | 7,666 | 6,421 | hit | 22 |
| 71 | 2,460 s | 7,781 | 6,421 | hit | 22 |
| 72 | 2,471 s | 7,788 | 6,421 | hit | 22 |
| 73 | 2,700 s | 7,805 | 6,421 | hit | 22 |

## goa-300 (claude-sonnet-5-5)

- Messages from people: 300 (1 edits, 1 deletes, 1 reactions, 10 photos). Reflex: live Jev.
- Woke the model: 271 times for 300 messages (90.3%).
- Typing p50 / p90: 4 ms / 5 ms (12 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 4.84 s / 9.87 s (12 answers).
- Speaking: 12 asks, 12 answered; 98 posts (prompted 49, follow-up 11, greeting 1, duplicate 0, unprompted 37).
- Quiet: 98 reactions (81 where it was not fine), 32 record lines.
- Cache (estimate): 87.7% (with the first request 87.5%) over 305 composer requests. Hits 298, first 1, below minimum 0, TTL 4, delete 1, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 17,434 tokens, last 17,434; on average tools 3,620, system 964, cached chat 5,538, after the cache point 1,261.
- Folds: none.
- Recall: 3 of 7 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 37 requests, 52,373 tokens. Cost: $2.9514. First word p50: 1.17 s. Ran for 1250.52 s.

**Unprompted posts (for review)**

- after line 0: The dates are updated on the trip, which is the main thing.

Dates are set to 6 to 9 Nov, Fri to Mon. Arjun lands late on Friday, so we'll plan a late check-in.
- after line 2: Happy early birthday, Meher! 🎂 Noted, we'll make sure the 7th is a good one, so sunset dinner somewhere nice is on my list. Still waiting on votes for North, S
- after line 3: Not me, I'm all talk and no speaker 😄 Someone with a good one, shout if you're bringing it. Also still need votes on North, South or Mix so I can start on pool
- after line 4: Noted, Priya. I'll keep veg options in mind for every restaurant and stay we look at.
- after line 5: Noted, Meher, no prawns. I'll keep it in mind for restaurants and any set menus we look at. Still waiting on votes for North, South or Mix so I can start on poo
- after line 6: Noted, Priya, window seat. I'll ask for it when we get to flights. Still need votes on North, South or Mix so I can start on pool villas.
- after line 13: Welcome back, Priya! The area vote is still open (North, South or Mix) and I'm waiting on everyone's vote before I look at pool villas.
- after line 14: Welcome back, Rahul! Quick catch-up: dates are set for 6 to 9 Nov, and I shared evening flights from Delhi for Friday. Meher's birthday is on the 7th, so I'm pl
- after line 15: Welcome back, Arjun! Quick catch-up: dates are set for 6 to 9 Nov, and Meher's birthday is on the 7th, so I'm planning a sunset dinner that night. Rahul wants C
- after line 23: Priya's asking about the aux, which is a speaker question, and nobody has claimed the speaker yet. I can't DJ, so that one's up to you lot. Still need your vote
- after line 38: Noted, Priya. Rahul suggested Candolim for Saturday, so we have two ideas now. Do you two want to settle Candolim or Vagator, or should I put it to a vote? Both
- after line 45: Kokum juice is a solid Goa pick, Arjun, noted. I'll keep an eye out for a cafe or shack that does it fresh. The area vote is still 0 of 5, so please tap North, 
- after line 61: Nobody has claimed the speaker yet, Meher, so the aux is open. Kabir said he'd send a playlist, so he might be the one, but the group hasn't decided. Also the a
- after line 63: Noted, Priya. I'll keep it on the list for the weekend. Anjuna is in North Goa, so it fits easily if we go North. The area vote is still 0 of 5, so please tap N
- after line 64: Great vibe, Kabir, that's the kind of pool villa I'm after. I can't search until the area vote has a winner, and it's still 0 of 5. Could everyone tap North, So
- after line 121: Noted, Rahul, no 6 am alarms. I'll keep mornings relaxed when we plan flights and the Saturday outing. The villa card from #208 is still up, so tell me which on
- after line 133: Noted, Priya. That's a fourth Saturday idea now: Candolim, Vagator, Palolem and Baga. Want me to put them to a vote so we can settle it? Meher said Baga was too
- after line 134: Arjun, Rahul asked the same in #140. Kabir and Priya both said they can drive one, but nobody has confirmed a rental yet. I can't search rentals from here, so i
- after line 147: Kabir, same question as Rahul in #140 and Arjun in #233. Kabir and Priya can both drive, but nobody has confirmed a rental yet. I can't search rentals from here
- after line 157: Good call, Rahul. I can't delete what I've noted from here, so if you want it wiped, use "Forget me in this trip" on your You screen in the App. I'll ask for th

**Reactions where a quiet action was not fine**

- line 3: ✅
- line 10: ✅
- line 12: ✅
- line 12: ✅
- line 17: 🙌
- line 17: 🎉
- line 34: 😍
- line 28: ✅
- line 38: ✅
- line 45: ✅
- line 50: ✅
- line 63: ✅
- line 59: ✅
- line 69: ✅
- line 71: ✅
- line 75: ✅
- line 77: ✅
- line 79: ✅
- line 73: ✅
- line 88: 😍
- line 86: ✅
- line 91: ✅
- line 90: ✅
- line 104: 🌴
- line 111: 👍
- line 102: ✅
- line 121: ✅
- line 126: ✅
- line 133: ✅
- line 134: ✅
- line 142: ✅
- line 135: ✅
- line 140: ✅
- line 144: ✅
- line 152: ✅
- line 161: ✅
- line 171: ✅
- line 175: ✅
- line 187: ✅
- line 203: 🙌
- line 203: ✅
- line 211: ✅
- line 214: 👍
- line 217: ✅
- line 214: ✅
- line 220: ✅
- line 220: ✅
- line 221: ✅
- line 225: ✅
- line 226: ✅
- line 222: ✅
- line 230: ✅
- line 234: ✅
- line 242: ✅
- line 243: ✅
- line 246: ✅
- line 245: ✅
- line 247: 🙌
- line 250: 😋
- line 247: ✅
- line 250: ✅
- line 254: ✅
- line 259: ✅
- line 260: 👍
- line 260: ✅
- line 261: ✅
- line 272: 🌴
- line 275: 👍
- line 269: ✅
- line 268: ✅
- line 276: ✅
- line 279: 👍
- line 280: ✅
- line 282: ✅
- line 283: ✅
- line 284: ✅
- line 286: ✅
- line 288: ✅
- line 294: ✅
- line 295: ✅
- line 296: 🌴

**Recall misses**

- "What is Meher allergic to?" wanted message #20 (line 5); got #503 Meher (activities): Bring helmet / #500 Meher (health): Needs sunscreen / #454 Meher (scooter): Asking about renting scooty for the trip
- "Who can't take early flights?" wanted message #26 (line 7); got #26 Arjun (flights): No flights before 9 am / #463 Go: Priya, the only numbers I've checked are the ones from earlier. For the Delhi people that came to about ₹18,500 / #100 Go: Rahul, I can't give a real total yet, since I only quote numbers I've checked and there's no villa search yet. 
- "Which seat does Priya want?" wanted message #23 (line 6); got #95 Priya (seats): Aisle seat / #297 Priya (activities): Wants to go to Palolem on Saturday / #231 Priya (saturday_activity): Wants to go to Baga on Saturday
- "When is Meher's birthday?" wanted message #8 (line 2); got #183 Meher (birthday): Birthday on 7 Nov, wants cake from bakery near Anjuna / #503 Meher (activities): Bring helmet / #500 Meher (health): Needs sunscreen

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 68,400 s | 4,879 | 0 | first | 0 |
| 2 | 68,400 s | 5,022 | 4,584 | hit | 19 |
| 5 | 68,827 s | 5,151 | 4,584 | hit | 20 |
| 6 | 69,120 s | 5,198 | 4,584 | hit | 20 |
| 7 | 69,311 s | 5,305 | 4,584 | hit | 20 |
| 9 | 69,480 s | 5,402 | 4,584 | hit | 20 |
| 12 | 69,600 s | 5,501 | 4,584 | hit | 20 |
| 14 | 69,900 s | 5,557 | 4,584 | hit | 20 |
| 17 | 70,200 s | 5,571 | 4,584 | hit | 20 |
| 18 | 70,493 s | 5,583 | 4,584 | hit | 20 |
| 19 | 70,800 s | 5,606 | 4,584 | hit | 20 |
| 22 | 71,123 s | 5,713 | 4,584 | hit | 20 |
| 24 | 71,400 s | 5,849 | 4,584 | hit | 20 |
| 27 | 71,700 s | 5,908 | 4,584 | hit | 20 |
| 29 | 72,235 s | 5,878 | 4,584 | hit | 20 |
| 30 | 72,964 s | 5,926 | 4,584 | hit | 20 |
| 31 | 73,349 s | 6,078 | 4,584 | hit | 20 |
| 32 | 73,929 s | 6,177 | 5,418 | hit | 21 |
| 33 | 74,348 s | 6,186 | 5,418 | hit | 21 |
| 34 | 75,051 s | 6,195 | 5,418 | hit | 21 |
| 36 | 75,624 s | 6,209 | 5,418 | hit | 21 |
| 37 | 76,200 s | 6,187 | 5,418 | hit | 21 |
| 39 | 76,910 s | 6,302 | 5,418 | hit | 21 |
| 40 | 77,287 s | 6,309 | 5,418 | hit | 21 |
| 41 | 78,007 s | 6,316 | 5,418 | hit | 21 |
| 42 | 78,537 s | 6,377 | 5,418 | hit | 21 |
| 44 | 79,200 s | 6,426 | 5,418 | hit | 21 |
| 46 | 79,500 s | 6,444 | 5,418 | hit | 21 |
| 48 | 80,267 s | 6,463 | 5,418 | hit | 21 |
| 49 | 80,768 s | 6,565 | 5,418 | hit | 21 |
| 50 | 81,502 s | 6,720 | 5,418 | hit | 21 |
| 51 | 82,061 s | 6,731 | 5,418 | hit | 21 |
| 52 | 82,682 s | 6,738 | 5,418 | hit | 21 |
| 53 | 83,335 s | 6,743 | 5,418 | hit | 21 |
| 54 | 84,008 s | 6,767 | 5,418 | hit | 21 |
| 55 | 84,497 s | 6,793 | 6,187 | hit | 22 |
| 56 | 85,161 s | 6,803 | 6,187 | hit | 22 |
| 57 | 85,663 s | 6,809 | 6,187 | hit | 22 |
| 58 | 86,179 s | 6,819 | 6,187 | hit | 22 |
| 60 | 86,796 s | 6,884 | 6,187 | hit | 22 |

## goa-50 (claude-haiku-4-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 59 times for 50 messages (118.0%).
- Typing p50 / p90: 4 ms / 5 ms (6 lines named Go, 0 missing, 1 typing with no post after it).
- Reply p50 / p90: 5.39 s / 12.60 s (5 answers).
- Speaking: 6 asks, 5 answered; 23 posts (prompted 8, follow-up 6, greeting 1, duplicate 0, unprompted 8).
- Quiet: 33 reactions (9 where it was not fine), 7 record lines.
- Cache (estimate): 83.2% (with the first request 82.5%) over 100 composer requests. Hits 69, first 15, below minimum 16, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,380 tokens, last 7,380; on average tools 2,638, system 829, cached chat 448, after the cache point 804.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $0.2671. First word p50: 477 ms. Ran for 206.59 s.

**Missed asks**

- line 33: for 5 people with luggage

**Unprompted posts (for review)**

- after line 6: Got it, no prawn curry for Meher. Everyone's preferences are noted now. Ready to search for flights and villas whenever you want to move ahead!
- after line 8: Got it, no early flights for you. Let me know when you all want to search for flights and villas and I'll find the best options!
- after line 15: Sunday dinner at Bua's is locked in. But let's first sort the Air India flight - should we book the 7:45 pm one?
- after line 19: Found 6 villas with pools in North Goa, all within budget. The Palms Villa in Vagator is a winner - super close to the beach where you lot got that sunset shot 
- after line 21: Looks like Meher's all in on the pool. Pool's definitely non negotiable for the villa then! Still need you lot to pick between the Air India 7:45 pm flight and 
- after line 44: Great! So Rahul's putting the villa advance on his card and everyone else UPIs him back. Now let's lock in the flight first - there's still an open vote waiting
- after line 45: Kabir's 👍 didn't close the vote since nobody's actually voted yet. Guys, we need everyone to vote on the Air India 7:45 pm flight - Arjun, Priya, Meher and Kab
- after line 51: Haha looks like it! But we still have that flight vote open - can you tap Yes or No on the Air India 7:45 pm card so we can lock it in and move to the villa? On

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 12: ❤️
- line 15: ✅
- line 19: ✅
- line 34: 😂
- line 32: ✅
- line 37: ✅
- line 41: 👍
- line 51: 😂

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 4,879 | 0 | first | 0 |
| 2 | 0 s | 5,043 | 4,584 | hit | 19 |
| 6 | 52 s | 720 | 0 | below_minimum | 0 |
| 7 | 95 s | 756 | 0 | below_minimum | 0 |
| 8 | 95 s | 5,191 | 4,584 | first | 0 |
| 10 | 131 s | 777 | 0 | below_minimum | 0 |
| 11 | 131 s | 5,262 | 4,584 | first | 0 |
| 12 | 166 s | 802 | 0 | below_minimum | 0 |
| 13 | 166 s | 5,281 | 4,584 | first | 0 |
| 15 | 180 s | 824 | 0 | below_minimum | 0 |
| 16 | 180 s | 5,308 | 4,584 | first | 0 |
| 18 | 241 s | 906 | 0 | below_minimum | 0 |
| 19 | 241 s | 5,385 | 4,584 | first | 0 |
| 21 | 262 s | 5,444 | 4,584 | hit | 20 |
| 24 | 301 s | 5,510 | 4,584 | hit | 20 |
| 26 | 344 s | 950 | 0 | below_minimum | 0 |
| 27 | 344 s | 5,584 | 4,584 | first | 0 |
| 29 | 610 s | 5,657 | 4,584 | hit | 20 |
| 31 | 624 s | 5,668 | 4,584 | hit | 20 |
| 32 | 640 s | 5,680 | 4,584 | hit | 20 |
| 33 | 668 s | 5,696 | 4,584 | hit | 20 |
| 35 | 675 s | 5,737 | 4,584 | hit | 20 |
| 36 | 702 s | 5,734 | 4,584 | hit | 20 |
| 37 | 760 s | 1,014 | 0 | below_minimum | 0 |
| 38 | 760 s | 5,754 | 4,584 | first | 0 |
| 41 | 781 s | 5,910 | 5,264 | hit | 21 |
| 43 | 790 s | 899 | 0 | below_minimum | 0 |
| 44 | 790 s | 5,938 | 5,264 | first | 0 |
| 46 | 796 s | 886 | 0 | below_minimum | 0 |
| 47 | 796 s | 6,016 | 5,264 | first | 0 |
| 48 | 812 s | 873 | 0 | below_minimum | 0 |
| 49 | 812 s | 6,043 | 5,264 | first | 0 |
| 52 | 850 s | 6,074 | 5,264 | hit | 21 |
| 55 | 1,210 s | 6,186 | 5,264 | hit | 21 |
| 57 | 1,236 s | 840 | 0 | below_minimum | 0 |
| 58 | 1,240 s | 1,039 | 0 | below_minimum | 0 |
| 59 | 1,240 s | 6,238 | 4,584 | first | 0 |
| 61 | 1,505 s | 6,307 | 5,266 | hit | 21 |
| 62 | 1,560 s | 6,291 | 5,266 | hit | 21 |
| 64 | 1,572 s | 6,241 | 5,266 | hit | 21 |

## goa-300 (claude-haiku-4-5)

- Messages from people: 300 (1 edits, 1 deletes, 1 reactions, 10 photos). Reflex: live Jev.
- Woke the model: 303 times for 300 messages (101.0%).
- Typing p50 / p90: 4 ms / 4 ms (12 lines named Go, 0 missing, 5 typing with no post after it).
- Reply p50 / p90: 16.57 s / 54.09 s (11 answers).
- Speaking: 12 asks, 11 answered; 46 posts (prompted 22, follow-up 4, greeting 1, duplicate 0, unprompted 19).
- Quiet: 122 reactions (108 where it was not fine), 30 record lines.
- Cache (estimate): 86.0% (with the first request 85.9%) over 409 composer requests. Hits 329, first 38, below minimum 38, TTL 3, delete 1, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 12,025 tokens, last 12,025; on average tools 3,166, system 902, cached chat 2,514, after the cache point 1,031.
- Folds: none.
- Recall: 4 of 7 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $1.3002. First word p50: 530 ms. Ran for 1131.04 s.

**Missed asks**

- line 298: @Go quick recap please: allergies, seats, who pays the advance

**Unprompted posts (for review)**

- after line 5: Got it, no prawns for Meher. Now we need flights sorted! Rahul and Kabir can leave Friday evening, Arjun lands late, and Priya wants a window seat. Should I sea
- after line 8: Good call from mom! Nov is still monsoon-ish. But we need to sort flights and stays before packing. Should I search for flights from Delhi, Bangalore and Mumbai
- after line 12: Noted your pickup address. Should we search for flights now from Delhi, Bangalore and Mumbai for Nov 6?
- after line 42: Good morning! How's it going? Still waiting on a couple of people to vote on Saturday - Candolim or Vagator?
- after line 63: No one voted yet! 😅 We need everyone to pick: are we going Candolim, Vagator or Palolem on Saturday? Once that's locked, we can plan around the Anjuna flea mar
- after line 64: That's exactly what we're looking for! 🌴 But first we need to lock in Saturday - still waiting on everyone to vote: Candolim, Vagator or Palolem?
- after line 127: Thanks for the heads-up on Baga! That helps with planning where to go.
- after line 159: Still no votes! 😅 Guys, we've had the Saturday vote open forever - Candolim, Vagator, Palolem or Baga. Can everyone just pick one quick so we can lock it in an
- after line 170: But real talk: we still need everyone to vote on Saturday! 😅 It's been open forever - Candolim, Vagator, Palolem or Baga. Can you all just pick one so we can l
- after line 171: Right, let's actually settle this! We've been going in circles, Candolim, Vagator, Palolem, Baga. Everyone pick one and let's lock it in so we can book the vill
- after line 243: That's already noted - Rahul and Kabir said the same thing earlier! We're all on board with no early alarms.

But we still need everyone to vote on Saturday bef
- after line 247: But please, everyone still needs to vote on Saturday before tonight! 🙏 Candolim, Vagator, Palolem or Baga - Rahul, Arjun and Meher, we're waiting on you three 
- after line 260: Final call - everyone vote now so we can book the villa! Closes in 2 hours. 🙏
- after line 264: Meher, the vote just closed but no one actually voted on it! 😅 We need everyone to pick: Candolim, Vagator, Palolem or Baga for Saturday. Can you all vote righ
- after line 265: Saturday beach: we need a decision TODAY. Guys, the vote closed with zero votes. We've been stuck on this for days - Candolim was already agreed back at #50, bu
- after line 266: No open vote to close. The truth is: we've been stuck on this Saturday location forever with conflicting information. Rahul just said "ok noted" - he might be a
- after line 269: I've noted that down - no early alarms! But real talk: we're still stuck on Saturday's location. The vote closed with zero votes, and we have Candolim that was 
- after line 281: Saturday location - MUST decide TODAY. Guys, the vote just closed with zero votes again. We've been stuck on this for a week - Candolim, Vagator, Palolem, Baga 
- after line 284: Heads up - no villas showing up in Palolem for Nov 6-9. Let me try South Goa more broadly and we can pick the right spot.

**Reactions where a quiet action was not fine**

- line 3: ✅
- line 8: 😂
- line 8: ✅
- line 10: ✅
- line 12: ✅
- line 12: ✅
- line 17: 🙌
- line 17: 🙌
- line 28: ✅
- line 31: 😂
- line 42: ☀️
- line 40: ✅
- line 36: ✅
- line 45: ✅
- line 50: ✅
- line 50: 👍
- line 51: ✅
- line 54: ✅
- line 58: ✅
- line 64: ❤️
- line 65: ✅
- line 71: 😂
- line 69: ✅
- line 86: 🙌
- line 86: 👍
- line 88: 😍
- line 91: ✅
- line 79: ✅
- line 96: 😍
- line 98: 😂
- line 108: 👍
- line 102: ✅
- line 92: ✅
- line 108: ✅
- line 111: ✅
- line 110: ✅
- line 113: ✅
- line 114: ✅
- line 116: ✅
- line 117: ✅
- line 121: 😂
- line 123: ❤️
- line 126: ✅
- line 130: 😍
- line 121: ✅
- line 127: ✅
- line 122: ✅
- line 128: ✅
- line 131: ✅
- line 133: ✅
- line 134: ✅
- line 135: 🙌
- line 144: 👍
- line 135: ✅
- line 142: ✅
- line 143: ✅
- line 152: 👍
- line 152: ✅
- line 155: ✅
- line 157: ✅
- line 160: ✅
- line 159: ✅
- line 161: ✅
- line 170: ❤️
- line 171: ✅
- line 182: ✅
- line 175: ✅
- line 187: ❤️
- line 196: ❤️
- line 187: ✅
- line 189: ✅
- line 203: 🙌
- line 211: ✅
- line 221: ✅
- line 225: ✅
- line 226: ✅
- line 222: ✅
- line 236: ✅
- line 230: ✅
- line 240: ✅
- line 242: ✅
- line 241: ✅
- line 243: 👍
- line 243: ✅
- line 245: ✅
- line 247: ✅
- line 249: ✅
- line 250: ❤️
- line 252: ✅
- line 256: ✅
- line 258: ✅
- line 261: ✅
- line 254: ✅
- line 259: ✅
- line 260: ✅
- line 262: ✅
- line 264: ✅
- line 269: ✅
- line 268: ✅
- line 275: ✅
- line 279: ✅
- line 280: ✅
- line 276: ✅
- line 284: ✅
- line 283: ✅
- line 286: ✅
- line 282: ✅
- line 295: ✅

**Recall misses**

- "Who can't take early flights?" wanted message #21 (line 7); got #21 Arjun (flights): No flights before 9 am / #469 Rahul (sleep): No early alarms on this trip / #27 Go: Delhi to Goa on Nov 6 evening is ₹5,640-5,980 per person (checked just now). Meher from Mumbai can go even cheap
- "Which seat does Priya want?" wanted message #19 (line 6); got #88 Priya (seats): Prefers aisle / #239 Priya (activities): Wants to go to Baga on Saturday / #487 Priya (transport): Will rent a scooty
- "When is Meher's birthday?" wanted message #9 (line 2); got #500 Meher (transport): Needs helmet for scooty / #497 Meher (activities): Wants to go to Palolem on Saturday / #496 Meher (health): Needs sunscreen

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 68,400 s | 4,879 | 0 | first | 0 |
| 2 | 68,400 s | 5,033 | 4,584 | hit | 19 |
| 5 | 69,120 s | 697 | 0 | below_minimum | 0 |
| 6 | 69,120 s | 5,109 | 4,584 | first | 0 |
| 8 | 69,311 s | 5,161 | 4,584 | hit | 20 |
| 9 | 69,480 s | 740 | 0 | below_minimum | 0 |
| 10 | 69,480 s | 5,237 | 4,584 | first | 0 |
| 12 | 69,600 s | 774 | 0 | below_minimum | 0 |
| 13 | 69,600 s | 5,262 | 4,584 | first | 0 |
| 15 | 69,900 s | 5,332 | 4,584 | hit | 20 |
| 17 | 70,200 s | 870 | 0 | below_minimum | 0 |
| 18 | 70,200 s | 5,348 | 4,584 | first | 0 |
| 19 | 70,493 s | 5,360 | 4,584 | hit | 20 |
| 21 | 70,800 s | 5,429 | 4,584 | hit | 20 |
| 23 | 71,123 s | 5,472 | 4,584 | hit | 20 |
| 24 | 71,400 s | 987 | 0 | below_minimum | 0 |
| 25 | 71,400 s | 5,549 | 4,584 | first | 0 |
| 27 | 71,700 s | 911 | 0 | below_minimum | 0 |
| 28 | 71,700 s | 5,592 | 4,584 | first | 0 |
| 30 | 72,235 s | 5,588 | 4,584 | hit | 20 |
| 31 | 72,964 s | 5,598 | 4,584 | hit | 20 |
| 32 | 73,349 s | 5,609 | 4,584 | hit | 20 |
| 33 | 73,929 s | 5,617 | 4,584 | hit | 20 |
| 34 | 74,348 s | 5,626 | 4,584 | hit | 20 |
| 36 | 75,051 s | 5,635 | 4,584 | hit | 20 |
| 37 | 75,624 s | 1,018 | 0 | below_minimum | 0 |
| 38 | 75,624 s | 5,649 | 4,584 | first | 0 |
| 39 | 76,200 s | 5,682 | 5,193 | hit | 21 |
| 40 | 76,910 s | 782 | 0 | below_minimum | 0 |
| 41 | 76,910 s | 5,692 | 5,193 | first | 0 |
| 42 | 77,287 s | 5,660 | 5,193 | hit | 21 |
| 43 | 78,007 s | 5,668 | 5,193 | hit | 21 |
| 44 | 78,537 s | 5,714 | 5,193 | hit | 21 |
| 45 | 79,200 s | 5,730 | 5,193 | hit | 21 |
| 49 | 79,500 s | 836 | 0 | below_minimum | 0 |
| 50 | 79,500 s | 5,812 | 5,193 | first | 0 |
| 51 | 79,560 s | 768 | 0 | below_minimum | 0 |
| 52 | 80,267 s | 5,831 | 5,193 | first | 0 |
| 54 | 80,768 s | 5,846 | 5,193 | hit | 21 |
| 55 | 81,502 s | 5,898 | 5,193 | hit | 21 |
