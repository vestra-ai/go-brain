# Evidence: Jev's quick read

Jev is a fast model that answers closed questions with a probability. Go asks it ten questions about each message from a person (is it for Go, is it finished, is it a fact worth keeping, which ixigo search it asks for, and so on) and reads each answer as sure or unsure against a bar. A question **acts live** only once its test set passes; until then it runs **in shadow**: Go still asks it and logs the answer (`reflex_reads`), but acts only on what code alone knows.

This page explains the recording in this folder: where it comes from, how each question is scored, and which questions act live.

## The files

- `jev-2026-10-07.json`: Jev's answers to every question for every line of the test set, as recorded, unedited. It is the same file, byte for byte, as `apps/brain/src/reflex/testsets/recorded/jev-1.13.0.json`, which CI scores on every change.
- `jev-2026-10-07.txt`: what the recording printed, unedited: the time of Jev's calls, one line per question at the bars Go had when it was recorded (for question 10, one more line per choice), then the bar sweep (each bar's values and what they give).
- `jev-2026-10-07-repeat.json` and `jev-2026-10-07-repeat.txt`: a second recording of the same lines about 2 minutes later, unedited. Go does not use it; it shows how much Jev's answers move between two runs (see "Asked twice" below).

## Where the answers come from

- **Runs:** jev-record run [37574778383](https://github.com/vestra-ai/go-brain/actions/runs/37574778383), job `record`, artifact `jev-record`, recorded at 2026-10-07 05:09 UTC (`recorded_at` in the file); the repeat is run [37574978572](https://github.com/vestra-ai/go-brain/actions/runs/37574978572), at 05:11 UTC.
- **Code:** pull request #134 at `f4baef5`. The questions asked are that commit's; `versions` in the file holds each question's wording version, and CI marks a question stale if its wording changes.
- **Jev:** model `jev-1.13.0` at Jev's default address, the same settings as Go's deployment, with Vestra's staging Jev key from the repository's secrets. The key is never printed.
- **The recording runs in CI** (`.github/workflows/jev-record.yml`) when a pull request gets the label `jev-record`: one Jev call per line, with all ten questions in it, as Go asks them.

## The test set

`apps/brain/src/reflex/testsets/chat.jsonl` holds 162 chat lines in the Goa trip, 94 in English and 68 in Hinglish, each labelled by a person before any recording with what Jev should say. Question 2 is labelled on 42 lines, question 10 on 106, and the others on 6 to 14 each. The lines are written for the test set. Some of questions 2 and 10's come from the bench's Goa chats (`goa-50`, `goa-300` and `goa-2000`) and from the cues in the ixigo maps (`recipes/`), which are written too, so none comes from a real trip chat yet.

## How a question is scored

Jev's recorded answers go through the same readers Go uses live, with the bars in `apps/brain/src/reflex/thresholds.ts`.

- **Right:** the reading is sure and matches the label.
- **Wrong:** the reading is sure and does not match. For question 8 a wrong answer is a false alarm: a line raised as risky that is not.
- **Unsure** counts as not found. It is the safe outcome: Go falls back to what code knows and the main model decides.
- **Recall:** right over labelled. For question 8, the risky lines raised over the risky lines.
- **Gate:** no wrong answer (question 8: at most 2 false alarms), and recall at least the question's minimum (`GATES` in `apps/brain/src/reflex/testset.ts`). Question 2 reads a line as finished only when it names Go (see "Question 2" below). Question 10 must also reach its minimum on the lines that ask for a search alone, so a reader that is only ever sure of "none" cannot pass on the other lines.

## The result

At the bars Go has now. Recall by language is right over labelled in that language.

| # | Question | Lines | Sure | Wrong | Recall | English / Hinglish | Gate | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | Is the message for Go? | 13 | 12 | 0 | 0.92 | 0.89 / 1.00 | 0.5 | live |
| 2 | Is the message finished? (an ask to Go) | 42 | 27 | 0 | 0.64 | 0.62 / 0.69 | 0.5 | live |
| 3 | A quick ask, or big work? | 9 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.4 | shadow |
| 4 | Which running job is it about? | 6 | 4 | 0 | 0.67 | 0.75 / 0.50 | 0.5 | live |
| 5 | A fact about the person worth keeping? | 14 | 10 | 0 | 0.71 | 0.70 / 0.75 | 0.5 | live |
| 6 | A line for the trip record (agreed, open, doing)? | 9 | 7 | 0 | 0.78 | 1.00 / 0.33 | 0.4 | live |
| 7 | A quiet reaction (✅ 👍 🙌), or none? | 10 | 9 | 0 | 0.90 | 1.00 / 0.67 | 0.3 | live |
| 8 | Risky (spend, steering Go, a secret)? | 14 (5 risky) | 5 raised | 0 false alarms | 1.00 | 1.00 / 1.00 | 0.8 | live |
| 9 | An opening for Go (a question it could answer, a choice going round in circles, someone asked to look something up)? | 6 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.3 | shadow |
| 10 | Which ixigo search does it ask for (flights, stays, trains, buses), or none? | 106 (52 searches) | 96 | 0 | 0.91 (searches 0.88) | 0.90 / 0.91 | 0.5 | live |

So questions 1, 2, 4, 5, 6, 7, 8 and 10 act live (`PASSED_SETS` in `apps/brain/src/reflex/live-gate.ts`, and `REFLEX_LIVE` defaults to `q1,q2,q4,q5,q6,q7,q8,q10`). The admin page's `REFLEX_LIVE` switch can narrow that list or turn Jev off, but it cannot make a question in shadow act live. Jev gave no sure wrong answer on any question at these bars. Questions 3 and 9 stay in shadow because Jev was too rarely sure on them: no value in the sweep brings them to their gate (the best, in the recording CI scores, are 0.33 and 0.17).

The rows are the lines the recording printed.

### Question 1's chatter bar

Question 1 reads a line as sure chatter when Jev's "chatter" answer is at least 0.85 and its "for Go" answer at most 0.2. Bash's bar is 0.9, measured on 149 lines. Jev reads the six chatter lines here at 0.75 to 0.88 (0.77 to 0.89 on the repeat), so at 0.9 none would be sure chatter, while at 0.85 four are; "I'm veg btw" (0.75) and "chal theek hai, kal baat karte hain" (0.84) stay below. The rule below then reads all six as not for Go, so on this set every value from 0.8 to 0.95 gives the same result: recall 0.92 and no wrong answer. The bar is 0.85, below Bash's, because the two mistakes do not cost the same: an ask read as chatter goes unanswered, while a needless wake costs one model call.

Read this with care:

- Six of question 1's 12 right answers are lines that name Go, which code gets right without Jev. Jev's own part is the other six: the chatter lines.
- One chatter line sits just above the bar: Jev read "hahaha Kabir you're never waking up at 6" at 0.86 both times. If it reads lower, the rule below still reads it as not for Go: Jev's "for Go" answer for it is 0.03.
- The one ask that does not name Go ("can someone check trains from Mumbai on Thursday?") stayed unsure, so Go still wakes for it.

### Not spoken to Go

Question 1 also reads a line as not for Go when Jev is sure no one spoke to Go in it, chatter or not: its "for Go" answer is at most 0.25 (`notAddressedMax`). That is a fact ("I'm veg btw"), a plan ("North for sure, I'm in"), friends talking or asking each other ("scuba karna hai kisi ko Saturday?"). A line that names Go is always for Go. A line about money is never read as not for Go, whatever Jev says: an amount that is plainly money (₹500, 3,200, 8k, 2 lakh) or a word for paying or owing (paid, pay, owe, owes, spent, gave, transferred, diya, bheja, dena, lena, udhaar), because only a turn records an expense or asks what an unclear one was for. On the first 50 lines of the set (the ones questions 1 to 9 are labelled on) the rule takes the lines that wake the model from 46 to 30 in both recordings; the money check keeps two of those awake ("maine apna share bhej diya 🙌" and "the villa costs 54k total, split 5 ways"). It skips none of the lines labelled for Go: the lowest "for Go" answer on a line labelled for Go that does not name it is 0.61 in both recordings, for "can someone check trains from Mumbai on Thursday?". A skipped line still gets the notes pass and its quiet reaction; only the main model stays asleep.

The bar is 0.25, set on the live chats: on the Jev answers of the definitive live run (`bench-live-2026-10-06-definitive.json`), it takes the lines that wake the model on `goa-300` from 107 to 72 and on `goa-50` from 18 to 13 (0.1 woke them all). Every line it skips there is labelled not for Go, mostly friends asking or teasing each other ("who's bringing the speaker?", "Kabir ka mood off hai kya?"), and none names Go or is about money. The nearest line Go may answer reads 0.30: "6:30 se pehle wali flight mat dekhna yaar", a limit on the flight search. A second live run's answers (run 37572657366) give the same: 72 and 13, and 0.28 for that line. `packages/bench/src/__tests__/wake-replay.test.ts` replays the first run in CI.

One line this skips is labelled as an opening ("pata nahi yaar, tum log decide karo": a vote would help). Question 9, which offers that help, is in shadow, so Go does not offer it on its own either way; the main model, woken, might have.

The sweep also shows question 5 would reach 0.86 at 0.7 instead of 0.8, question 7 would reach 1.00 at 0.85 instead of 0.9, and question 8 would raise one false alarm at 0.3; none was needed to pass, so none moved.

### Question 2: is an ask to Go finished

After a message that wakes the model, Go waits 2 seconds in case the same person sends more, unless the message is finished. Code calls a message finished when it plainly ends (?, ., ! or an emoji) and names Go or ends a burst of lines that named Go. Many whole asks to Go have no end mark ("@Go put the three villas to a vote please"), and code can't tell those from a line cut short ("@Go can you also check"). Question 2 can, for a line that names Go:

- Jev reads the 15 lines to Go that are cut short or only call for attention at 0.04 to 0.41 ("@Go can you" 0.08, "@Go one thing" 0.20, "Go suno" and "@Go sun na" 0.41), and the 18 whole asks to Go at 0.52 to 0.74. The repeat gives the same picture: at most 0.41 and at least 0.53.
- The bar is 0.5: sure finished when a line names Go and Jev reads it at 0.5 or more. The sweep: 0.4 makes two wrong answers ("Go suno" and "@Go sun na"; one on the repeat), 0.45 and 0.5 none, and 0.55 and up lose whole asks. 0.5 keeps 0.09 between the bar and the highest line cut short; question 2's answers on these 42 lines moved by at most 0.05 between the two recordings, and by at most 0.09 on any line of the set.
- A line that doesn't name Go is never read as finished. Mid-burst, such a line reads as finished as a burst's end: "find options with a pool" 0.64 and "if there's a cab from Mopa airport to Anjuna" 0.57 continue an ask, while "for 5 people with luggage" 0.60 ends one.
- A line Jev reads at 0.1 or less is sure unfinished. Go does nothing different for it: it waits, as for an unsure one.

Recall is 0.64: the 18 whole asks to Go, and 9 lines sure unfinished. The 15 not found are the lines that don't name Go, and lines to Go Jev reads between 0.1 and 0.5.

### Question 10: which ixigo search

Question 10 is one Choice: flights, stays, trains, buses (the four ixigo searches Go runs, `RECIPE_CHOICES` in `apps/brain/src/reflex/questions.ts`) or none. Go reads it as sure when one option reaches the bar and every other stays below 0.3. Its 106 lines:

- 52 search asks, 12 to 14 per kind, 25 in English and 27 in Hinglish, from the cues in the ixigo maps and the travel parser's own phrasings; some follow earlier lines ("Go Saturday subah ka bhi dikha do" after a flight search);
- 54 lines that ask for no search: travel talk from the Goa chats ("window seat for me pls 🙏", "train late tha last time"), the ixigo corners Go doesn't search (a flight's status, a PNR, coupons, a group fare, one hotel's pool), booking or cancelling, a running search, two kinds at once, and asks to Go that ixigo can't answer ("Go what's still undecided?").

At 0.9, on the recording CI scores (the repeat gives the same):

| Choice | Lines | Right | Wrong | Unsure |
|---|---|---|---|---|
| flights | 14 | 12 | 0 | 2 |
| stays | 14 | 13 | 0 | 1 |
| trains | 12 | 9 | 0 | 3 |
| buses | 12 | 12 | 0 | 0 |
| none | 54 | 50 | 0 | 4 |

**The bar.** Bash's Mac recipes pick at 0.6 with no rival at 0.3 or more, and the recording printed question 10 at that bar. One search ask is read as the wrong kind: "@Go is there confirmed sleeper availability Mumbai to Goa on the 5th" (a cue from the trains map) as buses, at 0.82 and 0.85 on the two recordings. "Sleeper" is a train class and a kind of bus. So every bar up to 0.85 makes a wrong pick on at least one recording. The bar is 0.9, which makes no wrong pick on either, with 0.05 to spare on this line. A missed pick costs nothing new: the travel parser decides alone, as it does without Jev.

The lines it is not sure of at 0.9 on the recording CI scores:

- the "sleeper" line above;
- "Go 5 Nov ko 3A mein 5 seats milengi kya Mumbai se Madgaon?": trains 0.57, flights 0.30;
- "Go return flights from Goa to Mumbai on 9 Nov evening please" (flights 0.89), "Go Goa ke liye Delhi se flight parso" (flights 0.79), "Go Vagator ke paas sasta hotel, 4 log ek room" (stays 0.89) and "Go train dekh lo phir Mumbai se, 5 Nov raat" (trains 0.85): right, below the bar;
- "how much is the villa per night?" and "Go also make sure the villa has parking", which Jev splits between stays and none;
- "Go is 6E 5341 on time?" (none 0.84) and "@Go flights and a villa for Friday from Delhi to Goa" (none 0.86): right, below the bar.

### Asked twice

The repeat ([run 37574978572](https://github.com/vestra-ai/go-brain/actions/runs/37574978572), the same model, settings and question wording) asked Jev the same 3,744 questions again. 1,789 of its answers came back different, by 0.016 on average and at most 0.09. At the bars Go has now, every question's pass or fail came out the same in both recordings, with no wrong answer in either. Sure, wrong and recall were the same in both for every question but two: question 4 was sure of 3 of its 6 lines in the repeat (recall 0.50, still at its gate), and question 7 of all 10 (recall 1.00). CI scores the first recording.

## What acting live changes

- **Question 1:** a message Jev is sure is chatter, or sure no one spoke to Go in, does not wake the main model; the notes pass and the quiet reactions still run for it. A message that names Go always does. When Jev gives no answer (a timeout or an error), a line that is only emoji, a laugh, an ok, or a greeting or sign-off ("gn 😴", "haha 😂", "gm all ☀️") does not wake it either; any other line does (`apps/brain/src/reflex/small-talk.ts`).
- **Questions 5, 6 and 7:** the notes pass runs at once for a sure fact or record line instead of after a quiet spell, and a sure 👍 or 🙌 goes on the message without any model. A ✅ goes on at once when questions 5 and 7 are both sure.
- **Questions 4 and 8:** no part of Go acts on these readings yet; acting live records them as acted in `reflex_reads`.
- **Question 2:** a message that names Go and that Jev is sure is finished goes to the main model at once. Any other message that wakes it waits 2 seconds (longer while more lines keep coming, up to 6), unless it names Go, or ends a burst of lines that named Go, and plainly ends with ?, ., ! or an emoji.
- **Question 9, in shadow:** Go does not offer help on its own from an opening.
- **Question 3, in shadow:** no part of Go acts on it yet.
- **Question 10:** travel's early search reads it (`apps/brain/src/travel/recipes/early.ts`, when ixigo.com is the travel source). A sure kind is the search to start, with the travel parser filling in its places and dates; a sure none starts no search, even one the parser found; unsure leaves the parser to decide alone.

## What this does not show

- The lines are written for the test, not taken from a real trip chat, and there are only 6 to 14 per question for questions other than 2 and 10. A wrong answer on a real chat is possible that this set did not catch.
- The bars for questions 2 and 10 were chosen on the same lines they are scored on. Question 10's one wrong pick shows the kind of line that can fool it: a word two kinds of travel share.
- These are Jev's answers from two runs on one day. Jev is pinned to `jev-1.13.0`; a new version means a new recording.
- Speed is measured from GitHub's runner, not from Go's server: a call with all ten questions took 179 ms at p50, 210 ms at p90 and 308 ms at most over the 162 lines (157, 192 and 340 ms on the repeat). Go waits at most 450 ms for Jev (`JEV_DEADLINE_MS`) before every question reads unsure.
- The "not spoken to Go" rule skips a line that is an opening for Go: "pata nahi yaar, tum log decide karo" (a vote would help) wakes no model. While question 9 is in shadow Go offers no help on its own from an opening anyway; once it acts live, this line is one it would miss. The set has only one line labelled for Go that does not name it, so the rule's "none for Go skipped" rests on that one line.
