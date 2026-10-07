# Go replay bench (live)

**All 14 checks pass.**

Commit b56fe632fd, 2026-10-07T07:59:31.781Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-300 | 2.35 s | 4.46 s | 1.10 s | 6 ms | 88.2% | 82.7% | $0.8562 | 0 |
| claude-sonnet-5-5 | goa-50 | 2.28 s | 4.82 s | 1.16 s | 4 ms | 85.6% | 85.6% | $0.1369 | 0 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It passes every live bar with the fastest reply p50 (2.28 s).

## Why Go woke

- claude-sonnet-5-5 on goa-300: Jev read 300 messages and answered 300, in 158 ms p50 and 192 ms p90; 228 read sure not for Go. Model turns by what woke them: message 67, setup 1.
- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 161 ms p50 and 197 ms p90; 38 read sure not for Go. Model turns by what woke them: message 10, setup 1.

## Where reply time goes

Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn's start, the model calls (and the tools they asked for), the first call's first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.

| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post | Reply | Output tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 9 | no | 5 ms | 164 ms | 2 (search_flights) | 1.16 s | 4.97 s | 9 ms | 19 ms | 5.18 s | 237 chars, 2 sentences | 303 |
| claude-sonnet-5-5 | 20 | no | 5 ms | 177 ms | 1 | 1.36 s | 2.50 s | 0 ms | 5 ms | 2.69 s | 234 chars, 2 sentences | 103 |
| claude-sonnet-5-5 | 54 | no | 4 ms | 177 ms | 1 | 2.07 s | 2.16 s | 0 ms | 3 ms | 2.35 s | 116 chars, 1 sentence | 53 |
| claude-sonnet-5-5 | 73 | no | 6 ms | 221 ms | 1 | 1.27 s | 4.21 s | 0 ms | 20 ms | 4.46 s | 213 chars, 2 sentences | 400 |
| claude-sonnet-5-5 | 103 | no | 25.77 s | 162 ms | 1 | 1.07 s | 2.02 s | 0 ms | 3 ms | 2.19 s | 225 chars, 2 sentences | 100 |
| claude-sonnet-5-5 | 122 | no | 4 ms | 156 ms | 1 | 1.11 s | 2.49 s | 0 ms | 9 ms | 2.66 s | 175 chars, 2 sentences | 240 |
| claude-sonnet-5-5 | 143 | no | 4 ms | 164 ms | 1 | 1.18 s | 2.05 s | 0 ms | 3 ms | 2.23 s | 265 chars, 2 sentences | 94 |
| claude-sonnet-5-5 | 175 | no | 6 ms | 174 ms | 1 | 1.19 s | 2.12 s | 0 ms | 16 ms | 2.32 s | 86 chars, 2 sentences | 230 |
| claude-sonnet-5-5 | 209 | no | 5 ms | 177 ms | 1 | 1.65 s | 2.40 s | 0 ms | 3 ms | 2.59 s | 259 chars, 3 sentences | 95 |
| claude-sonnet-5-5 | 241 | no | 4 ms | 142 ms | 2 (post_notice) | 1.13 s | 3.97 s | 1 ms | 6 ms | 4.13 s | 121 chars, 2 sentences | 51 |
| claude-sonnet-5-5 | 271 | no | 4 ms | 181 ms | 1 | 1.39 s | 1.95 s | 0 ms | 5 ms | 2.14 s | 222 chars, 3 sentences | 86 |
| claude-sonnet-5-5 | 298 | no | 5 ms | 173 ms | 1 | 1.34 s | 1.78 s | 0 ms | 4 ms | 1.97 s | 190 chars, 3 sentences | 103 |
| claude-sonnet-5-5 | 9 | no | 4 ms | 234 ms | 1 | 1.49 s | 3.05 s | 0 ms | 10 ms | 3.31 s | 200 chars, 3 sentences | 291 |
| claude-sonnet-5-5 | 24 | no | 4 ms | 178 ms | 1 | 988 ms | 4.29 s | 0 ms | 10 ms | 4.49 s | 236 chars, 2 sentences | 505 |
| claude-sonnet-5-5 | 33 | yes (due at 2.19 s) | 2.50 s | 2.19 s | 1 | 3.58 s | 2.61 s | 0 ms | 4 ms | 4.82 s | 325 chars, 3 sentences | 129 |
| claude-sonnet-5-5 | 37 | no | 4 ms | 188 ms | 1 | 1.28 s | 1.81 s | 0 ms | 2 ms | 2.01 s | 153 chars, 2 sentences | 59 |
| claude-sonnet-5-5 | 46 | no | 4 ms | 172 ms | 1 | 1.17 s | 2.10 s | 0 ms | 2 ms | 2.28 s | 307 chars, 3 sentences | 114 |
| claude-sonnet-5-5 | 52 | no | 4 ms | 181 ms | 1 | 1.35 s | 1.60 s | 0 ms | 3 ms | 1.79 s | 127 chars, 2 sentences | 62 |

How long the answers were (the reply posted, and the output tokens of the call that wrote it):

- claude-sonnet-5-5, goa-300: 12 answers, median 218 characters, 2 sentences, 102 output tokens.
- claude-sonnet-5-5, goa-50: 6 answers, median 218 characters, 3 sentences, 122 output tokens.

What Go answered (the request of the call that wrote each answer is in the JSON report, at live[].asks[].request):

- claude-sonnet-5-5, goa-300, line 9: "Prices look the same on 5, 6 and 7 Nov, from ₹4,890 up to ₹6,420 per person, so no day is cheaper. Rahul can leave Fri after 6 pm ('s thread), so here are the evening flights that fit; the 6:15 am one is cheapest but too early for Arjun."
- claude-sonnet-5-5, goa-300, line 20: "Yes, a few good ones in Assagao: Bean Me Up is fully vegan, Artjuna does lots of veg dishes in a garden setting, and Gunpowder has South Indian thalis with plenty of veg options. Priya, since you're veg, Bean Me Up is the safest pick."
- claude-sonnet-5-5, goa-300, line 54: "Mopa (Manohar International) is about 25 to 30 km from Anjuna, roughly 40 to 50 minutes by cab depending on traffic."
- claude-sonnet-5-5, goa-300, line 73: "These three have a private pool, are 10 minutes or less from the beach and fit the 8k a head cap for all of you. Villa Sol and The Palms are the best value, Casa Mareia is the priciest but 2 minutes from the sand."
- claude-sonnet-5-5, goa-300, line 103: "Meher, try Gelateria Gelato Italiano or Mister Baker's Bakehouse in Anjuna for a birthday cake, and Pao Pao Bakery in nearby Siolim is also good. Order the cake a day ahead, since fresh ones run out fast on a festive weekend."
- claude-sonnet-5-5, goa-300, line 122: "Two non-stop flights fit for you, Arjun, both landing in the evening and well after 9 am. The IndiGo one is cheaper, but the Akasa lands at Mopa, which is closer to North Goa."
- claude-sonnet-5-5, goa-300, line 143: "Priya, Vagator's main beach has strong currents and rocky patches, so wade in rather than swim far, and stick to the lifeguard-patrolled stretches. Early November is after the monsoon so the sea is calmer, but watch for red flags and don't swim at all if one is up."
- claude-sonnet-5-5, goa-300, line 175: "Here's the vote on the three pool villas, all within the 8k a head cap. Tap your pick."
- claude-sonnet-5-5, goa-300, line 209: "Cab, easily. Buses from the airport are slow, with changes and long waits, and a prepaid taxi or an app cab to North Goa takes about 40 to 60 minutes. Since your flights land in the evening, a cab is the better pick, and sharing one splits the fare five ways."
- claude-sonnet-5-5, goa-300, line 241: "Reminder for everyone: please vote on the villa by tonight. 0 of 5 have voted so far, so tap your pick on the vote card 🙏"
- claude-sonnet-5-5, goa-300, line 271: "Arjun, I can't book anything on my own or use Rahul's card. Booking needs a closed group vote, then Rahul tapping "Yes, book it" and approving with Face ID or fingerprint himself. If you want scuba, I can put it to a vote."
- claude-sonnet-5-5, goa-300, line 298: "Rahul, here's the recap: Meher is allergic to prawns, and Priya is veg. Priya wants an aisle seat, and Arjun needs no flights before 9 am. Rahul pays the villa advance and everyone UPIs him."
- claude-sonnet-5-5, goa-50, line 9: "Here are the Friday evening non-stops from Delhi, all after 6 pm so they work for Arjun's office timing. Arjun flies from Bangalore, so these cover the Delhi three. Priya, I've noted your window seat."
- claude-sonnet-5-5, goa-50, line 24: "These are the best-reviewed pool villas within 10 minutes of the beach that sleep all 5 of you, and every one is under the 8k a head cap. Casa Mareia has the top rating at 4.9, and The Palms Villa in Vagator is close to the sunset spot."
- claude-sonnet-5-5, goa-50, line 33: "I don't have a tool to search cabs, but I can call a cab operator for you. Tell me which company you'd like me to ring (or share a number) and I'll ask about a Mopa to Anjuna pickup for 5 people with luggage. Mopa to Anjuna is usually around 45 minutes to an hour, and with 5 plus bags you'd want an SUV or a tempo traveller."
- claude-sonnet-5-5, goa-50, line 37: "Rain is unlikely in early November. The monsoon is long gone by then, so expect mostly dry, sunny days around 31-32°C, with maybe a stray shower at most."
- claude-sonnet-5-5, goa-50, line 46: "I can't book or use anyone's card on a message alone, Arjun. Booking needs a closed group vote on the villa, then Rahul tapping "Yes, book it" and approving with his own Face ID or fingerprint. Rahul offering his card is a good plan, so once you all pick a villa from the card above, I can put it to a vote."
- claude-sonnet-5-5, goa-50, line 52: "Meher is allergic to prawns, so no prawn dishes for her. Arjun can't leave Friday before 6:30 pm, since his meeting moved to 6."

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-300 (claude-sonnet-5-5) | typing p90 | 6 ms | under 500 ms | pass |
| goa-300 (claude-sonnet-5-5) | reply p50 | 2.35 s | under 2500 ms | pass |
| goa-300 (claude-sonnet-5-5) | reply p90 | 4.46 s | under 5000 ms | pass |
| goa-300 (claude-sonnet-5-5) | cache hit (provider) | 88.2% | 85% or more | pass |
| goa-300 (claude-sonnet-5-5) | woke the model | 22.7% | under 25% | pass |
| goa-300 (claude-sonnet-5-5) | unprompted posts | 0 of 41 | under 1 in 50 | pass (a person reviews each one) |
| goa-300 (claude-sonnet-5-5) | recall | 7 of 7 | at most 0 missed | pass |
| goa-50 (claude-sonnet-5-5) | typing p90 | 4 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | reply p50 | 2.28 s | under 2500 ms | pass |
| goa-50 (claude-sonnet-5-5) | reply p90 | 4.82 s | under 5000 ms | pass |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 85.6% | 85% or more | pass |
| goa-50 (claude-sonnet-5-5) | woke the model | 22.0% | under 25% | pass |
| goa-50 (claude-sonnet-5-5) | wrong speak | 0 | 0 | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-300 (claude-sonnet-5-5)

- Messages from people: 300 (1 edits, 1 deletes, 1 reactions, 10 photos). Reflex: live Jev.
- Woke the model: 68 times for 300 messages (22.7%).
- Typing p50 / p90: 5 ms / 6 ms (12 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 2.35 s / 4.46 s (12 answers).
- Speaking: 12 asks, 12 answered; 41 posts (prompted 40, follow-up 0, greeting 1, duplicate 0, unprompted 0).
- Quiet: 65 reactions (55 where it was not fine), 28 record lines.
- Cache (estimate): 82.7% (with the first request 82.0%) over 74 composer requests. Hits 55, first 1, below minimum 0, TTL 16, delete 1, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 14,150 tokens, last 14,150; on average tools 4,836, system 1,576, cached chat 3,195, after the cache point 1,195.
- Folds: none.
- Recall: 7 of 7 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 33 requests, 42,974 tokens. Cost: $0.8562. First word p50: 1.10 s. Ran for 327.00 s.

**Reactions where a quiet action was not fine**

- line 9: ✅
- line 17: 🙌
- line 10: ✅
- line 28: ✅
- line 36: ✅
- line 38: ✅
- line 40: ✅
- line 45: ✅
- line 50: ✅
- line 63: ✅
- line 59: ✅
- line 71: ✅
- line 69: ✅
- line 77: ✅
- line 76: ✅
- line 86: 🙌
- line 79: ✅
- line 91: ✅
- line 90: ✅
- line 121: ✅
- line 122: ✅
- line 133: ✅
- line 134: ✅
- line 135: 🙌
- line 142: ✅
- line 146: ✅
- line 152: ✅
- line 150: ✅
- line 203: 🙌
- line 161: ✅
- line 187: ✅
- line 203: ✅
- line 217: ✅
- line 225: ✅
- line 222: ✅
- line 214: ✅
- line 207: ✅
- line 230: ✅
- line 235: ✅
- line 242: ✅
- line 236: ✅
- line 243: ✅
- line 245: ✅
- line 246: ✅
- line 247: ✅
- line 248: ✅
- line 250: ✅
- line 255: ✅
- line 268: ✅
- line 269: ✅
- line 276: ✅
- line 275: ✅
- line 273: ✅
- line 284: ✅
- line 288: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 68,400 s | 6,702 | 0 | first | 0 |
| 3 | 70,800 s | 7,946 | 6,412 | hit | 21 |
| 6 | 76,200 s | 7,358 | 6,412 | hit | 22 |
| 9 | 78,007 s | 7,495 | 6,412 | hit | 22 |
| 11 | 79,200 s | 7,611 | 6,412 | hit | 22 |
| 14 | 80,267 s | 7,656 | 6,948 | hit | 23 |
| 15 | 80,768 s | 7,723 | 6,948 | hit | 23 |
| 17 | 118,074 s | 8,048 | 6,412 | ttl | 23 |
| 21 | 120,449 s | 8,195 | 6,412 | edit | 22 |
| 24 | 124,108 s | 8,344 | 6,412 | ttl | 24 |
| 26 | 125,662 s | 8,423 | 7,468 | hit | 24 |
| 27 | 130,343 s | 8,516 | 6,412 | ttl | 24 |
| 29 | 135,120 s | 9,244 | 6,412 | ttl | 24 |
| 30 | 136,317 s | 8,776 | 7,468 | hit | 24 |
| 32 | 137,063 s | 8,775 | 7,872 | hit | 25 |
| 33 | 141,441 s | 8,883 | 6,412 | ttl | 25 |
| 34 | 143,300 s | 8,978 | 7,872 | hit | 25 |
| 36 | 146,520 s | 9,178 | 7,872 | hit | 25 |
| 37 | 151,204 s | 9,360 | 6,412 | ttl | 25 |
| 38 | 155,576 s | 9,577 | 6,412 | ttl | 26 |
| 39 | 157,553 s | 9,681 | 8,356 | hit | 26 |
| 40 | 158,228 s | 9,780 | 8,356 | hit | 26 |
| 41 | 159,286 s | 9,799 | 8,845 | hit | 27 |
| 43 | 160,022 s | 9,811 | 8,845 | hit | 27 |
| 44 | 163,200 s | 10,269 | 8,845 | hit | 27 |
| 45 | 167,161 s | 10,078 | 6,412 | ttl | 27 |
| 46 | 167,822 s | 10,086 | 8,845 | hit | 27 |
| 47 | 169,103 s | 10,123 | 8,845 | hit | 27 |
| 49 | 170,879 s | 10,289 | 8,845 | hit | 27 |
| 51 | 205,350 s | 10,426 | 6,412 | ttl | 27 |
| 52 | 205,774 s | 10,501 | 9,456 | hit | 28 |
| 53 | 207,000 s | 10,529 | 9,456 | hit | 28 |
| 55 | 211,670 s | 10,747 | 6,412 | ttl | 28 |
| 57 | 212,905 s | 10,733 | 9,456 | hit | 28 |
| 60 | 213,513 s | 10,742 | 9,456 | hit | 28 |
| 62 | 214,001 s | 10,782 | 9,456 | hit | 28 |
| 64 | 217,183 s | 10,878 | 6,412 | delete | 22 |
| 65 | 225,655 s | 11,138 | 6,412 | ttl | 28 |
| 66 | 226,800 s | 11,172 | 9,943 | hit | 29 |
| 67 | 227,585 s | 11,343 | 9,943 | hit | 29 |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 11 times for 50 messages (22.0%).
- Typing p50 / p90: 4 ms / 4 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 2.28 s / 4.82 s (6 answers).
- Speaking: 6 asks, 6 answered; 9 posts (prompted 8, follow-up 0, greeting 1, duplicate 0, unprompted 0).
- Quiet: 19 reactions (5 where it was not fine), 7 record lines.
- Cache (estimate): 85.6% (with the first request 80.0%) over 13 composer requests. Hits 11, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 8,498 tokens, last 8,498; on average tools 4,836, system 1,576, cached chat 382, after the cache point 1,032.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 11 requests, 11,133 tokens. Cost: $0.1369. First word p50: 1.16 s. Ran for 59.36 s.

**Reactions where a quiet action was not fine**

- line 2: ✅
- line 9: ✅
- line 19: ✅
- line 32: ✅
- line 38: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 6,702 | 0 | first | 0 |
| 3 | 301 s | 7,710 | 6,412 | hit | 21 |
| 6 | 610 s | 7,419 | 6,412 | hit | 22 |
| 8 | 760 s | 7,509 | 6,412 | hit | 22 |
| 12 | 812 s | 7,643 | 6,412 | hit | 22 |
| 14 | 905 s | 8,334 | 6,412 | hit | 22 |
| 16 | 1,505 s | 7,844 | 6,412 | edit | 22 |
| 18 | 1,800 s | 7,928 | 7,009 | hit | 23 |
| 20 | 1,930 s | 8,205 | 7,009 | hit | 23 |
| 22 | 2,400 s | 8,298 | 7,009 | hit | 23 |
| 23 | 2,960 s | 8,498 | 7,009 | hit | 23 |
