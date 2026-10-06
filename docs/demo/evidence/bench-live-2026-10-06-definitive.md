# Go replay bench (live)

**8 of 14 checks fail.**

Commit 1c7cbd829e, 2026-10-06T15:43:17.070Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-300 | 3.90 s | 6.64 s | 1.20 s | 5 ms | 87.6% | 83.9% | $1.3323 | 15 |
| claude-sonnet-5-5 | goa-50 | 3.98 s | 6.80 s | 1.20 s | 7 ms | 85.0% | 84.8% | $0.2154 | 0 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (3.90 s).

## Why Go woke

- claude-sonnet-5-5 on goa-300: Jev read 300 messages and answered 300, in 139 ms p50 and 175 ms p90; 187 read sure not for Go. Model turns by what woke them: message 111, setup 1.
- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 138 ms p50 and 161 ms p90; 32 read sure not for Go. Model turns by what woke them: message 16, setup 1.

## Where reply time goes

Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn's start, the model calls (and the tools they asked for), the first call's first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.

| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 9 | no | 5 ms | 156 ms | 2 (search_flights) | 1.54 s | 9.28 s | 20 ms | 14 ms | 9.48 s |
| claude-sonnet-5-5 | 20 | no | 3 ms | 131 ms | 1 | 1.16 s | 2.14 s | 0 ms | 6 ms | 2.28 s |
| claude-sonnet-5-5 | 54 | no | 5 ms | 145 ms | 1 | 1.22 s | 1.86 s | 0 ms | 3 ms | 2.02 s |
| claude-sonnet-5-5 | 73 | yes (due at 2.15 s) | 4 ms | 2.15 s | 2 (search_stays) | 3.18 s | 4.43 s | 8 ms | 20 ms | 6.62 s |
| claude-sonnet-5-5 | 103 | yes (due at 2.15 s) | 3.00 s | 2.16 s | 1 | 3.29 s | 2.32 s | 0 ms | 3 ms | 4.48 s |
| claude-sonnet-5-5 | 122 | no | 5 ms | 155 ms | 2 (search_flights) | 1.43 s | 4.24 s | 5 ms | 9 ms | 4.42 s |
| claude-sonnet-5-5 | 143 | no | 4 ms | 150 ms | 1 | 1.42 s | 2.87 s | 0 ms | 4 ms | 3.03 s |
| claude-sonnet-5-5 | 175 | yes (due at 2.15 s) | 4 ms | 2.16 s | 2 (search_stays) | 3.06 s | 4.44 s | 7 ms | 20 ms | 6.64 s |
| claude-sonnet-5-5 | 209 | no | 4 ms | 158 ms | 1 | 2.28 s | 3.73 s | 0 ms | 4 ms | 3.90 s |
| claude-sonnet-5-5 | 241 | no | 4 ms | 172 ms | 1 | 1.36 s | 2.14 s | 0 ms | 4 ms | 2.33 s |
| claude-sonnet-5-5 | 271 | no | 4 ms | 159 ms | 1 | 1.45 s | 2.31 s | 0 ms | 4 ms | 2.48 s |
| claude-sonnet-5-5 | 298 | yes (due at 2.13 s) | 4 ms | 2.14 s | 1 | 3.40 s | 2.77 s | 0 ms | 4 ms | 4.92 s |
| claude-sonnet-5-5 | 9 | yes (due at 2.15 s) | 7 ms | 2.16 s | 2 (search_flights) | 3.31 s | 4.36 s | 6 ms | 11 ms | 6.54 s |
| claude-sonnet-5-5 | 24 | yes (due at 2.19 s) | 5 ms | 2.19 s | 2 (search_stays) | 3.14 s | 4.14 s | 4 ms | 11 ms | 6.36 s |
| claude-sonnet-5-5 | 33 | yes (due at 2.14 s) | 2.50 s | 2.15 s | 1 | 3.10 s | 1.82 s | 0 ms | 4 ms | 3.98 s |
| claude-sonnet-5-5 | 37 | no | 5 ms | 135 ms | 1 | 1.36 s | 2.62 s | 0 ms | 7 ms | 2.77 s |
| claude-sonnet-5-5 | 46 | no | 6 ms | 138 ms | 3 (put_to_vote, search_stays) | 1.16 s | 6.62 s | 7 ms | 22 ms | 6.80 s |
| claude-sonnet-5-5 | 52 | no | 4 ms | 148 ms | 1 | 1.25 s | 1.69 s | 0 ms | 4 ms | 1.85 s |

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-300 (claude-sonnet-5-5) | reply p50 | 3.90 s | under 2500 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | reply p90 | 6.64 s | under 5000 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | woke the model | 37.3% | under 25% | **FAIL** |
| goa-300 (claude-sonnet-5-5) | unprompted posts | 15 of 77 | under 1 in 50 | **FAIL** (a person reviews each one) |
| goa-50 (claude-sonnet-5-5) | reply p50 | 3.98 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 6.80 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 85.0% | 85% or more | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 34.0% | under 25% | **FAIL** |
| goa-300 (claude-sonnet-5-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-300 (claude-sonnet-5-5) | cache hit (provider) | 87.6% | 85% or more | pass |
| goa-300 (claude-sonnet-5-5) | recall | 7 of 7 | at most 0 missed | pass |
| goa-50 (claude-sonnet-5-5) | typing p90 | 7 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | wrong speak | 0 | 0 | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-300 (claude-sonnet-5-5)

- Messages from people: 300 (1 edits, 1 deletes, 1 reactions, 10 photos). Reflex: live Jev.
- Woke the model: 112 times for 300 messages (37.3%).
- Typing p50 / p90: 4 ms / 5 ms (12 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 3.90 s / 6.64 s (12 answers).
- Speaking: 12 asks, 12 answered; 77 posts (prompted 50, follow-up 11, greeting 1, duplicate 0, unprompted 15).
- Quiet: 71 reactions (59 where it was not fine), 22 record lines.
- Cache (estimate): 83.9% (with the first request 83.6%) over 128 composer requests. Hits 113, first 1, below minimum 0, TTL 12, delete 1, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 16,650 tokens, last 16,650; on average tools 4,373, system 1,390, cached chat 4,274, after the cache point 1,221.
- Folds: none.
- Recall: 7 of 7 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 31 requests, 42,285 tokens. Cost: $1.3323. First word p50: 1.20 s. Ran for 542.19 s.

**Unprompted posts (for review)**

- after line 4: Nobody's claimed the speaker yet, so it's open. Who's bringing it?
- after line 6: Noted, Priya, window seat it is. I'll keep it in mind when we get to flights.
- after line 14: Hey Rahul, quick catch-up: 6 to 9 Nov is the plan, and I showed 3 Delhi to Goa flights for Fri 6 Nov after 6 pm, from ₹5,640 per person. Candolim on Saturday is
- after line 15: Hey Arjun, quick catch-up: 6 to 9 Nov is the plan, with Candolim on Saturday. Meher's birthday is the 7th 🎂, Priya is veg, Meher is allergic to prawns, Kabir d
- after line 25: Budgets stay private, so I'm not treating that number as the group's. Everyone, please answer the budget question in the App and I'll search pool villas within 
- after line 61: Nobody's claimed the aux or the speaker yet, Meher. Kabir has been sending playlists, but Arjun and Kabir both keep telling each other "DJ mat banna" 😂 Whoever
- after line 153: Priya, still open. You and Kabir both said you can drive, so a scooty looks likely, but nobody has settled it. Want me to open a quick yes/no vote? The Saturday
- after line 165: Hey Meher, quick catch-up: 6 to 9 Nov is the plan, and I've shown villa options (Vagator is the cheapest) and flights from Delhi and Bangalore. Your Mumbai flig
- after line 198: Rahul, thanks for offering. The villa vote is still open with nobody in yet (The Palms Villa, Villa Sol or Ocean Breeze). Once it closes, the payer taps "Yes, b
- after line 224: Hey Arjun, quick catch-up: 6 to 9 Nov is the plan, and your Bangalore flight card (Fri after 7 pm, from ₹3,890) is up. Two votes are open with nobody in yet, on
- after line 227: Rahul, still unclaimed. Whoever brings the speaker gets the aux, so Kabir or Arjun, want to take it? Both votes (Saturday and the villa) are still open with nob
- after line 246: Nobody's claimed the flip flops yet, Kabir, so it's open. Whoever's packing light can probably spare a spare pair 😄

The Saturday and villa votes are still at 
- after line 252: Priya, you said you'd get the power bank, and Rahul's packing photo shows one too, so it's covered twice 🔋

Both votes (Saturday and the villa) are still at ze
- after line 277: Hey Kabir, quick catch-up: 6 to 9 Nov is the plan, with Candolim agreed for Saturday, though Vagator, Baga, Palolem and now Assagao have come up. Three votes ar
- after line 280: Priya, the scooty yes/no vote is open, so tap your pick there. Priya, Kabir and Meher have all said they can drive, so it only needs the group's yes. The Saturd

**Reactions where a quiet action was not fine**

- line 3: ✅
- line 10: ✅
- line 8: ✅
- line 9: ✅
- line 12: ✅
- line 30: 😂
- line 38: ✅
- line 45: ✅
- line 40: ✅
- line 50: ✅
- line 51: ✅
- line 59: ✅
- line 63: ✅
- line 69: ✅
- line 71: ✅
- line 77: ✅
- line 86: 🙌
- line 79: ✅
- line 91: ✅
- line 90: ✅
- line 102: ✅
- line 115: ✅
- line 121: ✅
- line 122: ✅
- line 133: ✅
- line 135: ✅
- line 142: ✅
- line 140: ✅
- line 144: ✅
- line 152: ✅
- line 154: ✅
- line 187: ✅
- line 161: ✅
- line 171: ✅
- line 181: ✅
- line 203: 🙌
- line 189: ✅
- line 193: ✅
- line 217: ✅
- line 203: ✅
- line 243: ✅
- line 221: ✅
- line 225: ✅
- line 226: ✅
- line 242: ✅
- line 246: ✅
- line 247: ✅
- line 249: ✅
- line 250: ✅
- line 254: ✅
- line 255: ✅
- line 269: ✅
- line 268: ✅
- line 260: ✅
- line 281: ✅
- line 283: ✅
- line 286: ✅
- line 288: ✅
- line 301: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 68,400 s | 6,053 | 0 | first | 0 |
| 1 | 68,400 s | 6,123 | 5,763 | hit | 21 |
| 4 | 69,480 s | 6,328 | 5,763 | hit | 22 |
| 7 | 69,900 s | 6,408 | 5,763 | hit | 22 |
| 10 | 70,200 s | 6,448 | 5,763 | hit | 22 |
| 11 | 70,800 s | 6,477 | 5,763 | hit | 22 |
| 13 | 71,123 s | 6,468 | 5,763 | hit | 22 |
| 17 | 72,964 s | 6,610 | 5,763 | hit | 22 |
| 18 | 73,349 s | 6,737 | 5,763 | hit | 22 |
| 20 | 76,200 s | 6,904 | 5,763 | hit | 22 |
| 22 | 76,910 s | 7,061 | 5,763 | hit | 22 |
| 23 | 78,007 s | 7,075 | 6,376 | hit | 23 |
| 24 | 79,200 s | 7,098 | 6,376 | hit | 23 |
| 26 | 79,500 s | 7,109 | 6,376 | hit | 23 |
| 27 | 80,267 s | 7,133 | 6,376 | hit | 23 |
| 28 | 80,768 s | 7,227 | 6,376 | hit | 23 |
| 29 | 81,502 s | 7,364 | 6,376 | hit | 23 |
| 31 | 84,497 s | 7,422 | 6,376 | hit | 23 |
| 33 | 118,074 s | 7,570 | 5,763 | ttl | 23 |
| 34 | 119,067 s | 7,661 | 6,376 | hit | 23 |
| 38 | 120,449 s | 7,731 | 5,763 | edit | 22 |
| 40 | 123,300 s | 7,918 | 6,939 | hit | 24 |
| 41 | 124,108 s | 8,003 | 6,939 | hit | 24 |
| 43 | 125,662 s | 8,052 | 6,939 | hit | 24 |
| 44 | 126,352 s | 8,104 | 6,939 | hit | 24 |
| 45 | 127,530 s | 8,123 | 6,939 | hit | 24 |
| 46 | 130,343 s | 8,309 | 6,939 | hit | 24 |
| 48 | 133,129 s | 8,491 | 7,538 | hit | 25 |
| 49 | 135,000 s | 8,483 | 7,538 | hit | 25 |
| 51 | 135,851 s | 8,551 | 7,538 | hit | 25 |
| 52 | 136,317 s | 8,566 | 7,538 | hit | 25 |
| 54 | 137,063 s | 8,677 | 7,538 | hit | 25 |
| 55 | 141,441 s | 8,735 | 5,763 | ttl | 25 |
| 56 | 143,300 s | 8,878 | 7,538 | hit | 25 |
| 58 | 147,383 s | 9,088 | 5,763 | ttl | 26 |
| 59 | 148,780 s | 9,174 | 8,064 | hit | 26 |
| 60 | 151,204 s | 9,223 | 8,064 | hit | 26 |
| 61 | 155,576 s | 9,437 | 5,763 | ttl | 26 |
| 62 | 157,553 s | 9,575 | 8,641 | hit | 27 |
| 63 | 158,228 s | 9,650 | 8,641 | hit | 27 |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 17 times for 50 messages (34.0%).
- Typing p50 / p90: 5 ms / 7 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 3.98 s / 6.80 s (6 answers).
- Speaking: 6 asks, 6 answered; 11 posts (prompted 8, follow-up 2, greeting 1, duplicate 0, unprompted 0).
- Quiet: 20 reactions (6 where it was not fine), 9 record lines.
- Cache (estimate): 84.8% (with the first request 81.9%) over 25 composer requests. Hits 23, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,884 tokens, last 7,884; on average tools 4,373, system 1,390, cached chat 345, after the cache point 901.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 12 requests, 10,958 tokens. Cost: $0.2154. First word p50: 1.20 s. Ran for 93.39 s.

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 9: ✅
- line 19: ✅
- line 24: ✅
- line 38: ✅
- line 41: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 6,053 | 0 | first | 0 |
| 4 | 262 s | 6,503 | 5,763 | hit | 21 |
| 6 | 301 s | 6,552 | 5,763 | hit | 22 |
| 9 | 344 s | 6,586 | 5,763 | hit | 22 |
| 11 | 760 s | 6,706 | 5,763 | hit | 22 |
| 13 | 781 s | 6,756 | 5,763 | hit | 22 |
| 17 | 812 s | 6,817 | 5,763 | hit | 22 |
| 18 | 850 s | 6,844 | 5,763 | hit | 22 |
| 21 | 1,505 s | 7,001 | 5,763 | edit | 22 |
| 23 | 1,572 s | 7,034 | 6,284 | hit | 23 |
| 24 | 1,800 s | 7,118 | 6,284 | hit | 23 |
| 27 | 1,902 s | 7,264 | 6,284 | hit | 23 |
| 28 | 1,930 s | 7,379 | 6,284 | hit | 23 |
| 29 | 2,105 s | 7,465 | 6,284 | hit | 23 |
| 30 | 2,120 s | 7,582 | 6,284 | hit | 23 |
| 33 | 2,400 s | 7,613 | 6,284 | hit | 23 |
| 36 | 2,960 s | 7,884 | 6,284 | hit | 23 |
