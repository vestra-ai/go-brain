# Evidence: Jev's quick read

Jev is a fast model that answers closed questions with a probability. Go asks it ten questions about each message from a person (is it for Go, is it finished, is it a fact worth keeping, which ixigo search it asks for, and so on) and reads each answer as sure or unsure against a bar. A question **acts live** only once its test set passes; until then it runs **in shadow**: Go still asks it and logs the answer (`reflex_reads`), but acts only on what code alone knows.

This page explains the recording in this folder: where it comes from, how each question is scored, and which questions act live.

## The files

- `jev-2026-10-07.json`: Jev's answers to every question for every line of the test set, as recorded, unedited. It is the same file, byte for byte, as `apps/brain/src/reflex/testsets/recorded/jev-1.13.0.json`, which CI scores on every change.
- `jev-2026-10-07.txt`: what the recording printed, unedited: the time of Jev's calls, one line per question at the bars Go had when it was recorded (for question 10, one more line per choice), then the bar sweep (each bar's values and what they give).
- `jev-2026-10-07-repeat.json` and `jev-2026-10-07-repeat.txt`: a second recording of the same lines about 3 minutes later, unedited. Go does not use it; it shows how much Jev's answers move between two runs (see "Asked twice" below).

## Where the answers come from

- **Runs:** jev-record run [37571683670](https://github.com/vestra-ai/go-brain/actions/runs/37571683670), job `record`, artifact `jev-record`, recorded at 2026-10-07 04:30 UTC (`recorded_at` in the file); the repeat is run [37571925813](https://github.com/vestra-ai/go-brain/actions/runs/37571925813), at 04:33 UTC.
- **Code:** pull request #126 at `45d8c03`. The questions asked are that commit's; `versions` in the file holds each question's wording version, and CI marks a question stale if its wording changes.
- **Jev:** model `jev-1.13.0` at Jev's default address, the same settings as Go's deployment, with Vestra's staging Jev key from the repository's secrets. The key is never printed.
- **The recording runs in CI** (`.github/workflows/jev-record.yml`) when a pull request gets the label `jev-record`: one Jev call per line, with all ten questions in it, as Go asks them.

## The test set

`apps/brain/src/reflex/testsets/chat.jsonl` holds 131 chat lines in the Goa trip, 72 in English and 59 in Hinglish, each labelled by a person before any recording with what Jev should say. Questions 1 to 9 are each labelled on 6 to 14 lines, and question 10 on 106. The lines are written for the test set. Some of question 10's come from the bench's Goa chats (`goa-50` and `goa-300`) and from the cues in the ixigo maps (`recipes/`), which are written too, so none comes from a real trip chat yet.

## How a question is scored

Jev's recorded answers go through the same readers Go uses live, with the bars in `apps/brain/src/reflex/thresholds.ts`.

- **Right:** the reading is sure and matches the label.
- **Wrong:** the reading is sure and does not match. For question 8 a wrong answer is a false alarm: a line raised as risky that is not.
- **Unsure** counts as not found. It is the safe outcome: Go falls back to what code knows and the main model decides.
- **Recall:** right over labelled. For question 8, the risky lines raised over the risky lines.
- **Gate:** no wrong answer (question 8: at most 2 false alarms), and recall at least the question's minimum (`GATES` in `apps/brain/src/reflex/testset.ts`). Question 10 must also reach its minimum on the lines that ask for a search alone, so a reader that is only ever sure of "none" cannot pass on the other lines.

## The result

At the bars Go has now. Recall by language is right over labelled in that language.

| # | Question | Lines | Sure | Wrong | Recall | English / Hinglish | Gate | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | Is the message for Go? | 13 | 12 | 0 | 0.92 | 0.89 / 1.00 | 0.5 | live |
| 2 | Is the message finished? | 11 | 2 | 0 | 0.18 | 0.14 / 0.25 | 0.5 | shadow |
| 3 | A quick ask, or big work? | 9 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.4 | shadow |
| 4 | Which running job is it about? | 6 | 4 | 0 | 0.67 | 0.75 / 0.50 | 0.5 | live |
| 5 | A fact about the person worth keeping? | 14 | 10 | 0 | 0.71 | 0.70 / 0.75 | 0.5 | live |
| 6 | A line for the trip record (agreed, open, doing)? | 9 | 7 | 0 | 0.78 | 1.00 / 0.33 | 0.4 | live |
| 7 | A quiet reaction (✅ 👍 🙌), or none? | 10 | 9 | 0 | 0.90 | 1.00 / 0.67 | 0.3 | live |
| 8 | Risky (spend, steering Go, a secret)? | 14 (5 risky) | 5 raised | 0 false alarms | 1.00 | 1.00 / 1.00 | 0.8 | live |
| 9 | An opening for Go (a question it could answer, a choice going round in circles, someone asked to look something up)? | 6 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.3 | shadow |
| 10 | Which ixigo search does it ask for (flights, stays, trains, buses), or none? | 106 (52 searches) | 96 | 0 | 0.91 (searches 0.88) | 0.92 / 0.89 | 0.5 | live |

So questions 1, 4, 5, 6, 7, 8 and 10 act live (`PASSED_SETS` in `apps/brain/src/reflex/live-gate.ts`, and `REFLEX_LIVE` defaults to `q1,q4,q5,q6,q7,q8,q10`). The admin page's `REFLEX_LIVE` switch can narrow that list or turn Jev off, but it cannot make a question in shadow act live. Jev gave no sure wrong answer on any question at these bars. Questions 2, 3 and 9 stay in shadow because Jev was too rarely sure on them: no value in the sweep brings them to their gate (the best, in the recording CI scores, are 0.18, 0.22 and 0.17).

Rows 1 to 9 are the lines the recording printed. Row 10 is at the bar Go has now, 0.9; the recording printed it at 0.6, the bar it had then, where it made one wrong pick (see "Question 10" below).

### Question 1's chatter bar

Question 1 reads a line as sure chatter when Jev's "chatter" answer is at least 0.85 and its "for Go" answer at most 0.2. Bash's bar is 0.9, measured on 149 lines. Jev reads the six chatter lines here at 0.77 to 0.87 (0.78 to 0.88 on the repeat), so at 0.9 none would be sure chatter, while at 0.85 four are; "I'm veg btw" (0.77) and "chal theek hai, kal baat karte hain" (0.82) stay below. The rule below then reads all six as not for Go, so on this set every value from 0.8 to 0.95 gives the same result: recall 0.92 and no wrong answer. The bar is 0.85, below Bash's, because the two mistakes do not cost the same: an ask read as chatter goes unanswered, while a needless wake costs one model call.

Read this with care:

- Six of question 1's 12 right answers are lines that name Go, which code gets right without Jev. Jev's own part is the other six: the chatter lines.
- One chatter line sits on the bar: Jev read "hahaha Kabir you're never waking up at 6" at 0.87 the first time and 0.85 the second. If it reads lower, the rule below still reads it as not for Go: Jev's "for Go" answer for it is 0.03.
- The one ask that does not name Go ("can someone check trains from Mumbai on Thursday?") stayed unsure, so Go still wakes for it.

### Not spoken to Go

Question 1 also reads a line as not for Go when Jev is sure no one spoke to Go in it, chatter or not: its "for Go" answer is at most 0.1 (`notAddressedMax`). That is a fact ("I'm veg btw"), a plan ("North for sure, I'm in"), friends talking. A line that names Go is always for Go. A line about money is never read as not for Go, whatever Jev says: an amount that is plainly money (₹500, 3,200, 8k, 2 lakh) or a word for paying or owing (paid, pay, owe, owes, spent, gave, transferred, diya, bheja, dena, lena, udhaar), because only a turn records an expense or asks what an unclear one was for. On the first 50 lines of the set (the ones questions 1 to 9 are labelled on) the rule takes the lines that wake the model from 46 to 32 (33 on the repeat); the money check keeps two of those awake ("maine apna share bhej diya 🙌" and "the villa costs 54k total, split 5 ways"). It skips none of the lines labelled for Go: the lowest "for Go" answer on a line labelled for Go that does not name it is 0.67 (0.61 on the repeat), for "can someone check trains from Mumbai on Thursday?". A skipped line still gets the notes pass and its quiet reaction; only the main model stays asleep.

One line this skips is labelled as an opening ("pata nahi yaar, tum log decide karo": a vote would help). Question 9, which offers that help, is in shadow, so Go does not offer it on its own either way; the main model, woken, might have.

The sweep also shows question 5 would reach 0.86 at 0.7 instead of 0.8, question 7 would reach 1.00 at 0.85 instead of 0.9, and question 8 would raise one false alarm at 0.4 or lower; none was needed to pass, so none moved.

### Question 10: which ixigo search

Question 10 is one Choice: flights, stays, trains, buses (the four ixigo searches Go runs, `RECIPE_CHOICES` in `apps/brain/src/reflex/questions.ts`) or none. Go reads it as sure when one option reaches the bar and every other stays below 0.3. Its 106 lines:

- 52 search asks, 12 to 14 per kind, 25 in English and 27 in Hinglish, from the cues in the ixigo maps and the travel parser's own phrasings; some follow earlier lines ("Go Saturday subah ka bhi dikha do" after a flight search);
- 54 lines that ask for no search: travel talk from the Goa chats ("window seat for me pls 🙏", "train late tha last time"), the ixigo corners Go doesn't search (a flight's status, a PNR, coupons, a group fare, one hotel's pool), booking or cancelling, a running search, two kinds at once, and asks to Go that ixigo can't answer ("Go what's still undecided?").

At 0.9, on the recording CI scores:

| Choice | Lines | Right | Wrong | Unsure |
|---|---|---|---|---|
| flights | 14 | 13 | 0 | 1 |
| stays | 14 | 13 | 0 | 1 |
| trains | 12 | 9 | 0 | 3 |
| buses | 12 | 11 | 0 | 1 |
| none | 54 | 50 | 0 | 4 |

On the repeat, flights is 12 of 14 and everything else is the same (recall 0.90, searches 0.87, no wrong pick).

**The bar.** Bash's Mac recipes pick at 0.6 with no rival at 0.3 or more, and the recording printed question 10 at that bar. One search ask is read as the wrong kind: "@Go is there confirmed sleeper availability Mumbai to Goa on the 5th" (a cue from the trains map) as buses, at 0.76 and 0.81 on the two recordings. "Sleeper" is a train class and a kind of bus. So every bar up to 0.8 makes a wrong pick on at least one recording, and 0.85 clears it by 0.04. The bar is 0.9, which makes no wrong pick on either and leaves room for answers moving between runs. A missed pick costs nothing new: the travel parser decides alone, as it does without Jev.

The lines it is not sure of at 0.9 on the recording CI scores:

- the "sleeper" line above;
- "Go 5 Nov ko 3A mein 5 seats milengi kya Mumbai se Madgaon?": trains 0.56, flights 0.33;
- "Go Goa ke liye Delhi se flight parso" (flights 0.73), "Go Vagator ke paas sasta hotel, 4 log ek room" (stays 0.87), "Go train dekh lo phir Mumbai se, 5 Nov raat" (trains 0.87) and "Go bus hi dekh le phir, Thursday raat ki" (buses 0.85): right, below the bar;
- "how much is the villa per night?" and "Go also make sure the villa has parking", which Jev splits about evenly between stays and none;
- "Go is 6E 5341 on time?" (none 0.79) and "@Go flights and a villa for Friday from Delhi to Goa" (none 0.86): right, below the bar.

### Asked twice

The repeat ([run 37571925813](https://github.com/vestra-ai/go-brain/actions/runs/37571925813), the same model, settings and question wording) asked Jev the same 3,031 questions again. 1,451 of its answers came back different, by 0.017 on average and at most 0.10. At the bars Go has now, every question's pass or fail came out the same in both recordings. Questions 1 to 8 had the same sure, wrong and recall in both; question 9 was sure on one of its six lines in the repeat (recall 0.17, still under its gate); question 10 was 96 and 95 right of 106, with no wrong pick in either. CI scores the first recording.

## What acting live changes

- **Question 1:** a message Jev is sure is chatter, or sure no one spoke to Go in, does not wake the main model; the notes pass and the quiet reactions still run for it. A message that names Go always does.
- **Questions 5, 6 and 7:** the notes pass runs at once for a sure fact or record line instead of after a quiet spell, and a sure 👍 or 🙌 goes on the message without any model. A ✅ goes on at once when questions 5 and 7 are both sure.
- **Questions 4 and 8:** no part of Go acts on these readings yet; acting live records them as acted in `reflex_reads`.
- **Question 2, in shadow:** Jev never marks a message finished, so Go waits 2 seconds (longer while more lines keep coming, up to 6) before the main model answers, unless the message names Go, or ends a burst of lines that named Go, and plainly ends with ?, ., ! or an emoji.
- **Question 9, in shadow:** Go does not offer help on its own from an opening.
- **Question 3, in shadow:** no part of Go acts on it yet.
- **Question 10:** travel's early search reads it. A sure kind is the search to start, with the travel parser filling in its places and dates; a sure none starts no search, even one the parser found; unsure leaves the parser to decide alone. Until that hook is built, no part of Go acts on it; acting live records it as acted in `reflex_reads`.

## What this does not show

- The lines are written for the test, not taken from a real trip chat, and there are only 6 to 14 per question for questions 1 to 9. A wrong answer on a real chat is possible that this set did not catch.
- Question 10's bar was chosen on the same lines it is scored on, and its one wrong pick shows the kind of line that can fool it: a word two kinds of travel share.
- These are Jev's answers from two runs on one day. Jev is pinned to `jev-1.13.0`; a new version means a new recording.
- Speed is measured from GitHub's runner, not from Go's server: a call with all ten questions took 162 ms at p50, 191 ms at p90 and 296 ms at most over the 131 lines (163, 203 and 322 ms on the repeat). Go waits at most 450 ms for Jev (`JEV_DEADLINE_MS`) before every question reads unsure.
- The "not spoken to Go" rule skips a line that is an opening for Go: "pata nahi yaar, tum log decide karo" (a vote would help) wakes no model. While question 9 is in shadow Go offers no help on its own from an opening anyway; once it acts live, this line is one it would miss. The set has only one line labelled for Go that does not name it, so the rule's "none for Go skipped" rests on that one line.
