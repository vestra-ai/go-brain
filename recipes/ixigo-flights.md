# ixigo.com flights: every corner, Jev-ready

Every flights corner of ixigo.com: what it is, why a group would care, how to get in, the page's own data
call, whether it needs login or money, how people in an Indian group chat ask for it, and a recipe sketch.
It builds on [ixigo-web-map.md](ixigo-web-map.md), which has the full field table for the search results.

How this was mapped (7 Oct 2026): a local headless Chromium (Playwright 1.59), a fresh logged-out profile per
load, no screenshots, a few seconds between loads. 22 page loads in all. Read only: no login, no booking, no
payment, no price lock bought, no form filled beyond search and the flight-status search. The deepest step
taken was the booking's first page ("Review Flight Details", step 1 of 4), opened by pressing "Book", to
read the fares, add-ons and coupons it shows. Nothing was entered there. Times are from the start of
navigation on one Mac, so treat them as rough.

The example throughout: Delhi to Goa, Fri 6 Nov 2026, 4 adults, economy.

## The corners at a glance

| # | Corner | Group value | Entry | Login? | Costs money? | Data in |
|---|---|---|---|---|---|---|
| 1 | Flight search | high | URL | no | no | 1.3 to 2.2 s |
| 2 | Filters and sort | high | URL params | no | no | 1.6 s |
| 3 | Round trip and the pair price | high | URL | no | no | 1.6 s, pair price 1.6 to 3.2 s |
| 4 | Cheapest dates (30-day calendar) | high | same results page | no | no | 1.5 s |
| 5 | Cheapest month (route page) | med | URL | no | no | 0.6 s |
| 6 | Group total, refund timeline (review page) | high | "Book" from results | no | no (stop before Continue) | 2.2 s after the click |
| 7 | Free cancellation: Assured and Assured Flex | high | review page | to buy, yes | yes, ₹1,209 or ₹1,509 per traveller | with 6 |
| 8 | Price lock | high | "Lock Price" button | yes | yes, ₹459 per traveller for 48 h in the example | fee in search data |
| 9 | Coupons and offers | med | review page, offers page | no | no | with 6; offers page 0.7 s |
| 10 | Special fares (student, senior, forces, doctors) | med | URL param | no | no | 1.9 s |
| 11 | Nearby airports (GOX vs GOI, Hindon) | med | in search data, URL param | no | no | with 1 |
| 12 | Flight status by flight number | high | form on /flight-status | no | no | 2.5 s after Search |
| 13 | Flight status by route | med | form on /flight-status | no | no | not captured |
| 14 | Fare alerts | med | /account/farealerts/ | yes | no | n/a |
| 15 | Web check-in (automatic) | med | /airlines/{airline}/web-checkin | PNR and last name | no (free) | n/a |
| 16 | Baggage and airline info | med | /airlines/{airline} | no | no (extra bags cost) | 0.3 s, in the HTML |
| 17 | Group booking (big groups) | med | /support/group | no, but asks for phone and email | no | n/a |
| 18 | Free-text filter box | low for Go | AX textbox | no | no | 1.1 s |

Not found or not mapped: no multi-city search on the web (the form has only "One Way" and "Round Trip"); no
split payment up to the review step (the payment step was not opened); international flights,
`/vas/visa-rejection-protection` and the `/plan` trip planner were seen but not mapped.

## Top 5 for fast recipes

1. **Search with filters in the URL (1, 2, 11).** One results URL carries route, date, people and filters;
   one stream returns every fare at about 1.6 s. Go can also filter and sort the JSON itself.
2. **Round trip (3).** Same URL with a return date; both legs in one stream at 1.6 s.
3. **Cheapest dates (4).** It comes free with every results load: a 30-day fare strip at about 1.5 s.
4. **Group total, refund rules, free cancellation and coupons (6, 7, 9).** One click on "Book" opens the
   review page, and in about 2 s its calls give the group's total, the refund timeline, Assured prices and
   every coupon. Stop there.
5. **Flight status by flight number (12).** About 2.5 s from Search to the status; it needs the tracker
   form, because the per-flight status pages sit behind a Cloudflare Turnstile check.

## What applies to every corner

- Read the page's own calls inside the page (`page.waitForResponse` on the call's path). Don't replay them
  from outside: they carry page-made ids, a static web key (`apikey`) and, for flight status, a fresh
  invisible reCAPTCHA token (`gauth`) per call.
- Fares in search data are **per adult**. The review page showed ₹31,584 for 4 adults on a ₹7,896 card.
- Cloudflare's `__cf_bm` cookie is set on every page. No challenge page or captcha prompt showed on any of
  the 22 loads, with one exception: the per-flight status pages (see 12) load a Cloudflare Turnstile check
  and stayed empty.
- One harmless error shows on most pages: a 400 from `/ab-test-api/check-variant-for-experiment`.

---

## 1. Flight search

1. **What:** every flight on a route and date, with price, times, stops and seats left. Group value:
   **high**; it's where every trip starts.
2. **Entry (URL):**
   `https://www.ixigo.com/search/result/flight?from={IATA}&to={IATA}&date={DDMMYYYY}&returnDate=&adults={n}&children={n}&infants={n}&class=e&source=Search%20Form`.
   Example: `...?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form`.
   `class=e` is economy. Other class letters were not tried.
3. **Data call:** `GET /flights/v2/search/stream?origin=DEL&destination=GOI&leave=06112026&return=&adults=4&children=0&infants=0&class=e&airlineFareType=REGULAR&version=2.0&searchSrc=Search%20Form`,
   a server-sent event stream with one `data:` line holding everything (290 to 330 KB, 134 to 153 fares as
   inventory moved during the day). Under `data.flightJourneys[0].flightFare[]`: `flightKeys` (the id, e.g.
   `DEL-GOI-6E5341-06112026`), `flightDetails[0].headerTextWeb` (airline), `.subHeaderTextWeb` (flight
   number), `.departureTime`, `.arrivalTime`, `.duration.text`, `.stopText`, `.layover[]`,
   `fares[0].fareDetails.displayFare` (per adult), `fares[0].fareMetadata[0].seatRemaining` and
   `.baggageDetails`, `refundableType`, plus the price-lock fields in 8. Top level: `searchToken`,
   `tripFilter` (price range, stop counts, airline names), `airportDetails`.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "Delhi se Goa flight dikhao 6 Nov ko, hum 4 log", "cheapest flight DEL to GOI on Friday?",
   "6 tareekh ko Goa ki koi sasti flight hai?", "kitne ki padegi Delhi-Goa flight per head?", "flights for
   4 of us to Goa on the 6th", "Goa ke liye kaunsi flights hain Friday ko?".
   Slots: from, to, date, adults (children, infants), class.
7. **Recipe:** open the URL → wait for `/flights/v2/search/stream` → read the one `data:` line → return per
   option: airline + flight number, departure and arrival time, duration, stops, price per adult (× adults
   for the group), seats left. Stream requested at 0.7 to 1.5 s and done at 1.3 to 2.2 s across runs.

## 2. Filters and sort

1. **What:** non-stop only, chosen airlines, departure or arrival time window, a price cap, free meal, a
   chosen airport. Group value: **high**; groups have rules like "morning only" or "no layovers".
2. **Entry (URL params, appended to the search URL):**

   | Param | Example | How it was confirmed |
   |---|---|---|
   | `stops` | `0` (non-stop) | loaded directly: 4 flights, boxes ticked |
   | `airlines` | `6E,AI` | loaded directly |
   | `takeOff` | `EARLY_MORNING,MORNING` | loaded directly |
   | `price` | `0,9000` | loaded directly, slider at 9000 |
   | `landing` | `EARLY_MORNING,MORNING` | in a URL the page made |
   | `freeMeal` | `true` | in a URL the page made |
   | `arrivalAirports` | `GOI` (or `GOX`) | in a URL the page made |
   | `sort_type` | `cheapest` | made by pressing the "Price" sort radio |

   Time windows are the stream's own buckets: `EARLY_MORNING`, `MORNING`, `AFTERNOON`, `NIGHT` ("before
   12 pm" mapped to EARLY_MORNING and MORNING). The other `sort_type` values were not seen, and Go can sort
   the JSON itself.

   Verified example (4 non-stop IndiGo or Air India flights before noon under ₹9,000):
   `https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form&stops=0&airlines=6E,AI&takeOff=EARLY_MORNING,MORNING&price=0,9000`

   AX fallback: checkboxes and radios have no names. Their labels are the paragraphs next to them ("Stops" →
   "Non-Stop"; "Sort by" → four unnamed radios with "Price / Low to High", "Fastest / Shortest First",
   "Departure / Earliest First", "Smart / Recommended"). Clicking the "Non-Stop" label text timed out; the
   first radio (`getByRole('radio').first()`) worked.
3. **Data call:** the same stream. Filtering happens in the page, so the stream still holds every fare.
   `flightFilter` on each fare (`stops`, `departTime`, `arrivalTime`, `airline`, `arrivalAirport`) and each
   fare's `sort` scores let Go filter and sort without the page.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "sirf non-stop dikhao", "IndiGo ya Air India hi chahiye", "subah 10 se pehle wali flight",
   "9000 se kam wali", "Mopa pe utarne wali flight", "meal free wali", "sabse sasti pehle dikhao", "fastest
   kaunsi hai?".
   Slots: stops, airlines, departure window, arrival window, max price per head, arrival airport, free meal,
   sort.
7. **Recipe:** build the search URL with the params → wait for the stream → return the matching fares. The
   filtered load streamed from 0.9 to 1.6 s. Or load the plain URL and filter the stream's JSON in Go.

## 3. Round trip and the pair price

1. **What:** out and back in one search, with a combined price for a chosen pair. Group value: **high**;
   most trips are return trips.
2. **Entry (URL):** the search URL with `returnDate={DDMMYYYY}`, e.g. `...&date=06112026&returnDate=09112026&adults=4...`.
3. **Data calls:**
   - The stream (`...&return=09112026...`) returns `type: SPLIT` with two `flightJourneys`: onward (79 fares)
     and return (70 fares), the same fields as in 1.
   - `POST /flights/v2/search/discount`, sent when a pair is selected (the page picks one by default), with
     body `{"flightFares": {"{onwardKey}+{returnKey}": {"fareToken": "..."}}, "providerId": ..., "searchToken": "..."}`.
     It returns `data.flightFares["{pair}"].displayFare` (₹15,484 per adult for 6E5341 out, IX2224 back),
     `offerText`, `priceLockAttributes` (₹1,948 "for 2 days" for one pair; whether that's per person or for
     the group isn't shown) and `validCombination`.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "6 ko jaana 9 ko wapas, 4 log", "return bhi dekh lo 9 Nov ka", "aana-jaana total kitna
   padega?", "round trip Delhi Goa Delhi kitne ka?", "up-down ticket ka rate batao", "return flight Sunday
   shaam ki chahiye".
   Slots: from, to, out date, return date, people, optional time windows per leg.
7. **Recipe:** open the round-trip URL → wait for the stream → return the cheapest few per leg. For a pair
   price, read `/flights/v2/search/discount` after the page selects a pair, or add the two legs' per-adult
   fares as an estimate. Stream done at 1.6 s; pair price at 1.6 to 3.2 s over two runs.

## 4. Cheapest dates (30-day calendar)

1. **What:** the lowest fare for each day in a 30-day window around the chosen date (the strip above the
   results). Group value: **high**; groups often bend the dates for a cheaper fare.
2. **Entry:** it loads with every results URL. Its own call can also be watched alone.
3. **Data call:** `GET /outlook/v1/onward/ranged?departureDate=06112026&destination=GOI&fareClass=e&origin=DEL&paxCombinationType=100&refundTypes=REFUNDABLE,NON_REFUNDABLE`.
   It returns `data.going.results[]` with `date` (DD-MM-YYYY), `fare`, `airline`, `airlineCode`,
   `flightNumber` (sometimes blank) and `found` (when ixigo last saw that fare, often hours earlier). The
   window ran 22 Oct to 21 Nov for a 6 Nov search. `paxCombinationType=100` means one adult, so these are
   per-adult and cached, not live. A round-trip search adds a second call for the return route and date.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "Nov mein kaunse din sasta hai?", "6 ke aaspaas cheapest date kaunsi?", "ek din aage-peeche
   karein toh kitna bachega?", "which day is cheapest to fly to Goa next month?", "Friday vs Saturday price
   kya hai?", "weekend pe mehenga hai kya?".
   Slots: from, to, centre date (window is about ±15 days), people (multiply the per-adult fare).
7. **Recipe:** open the results URL for the centre date → wait for `/outlook/v1/onward/ranged` → return
   date and fare pairs sorted by fare, flagged "last seen at `found`". Answered at about 1.5 s. Before
   quoting a date, check it with a real search for that date (corner 1).

## 5. Cheapest month (route page)

1. **What:** a page per route with the cheapest fare per month for the next year, cheapest by airline,
   non-stop and connecting flights, and a cheapest-day table. Group value: **med**; good for "when should
   we go?" before dates exist.
2. **Entry (URL):** `https://www.ixigo.com/cheap-flights/{from-city}-{to-city}-{from}-{to}`, e.g.
   `https://www.ixigo.com/cheap-flights/new-delhi-goa-del-goi`. The slug format comes from the site's own
   links. A route the site has no page for was not tried.
3. **Data:** no separate call. The page is server-rendered, with its data in `<script id="__NEXT_DATA__">`
   under `props.pageProps`:
   - `cheapestFares.going.results[]`: 12 months, each with `date`, `fare`, `airline`, `flightNumber` and
     `found`.
   - `cheapestFares.going.ranges`: colour bands, e.g. green up to ₹8,947.
   - `quickAccess`: Cheapest, Earliest, Fastest and Latest flights for tomorrow.
   - `cheapFlightsData[]`: tomorrow's flights.
   - `outlookData[]`: 46 days.
   - `cheapestOutlookFares`: in 15, 30 and 45 days.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "Goa trip kab sasta padega?", "December ya January, kab flights sasti hain?", "cheapest
   month to fly Delhi to Goa", "agle 3 mahine mein sabse sasti flight kab hai?", "Diwali ke baad rates kaise
   hain?".
   Slots: from, to, optional month range.
7. **Recipe:** open the route URL → parse `__NEXT_DATA__` from the HTML (no call to wait for) → return
   month and fare pairs. HTML arrived at 0.16 s; page ready at 0.56 s.

## 6. Group total and refund timeline (the review page)

1. **What:** the first booking step for one chosen flight. It shows the total for everyone, taxes, the
   applied coupon, the cancellation refunds by time before departure, and the add-ons. Group value:
   **high**; it answers "what does it cost all of us" and "what if we cancel".
2. **Entry:** on the results page, the card's button "Book" (exact name) navigates in the same tab to
   `https://www.ixigo.com/flight/booking/{providerId}/{searchToken}?fareKey={flightKeys}&providers={providerId}&hbo=false&ftk={fareToken}&source=Search+Form`
   (title "Review Flight Details"; steps shown: Flight Selection, Review & Traveller Details, Add-ons,
   Payment). All of `providerId` (`fares[0].fareMetadata[0].providerId`), `searchToken` (top level) and
   `fareToken` (`fares[0].fareDetails.fareToken`) are in the search stream, so the URL can likely be built
   without the click. That was not tried, and the tokens belong to one search. **Stop here: never press
   "Continue", never enter traveller details.**
3. **Data calls:**
   - `GET /flight-booking/flight-fare?ixi_src=ixiweb&searchToken=...&fareToken=...`, under `data`:
     - `flightFare[0].fareSummary`: `baseFare` 24000, `totalTaxFeeBreakup` 7584,
       `totalFareForAllPassengers` 31584, and `ixigoConvenienceFee` 1956, which is in the data but not shown
       on this page.
     - `fareTypeResponse.fareTypes[]`: see 7.
     - `priceLockInfo.reviewInfo`: see 8.
     - `itineraryFlightDetails`.
   - `POST /api/v5/flights/fare-rules` (body: fareKey, providerId, searchToken, fare, fareToken).
     `data.cancellationDetails.segments[].penalties[]` gives `timeRange`, `charges`, `headingText`. For the
     example: "₹11748 refund" if cancelled 72+ hours before, "₹8948 refund" at 3 to 72 hours,
     "Non Refundable" under 3 hours. `ixigoFee` is ₹1,200 (₹0 with Assured). `segmentDisclaimer`: "Total
     refund amount applicable for 4 travellers."
   - `POST /graph` (GraphQL `insuranceCouponBurnV2`): the coupons, see 9.
   - `POST /flights-vas/v1/fare-type/enrich`: the refund amount text for the add-on cards.
4. **Login:** no; the review page opened logged out.
5. **Money:** nothing until Payment. The page's own numbers for the example: base ₹24,000 + taxes and fees
   ₹7,584 = ₹31,584; coupon SALE −₹1,440 = ₹30,144 for 4.
6. **Jev cues:** "4 logon ka total kitna hoga?", "taxes milake final kitna?", "per head kitna padega?",
   "cancel kiya toh kitna wapas milega?", "agar ek banda drop ho gaya toh?", "refund policy kya hai is
   flight ki?".
   Slots: the chosen flight (flight number or option from the last search), people.
7. **Recipe:** results URL → wait for the stream → press "Book" on the chosen card (or open the built review
   URL) → wait for `/flight-booking/flight-fare`, `/api/v5/flights/fare-rules` and `/graph` → return the
   total for all, total per head, the coupon applied and the refund steps. About 2.2 s from the click to all
   three.

## 7. Free cancellation: ixigo Assured and Assured Flex

1. **What:** paid add-ons on the review page. **Assured** is a full refund if you cancel up to 24 hours
   before departure (for domestic flights booked 26 hours to 121 days ahead). **Assured Flex** adds free
   changes of date, airline or even route up to 24 hours before. Group value: **high**; plans change and one
   person dropping out shouldn't cost the group.
2. **Entry:** review page (see 6), radios named "Assured Most Popular Free Cancellation @₹1,209/traveller
   ...", "Assured Flex Free Cancellation + Rescheduling @₹1,509/traveller ..." and "I don't want Free
   Cancellation. Pay ₹15,996 fee if you cancel or reschedule". The search home page also has a checkbox
   "Always opt for Free Cancellation". Terms: `https://www.ixigo.com/ixigo-assured` and
   `https://www.ixigo.com/assured-flex-flight`.
3. **Data calls:**
   - `/flight-booking/flight-fare`, `data.fareTypeResponse.fareTypes[]`: `type` (`BASIC_FARE`,
     `IXIGO_ASSURED`, `ASSURED_FLEX`), `totalFareForAllPassengers` (31,584 / 36,420 / 37,620),
     `finalDisplayedFarePerPassenger`. Also `recommendedUpsellFareType`.
   - `GET /api/v1/free-cancellation/claimWindows` (on the Assured page) gives the claim window by how early
     you booked. Domestic: booked 26 hours to 121 days ahead → cancel up to 24 hours before; booked 10 to 26
     hours ahead → 8 hours. International: 3 to 120 days ahead → 48 hours.
4. **Login:** no to see it. Buying goes through payment.
5. **Money:** yes, per traveller, priced per fare: ₹1,209 (Assured) and ₹1,509 (Flex) on this ₹7,896
   fare, so ₹4,836 or ₹6,036 for 4. 18% GST included. The Assured fee is refunded only if the airline
   cancels, and the price-lock fee is never refunded (the Assured terms).
6. **Jev cues:** "free cancellation wala option kitne ka hai?", "agar koi drop out ho gaya toh paisa
   wapas?", "refundable ticket chahiye", "date change free hai kya?", "Assured lena worth hai?", "cancel
   karne pe kitna katega?".
   Slots: chosen flight, people.
7. **Recipe:** same as 6 → return the three options with total for the group, per-head add-on cost and
   the cut-off ("cancel up to 24 hours before"). No extra wait beyond 6.

## 8. Price lock

1. **What:** pay a small fee to hold today's fare for 2 or 4 days and book later. Group value: **high**;
   it buys time while everyone confirms.
2. **Entry:** button "priceLock Lock Price @₹{n}" on each result card and on the review page ("Lock Fare
   Now & Book Later ... Need more time?"). Pressing it adds `loginVisible=true` to the URL and opens the
   login dialog (in an iframe). **Mapped up to there; never log in, never pay.**
3. **Data:** already in the search stream, per fare, under `fares[0]`: `priceLockPremium` (₹389 to ₹1,469
   across the 134 fares; ₹459 for 6E5341), `priceLockExpiry` ("2 days"), `lockWindow` (48 hours),
   `allPriceLockPremiums` (`[{amount: 459, expiry: 48}, {amount: 499, expiry: 96}]`),
   `priceLockMaxAbsorption` (4000), `hasPriceLock` (top level). The review page's
   `priceLockInfo.reviewInfo.travellerText` is "/traveller", so the fee is per traveller: ₹459 × 4 = ₹1,836
   to hold 6E5341 for 48 hours. `priceLockMaxAbsorption` looks like the most ixigo will cover if the fare
   rises (₹4,000), but the page doesn't say.
4. **Login:** **needs login.**
5. **Money:** **yes**, the lock fee, non-refundable. Stop before paying.
6. **Jev cues:** "fare lock kar do", "price 2 din ke liye hold ho sakta hai?", "sab confirm karein tab tak
   rate lock kar lo", "lock price kitne ka hai?", "price freeze karo Sunday tak", "abhi book nahi karna, bas
   rate rok lo".
   Slots: chosen flight, people, how long (48 or 96 hours).
7. **Recipe:** results URL → stream → for the chosen fare return the lock fee per traveller and for the
   group, and the hold time (48 or 96 hours). Then tell the group it needs a logged-in ixigo account and a
   payment, which Go doesn't do. Same 1.3 to 2.2 s as search.

## 9. Coupons and offers

1. **What:** discount codes and bank-card offers. The review page shows the ones valid for that booking,
   with the best non-card one applied. Group value: **med**; real money on a 4-person booking (₹1,440 in the
   example).
2. **Entry:**
   - Review page (see 6): textbox "Have a promocode? Redeem here", radios named by code ("SALE",
     "AUSFD", "RBLD", ...), button "View All Offers".
   - All offers: `https://www.ixigo.com/offers`, one page per offer at `/offers/{slug}` or
     `/offers/campaigns/{slug}`.
3. **Data calls:**
   - Review page `POST /graph`, `data.insuranceCouponBurnV2.coupon.data[]`: `couponCode`,
     `instantDiscount.amount`, `description`, `tnc`, `selected`. That was 23 codes for the example: SALE
     ₹1,440 (applied); card offers such as AUSFD and RBLD ₹1,500, HSBCFD ₹1,800, ICICIEMI ₹2,169 and
     IXIGOCCFLY ₹3,000.
   - Results page `GET /upahaar-inventory/api/deals?productType=FLIGHTS&source=SRP&journeyType=DOMESTIC&...`,
     `data.srp.headerDeals.deals[]` (`offerCode`, `offerTitle`, `pathName`).
   - Offers page: server-rendered, `__NEXT_DATA__` → `props.pageProps.data.offers[]` (`offerTitle` or
     `campaignName`, `product`, `offerCode`, `endDate`, `slug`).
   - Per-fare nudge in the stream: `fares[0].offerText` (HTML, e.g. "Extra ₹1,440 Off").
4. **Login:** no.
5. **Money:** no; card offers need that bank's card at payment.
6. **Jev cues:** "koi coupon code hai?", "HDFC card pe discount milega?", "best offer kaunsa lagega?", "SALE
   code se kitna bachega?", "credit card offer on flights?", "sabse zyada discount kis card pe?".
   Slots: chosen flight (for exact coupons), optional bank or card.
7. **Recipe:** review-page route as in 6 → wait for `/graph` → return the applied code and the top few
   codes by discount, with their card conditions. For browsing, the offers page's `__NEXT_DATA__` is ready
   at about 0.7 s.

## 10. Special fares (student, senior citizen, armed forces, doctors and nurses)

1. **What:** discounted fare types on some flights (the site's FAQ mentions up to 10% for seniors, and
   student fares with extra baggage). Group value: **med**; a college group is all students.
2. **Entry:** chips under "Special Fares (Optional) :" on the search form ("Student", "Senior Citizen",
   "Armed Forces", "Doctors & Nurses"). Picking "Student" and pressing Search adds
   `airlineFareType=STUDENT` to the URL: `...&adults=4&children=0&infants=0&class=e&source=Search+Form&airlineFareType=STUDENT`.
   The other three types' values were not tried.
3. **Data call:** the same stream with `airlineFareType=STUDENT`. It returned only the 15 flights that sell
   student fares (`fares[].fareType` `STUDENT`), cheapest ₹7,634 against ₹7,490 regular at that moment, so
   a special fare is not always cheaper.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "student discount milega?", "hum sab college students hain", "papa ke liye senior citizen
   fare", "armed forces discount on flights?", "doctor hoon, koi special fare?".
   Slots: fare type + the search slots.
7. **Recipe:** search URL + `airlineFareType=STUDENT` → stream → compare with the regular search before
   saying it saves money. The stream finished 1.9 s after the search.

## 11. Nearby airports

1. **What:** other airports near the origin and destination: Hindon (HDO, 27 km from DEL) and Noida (DXN,
   66 km) for Delhi; Manohar International (GOX, the Mopa airport in North Goa) next to Dabolim (GOI).
   Group value: **med**; GOX is in North Goa, so it can suit a North Goa stay.
2. **Entry:** it's included in every Delhi→Goa search. `arrivalAirports=GOX` in the search URL narrows to
   Mopa (the param name was seen with GOI).
3. **Data:** stream top level `airportDetails` (name, city, `distanceFromSearchedAirport`) and
   `flightJourneys[0].journeyFilter[0].departureAirports[]` / `.arrivalAirports[]` (`airportCode`, `count`,
   `minFare`, `distance`).
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "North Goa ke liye Mopa better hai?", "GOX ya GOI, kaunsa paas hai Anjuna se?", "Hindon se
   koi flight hai?", "Noida airport se sasta hai kya?", "dusre airport pe land karne wali flights".
   Slots: from, to, preferred airport.
7. **Recipe:** search URL → stream → group fares by arrival airport and return the cheapest per airport
   with its distance. Same timing as 1.

## 12. Flight status by flight number

1. **What:** live status for a flight on a day: departed or landed, minutes early or late, terminal, gate,
   belt hint, aircraft, on-time record. Group value: **high** on travel day ("has their flight landed?").
2. **Entry:** `https://www.ixigo.com/flight-status`, then the AX path: textbox (airline; type "6E", pick the
   option with text "6E - IndiGo") → spinbutton (number; type "5341") → button "Date {today}" (left at
   today) → button "Search" (exact). The URL does not change.
   - Don't use the per-flight pages (`/airlines/indigo-6e/6e-5341-flight-status`, linked from airline
     pages). They load a Cloudflare Turnstile check, their data says `validateTurnstile: true`, and they
     stayed empty here.
3. **Data calls:**
   - `GET /api/v3/flights/list?airlineCode=6E&flightNo=5341&departDt=20261007&error=jsonError&searchType=flightNumber&apiVersion=2.0`,
     sent with a fresh reCAPTCHA token in the `gauth` header. `data[]` gives `statusMap.status` ("Arrived"),
     `timings` (scheduled, estimated and actual times in epoch ms), `departureDeviation.deviationText` ("9m
     Early"), `arrivalDeviation`, `terminalInfo` (T3, gate 39B), `boardingStatus`, `aircraftType`,
     `onTimeAccuracy`, `flightUniqueId`.
   - Then `POST /nav/api/v4/flights/track` (body: that flight object) gives
     `data.overallJourneyStatus.status` ("Landed"), `segments[].overallStatus.statusChip.message` ("Collect
     baggage from belt"), `departure` and `arrival` (`scheduledTime`, `availableTime`, `gate`, `deviation`).
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "is 6E5341 on time?", "flight late hai kya?", "uski flight land hui?", "6E 5341 ka gate
   number kya hai?", "IndiGo 5341 status batao", "kitne baje pahunchegi flight?", "kal wali flight time pe
   hai?".
   Slots: airline code, flight number, date (today, yesterday or tomorrow on the page; other dates untested).
7. **Recipe:** open `/flight-status` → fill airline and number through the AX path → Search → wait for
   `/api/v3/flights/list` (it waits about 2 s for the reCAPTCHA token) and `/nav/api/v4/flights/track` →
   return status, actual or estimated times, delay text, terminal and gate. 2.5 s from Search to both
   calls.

## 13. Flight status by route

1. **What:** status for flights on a route today, when nobody has the flight number. Group value: **med**.
2. **Entry:** `/flight-status` → button "Route" → textbox (Departure Airport; type "DEL", options are
   listitems with the code, then the city and airport as paragraphs) → textbox (Arrival Airport) → button
   "Search". Picking the listitem failed with a text locator, so the search never ran. Next time, use
   `getByRole('listitem').filter({ hasText: 'Delhi Indira Gandhi' })`.
3. **Data call:** not captured. The airport lookup is
   `GET /action/content/city?searchFor=airportSuggestions&value=DEL&nearByAirport=true`.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** "aaj Delhi-Goa wali flights time pe hain?", "DEL se GOI ki saari flights ka status", "Goa
   wali flight ka kya scene hai?", "evening wali Delhi-Goa flight late hai?", "route se status dikhao".
   Slots: from, to, date.
7. **Recipe:** untested past the airport lookup; prefer 12 when a flight number is known.

## 14. Fare alerts

1. **What:** ixigo emails or notifies you when a route's fare drops. Group value: **med**.
2. **Entry:** `https://www.ixigo.com/account/farealerts/` (also linked as "Fare Alerts" on the flights
   home). Logged out it redirects to `/account`, which shows "LOG IN".
3. **Data call:** none logged out.
4. **Login:** **needs login.**
5. **Money:** no.
6. **Jev cues:** "price gire toh batana", "Delhi-Goa pe alert laga do", "fare track karo", "jab 7000 se
   neeche aaye tab bolna", "notify me when it gets cheaper", "roz rate check karte rehna".
   Slots: from, to, date, target price.
7. **Recipe:** don't use ixigo's alert. Go can re-run corner 1 (or 4) on a schedule and tell the group when
   the fare crosses their number.

## 15. Web check-in (automatic)

1. **What:** ixigo checks you in automatically when the airline's window opens and sends the boarding pass
   on WhatsApp. It's free and works for bookings made anywhere. Domestic one-way direct flights only (not
   international, round trip or multi-city bookings); everyone on the same PNR in one go. Group value:
   **med**.
2. **Entry:** `https://www.ixigo.com/airlines/{airline-slug}/web-checkin`, e.g.
   `/airlines/indigo-6e/web-checkin`. Also `/airlines/web-checkin`, plus Air India, Air India Express,
   SpiceJet and Akasa pages. Form: textbox (airline, prefilled "6E"), textbox "PNR Number", textbox "Last
   Name", button "Check-in". **Not filled**: it takes a person's booking details.
3. **Data call:** the page is server-rendered; scheduling was not tried.
4. **Login:** needs the PNR and last name, and likely login to schedule. Mapped to the entry only.
5. **Money:** no (the page says it is free).
6. **Jev cues:** "web check-in kar do", "boarding pass bhej do", "check-in khul gaya kya?", "auto check-in
   laga do", "seat select karni hai check-in mein", "sabka check-in ek saath ho jayega?".
   Slots: airline, PNR, last name (personal: hand off, don't collect into a shared chat).
7. **Recipe:** answer the facts (window usually 48 hours before, free, WhatsApp delivery, same-PNR group)
   from the page, and send the person the entry URL. The page HTML arrived at 0.3 s.

## 16. Baggage and airline info

1. **What:** per-airline pages with cabin and checked baggage allowances, prepaid extra-baggage prices,
   cancellation and change fees, travel documents, customer care, and links to web check-in and flight
   status. Group value: **med**; "how much can we carry" comes up every trip.
2. **Entry:** `https://www.ixigo.com/airlines/{airline-slug}`, e.g. `/airlines/indigo-6e`, plus
   `/airlines/indigo-6e/baggage-allowance-icms` and `/airlines/indigo-6e/travel-documents-icms`. The slugs
   seen are `air_india-ai`, `airindia_express-ix`, `akasa_air-qp`, `spicejet-sg`, `alliance_air-9i` and
   `indigo-6e`. The fare's own allowance is also in the search stream
   (`fares[0].fareMetadata[0].baggageDetails`) and on the review page.
3. **Data:** server-rendered text, read from the AX tree. IndiGo: cabin 7 kg + one personal item; checked
   15 kg domestic; table "Indigo Airlines Extra Baggage Charges" (3 kg ₹1,515, 5 kg ₹2,525, 10 kg ₹4,950,
   15 kg ₹7,260 prepaid).
4. **Login:** no.
5. **Money:** the info is free; extra baggage costs (prepaid prices above).
6. **Jev cues:** "kitna saman le ja sakte hain?", "IndiGo ka baggage limit kya hai?", "extra 5 kg kitne ka
   padega?", "cabin bag 7 kg hi hai kya?", "check-in baggage kitna allowed hai?", "ID kaunsi chahiye
   flight ke liye?".
   Slots: airline (from the chosen flight), domestic or international, extra kg.
7. **Recipe:** prefer the chosen fare's `baggageDetails` from the stream. For extra-baggage prices, open the
   airline URL and read the "Extra Baggage" table rows from the AX tree. HTML at 0.14 s; page ready at
   0.33 s.

## 17. Group booking (big groups)

1. **What:** a request form for group travel ("Discount for Group Bookings", "All Airlines Supported").
   Someone from ixigo calls back within 1 hour. Group value: **med**; it's for big groups, while a group of
   4 books normally.
2. **Entry:** "Group Booking" on every flights page, linking to
   `https://rocket.ixigo.com/group/index.html?p=app_search_form`, which redirects to
   `https://www.ixigo.com/support/group?p=app_search_form`. The form has buttons "One Way" and "Round
   Trip", textboxes "Enter origin", "Enter destination" and "Departure", a spinbutton (people), "Enter
   email", "Enter phone number", a notes box and button "Submit". **Never filled**: it sends a person's
   phone and email. The page also loads Cloudflare Turnstile.
3. **Data call:** none before Submit.
4. **Login:** no, but it collects contact details.
5. **Money:** not on this form.
6. **Jev cues:** "hum 12 log hain, group booking ho sakti hai?", "group discount milta hai kya?", "bade
   group ke liye special rate?", "10+ logon ki booking kaise karein?", "group ke liye kisi agent se baat
   karao".
   Slots: from, to, date, people count; contact details stay with the person.
7. **Recipe:** tell the group what the form does and give one person the URL. Go doesn't submit it.

## 18. Free-text filter box

1. **What:** a box on the results page that turns plain words into filters. Group value: **low** for Go,
   which can map words to the URL params in 2 itself. It's useful as the source of truth for the param
   names.
2. **Entry:** textbox "Ask something like: I want to see flights with no stops under ₹25000." → button
   "Filter Flights".
3. **Data call:** `GET https://weather-api.ixigo.com/filters/translate?q={words}&token={static page token}`
   returns `text/plain` URL params, e.g. "non-stop IndiGo or Air India flights reaching Goa before 12 pm,
   cheapest first" → `stops=0&airlines=6E,AI&arrivalAirports=GOI&landing=EARLY_MORNING,MORNING` (the sort
   part was dropped). The page then navigates to the search URL with those params.
4. **Login:** no.
5. **Money:** no.
6. **Jev cues:** same as 2.
7. **Recipe:** not needed; use 2. The translate call answered in 1.1 s.

## Gaps

- Sort values other than `sort_type=cheapest`, and special-fare values other than `STUDENT`, were not seen.
- The review URL built from stream fields was not loaded directly; only the "Book" click was used.
- Round-trip price-lock fee: per person or for the group is not shown.
- `priceLockMaxAbsorption` and `ixigoConvenienceFee` meanings are read from field names, not page text.
- Flight status by route never ran its search (the option click failed), and the per-flight status pages
  are behind Turnstile.
- Not opened: the Payment step (so split payment is unknown), international flights, visa rejection
  protection, the `/plan` planner, and the maximum travellers per search.
