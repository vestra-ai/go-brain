# ixigo.com trains and buses: every corner, ready for Jev

This page maps every trains and buses corner of ixigo.com, so Jev can answer a group chat's train or bus question
from the site's own data. It builds on [ixigo-web-map.md](ixigo-web-map.md), which has the method and the basics of
the train search and bus search; this page adds every other corner and the fields those two calls carry that the
first map didn't need.

How this was mapped (7 Oct 2026, evening, India time): a local headless Chromium (Playwright 1.59.1), a fresh
logged-out profile for every load (locale en-IN, Asia/Kolkata, desktop Chrome user agent), at least 4 seconds
between loads. Read only: 21 page loads in all; no login, no booking, no traveller form, no payment, and no form
filled except searches, status lookups and one obviously fake PNR (1234567890). Nothing hit a captcha challenge, a
block or a login wall. Times are from one Mac on one evening, so treat them as rough.

## The short answer

| # | Corner | Group value | Entry | Data | Login | In by |
|---|---|---|---|---|---|---|
| T1 | Trains between two stations | High | URL | JSON call (reCAPTCHA, in page) | No | 2.1 to 2.7 s |
| T2 | Seat availability by class and quota, Tatkal included | High | Same page | JSON call (reCAPTCHA, in page) | No | 2.9 to 3.0 s |
| T3 | Waitlist confirmation chances | High | Same page | Field `p` of T2 | No | with T2 |
| T4 | Fares and fare breakup per class | High | Same page | Fields of T1 | No | with T1 |
| T5 | Confirmed seats via other stations (alternate route) | Medium | Same page | Field of T1 | No | with T1 |
| T6 | 60-day availability calendar (route, or one train) | High | URL | JSON call (route) / page HTML (train) | No | 0.6 s / 0.9 s |
| T7 | Train page: schedule, stops, platforms, average delay, running days | Medium | URL | Page HTML | No | 0.8 s |
| T8 | Live running status ("where is my train") | High on travel day | URL | Page HTML (today); JSON call (other days, reCAPTCHA) | No | 0.6 s / 2.1 s after the click |
| T9 | PNR status | High after booking | URL | JSON call (reCAPTCHA, in page) | No | 2.0 s after the URL |
| T10 | Platform number | Medium | Inside T7 and T8 | Page HTML | No | with T7 / T8 |
| T11 | Coach position | Medium | Inside T7 | Page HTML | No | with T7 |
| T12 | Tatkal timings, rules and charges | High | URL | Static page | No | 1.3 s |
| T13 | ixigo Assured (free cancellation) | Medium | URL | Static page; a paid add-on at booking | No | 0.5 s |
| T14 | Alternate Travel Plan (refund if still waitlisted) | Medium | URL | Static page; a paid add-on at booking | No | 0.3 s |
| T15 | IRCTC cancellation charges | Medium | URL | Static page | No | 0.6 s |
| T16 | Station page: trains through a station | Low | URL | Page HTML | No | 0.6 s |
| T17 | Find a train by name or number | High (it feeds every train recipe) | Search box | JSON call, no reCAPTCHA | No | 0.5 s after typing |
| T18 | Groups | Low | Group page is flights only | None | No | n/a |
| T19 | Order food on the train | Low | Link only | Not mapped | Needs a PNR | n/a |
| T20 | Seat map | None | ixigo has no train seat map | n/a | n/a | n/a |
| B1 | Bus search | High | URL | One JSON call, no reCAPTCHA | No | 0.7 to 0.8 s |
| B2 | Filters and sort (AC, sleeper, operator, rating, time, price) | High | Fields of B1 | Fields of B1 | No | with B1 |
| B3 | Seat layout (one bus) | High | "Select Seats" button | JSON call, no reCAPTCHA | No | 0.5 s after the click |
| B4 | Boarding and dropping points | High | B1 (ids) and B3 (times, landmarks) | Fields | No | with B1 / B3 |
| B5 | Bus cancellation policy and free cancellation | Medium | Inside B3 | Fields of B3 | No | with B3 |
| B6 | Offers, coupons, group deal | Medium | URL, plus fields of B1 | Page HTML and fields | No | 0.4 s |
| B7 | Live bus tracking | Medium on travel day | URL | Not mapped | Needs a booking ID and phone | n/a |

## Top 5 for fast recipes

1. **B1 Bus search.** One call, every bus, fares, seats left, ratings, boarding and dropping points, offers and
   flags, in 0.8 s, with no reCAPTCHA.
2. **T1 + T2 + T3 Trains between stations, with availability, Tatkal and chances.** One page, two calls, every
   train with its classes, fares, status per class and quota (General and, once open, Tatkal) and the % chance a
   waitlisted ticket confirms, in about 3 s. In page only (reCAPTCHA).
3. **T8 Live running status, today.** Plain URL, server-rendered table of every station with actual times, delay
   and platform, in 0.6 s, no reCAPTCHA.
4. **T7 Train page.** Plain URL, server-rendered: schedule with platforms and average delay, running days,
   classes, pantry and coach order, in 0.8 s, no reCAPTCHA.
5. **B3 + B4 + B5 Bus seat layout.** One click after B1: which seats are free and at what price, the full
   boarding and dropping lists with times and landmarks, the cancellation tiers and the free cancellation add-on,
   in 0.5 s, no reCAPTCHA.

Next after these: **T9 PNR status** (high value, 2 s, but in page only, and a real PNR's fields are still
unmapped) and **T17 train lookup by name**, which every train recipe needs to turn "Mandovi Express" into 10103.

## What every train recipe shares

- **Station codes.** URLs use railway codes (NDLS, CSMT, MAO). A search from NDLS also returns trains leaving
  other Delhi stations (most from NZM): use the boarding station each train reports. The results page looks up each
  end with `GET /action/content/trainstation?searchFor=trainstationsLatLon&anchor=false&value=Madgaon%20(MAO)`.
- **Train number from a name (T17).** `GET /action/content/trainstation?searchFor=getTrainByNameOrCode&nameOrCode={text}`
  answers a list: `c` number, `n` name, `origin` / `destination` codes and names, `ct` classes (`:1A:2A:3A:SL:`),
  `d` running days as a 7-bit number (127 is daily). It carries the static web `apikey`, no reCAPTCHA token.
- **reCAPTCHA.** The train list, availability, running history (other days) and PNR calls each carry `gauth`, a
  fresh invisible reCAPTCHA token the page mints just before the call. These can only be read inside the page:
  open the URL, wait for the call with `page.waitForResponse`, parse its JSON. Never replay them from outside.
  Most of the 2 s these take is the token, not ixigo.
- **Server-rendered pages.** The train page, running status (today), seat calendar (one train), station page and
  the policy pages come as HTML with no data call; read them from the accessibility tree or the HTML.

## Trains

### T1 Trains between two stations

**What and why (high).** Every train from A to B on a date, with times, duration, classes and fares. The first
question of almost every trip plan: "Delhi se Goa kaunsi trains hain 6 Nov ko".

**Entry.** `https://www.ixigo.com/search/result/train/{FROM}/{TO}/{DDMMYYYY}//1/0/0/0/ALL`
(for example `.../train/CSMT/MAO/08102026//1/0/0/0/ALL`; the trailing segments are unconfirmed, this shape loads).

**Data.** `GET /trains/v1/search/between/{FROM}/{TO}?date={YYYY-MM-DD}&languageCode=en` (reCAPTCHA). Under `data`:

| Need | Field | Example |
|---|---|---|
| trains | `trainsBetweenStations[]` | 6 (NDLS to MAO, 6 Nov), 16 (CSMT to MAO, 8 Oct) |
| number, name, type | `attributes.number`, `.localName`, `.type` | `22656`, `NZM ERS SF EXP` |
| where you board and get off | `boardStation`, `deboardStation`, `bookingOriginStation`, `bookingDestinationStation` | `NZM`, `MAO` |
| times | `departDate`, `attributes.departTime`, `arrivalDate`, `attributes.arrivalTime`, `attributes.dayOfJourney` | |
| distance, stops | `distance`, `stationsElapsed` | `2093` |
| runs on | `attributes.daysOfOperation` (7 characters, Sunday first) | `0000100` |
| rating, bookable | `attributes.averageRating`, `.bookable`, `suspended` | |
| cheapest per class | `minFare`, `trainMinFaresAndDurations[]` (`trainClass`, `minFare`, `trainDuration` ms) | SL `865` |

**Login, money.** No login. Free to read; "BOOK" starts an IRCTC booking (never).

**Jev cues.** Slots: from, to, date (and optionally class, time of day).
- "Delhi se Goa train hai kya 6 Nov ko?"
- "Mumbai to Goa trains kal ke liye dikhao"
- "koi raat wali train hai Pune se Madgaon?"
- "which trains go from Bangalore to Goa on Friday"
- "NZM to MAO trains list bhejo"
- "Goa ke liye sabse fast train kaunsi hai?"

**Recipe.** Open the URL; wait for `/trains/v1/search/between/`; return per train: number, name, board and
deboard stations, depart and arrive times with dates, duration, classes, cheapest fare. All in by 2.1 to 2.7 s.

### T2 Seat availability by class and quota, Tatkal included

**What and why (high).** For every train on the route: is there a seat in each class, waitlisted, RAC or closed.
A group needs several seats in one class on one train, so this decides the plan.

**Entry.** The T1 URL; the same page fetches it right after the train list.

**Data.** `GET /api/v3/trains/availability?originCode={FROM}&destinationCode={TO}&travelDate={DDMMYYYY}`
(reCAPTCHA). Under `data.routesData[]`: `trainCode`, `bookingOriginStation`, `bookingDestinationStation`, and
`availabilities[]`:

| Field | Meaning | Examples |
|---|---|---|
| `c` | class | `1A`, `2A`, `3A`, `3E`, `SL`, `CC`, `2S`, `EC`, `EV` |
| `q` | quota | `GN` General, `TQ` Tatkal |
| `a` | status | `AVAILABLE 346`, `WL 11`, `RAC 70`, `Regret`, `Not Available` |
| `f` | fare (₹, per person); for Tatkal it includes the Tatkal charge | `2005` (Tatkal 2A; its base fare is `1565`) |
| `t` | when ixigo last checked it (epoch ms) | the page shows "3hr 20min ago" |
| `p` | confirmation chance, % (T3) | `39` |
| `ancillaryMetadata` | add-on offered on this class | `{"text":"Alternate Travel Plan","insuranceType":"TRAVEL_GUARANTEE"}` |
| `bookingErrorMessage` | on Tatkal entries | `tatkal.ac`, `tatkal.nonac` (meaning unconfirmed; matches the AC 10:00 and non-AC 11:00 windows) |

- **Tatkal is in the same response once it's open.** For 8 Oct (searched the evening of 7 Oct) the answer held 60
  General and 50 Tatkal entries. For 6 Nov it held General only. Clicking "Tatkal" on the page only filters what's
  shown (the card links switch to `quota=TQ`); it makes no new call. So one read gives both quotas.
- The page's quota filter also lists "Lower Berth" and "Ladies"; neither appeared in the data I saw.
- Each `f` is per person: a group's total is fare × heads.

**Login, money.** No login; free to read.

**Jev cues.** Slots: route, date, class (optional), quota (optional), heads.
- "6 Nov ko 3A mein 5 seats milengi kya Mandovi mein?"
- "tatkal mein seat hai kya kal ke liye Goa?"
- "is there confirmed sleeper availability Mumbai to Goa on 8th"
- "WL kitna hai 2A ka?"
- "kaunsi train mein seat available hai abhi"
- "Goa ke liye tatkal kab khulega aur abhi kitni seats hain"

**Recipe.** Same load as T1; wait for `/api/v3/trains/availability`; join on `trainCode`; return per train and
class: status, fare, quota, checked how long ago, chance. In by 2.9 to 3.0 s from the start.

### T3 Waitlist confirmation chances

**What and why (high).** For a waitlisted class, ixigo's % chance it confirms ("39% Chances" on the card). Tells
a group whether to risk WL or pick another train.

**Entry and data.** Field `p` of each T2 entry. `0` means no prediction shown. For 6 Nov, 2 of 25 entries had one
(`p: 39` on `WL 22`); for 8 Oct, 28 of 110. The page also fetches a small prediction switch,
`GET /action/content?searchFor=cmsContent&page=trains&identifier=prediction&token=config`
(`{"listing":true,"booking":true,"status":true,"detail":true,"a2b":true}`).

**Login, money.** No login; free.

**Jev cues.** Slots: train, class, date (or a PNR, see T9).
- "WL 22 confirm hoga kya?"
- "is waitlist ke chances kitne hain"
- "what are the chances our 3E tickets confirm"
- "risk le sakte hain WL pe?"
- "confirmation probability batao 12218 ka"

**Recipe.** From the T2 read: for each WL entry, `p` > 0 means "about p% chance"; `0` means "no prediction".

### T4 Fares and fare breakup per class

**What and why (high).** The per-person fare in each class, and its parts. A group's budget question:
"3A mein total kitna padega 5 logon ka".

**Data.** In the T1 answer, `fares.{class}`: `baseFare`, `serviceCharge`, `railwayCharges`, `cateringCharges`,
`otherCharges`. In what I saw only `baseFare` was filled (the rest `0`). T2's `f`, the fare on the card, equalled
`baseFare` for all 85 General entries I checked; for Tatkal it is higher by the Tatkal charge (2A `2005` vs `1565`,
+₹440; 3A `1435` vs `1120`, +₹315), inside T12's limits.

**Login, money.** No login; free.

**Jev cues.** Slots: route or train, class, heads.
- "Goa train ka 3A fare kitna hai"
- "5 logon ka sleeper mein total kitna hoga"
- "AC vs sleeper price difference?"
- "cheapest train Mumbai to Goa"
- "tatkal mein kitna extra lagega"

**Recipe.** From T1 and T2: quote T2's `f` per person, × heads for the group, and say it's per person.

### T5 Confirmed seats via other stations (alternate route)

**What and why (medium).** ixigo's "Confirmed seat(s)" option: board from, or book to, another station on the
route where seats are free. Useful when the group's exact pair is waitlisted.

**Data.** In the T1 answer, `alternateTrainsResponse`: `metadata.title` ("Confirmed Seat(s)"), `.text`,
`.subtitle` ("1 confirmed seat available"), and `alternateRouteTrains[]`. The list was empty in both searches I
ran, so its fields are unmapped.

**Login, money.** No login; booking would cost the longer route's fare (not tried).

**Jev cues.** Slots: route, date, class.
- "kisi aur station se confirm seat mil sakti hai kya?"
- "is there any way to get confirmed seats to Goa"
- "Panvel se board karein toh seat milegi?"
- "alternate route se try karo"
- "WL hai, koi aur option?"

**Recipe.** From the T1 read: if `alternateRouteTrains` is non-empty, offer them; else say none was found.

### T6 60-day availability calendar

**What and why (high).** Which dates still have seats. Lets a group pick the travel date: "kis din seat mil
rahi hai".

**Route level.** `GET /api/v2/trains/availabilityCalender?originCode={FROM}&destinationCode={TO}&bookingClass=ALL`
(no reCAPTCHA; fetched by the T1 page at 0.6 s): `data.availability[]` with `date` (`2026/10/07`) and `state`
(`FewSeats`, `FillingFast`, `Available`). Coarse, but it covers 60 days.

**One train.** `https://www.ixigo.com/trains/{number}/seat-availability` (0.9 s, server-rendered). For the first
class (1A for 10103) it lists every day with status and freshness: "Thu, 08 Oct WL2 … Alternate Travel Plan a
moment ago", "Tue, 13 Oct AVL2 4hr 47min ago", today as "CURR_AVL4". Class tabs ("1A 2605 2A 1540 …") and the
quota box ("General / Tatkal / Lower Berth / Ladies") are client-side controls; they were not clicked, so another
class needs a click (and likely a reCAPTCHA call), or T2 per date.

**Login, money.** No login; free.

**Jev cues.** Slots: route or train, class, month or date range.
- "Nov mein kis date ko Goa ki seat mil rahi hai?"
- "which dates in the next month have 3A available on Mandovi"
- "Diwali ke aas paas seat hai kya?"
- "agle weekend kab ka ticket confirm milega"
- "is there any day this month with available sleeper"

**Recipe.** Route: read the calendar call from the T1 load. Train: open the seat-availability URL, read the day
lines from the tree, say which class it is.

### T7 Train page: schedule, stops, platforms, average delay, running days

**What and why (medium).** Everything about one train: when it runs, every stop with times, halt, distance,
platform and its usual delay, classes, pantry. Groups use it for "kahan se board karein" and "late chalti hai
kya".

**Entry.** `https://www.ixigo.com/trains/{number}?orgn={FROM}&dstn={TO}&departDate={YYYY-MM-DD}&quota={GN|TQ}`
(`/trains/{number}` alone also works; anchors `#availability`, `#schedule`, `#coachPosition`). A Hindi version
is at `/hi/trains/{number}...`.

**Data.** Server-rendered, 0.8 s, no data call:
- heading "Mandovi Express 10103 Train"; "Runs on: SMTWTFS"; a line with from, time, duration, stops, to, time,
  and tags (Pantry, Superfast, Overnight, Catering).
- "Train Details" table: Classes, Service Days, Stops, Duration, Type, Pantry.
- "Schedule, Routes & Time Table" table, one row per station: Stn Code, Stn Name (a link to the station page),
  Arrives, Departs, Stop time, Distance, Platform, Route, Day, Avg delay ("On Time", or minutes).
- "Ticket Prices": From, To and Quota boxes and an 8-day strip; it showed "NA" for every day (it fills only after
  a click, not tried).

**Login, money.** No login; free.

**Jev cues.** Slots: train number or name (T17).
- "Mandovi express ka time table bhejo"
- "10103 kahan kahan rukti hai"
- "does this train stop at Thivim?"
- "Madgaon kab pahunchegi"
- "ye train roz chalti hai kya"
- "kitna late chalti hai usually"

**Recipe.** Open the URL; read the tables from the tree; return the stops (code, name, arrives, departs, halt,
platform, day, average delay) plus running days and classes.

### T8 Live running status ("where is my train")

**What and why (high on the day).** Where the train is now and how late. The travel-day question: "train late hai
kya", "kahan pahunchi".

**Entry.** `https://www.ixigo.com/trains/{number}/running-status`.

**Today (0.6 s, server-rendered, no reCAPTCHA).** A day strip ("Monday 05-10-2026, Yesterday, Today, Tomorrow";
Today selected), an overall line ("Yet to start from C Shivaji Mah T at", or the delay), "Updated 34min ago", and a
table with one row per station: Station (and km), Arrival actual/scheduled, Departure actual/scheduled, Delay,
PF/Halt. For 10103 at about 8 pm the page still said "Yet to start" though the train leaves at 07:10, so check
"Updated … ago" and don't over-trust it.

**Another day (a train that started yesterday).** Click the day ("Yesterday"); the page calls
`GET /api/v3/trains/running/history?date={DDMMYYYY}&trainNumber={number}` (reCAPTCHA), answered 2.1 s after the
click. Fields:

| Need | Field | Example (12051, 6 Oct) |
|---|---|---|
| where now | `curStn`, `curStnName`, `departed`, `terminated`, `distanceFromCurrentStation` | `MAO`, `Madgaon`, `true`, `true` |
| how late | `totalLateMins`, per station `delayArr`, `delayDep` | `7` |
| how fresh | `lastUpdated`, `lastFetched` | `06 Oct 2026 17:21` |
| on the map | `latitude`, `longitude`, `speed` | |
| cancelled bits | `cncldFrmStn`, `cncldToStn`, per station `cancelled`, `diverted` | |
| per station | `stations[]`: `stnCode`, `stnName`, `schArrTime`, `actArr`, `schDepTime`, `actDep`, `pfNo`, `platformArray`, `haltMins`, `distance`, `travelled` | |

**Login, money.** No login; free.

**Jev cues.** Slots: train number or name; day (today by default; "kal wali" means yesterday's start).
- "train late hai kya 12051"
- "Mandovi abhi kahan pahunchi?"
- "where is my train, Rajdhani 12952"
- "Madgaon kitne baje pahunchegi aaj"
- "kal raat wali train ka live status"
- "train chal rahi hai ya cancel ho gayi?"

**Recipe.** Today: open the URL, read the overall line, "Updated … ago" and the rows. Another day: open the URL,
click the day, wait for `/api/v3/trains/running/history`, return `curStnName`, `totalLateMins`, next stop and its
expected time, `lastUpdated`.

### T9 PNR status

**What and why (high after booking).** A booked ticket's status per passenger (confirmed, RAC, WL, coach and
berth), plus ixigo's prediction. The group has one PNR per booking: "PNR check karo 2345678901".

**Entry.** `https://www.ixigo.com/trains/pnr-status/{PNR}` (typing a PNR into the textbox on
`/trains/pnr-status` and pressing Enter navigates there).

**Data.** `GET /trains-info/v1/pnr/enquiry?pnr={PNR}&mode=NEW_ADDITION` (reCAPTCHA), answered 2.0 s after the
PNR was entered. Only the fake number 1234567890 was tried: the answer was
`{"errors":{"code":500,"message":"Flushed PNR /PNR not yet generated"}}`, and the page showed "PNR Not Found: The
booking details for this PNR are no longer available" with a "Retry" button. A real PNR's fields are unmapped:
map them with a real one before writing the recipe.

**Login, money.** No login; free.

**Jev cues.** Slots: PNR (10 digits).
- "PNR check karo 2345678901"
- "mera ticket confirm hua kya, PNR 2345678901"
- "what's the status of our booking 2345678901"
- "coach aur berth number batao"
- "WL se RAC hua kya?"
- "chart bana kya?"

**Recipe.** Open `/trains/pnr-status/{PNR}`; wait for `/trains-info/v1/pnr/enquiry`; an `errors` answer means
"not found or flushed"; otherwise return each passenger's status (fields to be mapped).

### T10 Platform number

**What and why (medium).** Which platform the train comes on, so the group meets at the right place.

**Entry and data.** No page of its own is needed:
- historic: the "Platform" column of T7's schedule;
- live: "PF/Halt" in T8 today, or `pfNo` / `platformArray` in the running history.

`/trains/platform-locator` has a textbox "Enter the train name or number" and a button "Search Platform"; it was
not submitted.

**Login, money.** No login; free.

**Jev cues.** Slots: train, station.
- "Mandovi CSMT se kaunse platform pe aayegi?"
- "which platform at Madgaon"
- "PF number batao 12051 ka Thane pe"
- "platform kaunsa hai, sab wahi milte hain"
- "platform change hua kya?"

**Recipe.** Today: T8's row for the station. Otherwise: T7's row, said as "usually platform N".

### T11 Coach position

**What and why (medium).** The order of coaches from the engine, so a group with seats in B2 and B3 knows where to
stand.

**Entry and data.** T7's "Coach Position & Seat Layout" section (`#coachPosition`): "has 22 coaches", then the order
from the engine, for example "EN GN GN M3 M2 M1 B4 B3 B2 B1 A1 HA1 PC S7 … S1 GN GN", marked "based on historic
data". The coach-position page (`/trains/coach-position`) has a search box ("Search trains by name or number")
that leads to `/trains/coach-position/{number}`, which answered HTTP 500 on 7 Oct: use T7 instead.

**Login, money.** No login; free.

**Jev cues.** Slots: train, coach (optional).
- "B2 coach kahan rukega?"
- "coach position batao Mandovi ka"
- "engine se kaunsa number hai S4?"
- "where should we stand for 3A"
- "AC coaches aage hain ya peeche?"

**Recipe.** Open T7; read the coach order line; say where the asked coach is, and that it's historic.

### T12 Tatkal timings, rules and charges

**What and why (high).** Last-minute trips run on Tatkal: when it opens, how many per PNR, what it costs, refund
rules.

**Entry.** `https://www.ixigo.com/trains/tatkal-railway-reservation` (static, 1.3 s).

**What it says (7 Oct 2026):**
- Opens one day before the journey date (from the train's origin station): AC classes (1A, 2A, 3A, CC, EC, 3E)
  10:00 to 10:30 AM, non-AC (SL, FC, 2S) 11:00 to 11:30 AM.
- At most 4 passengers per PNR.
- Extra charge: 10% of base fare for second class, 30% for the others, within limits: 2S ₹10 to ₹15, Sleeper ₹100
  to ₹200, AC Chair Car ₹125 to ₹225, AC 3 Tier ₹300 to ₹400, AC 2 Tier ₹400 to ₹500, Executive ₹400 to ₹500.
- Confirmed Tatkal: no refund on cancellation. Waitlisted or RAC Tatkal: refund with deductions if cancelled up to
  30 minutes before departure. TDR possible if the train is cancelled or over 3 hours late.

Live Tatkal seats are in T2 (`q: "TQ"`).

**Login, money.** No login; free to read. Booking costs the fare plus the Tatkal charge.

**Jev cues.** Slots: route or train, travel date (to compute when it opens), class.
- "Goa ke liye tatkal kab khulega"
- "kal ki tatkal booking kitne baje start hogi"
- "tatkal mein 5 log ek PNR pe ho sakte hain?"
- "tatkal ka extra charge kitna hai 3A mein"
- "tatkal cancel karein toh paisa milega?"

**Recipe.** No load needed for the rules: answer from this page (say "as of 7 Oct 2026"); for "kab khulega",
compute the day before the journey and the AC or non-AC time. For seats, run T2.

### T13 ixigo Assured (free cancellation)

**What and why (medium).** A paid add-on at booking: cancel and get the full train fare back. Good for a group
whose plans may change.

**Entry.** `https://www.ixigo.com/ixigo-assured-trains-policy` (0.5 s). The results page's banner links to the
same policy (`IXIGO_ASSURED_TRAINS_POLICY`).

**What it says:** zero cancellation fee, instant full train fare refund; only the train fare is refunded (ixigo
fee, IRCTC convenience fee, payment gateway charges and the free cancellation charge are not); cancel before chart
preparation; "Current Availability" bookings at least 30 minutes before departure. The add-on's price shows only
during booking, so it wasn't seen.

**Login, money.** Booking needs login; the add-on costs money (stop before booking).

**Jev cues.** Slots: none (policy), or a fare to estimate.
- "free cancellation milta hai kya train mein"
- "agar plan cancel hua toh paisa wapas aayega?"
- "Assured kya hota hai ixigo pe"
- "can we cancel later without losing money"
- "refund kitne din mein aata hai"

**Recipe.** Answer from this page; say the add-on price shows only at booking.

### T14 Alternate Travel Plan (refund if still waitlisted)

**What and why (medium).** A paid add-on on WL tickets (formerly Travel Guarantee): if the ticket is still
waitlisted at chart preparation, a refund of 3X (flight), 3X (bus) or 2X (train) of the fare, as 1X to the
payment method and the rest as a coupon valid 7 days from chart preparation for a trip in those 7 days.

**Entry.** `https://www.ixigo.com/trains/alternate-travel` (0.3 s). In T2 it shows on a class as
`ancillaryMetadata.insuranceType: "TRAVEL_GUARANTEE"`; the T6 calendar tags those days "Alternate Travel Plan".

**Login, money.** Booking needs login; the add-on costs money (price not seen).

**Jev cues.**
- "WL book karein toh koi guarantee hai?"
- "agar confirm nahi hua toh kya milega"
- "3X refund wala option kya hai"
- "Alternate Travel Plan lena chahiye?"
- "waitlist ticket pe flight ka option milta hai kya"

**Recipe.** Answer from this page; from T2 say which classes offer it.

### T15 IRCTC cancellation charges

**What and why (medium).** What it costs to cancel a confirmed ticket.

**Entry.** `https://www.ixigo.com/trains/irctc-cancellation-charges-icms` (0.6 s). Table "IRCTC Cancellation
Charges": more than 48 hours before, 12 to 48 hours, less than 12 hours and up to 4 hours. For example AC First /
Executive ₹240 / 25% of fare (min ₹240) / 50% (min ₹240); AC 2 Tier ₹200 / 25% / 50%; AC 3 Tier, Chair Car, 3E ₹180
/ 25% / 50%; Sleeper ₹120 / 25% / 50%; Second Class ₹60 / 25% / 50%. The title mentions a refund calculator; no
calculator inputs were in the tree.

**Login, money.** No login; free to read.

**Jev cues.**
- "cancel karein toh kitna katega 3A mein"
- "2 din pehle cancel karne pe refund kitna"
- "what's the cancellation charge for sleeper"
- "aaj cancel kiya toh kuch milega?"
- "RAC ticket cancel kar sakte hain?"

**Recipe.** Answer from the table (say "as of 7 Oct 2026"), class by hours before departure.

### T16 Station page

**What and why (low).** A station's code, city, number of trains and its timetable.

**Entry.** `https://www.ixigo.com/train-stations/{name}-{code}-railway-station` (e.g.
`madgaon-mao-railway-station`; T7 links every stop's page). Server-rendered, 0.6 s: "Station Details" (Code MAO,
Name Madgaon, City Goa, Total trains 223) and a table of trains (Train Name/No. (link), Arrives, Departs,
Duration, Day of Run), with a "View More Trains" button. There is no live arrivals board. Search box: textbox
"Enter the station name or code", button "Search".

**Jev cues.** Slots: station.
- "Madgaon se kaunsi trains jaati hain"
- "Thivim station ka code kya hai"
- "Goa ke kitne stations hain train ke liye"
- "Karmali pe kaunsi trains rukti hain"
- "first train from Madgaon"

**Recipe.** Open the station URL; read the details and the train table.

### T17 Find a train by name or number

**What and why (high as a building block).** People say "Mandovi" or "Goa Express", not 10103.

**Data.** `GET /action/content/trainstation?searchFor=getTrainByNameOrCode&nameOrCode={text}` (no reCAPTCHA),
seen from the coach-position search box, answered about 0.5 s after typing "Mandovi". "Mandovi" returned both
directions (10103 CSMT to MAO, 10104 MAO to CSMT) and near matches (01114 "Mandovi Special Fare Special", 22996
"Mandore Express"), so pick by origin and destination. The trains home has a "Train by Name/No." page,
`/trains/name-number` (not loaded).

**Jev cues.** Slots: name or number, and the direction if the name is ambiguous.
- "Mandovi express ka number kya hai"
- "Goa Express kaunsi hai"
- "Rajdhani Mumbai to Delhi number"
- "vande bharat Goa wali"
- "Janshatabdi Madgaon"

**Recipe.** Run the lookup inside any ixigo page (it needs only the page's static web key); choose the match whose
`origin` and `destination` fit the trip; ask when two fit.

### T18 Groups

The "Group Booking" link on the trains home (`rocket.ixigo.com/group/index.html`) redirects to
`/support/group?p=app_search_form`, a callback form for **flights** ("Got Group Travel plan?"): One Way or Round
Trip, origin, destination, departure, head count, email, phone, notes, "Submit"; a representative calls within an
hour. It was not filled. Trains have no group corner; what matters for a group is the per-PNR limit (4 for Tatkal,
T12) and T2's seats per class.

### T19 Order food on the train

`/trains/order-food-in-train` (linked from the trains home). It needs a booked PNR; not mapped.

### T20 Seat map

ixigo has no seat map for trains (IRCTC allots berths). The train page's "Seat Layout" is a coach diagram image
plus the coach order (T11).

## Buses

Bus search is AbhiBus inside ixigo. Its calls carry only `x-app-name: ixibusweb`, no reCAPTCHA, and no page in
the bus flow loaded a reCAPTCHA frame.

### B1 Bus search

**What and why (high).** Every bus from A to B on a date with fares, seats left, operator, type and rating.
"Mumbai se Goa bus kitne ki hai".

**Entry.** `https://www.ixigo.com/buses/bus_search/{FromName}/{fromId}/{ToName}/{toId}/{DD-MM-YYYY}/O`
(Mumbai is 4, Goa 102; ids come from `GET /wap/abus-autocompleter/api/v1/results?s={text}`, see
ixigo-web-map.md). Route pages also exist at `/buses/{from}-{to}-sts`.

**Data.** `POST /buslist/v3/services` (body in ixigo-web-map.md), answered at 0.7 to 0.8 s with all 71 buses for
Mumbai to Goa on 6 Nov. Per bus, beyond the first map's fields:

| Need | Field | Example |
|---|---|---|
| ids for B3 | `serviceKey`, `operatorId` | `4702694922`, `126130` |
| bus | `travelerAgentName`, `busTypeName`, `busType`, `busNo`, `viaPlaces` | |
| rating | `rating`, `noOfRatings` | |
| offer line | `discountMsg` | "Save min ₹300 with Early Bird Offer" |
| flags | `flags.isTrackAvail`, `.hasGroupDeal`, `.isFcOperator`, `.isWomenSafeBoarding`, `.isVolvo`, `.isLuxury`, `.isElectric`, `.isDealAvail`, `.isAssuredOperator` | `isTrackAvail: 1` on all 71 |
| berth tags | `tags[]` | "11 Single Berths (LB-5, UB-6)" |
| discounts | `edgeConfig.{n}`: `type`, `discount`, `maxDiscount`, `minTicketValue`, `groupDealCount` | type 8: 10%, `groupDealCount: "4"` |

Top level adds `quickFiltersList`, `onTimePerformantPer`, `filterBanners`, `operatorBanners`,
`promotionalOfferEnabled`.

**Login, money.** No login; free to read. "Select Seats" opens B3; choosing a seat starts a booking (never).

**Jev cues.** Slots: from, to, date (heads for seats).
- "Mumbai se Goa bus kitne ki hai 6 Nov"
- "Pune to Goa sleeper bus tonight"
- "koi AC bus hai Bangalore se Gokarna?"
- "sabse sasti bus dikhao"
- "5 logon ke liye bus mein seat hai?"
- "Volvo bus Mumbai to Goa"

**Recipe.** Open the URL; wait for `/buslist/v3/services`; return per bus: operator, type, departure and arrival,
duration, fare from, seats left, rating, offer line. All in by 0.8 s.

### B2 Filters and sort

**What and why (high).** AC or not, sleeper or seater, operator, rating, time of day, price. Groups often want
"AC sleeper, raat ko, rating 4+".

**Data.** No filter call: B1's answer already has `busTypeName` / `busType`, `travelerAgentName` / `operators{}`,
`rating`, `timings`, `fares`, `flags`, `tags`, so Jev filters the JSON itself. Page controls (text, no roles): bus
type "AC", "Sleeper", "Non AC", "Seater", "Bus Track", "New Buses", "Offers"; "Price Range"; departure buckets;
"Bus Partner", "Boarding Point", "Dropping Point"; sort "Price", "Seats", "Ratings", "Arrival Time", "Departure
Time" (see ixigo-web-map.md).

**Jev cues.** Slots: B1's plus type, time window, minimum rating, maximum price.
- "sirf AC sleeper dikhao"
- "raat 9 baje ke baad wali buses"
- "rating 4 se upar wali"
- "under 1500 koi bus?"
- "Neeta ki bus hai kya?"

**Recipe.** B1, then filter and sort the JSON.

### B3 Seat layout (one bus)

**What and why (high).** Which seats or berths are free, where, and at what price. A group of 5 wants berths
together, and lower berths for some.

**Entry.** On the B1 page, button "Select Seats" on the bus. No URL of its own.

**Data.** `POST /wap/GetSeatLayout`, answered 0.5 s after the click (no reCAPTCHA), body
`{"sourceid":"4","destinationid":"102","jdate":"2026-11-06","serviceKey":"{serviceKey}","prd":"mobile",
"version":"58","isReturnJourney":"0","operatorId":"{operatorId}","clevertapID":"..."}`.

| Need | Field | Example |
|---|---|---|
| seats | `TotalSeatList.lowerdeck_seat_nos[]`, `.upperdeck_seat_nos[]`: comma-separated, columns named in `titles` | `"3L, 1, 1, LB, Y, M, 3000, 0, 150.00, 0.00, 0, 0,h,2700"` |
| columns | `titles` | Seat Number, Row ID, Column ID, Seat Type, Availability (Y/N), Is Ladies Seat, Seat Fare, Seat ID, GST Amount, Service Charge, Toll Fee, Service Fee, Child Fare, Child Service Fee Percentage, seat_flip, price_filter |
| layout | `upperTotalRows`, `upperTotalColumns`, `lowerTotalRows`, `lowerTotalColumns`, `SeatLayoutID` | `2+1, VE A/C Sleeper, AC` |
| most seats per booking | `maxNumberOfSeats` | `6` |
| fares with offer | `offerFaresList[]` | `{"fare":"3000","discountedFare":"2700"}` |
| other | `minAge`, `travelerAgentName`, `busTypeName`, `isRTC`, `singleLadySeats`, `gentsSeats` | |

**Login, money.** No login to view. Choosing a seat and continuing is a booking (never).

**Jev cues.** Slots: the bus (from B1), heads, berth preference.
- "is bus mein 5 berths saath mein milenge?"
- "lower berth available hai kya"
- "seat layout dikhao Naik travels ka"
- "kitni seats khali hain upper deck pe"
- "ladies seat chahiye 2"

**Recipe.** B1 load; click "Select Seats" on the chosen bus (or the nth); wait for `/wap/GetSeatLayout`; count
free seats (column 5 = `Y`) by deck and type; quote the fare and discounted fare; say at most 6 per booking.

### B4 Boarding and dropping points

**What and why (high).** Where to get on and off: in Mumbai (Mira Road, Borivali, Sion …) and in Goa (Mapusa,
Panjim, Margao). The group picks the stop nearest everyone.

**Data.** B1: `filters.boardingPoints[]` / `filters.droppingPoints[]` per bus, as ids into the top-level
`boardingPointList` / `droppingPointList`. B3, per bus, with times: `boardingPoints[]` (35 for one Mumbai to Goa
bus) and `droppingPoints[]` (6), each `placeName`, `placeTime`, `placeTimeTwfFormat`, `dt`, `landMark`, `placeId`,
`latlong` (empty in what I saw). Example: "Mira Road - (St Joseph Church Sheetal Nagar)" 17:30;
"Mapusa New Intercity Bus Stand" 08:45 the next day.

**Jev cues.** Slots: bus, our area.
- "Andheri se pickup hai kya?"
- "boarding point kahan hai Borivali mein"
- "Goa mein kahan utaregi, Panjim ya Mapusa?"
- "kitne baje pickup hoga Thane se"
- "Calangute ke paas drop milega?"

**Recipe.** B1 for which buses stop near the asked place; B3 for the time and landmark.

### B5 Bus cancellation policy and free cancellation

**What and why (medium).** What the group gets back if they cancel.

**Data.** In B3: `cancellationsPolicy[]`, tiers with `con` (window), `rp` (refund %), `cc` (refund amount), `tl`
(text), for example "Before 30-Oct 18:20 … 100%", "Between 30-Oct 18:20 & 3-Nov 18:20 … 90%", down to 0%. And
`freeCancellation` (`enableFreeCancellation: 1`): "Get Full Refund upon cancellation before 6 hours of bus start
time", priced `amount: "7"` with `type: "P"` and `calcOnBaseFare: "1"`, which reads as 7% of the base fare
(unconfirmed). Also `applicableCancPolicyPercentage`, `applicableAbsCancellationFee`.

**Login, money.** No login to read; free cancellation is a paid add-on at booking.

**Jev cues.**
- "bus cancel karein toh kitna refund"
- "free cancellation hai kya is bus mein"
- "last minute cancel kiya toh?"
- "refund policy batao"
- "kab tak cancel kar sakte hain full refund ke saath"

**Recipe.** From B3: quote the tier for "now", and the free cancellation terms.

### B6 Offers, coupons and the group deal

**What and why (medium).** Coupons and bank offers lower a group's total; the group deal applies from 4 seats.

**Entry.** `https://www.ixigo.com/buses/offers` (0.4 s, server-rendered): one heading per offer and the coupon code
in its image text, for example "Use Coupon BUSAU200 … 10% up to Rs.200 off with AU Bank Credit Card", "VRL10" (10%
up to ₹100 on VRL), "UPIMBK" (10% with MobiKwik UPI), "MAHA200" (₹200 off Mahalaxmi, new users), "IXIGOCCBUS"
(10% via ixigo AU card), "VISACC", RTC offers (HRTC, UPSRTC up to ₹500). The buses home repeats RTC offers.

**Per bus (B1).** `discountMsg`, `flags.hasGroupDeal`, `flags.isDealAvail`, and `edgeConfig`; type 8 has
`groupDealCount: "4"` with 10% up to ₹5,000 (that it's the group deal is my reading of the field name).

**Login, money.** No login to read; coupons apply at payment (never).

**Jev cues.**
- "koi bus offer hai?"
- "coupon code batao bus booking ke liye"
- "group mein book karein toh discount milega?"
- "AU card pe kya offer hai"
- "early bird offer kya hai"

**Recipe.** Offers page for coupons; B1 for which buses carry a deal; say coupons apply at payment.

### B7 Live bus tracking

**What and why (medium on the day).** Where the bus is.

**Entry.** "Track Ticket" in the buses header opens `https://www.ixigo.com/buses/track`: heading "Enter Ticket
Details", textboxes "Please enter the booking ID" and "Please enter the mobile number". It needs an existing booking,
so only the entry was mapped (nothing typed). B1's `flags.isTrackAvail` says which buses can be tracked (all 71 in
my search).

**Jev cues.** Slots: booking ID, phone.
- "bus kahan pahunchi"
- "track my bus"
- "bus late hai kya"
- "driver ka location bhejo"
- "pickup kab aayega"

**Recipe.** Not possible without a booking; say so, and that the bus is trackable if `isTrackAvail` is 1.

## Bot protection

- No captcha challenge, block, 403 or 429 in 21 loads. Cloudflare sets `__cf_bm`; on the group page its challenge
  platform ran a private-access-token check (one 401 from `challenges.cloudflare.com`) and the page still loaded.
- Invisible reCAPTCHA tokens (`gauth`) on: train list (T1), availability (T2), running history for other days (T8)
  and PNR (T9). Read them inside the page only.
- No reCAPTCHA on: the 60-day route calendar (T6), train lookup (T17), station lookup, every server-rendered page,
  and every bus call.
- Errors seen: `/trains/coach-position/{number}` answered 500 (T11); `/ab-test-api/check-variant-for-experiment`
  answered 400 (an A/B call, harmless).
