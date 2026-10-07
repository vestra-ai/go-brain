# ixigo.com web map: fast recipes for Go (plan B)

If ixigo's APIs don't come through, Go can search ixigo.com itself in a browser. This page says, for each
flow, how to get from a URL to the site's own results data, what the data looks like, which page controls
to use for what the URL can't do, how long it takes, and what bot protection showed up.

How this was mapped (7 Oct 2026): a local headless Chromium (Playwright 1.59), a fresh logged-out profile
for every load (locale en-IN, Asia/Kolkata, desktop Chrome user agent), no screenshots. Read only: result
pages and home pages, never a login, a booking, a seat map, a traveller form or a payment form. Nine page
loads in all, six of them searches (flights 2, hotels 1, trains 1, buses 2). Every time below is from the
start of navigation, measured on one Mac on one evening, so treat them as rough.

## The short answer

| Flow | Straight to results by URL? | Results data call | All results in |
|---|---|---|---|
| Flights | Yes: from, to, date, adults, children, infants, class | One server-sent event stream with every fare | 1.3 to 2.2 s |
| Hotels | Yes: place, check-in, check-out, adults, rooms, children | POST search, paged (a few hotels per page) | First 3 at 1.7 s, 7 at 5 s, more only on scroll |
| Trains | Yes: from, to, date | GET train list, then GET availability | 2.8 s (waits about 2 s for an invisible reCAPTCHA token) |
| Buses | Yes: from, to (name and id), date | One POST with every bus | 0.7 s |

The recipe that works for all four: open the results URL in the page, wait for the page's own data call
with `page.waitForResponse` on its path, and parse that JSON. Don't replay the calls from outside the page:
they carry page-made ids, a static web key and, for trains, a fresh reCAPTCHA token on every call.

For flights, buses and trains the one response already holds every result plus the fields the filters work
on (stops, airline, times, bus type, class), so Go can filter and sort the JSON itself without clicking
anything. Hotels are the exception: results come in pages, so a pool or area filter needs either the
page's filter control or the page's own search call with a filter code.

## Flights

### URL

```
https://www.ixigo.com/search/result/flight?from={IATA}&to={IATA}&date={DDMMYYYY}&returnDate=&adults={n}&children={n}&infants={n}&class=e&source=Search%20Form
```

Delhi to Goa, Fri 6 Nov, 4 adults (loaded straight to results, title "Flight Results", 134 flights):

```
https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form
```

`class=e` is economy. One way only was tried; round trip (a filled `returnDate`) is untested.

### Data call

`GET https://www.ixigo.com/flights/v2/search/stream?origin=DEL&destination=GOI&leave=06112026&return=&adults=4&children=0&infants=0&class=e&airlineFareType=REGULAR&version=2.0&searchSrc=Search%20Form`

- Response `content-type: text/event-stream`. In practice it was one `data:` line holding the whole result
  (291 KB, 134 fares), then the stream closed. Read it with `await response.text()`.
- Headers the page sends: `ixisrc`, `clientid` (both `ixiweb`), `deviceid` and `uuid` (a page-made id),
  `apikey` (a static web client key from the page's own script; not copied here), `appversion`,
  `x-request-webappversion`, `content-type`.
- Also on the page: `/outlook/v1/onward/ranged?...` (the fare calendar strip) and
  `/action/content/city?searchFor=airportSuggestions&value=DEL` (airport lookup).

Fields, under `data.flightJourneys[0].flightFare[]` (one entry per option):

| Need | Field | Example |
|---|---|---|
| id | `flightKeys` | `DEL-GOI-6E5341-06112026` (a connection joins legs with `*`) |
| name | `flightDetails[0].headerTextWeb`, `.subHeaderTextWeb`, `.airlineCode` | `IndiGo`, `6E5341`, `6E` |
| price | `fares[0].fareDetails.displayFare` | `7896` |
| times | `flightDetails[0].departureTime`, `.arrivalTime`, `.arrivingInDays`, `.departureTimeEpoch`, `.duration.text` | `05:00`, `07:35`, `0`, ms, `2h 35m` |
| route | `flightDetails[0].origin`, `.destination`, `.stopText`, `.layover[].location` | `DEL`, `GOI`, `Non-stop` |
| seats left, bags | `fares[0].fareMetadata[0].seatRemaining`, `.baggageDetails` | `9`, `15 kg per piece...` |
| refunds | `refundableType` | `PARTIALLY_REFUNDABLE` |

The price looks like a per-adult fare: the search was for 4 adults and the card shows ₹7,896, but the page
does not label it. Confirm before quoting a group total.

Also in `data`: `tripFilter` (price range, stop counts, `airlineMap` with names and cheapest fare),
`airportDetails` (airport names, nearby airports such as Hindon and Manohar), `searchId`, `searchToken`.

Deep link: there is none per flight. The card's only actions are "Book" and "Lock Price", which start a
booking. Point people at the results URL and name the flight by its `flightKeys`.

### Page controls (AX)

Checkboxes and radios on this page have no accessible names. Their labels are the paragraphs next to them,
so find a control by its label text.

- Sort: paragraph "Sort by", then four unnamed radios, each followed by its label paragraphs: "Price" / "Low
  to High", "Fastest" / "Shortest First", "Departure" / "Earliest First", "Smart" / "Recommended" (checked
  by default).
- Non-stop: paragraph "Stops", then unnamed checkbox + paragraph "Non-Stop" + its fare; also "1 Stop", and
  "2+ Stops" (disabled when there are none). "Recommended Filters" repeats Non-Stop as a listitem.
- Airlines: paragraph "Airlines", one listitem per airline. Departure Airport: paragraph "Departure
  Airport", checkboxes per airport.
- Price and duration: two sliders.
- A free-text filter box: textbox "Ask something like: I want to see flights with no stops under ₹25000."
  and button "Filter Flights".
- Each card: img with the airline code, paragraphs for airline and flight number, headings (level 6) for
  departure time, arrival time and price, button "Book" (never), button "priceLock Lock Price @₹..."
  (never), and a paragraph "Flight Details". The fare type, cabin and baggage under it are already in the
  tree, so reading them needs no click.

### Timing

| Run | Page ready (DOMContentLoaded) | Stream requested | Stream answered | Stream closed |
|---|---|---|---|---|
| 1 | 451 ms | 1,523 ms | 2,117 ms | not captured |
| 2 | 324 ms | 693 ms | 1,189 ms | 1,273 ms |

The first data is the complete data: all 134 fares arrive in the one event.

## Hotels

### URL

```
https://www.ixigo.com/hotels/search/result?locationId={id}&locationName={name}&locationType={C|S}&masterLocationId={id}&countryId=1&checkinDate={DDMMYYYY}&checkoutDate={DDMMYYYY}&adultCount={n}&roomCount={n}&childCount={n}
```

Goa, 6 to 9 Nov, 4 adults in one room (loaded straight to results, "Hotels in Goa", 698 hotels):

```
https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=1&childCount=0
```

North Goa: I found no location id for North Goa as a search place. The Goa ids above come from the hotels
home page's own city links (`locationType=S` is a state, `C` a city). Inside a Goa search, "North Goa" is
only an area tag on 9 hotels (`PA_C_78647`); the North Goa beach areas are separate tags (Candolim
`PA_C_1459`, Calangute `PA_C_1047`, Vagator `PA_C_78528`, Morjim `PA_C_1067`, Arpora `PA_C_77993`, Mandrem
`PA_C_1169`). The place lookup the search box uses was not mapped (no typing was done on hotels).

The site accepted 4 adults in 1 room and tagged the search `persona: GROUP`. Prices on the cards are per
night, per room, so check whether the stay needs two rooms.

### Data call

`POST https://www.ixigo.com/accommodation-search/api/v3/accommodations/search`

```json
{"roomCount":1,"locationId":"32","countryId":"1","masterLocationId":"48569","locationName":"Goa",
 "adultCount":4,"childAges":[],"childCount":0,"locationType":"S",
 "checkinDate":"2026-11-06 00:00:00","checkoutDate":"2026-11-09 00:00:00",
 "filterCriteria":[],"sortCriteria":"SC_P","pageNumber":1,"pageSize":10,
 "receivedResults":0,"lastViewedHotelIDs":[], "...": "plus a dozen empty or default fields"}
```

- Paging: the next call sends `pageNumber: 2`, `receivedResults: 3` and the hotel ids already shown in
  `lastViewedHotelIDs`. Page 1 returned 3 hotels and page 2 returned 4, though `pageSize` is 10.
- Headers: `ixisrc` and `clientid` (`ixiweb`), `deviceid`, `uuid`, `apikey` (static web key, not copied
  here), `x-session-id` and `x-search-id` (uuids the page makes; they reappear in the hotel links),
  `x-webapp-version`.
- `POST .../api/v2/accommodations/search/metadata` (same body) returns the filter and sort codes with
  counts and `totalCount` (698). It arrived last, at about 10 s.

Fields, under `data.result.inventoryInfoList[]`:

| Need | Field | Example |
|---|---|---|
| id | `hotelId` | `1384544` |
| name | `name` | `Meritas Auberge Calangute Goa` |
| area | `locality`, `city`, `distanceFromSearchedEntity`, `geoLocationInfo` | `Candolim`, `2.3 km from Candolim Beach` |
| price shown on the card | `fareDetail.displayedBaseFare` + `fareDetail.taxesAndFees` | `6426` + `1678` per night, per room |
| other price fields | `fareDetail.markUpFare` (struck out), `totalBaseFare` and `totalTaxesAndFees` (all nights), `paymentType` | `13666`, `23368.29`, `5032.73` |
| quality | `starRating`, `userRating`, `userRatingCount`, `accommodationType` | `4`, `9.0`, `331`, `Hotel` |
| detail token | `locationId` (the hotel's own), `hotelInfoToken` | `1366415`, `true\|3001\|1` |

The `total*` fields cover the whole stay but I did not reconcile them with the discounts shown; quote the
card's per-night numbers unless that's checked.

Codes (from the metadata call):

- Sort: `SC_P` Popularity (default), `SC_P_LH` Price low to high, `SC_P_HL` Price high to low, `SC_UR`
  User rating.
- Pool: `FL_HF_29` Swimming Pool, `FL_HF_23` Private Pool. Free cancellation `MP_FC`, breakfast `ML_BR`,
  stars `SR_1`..`SR_5`, rating `UR_9.0` / `UR_8.0` / ..., price bands `DP_{min}_{max}`, areas `PA_...`.
- Sending these in `filterCriteria` / `sortCriteria` was not tried.

Deep link to a hotel's own page (from the card's link):

```
https://www.ixigo.com/hotels/{hotelId}/details?locationId={hotel.locationId}&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=1&childCount=0&searchLocationId=32&hotelInfoToken={hotelInfoToken, URL-encoded}&hName={name}
```

The card links also carry `cp`, `searchId` and `usid` (position and tracking). A details page was not
loaded.

### Page controls (AX)

- heading "Hotels in Goa" (level 1); paragraph "Sort by: Popularity" is the sort control. It wasn't
  clicked, so the names of its choices are known only from the codes above.
- Filters: paragraph "Filters", textbox "Enter area, locality or hotel" (search within Goa), then groups
  headed by paragraphs: "Most Popular", "Price" (two sliders), "User Rating", "Facilities", "Star Rating",
  "Accommodation Type", "Popular Areas", "Payment Mode", "Hotel Chain". Each option is a listitem holding a
  paragraph "{name} {count}" and an unnamed checkbox; each group has a button "View More".
- Pool: under "Facilities" only the top four show (Internet access, Parking, Facilities for kids,
  CCTV/Security). Swimming Pool is one of the facility codes, so it should appear after that group's
  "View More"; not tried.
- Each card is one link whose name starts "Add to wishlist ..." and runs through name, area, rating and
  price; its URL is the hotel's details page (that's "view details"). Inside: heading (level 2) with the
  hotel name, button "Add to wishlist" (needs login, never), button "Book Now" (never).

### Timing

| Event | Time |
|---|---|
| Page ready | 326 ms |
| Search page 1 requested | 751 ms |
| Page 1 answered (3 hotels) | 1,727 ms |
| Page 2 answered (4 more) | 4,992 ms |
| Filter metadata answered (698 total) | 9,877 ms |

"Complete" doesn't exist here: after page 2 the page fetches more only as you scroll.

## Trains (availability)

### URL

```
https://www.ixigo.com/search/result/train/{FROM}/{TO}/{DDMMYYYY}//1/0/0/0/ALL
```

New Delhi to Madgaon, Fri 6 Nov (loaded straight to results, title "New Delhi - Madgaon - 06 Nov Trains |
ixigo", 6 trains):

```
https://www.ixigo.com/search/result/train/NDLS/MAO/06112026//1/0/0/0/ALL
```

Station codes are the railway codes (NDLS, MAO). I didn't confirm what the trailing `/1/0/0/0/ALL`
segments mean; this exact shape loaded. Head count doesn't matter for availability: it's per class and
quota, not per person.

Searching NDLS also returns trains from other Delhi stations: 5 of the 6 leave from Hazrat Nizamuddin
(NZM). Use the boarding station each train reports.

### Data calls

1. `GET https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en` is the
   train list, under `data.trainsBetweenStations[]`:

   | Need | Field | Example |
   |---|---|---|
   | id, name | `attributes.number`, `attributes.localName` | `22656`, `NZM ERS SF EXP` |
   | route | `board` / `boardStation`, `deboard` / `deboardStation`, `distance` | `NZM`, `MAO`, `2093` |
   | times | `departDate`, `attributes.departTime`, `arrivalDate`, `attributes.arrivalTime` | `2026-11-06`, `05:00:00`, `2026-11-07`, `10:10:00` |
   | classes, fares | `attributes.fareClasses`, `fares.{class}.baseFare` | `["2A","3A","3E","SL"]`, SL `865` |
   | runs on | `attributes.daysOfOperation` | `0000100` |

2. `GET https://www.ixigo.com/api/v3/trains/availability?originCode=NDLS&destinationCode=MAO&travelDate=06112026`
   is the availability, under `data.routesData[]`: `id` (`22414_NZM_MAO`), `trainCode`, and
   `availabilities[]` with `c` class, `q` quota, `a` status, `f` fare, `t` when it was checked (epoch ms).
   On 6 Nov every class was waitlisted or closed: `WL 11`, `RAC 70`, `Regret`.

3. `GET /api/v2/trains/availabilityCalender?originCode=NDLS&destinationCode=MAO&bookingClass=ALL` fills the
   60-day strip ("Few Seats", "Filling Fast", "Available").

Headers on calls 1 and 2: `gauth`, a fresh Google reCAPTCHA token minted by the page just before each call,
plus `ixisrc`, `clientid`, `uuid`, `deviceid`, `x-requested-with`, `apikey`. These two calls can only be
read inside the page; replaying them would mean making reCAPTCHA tokens, which is out of bounds.

Deep link per train (the card's link): `https://www.ixigo.com/trains/22656?orgn=NZM&dstn=MAO&departDate=2026-11-06&quota=GN`

### Page controls (AX)

Most train filters are plain text with no role, so they need text locators.

- Class: text "Class 2A 3A 3E SL 1A". Quota: "General Tatkal Lower Berth Ladies". Availability: text "Show
  trains with confirmed seats".
- Times: buttons "00:00 - 06:00", "06:00 - 12:00", "12:00 - 18:00", "18:00 - 24:00", once under
  "Departure from" and once under "Arrival at".
- Sort: a navigation with "DEPARTURE TIME", "ARRIVAL TIME", "DURATION", "NAME".
- Each train is a listitem: link "{number}{name}" (the deep link), link "({number} Running Status)", link
  "{from} {time} {date} {duration} {to} {time} {date}", button "Show Availability", then text per class
  such as "SL 865 WL42".

### Timing

| Event | Time |
|---|---|
| Page ready | 418 ms |
| reCAPTCHA token ready | about 1,560 ms |
| Train list requested / answered | 2,356 / 2,361 ms |
| Availability requested / answered | 2,574 / 2,757 ms |

Everything is in by about 2.8 s; most of the wait is the reCAPTCHA token, not ixigo's search.

## Buses

### URL

```
https://www.ixigo.com/buses/bus_search/{FromName}/{fromId}/{ToName}/{toId}/{DD-MM-YYYY}/O
```

Mumbai to Goa, Fri 6 Nov (loaded straight to results, 71 buses):

```
https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O
```

- The city ids come from the search box's lookup, `GET /wap/abus-autocompleter/api/v1/results?s={text}`
  (Mumbai is 4, Goa is 102). I learnt the URL shape from one search through the form (from, to,
  "Tomorrow"). After that search the address bar showed `2026-10-08` while the page had requested
  `08-10-2026`; the `DD-MM-YYYY` form above is the one I loaded directly.
- There is no head count in the URL: seats are picked later, on the seat map.
- Bus search is AbhiBus inside ixigo (the page title says AbhiBus).

### Data call

`POST https://www.ixigo.com/buslist/v3/services`, header `x-app-name: ixibusweb`, body:

```json
{"source":"Mumbai","sourceid":4,"destination":"Goa","destinationid":102,"jdate":"2026-11-06",
 "prd":"mobile","filters":"1","isReturnJourney":"0","version":"105","api_exp":{"...": "A/B flags"},
 "clevertapID":"..."}
```

One response held all 71 buses (170 KB). `GET /buslist/v3/services/meta/105` (config) comes just before
it.

Fields, under `services[]`:

| Need | Field | Example |
|---|---|---|
| id | `serviceId`, `serviceKey` | `4702793519` |
| name | `travelerAgentName`, `busTypeName` | `Naik Tours & Travels`, `NON-AC Sleeper (2 + 1)` |
| price | `fares.fare` (the "From" price), `fares.fareList` | `1500` |
| times | `timings.startTimeTwfFormat`, `.arriveTimeTwfFormat`, `.travelTime`, `.startTimeDateFormat` | `15:30`, `06:30`, `15:00:00` |
| seats | `seatStats.availableSeats`, `.seatsCapacity` | `15` |
| stops | `filters.boardingPoints[]`, `filters.droppingPoints[]` (ids into the top-level `boardingPointList` / `droppingPointList`) | |
| rating | `rating`, `noOfRatings` | |

Top level: `minFare`, `maxFare`, `operators{}` (names, ratings), `travelNamesList`, `busTypeList`.

Deep link: none. A card's only way on is "Select Seats", which opens the seat map, the start of a booking.

### Page controls (AX)

Bus filters and sort are plain text next to images, with no roles.

- Search: textboxes "Leaving From", "Going To", "Onward Journey Date"; buttons "Today", "Tomorrow",
  "Search".
- Bus type: "AC", "Sleeper", "Non AC", "Seater", "Bus Track", "New Buses", "Offers". Price Range: two
  sliders. Departure Time: "Before 10 AM", "10 AM - 5 PM", "5 PM - 11 PM", "After 11 PM". Then "Bus
  Partner", "Boarding Point", "Dropping Point".
- Quick filters are buttons named by short codes: "Operator", "WD", "ASD", "TopRated", "EEB", "PriceDrop",
  "EER".
- Sort: text "Sort by", then "Price", "Seats", "Ratings", "Arrival Time", "Departure Time".
- Each card: text "Bus details" (not clicked); button "Select Seats" (never).

### Timing

| Event | Time |
|---|---|
| Page ready | 331 ms |
| Bus list requested | 548 ms |
| Bus list answered (all 71) | 661 ms |

## Bot protection

- Cloudflare: every flow sets a `__cf_bm` bot-management cookie on the first response. None of the nine
  loads hit a challenge page, a captcha, a 403 or a 429. Nothing has to be set first: a fresh profile went
  straight to results each time.
- Google reCAPTCHA (invisible): trains attach a fresh token to each data call (the `gauth` header), which is
  why train results take about 2 s longer. The flights and hotels pages also load reCAPTCHA frames (at 1.9
  to 6 s), but their results calls carry no token; it looks like it's for login. Buses loaded none.
- Static web keys: flights, hotels and trains send an `apikey` header that is the same for every visitor
  (it's in the page's script). Buses send only `x-app-name`.
- The one error seen was a 400 from `/ab-test-api/check-variant-for-experiment` on flights, an A/B test
  call that doesn't affect the results.
- Headless Chromium with a desktop Chrome user agent passed every time, but nine loads say nothing about
  what volume or a datacentre IP would trigger.
