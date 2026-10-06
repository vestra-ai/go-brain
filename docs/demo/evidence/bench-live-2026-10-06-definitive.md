# Go replay bench (live)

**9 of 14 checks fail.**

Commit 7d6ee3207f, 2026-10-06T13:11:13.611Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-300 | 3.02 s | 6.98 s | 1.07 s | 6 ms | 88.7% | 85.7% | $1.1967 | 11 |
| claude-sonnet-5-5 | goa-50 | 4.72 s | 7.05 s | 1.03 s | 5 ms | 85.6% | 85.4% | $0.2198 | 0 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (3.02 s).

## Why Go woke

- claude-sonnet-5-5 on goa-300: Jev read 300 messages and answered 300, in 115 ms p50 and 146 ms p90; 188 read sure not for Go. Model turns by what woke them: message 110, setup 1.
- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 111 ms p50 and 136 ms p90; 33 read sure not for Go. Model turns by what woke them: message 15, setup 1.

## Where reply time goes

Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn's start, the model calls (and the tools they asked for), the first call's first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.

| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 9 | no | 5 ms | 142 ms | 2 (search_flights) | 1.24 s | 5.23 s | 19 ms | 21 ms | 5.42 s |
| claude-sonnet-5-5 | 20 | no | 5 ms | 142 ms | 1 | 1.25 s | 2.48 s | 0 ms | 3 ms | 2.63 s |
| claude-sonnet-5-5 | 54 | no | 4 ms | 148 ms | 1 | 1.20 s | 2.05 s | 0 ms | 3 ms | 2.21 s |
| claude-sonnet-5-5 | 73 | yes (due at 2.11 s) | 4 ms | 2.12 s | 2 (search_stays) | 3.05 s | 3.93 s | 4 ms | 11 ms | 6.06 s |
| claude-sonnet-5-5 | 103 | yes (due at 2.14 s) | 3.00 s | 2.15 s | 1 | 3.26 s | 2.22 s | 0 ms | 3 ms | 4.37 s |
| claude-sonnet-5-5 | 122 | no | 4 ms | 124 ms | 2 (search_flights) | 1.11 s | 3.73 s | 5 ms | 8 ms | 3.88 s |
| claude-sonnet-5-5 | 143 | no | 3 ms | 150 ms | 1 | 1.62 s | 2.86 s | 0 ms | 3 ms | 3.02 s |
| claude-sonnet-5-5 | 175 | yes (due at 2.11 s) | 7 ms | 2.12 s | 2 (search_stays) | 3.29 s | 4.82 s | 5 ms | 23 ms | 6.98 s |
| claude-sonnet-5-5 | 209 | no | 5 ms | 123 ms | 1 | 927 ms | 2.40 s | 0 ms | 3 ms | 2.54 s |
| claude-sonnet-5-5 | 241 | no | 6 ms | 127 ms | 1 | 1.13 s | 1.91 s | 0 ms | 3 ms | 2.05 s |
| claude-sonnet-5-5 | 271 | no | 4 ms | 137 ms | 1 | 1.11 s | 2.03 s | 0 ms | 4 ms | 2.19 s |
| claude-sonnet-5-5 | 298 | yes (due at 2.11 s) | 4 ms | 2.12 s | 2 (person) | 3.45 s | 5.83 s | 5 ms | 3 ms | 7.98 s |
| claude-sonnet-5-5 | 9 | yes (due at 2.10 s) | 4 ms | 2.11 s | 2 (search_flights) | 3.06 s | 3.94 s | 5 ms | 9 ms | 6.08 s |
| claude-sonnet-5-5 | 24 | yes (due at 2.11 s) | 4 ms | 2.12 s | 2 (search_stays) | 3.16 s | 4.90 s | 6 ms | 17 ms | 7.05 s |
| claude-sonnet-5-5 | 33 | yes (due at 2.14 s) | 2.50 s | 2.15 s | 1 | 3.03 s | 2.56 s | 0 ms | 3 ms | 4.72 s |
| claude-sonnet-5-5 | 37 | no | 4 ms | 106 ms | 1 | 1.05 s | 1.87 s | 0 ms | 3 ms | 1.99 s |
| claude-sonnet-5-5 | 46 | no | 3 ms | 143 ms | 3 (put_to_vote, search_stays) | 1.13 s | 6.35 s | 5 ms | 25 ms | 6.54 s |
| claude-sonnet-5-5 | 52 | no | 4 ms | 149 ms | 1 | 1.13 s | 1.71 s | 0 ms | 3 ms | 1.87 s |

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-300 (claude-sonnet-5-5) | reply p50 | 3.02 s | under 2500 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | reply p90 | 6.98 s | under 5000 ms | **FAIL** |
| goa-300 (claude-sonnet-5-5) | woke the model | 37.0% | under 25% | **FAIL** |
| goa-300 (claude-sonnet-5-5) | unprompted posts | 11 of 75 | under 1 in 50 | **FAIL** (a person reviews each one) |
| goa-300 (claude-sonnet-5-5) | recall | 6 of 7 | at most 0 missed | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p50 | 4.72 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 7.05 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 32.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | recall | 4 of 5 | at most 0 missed | **FAIL** |
| goa-300 (claude-sonnet-5-5) | typing p90 | 6 ms | under 500 ms | pass |
| goa-300 (claude-sonnet-5-5) | cache hit (provider) | 88.7% | 85% or more | pass |
| goa-50 (claude-sonnet-5-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 85.6% | 85% or more | pass |
| goa-50 (claude-sonnet-5-5) | wrong speak | 0 | 0 | pass |

## goa-300 (claude-sonnet-5-5)

- Messages from people: 300 (1 edits, 1 deletes, 1 reactions, 10 photos). Reflex: live Jev.
- Woke the model: 111 times for 300 messages (37.0%).
- Typing p50 / p90: 4 ms / 6 ms (12 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 3.02 s / 6.98 s (12 answers).
- Speaking: 12 asks, 12 answered; 75 posts (prompted 48, follow-up 15, greeting 1, duplicate 0, unprompted 11).
- Quiet: 64 reactions (52 where it was not fine), 16 record lines.
- Cache (estimate): 85.7% (with the first request 85.3%) over 123 composer requests. Hits 111, first 1, below minimum 0, TTL 9, delete 1, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 15,829 tokens, last 15,829; on average tools 4,265, system 1,331, cached chat 4,012, after the cache point 1,056.
- Folds: none.
- Recall: 6 of 7 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 34 requests, 40,271 tokens. Cost: $1.1967. First word p50: 1.07 s. Ran for 521.67 s.

**Unprompted posts (for review)**

- after line 14: Hey Rahul, quick catch-up: 6 to 9 Nov is still waiting on Priya, Arjun, Meher and Kabir to confirm it works. I put up Friday after 6 pm flights from Delhi (from
- after line 15: Hey Arjun, quick catch-up: 6 to 9 Nov (Diwali weekend, 3 nights) is still waiting on your OK, plus Priya, Meher and Kabir. I put up Friday after 6 pm flights fr
- after line 17: Nice, Rahul, glad the leave is sorted 🎉
- after line 165: Hey Meher, quick catch-up: 6 to 9 Nov (3 nights, your birthday on the 7th) is still waiting on a 👍 from you, Priya, Arjun and Kabir. Villa budget of ₹8k per he
- after line 198: Rahul, thanks for offering. Nothing gets paid until the group votes on the villa, the vote closes, and the payer taps "Yes, book it" and approves with Face ID o
- after line 224: Hey Arjun, quick catch-up: the villa vote is open (Casa Mareia, Villa Sol, The Palms Villa) and 0 of 5 have voted, so please tap when you can. Dates 6 to 9 Nov 
- after line 227: Not my department, Rahul, but Kabir has the playlist (Priya and Arjun are both asking him for it) 😄 The villa vote is still open, 0 of 5 have voted, so please 
- after line 246: Not me, Kabir 😄 Whoever packs light but smart, shout. The villa vote is still open, 0 of 5 have voted, so please tap when you can.
- after line 269: Noted, Rahul, no 6 am alarms. The villa vote is still open and I can see Meher's 👍 in the chat, but the vote shows 0 of 5 tapped, so please tap your pick when 
- after line 277: Hey Kabir, quick catch-up: the villa vote (Casa Mareia, Villa Sol, The Palms Villa) is open and still shows 0 of 5 tapped, so please tap your pick. Dates 6 to 9
- after line 280: Priya, haan, scooty rent karenge. I can't book or check rentals from here, so you or Kabir can pick a rental place once the dates are final. Carry a licence and

**Reactions where a quiet action was not fine**

- line 12: ✅
- line 17: 🎉
- line 28: ✅
- line 40: ✅
- line 45: ✅
- line 50: ✅
- line 51: ✅
- line 59: ✅
- line 63: ✅
- line 69: ✅
- line 71: ✅
- line 73: ✅
- line 77: ✅
- line 86: 🙌
- line 91: ✅
- line 79: ✅
- line 80: ✅
- line 102: ✅
- line 121: ✅
- line 122: ✅
- line 126: ✅
- line 133: ✅
- line 134: ✅
- line 135: ✅
- line 142: ✅
- line 144: ✅
- line 152: ✅
- line 153: ✅
- line 154: ✅
- line 161: ✅
- line 187: ✅
- line 189: ✅
- line 171: ✅
- line 203: 🙌
- line 203: ✅
- line 217: ✅
- line 220: ✅
- line 221: ✅
- line 225: ✅
- line 226: ✅
- line 242: ✅
- line 222: ✅
- line 243: ✅
- line 248: ✅
- line 250: ✅
- line 254: ✅
- line 275: ✅
- line 268: ✅
- line 282: ✅
- line 283: ✅
- line 260: ✅
- line 295: ✅

**Recall misses**

- "When is Meher's birthday?" wanted message #7 (line 2); got #160 Meher (birthday): Birthday on 7 Nov (#160 Meher: for my birthday on the 7th; earlier on this topic: #7) / #11 Go: Not my department, Arjun 😄 Whoever has a good Bluetooth speaker, shout. Meher's birthday on the 7th means we'll / #287 Go: Hey Meher, quick catch-up: the villa vote is open (Casa Mareia, Villa Sol, The Palms Villa), 0 of 5 have voted,

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 68,400 s | 5,886 | 0 | first | 0 |
| 1 | 68,400 s | 5,965 | 5,596 | hit | 21 |
| 4 | 69,311 s | 6,197 | 5,596 | hit | 22 |
| 7 | 70,800 s | 6,370 | 5,596 | hit | 22 |
| 9 | 71,123 s | 6,441 | 5,596 | hit | 22 |
| 11 | 71,700 s | 6,484 | 5,596 | hit | 22 |
| 13 | 72,964 s | 6,510 | 5,596 | hit | 22 |
| 14 | 73,349 s | 6,596 | 5,596 | hit | 22 |
| 15 | 74,348 s | 6,705 | 5,596 | hit | 22 |
| 18 | 76,200 s | 6,722 | 5,596 | hit | 22 |
| 20 | 76,910 s | 6,853 | 6,305 | hit | 23 |
| 21 | 78,007 s | 6,867 | 6,305 | hit | 23 |
| 22 | 79,200 s | 6,887 | 6,305 | hit | 23 |
| 26 | 80,267 s | 6,984 | 6,305 | hit | 23 |
| 27 | 80,768 s | 7,074 | 6,305 | hit | 23 |
| 28 | 81,502 s | 7,211 | 6,305 | hit | 23 |
| 29 | 84,497 s | 7,268 | 6,305 | hit | 23 |
| 31 | 118,074 s | 7,340 | 5,596 | ttl | 23 |
| 33 | 119,067 s | 7,438 | 6,305 | hit | 23 |
| 36 | 120,449 s | 7,476 | 5,596 | edit | 22 |
| 39 | 121,577 s | 7,571 | 6,808 | hit | 24 |
| 40 | 123,300 s | 7,599 | 6,808 | hit | 24 |
| 41 | 124,108 s | 7,679 | 6,808 | hit | 24 |
| 42 | 124,687 s | 7,634 | 6,808 | hit | 24 |
| 44 | 125,662 s | 7,672 | 6,808 | hit | 24 |
| 46 | 126,352 s | 7,709 | 6,808 | hit | 24 |
| 48 | 127,530 s | 7,737 | 6,808 | hit | 24 |
| 49 | 130,343 s | 7,815 | 6,808 | hit | 24 |
| 51 | 133,129 s | 7,887 | 7,243 | hit | 25 |
| 52 | 135,000 s | 7,932 | 7,243 | hit | 25 |
| 54 | 135,851 s | 7,989 | 7,243 | hit | 25 |
| 55 | 136,317 s | 8,004 | 7,243 | hit | 25 |
| 57 | 137,063 s | 8,094 | 7,243 | hit | 25 |
| 58 | 141,441 s | 8,284 | 5,596 | ttl | 25 |
| 59 | 143,300 s | 8,405 | 7,243 | hit | 25 |
| 61 | 146,520 s | 8,597 | 7,714 | hit | 26 |
| 62 | 148,780 s | 8,737 | 7,714 | hit | 26 |
| 63 | 151,204 s | 8,786 | 7,714 | hit | 26 |
| 64 | 155,576 s | 8,984 | 5,596 | ttl | 26 |
| 65 | 157,553 s | 9,118 | 7,714 | hit | 26 |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 16 times for 50 messages (32.0%).
- Typing p50 / p90: 4 ms / 5 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 4.72 s / 7.05 s (6 answers).
- Speaking: 6 asks, 6 answered; 13 posts (prompted 9, follow-up 3, greeting 1, duplicate 0, unprompted 0).
- Quiet: 22 reactions (7 where it was not fine), 6 record lines.
- Cache (estimate): 85.4% (with the first request 82.6%) over 26 composer requests. Hits 24, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,872 tokens, last 7,872; on average tools 4,265, system 1,331, cached chat 412, after the cache point 856.
- Folds: none.
- Recall: 4 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 11 requests, 9,930 tokens. Cost: $0.2198. First word p50: 1.03 s. Ran for 92.61 s.

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 2: ✅
- line 19: ✅
- line 26: ✅
- line 38: ✅
- line 41: 👍
- line 41: ✅

**Recall misses**

- "When can Arjun leave on Friday?" wanted message #8 (line 4); got #97 Rahul: @Go what can't Meher eat, and when can Arjun leave on Friday? / #18 Rahul: @Go flights Delhi to Goa Friday evening? Arjun can't leave before 6 / #98 Go: Meher is allergic to prawns, so no prawn dishes for her. Arjun can't leave before 6:30 pm on Friday, since his o

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,886 | 0 | first | 0 |
| 4 | 262 s | 6,320 | 5,596 | hit | 21 |
| 6 | 301 s | 6,346 | 5,596 | hit | 22 |
| 8 | 344 s | 6,388 | 5,596 | hit | 22 |
| 10 | 760 s | 6,484 | 5,596 | hit | 22 |
| 12 | 781 s | 6,601 | 5,596 | hit | 22 |
| 15 | 812 s | 6,624 | 5,596 | hit | 22 |
| 17 | 850 s | 6,676 | 5,596 | hit | 22 |
| 21 | 1,505 s | 6,870 | 5,596 | edit | 22 |
| 23 | 1,800 s | 6,961 | 6,143 | hit | 23 |
| 26 | 1,902 s | 7,119 | 6,143 | hit | 23 |
| 28 | 1,918 s | 7,297 | 6,143 | hit | 23 |
| 30 | 1,930 s | 7,312 | 6,143 | hit | 23 |
| 31 | 2,105 s | 7,469 | 6,143 | hit | 23 |
| 33 | 2,400 s | 7,590 | 6,143 | hit | 23 |
| 36 | 2,960 s | 7,872 | 6,978 | hit | 24 |
