# ixigo recipes: Go as an agent of ixigo.com

Go does on ixigo.com what a person does there, fast: search, filter, sort, pick, and the steps up to booking. Each thing
a person can do is a recipe file. One engine in Go runs any of them, so a new capability is a new file, not new code. A
recipe knows how to use the site, never what is on it: no list of cities, airports, stations, hotels or areas. ixigo
resolves every place through its own search box, and Go keeps what it resolved.

## 1. The book

- `apps/brain/recipes/<section>/<name>.yaml`: one recipe, its id `section.name` (`trains.between`, `hotels.search`).
- `apps/brain/recipes/samples/`: trimmed responses the recipes read, with no personal data. CI runs recipes over them.
- The engine is `apps/brain/src/travel/book/`: `format.ts` (what a file may say), `book.ts` (the loader), `expr.ts`
  (expressions), `template.ts`, `read.ts` (rows into options), `lookup.ts` (places), `engine.ts` (a run).

Go loads the book at boot. Each file is checked against the format, its id against its path, every expression and
template part compiled, and every lookup it names found. A file that fails is left out, with the reason in the log;
the rest run. A turn never parses an expression.

### A recipe file

```yaml
id: buses.between
title: Buses between two cities on a date
asks: [buses from mumbai to goa on friday, mumbai se goa bus kal raat]   # how people say it
inputs:                                     # concepts only
  from: { kind: place, lookup: buses.city_lookup }
  to: { kind: place, lookup: buses.city_lookup }
  date: { kind: date }
auth: none                                  # none | login
changes_state: false                        # true: it books, locks or cancels, so it needs the group's yes
page: /buses/bus_search/{from.name}/{from.id}/{to.name}/{to.id}/{date|DD-MM-YYYY}/O
capture: [/buslist/v3/services$]            # the page's own data call the browser fetch keeps
read:
  rows: { from: /buslist/v3/services$, list: services }
answer:
  as: options                               # options | link | facts | places
  kind: bus
  each: |                                   # one row as one option (JSONata)
    ( ... { "title": $trim(travelerAgentName), "priceMinor": $paise(fares.offerPrice ? fares.offerPrice : fares.fare), ... } )
```

Also: `conditions` (the person's conditions ixigo filters on itself, as its own codes: `pool: "'FL_HF_29'"`, bound as
`$conditions`), `let` (values worked out once, such as the filters list), `fetch` (another plan when a condition holds:
two pages for a whole state, the popup's close, the settle before the last picture), `keep` (which options stay),
`ttl_minutes`, `samples`, `measured` and `notes`.

### A composite

A composite runs other recipes in the book for each entry of a list, at once, and answers them side by side. It opens
nothing itself. `trip.how_we_get_there` runs each member's home city's trains, buses and flights to the trip:

```yaml
inputs:
  to: { kind: text, value: $trip.destination }
  date: { kind: date, value: $trip.start }
steps:
  each: $trip.homes[$lowercase($) != $lowercase($$.to)]    # the list: each entry once, the most listed first, at most 4
  as: home                                                 # an entry's name in the steps' given
  run:                                                     # at most 4 steps, each a recipe and its inputs
    - { recipe: trains.between, given: { from: $home, to: to, date: date } }
    - { recipe: buses.between, given: { from: $home, to: to, date: date } }
    - { recipe: flights.search, given: { from: $home, to: to, date: date } }
answer: { as: compare }   # each entry with each step's answer, or why it has none
```

A step is a search, a link or facts: never a lookup, another composite, or a recipe that changes something on ixigo;
its `given` names only inputs its recipe has. Every step starts at once, straight through the engine (not the search
backend, so no shared cache or live search card); the trip's computer runs as many fetches as Bash allows at a time (the `BROWSER_FETCH_SLOTS`
switch: 2, and 4 once Bash runs four), and the rest wait their turn in Go, so Bash never answers `409 browser_busy`
(when it does, Go waits as long as Bash says and asks again). A step that fails is its entry's why, never the
composite's failure. On the run strip the composite is a run of speed `steps`, and each step a run that names it in
`step_of`, with its entry as its `lane` (a lookup inside a step has the step as its `parent`, as in any search).

### Expressions

Every `read`, `answer`, `let` and template part is a JSONata expression (jsonata.org, version 2.2.2 pinned): sandboxed,
no IO, no access to Go's code. The engine adds a fixed set of generic functions any recipe may call (`$paise`,
`$istAt`, `$istPlus`, `$minutes`, `$hoursMinutes`, `$highlights`, `$titleWords`, `$groups`, `$mentions`, `$query`,
`$num`, `$dateAs`, `$rupees`); nothing recipe-specific is code. Every evaluation is timeboxed by JSONata's own guardrails
(50 ms, a stack of 250, a sequence of 20,000): a run past them fails as a whole. A single regular expression can't be
interrupted, so recipe files are reviewed for that.

Templates fill `{expr}` or `{expr|DDMMYYYY}` from the inputs; in an address every value is URL-encoded unless it says
`|raw`, so a place's name can never add a parameter.

ixigo sends a detail it doesn't have as null: a null is the same as missing. Every option is checked against the option
shape, and one that doesn't check out is dropped, never half read; a page where nothing reads is refused.

## 2. Places: ixigo's own search box resolves them

1. **A place ixigo resolved before goes straight to its results.** `travel_places` keeps each place by kind of search
   and the words people used ("london" for flights is LON), loaded at boot. The codes Go used before seed it; they are
   ixigo's own.
2. **A new place: ask ixigo's box.** A lookup recipe (`flights.airport_lookup`, `hotels.place_lookup`,
   `trains.station_lookup`, `buses.city_lookup`) says how to reach the box's suggestions and how they read. Each end of
   a route opens the box's own suggestion call for the person's words as the page (`box.open`), all ends at once, with
   nothing typed: on 8 Oct, typing into the box timed out in the box's browser. A recipe with no `open` types into the
   box on ixigo's search page instead (`box.page` and `box.type`), both ends in one fetch.
3. **The pick**, as a person makes it:
   - the "All airports", "All stations" or "All boarding points" entry;
   - else the one entry that is the place by its own name (a stay's city or state, an airport's city, a bus city), or the
     only entry the words fit, India first unless the words say otherwise;
   - else the model chooses: the turn gets ixigo's list, and the name the model gives ("Udaipur City (UDZ)") resolves
     from that list with no second load, kept for the words asked too.
4. **Then the results page**, from the picked codes: the same address ixigo's own Search lands on.
5. **A place ixigo doesn't know either**: the search answers with ixigo's own page for that kind, never another site.

Reading the suggestions, rather than clicking one and then the dates and Search: the pick needs the list (the second
and third rules can't be a click before the list is seen), the date pickers differ form by form (bus days are buttons
named by a bare number behind a month arrow; hotel guests are steppers with no names), and the address Search lands on
is the one the recipe opens, with the dates, travellers, filters and sort on it.

## 3. Speeds, fastest first

1. **fast:** the page's own call, made from inside the trip's warm ixigo tab through Bash's `page_fetch` (to come).
2. **page:** open the address and keep its data calls: Bash's browser fetch (`runners.ts`), 2 to 5 s.
3. **flow:** the person's way through the controls, as accessibility steps (to come). A call that changed shape is
   reported, and the recipe is redone; the engine never rewrites a file.

The /v1 agent job is for the long tail beyond the book.

**The warm.** A sleeping box takes about 5.5 s to wake. One function owns waking it, `travel/warm.ts`
`warmForTravel`, on travel intent only: a line Jev's question 10 is sure asks for a search, a search the early start or a
search tool starts, and the engine's runs that open a page. Chatter never wakes the box, nor does a new trip's setup.
Under `ixigo_web` only; the warm holds the box awake for 2 minutes (`keep_ms`), and intent with under 20 s of the hold
left extends it.

## 4. Safety, in code

- **Payments:** ixigo's payment page opens with a saved card ready to pay in one click. The engine refuses any page, box
  or landing under `/payments/`, and the format check refuses a file that names one.
- **The group's yes:** a `changes_state` recipe (lock, book, cancel) never runs without it, and stops on the page before
  Payment.
- **Never another site:** a search that can't answer gives ixigo's own page.

## 5. The searches today

| Recipe | Page | Data call | Answer |
|---|---|---|---|
| `hotels.search` | `/hotels/search/result?locationId=…` | `/accommodation-search/api/v3/accommodations/search$` (10 a page; two pages for a whole state) | options, per night per room with taxes |
| `trains.between` | `/trains/search-pwa/from/{from}/to/{to}/{DD-MM-YYYY}` | `ixigotrainsapi.confirmtkt.com/api/v1/trains/search` (ixigo's own train service since October) | options, one per train and class, with seats and ixigo's chance |
| `buses.between` | `/buses/bus_search/{From}/{id}/{To}/{id}/{DD-MM-YYYY}/O` | `/buslist/v3/services$` | options, the lowest seat fare after ixigo's offer |
| `flights.search` | `/search/result/flight?from=…` with ixigo's own filter and sort params | none | a link: ixigo answers flight pages with a 403 from the boxes' shared egress |

## 6. Next

- The `ixigo` tool: any recipe by id, with a description built from the book; `facts` answers.
- `plan.destination` (ixigo's destination guide: places to eat and visit, best time to go), and Go naming a place only
  from ixigo's data in that turn.
- `flights.fare_calendar` and `flights.price_lock` (changes state: the group's yes).
- The fast and flow speeds; a composite's fast steps in one batch `page_fetch` (Bash's #4596).
- Areas inside a city through ixigo's "Search within" box and its Popular Areas filter, in place of Goa's halves.


## 7. How ixigo works


Walked by hand on www.ixigo.com, logged in as Keshav, on 7 Oct 2026, through the accessibility tree. Nothing was booked or
paid. There is no personal data in this file: saved travellers, contact details and addresses were seen but are not copied.

### The rule for every recipe

A recipe knows HOW to use ixigo (which control, what to type, which suggestion to take, which filter, sort, Book). It
never knows WHAT is on ixigo: no city, airport, station, hotel or area list anywhere. ixigo resolves every place through
its own search box. The results address a run lands on carries ixigo's codes; Go keeps those per place (p1-a's
`learnFromPage`), so the next ask for the same place can open the results address straight away.

**Picking a suggestion.** ixigo lists suggestions under the box. Take, in order:
1. the "All airports", "All stations" or "All boarding points" entry for the city, when there is one;
2. otherwise the first entry whose second line (city, state, country) fits the ask and the trip (India unless the ask
   says otherwise; "London" is London, England, United Kingdom, not London, Ontario or London, Kentucky);
3. otherwise hand the list (name and second line only) to the model and let it choose. Example: "Udaipur" must be
   "Udaipur City (UDZ)", not "Udaipur (UDPU)", which is another town.

### Flights (www.ixigo.com or /flights)

| Step | Control (role and name) | Notes |
|---|---|---|
| Trip type | tab "One Way" or tab "Round Trip" | One Way is the default |
| From | paragraph "From", then an UNNAMED focused textbox | type the person's words |
| From suggestions | listitem: text CODE, paragraph "City, State, Country", paragraph airport name | e.g. LON, "London, England, United Kingdom", "All Airports" |
| To | focus moves to To by itself after From is picked | same suggestion shape |
| Date | the calendar opens by itself: button "20 October 2026 73745" | the number is that day's cheapest fare; past days are [disabled] |
| Travellers | opens by itself: Adults buttons "1".."9", Children "0"..., Infants; class text Economy, Premium Economy, Business; button "Done" | digit buttons repeat per group, so pick by group |
| Search | button "Search" | lands on /search/result/flight?from=LON&to=DEL&date=20102026&adults=1&children=0&infants=0&class=e |

The suggestion data call is `/action/content/city?searchFor=airportSuggestions&value=<words>&nearByAirport=true`.

**Results page**
- **Smart Filters:** textbox "Ask something like: I want to see flights with no stops under ₹25000." plus button
  "Filter Flights". ixigo turns plain words into its own filters: "non stop flights only" added `&stops=0`. Go can pass the
  person's conditions here in their own words.
- **Filters** (unnamed checkboxes; the label is the paragraph next to each): Stops (Non-Stop, 1 Stop, 2+ Stops, each with
  its lowest price), Baggage, Flight Price slider, Duration slider, Airlines (count and lowest price), Departure Airport,
  Arrival Airport, departure time bands, Hide Non Refundable.
- **Sort:** four radios, in order: Price (Low to High), which adds `&sort_type=cheapest`; Fastest (Shortest First);
  Departure (Earliest First); Smart (Recommended, the default).
- **A flight card:** airline, flight numbers, departure time, from airport, duration, stops, arrival time (+N days), to
  airport, price, "Extra ₹X Off", button "Book", button "priceLock Lock Price @₹1,239", and "Flight Details" (fare type,
  cabin and check-in baggage).

**Booking** ("Book" opens /flight/booking/…, titled "Review Flight Details")
- Steps: Flight Selection, Review & Traveller Details, Add-ons, Payment.
- On the review page:
  - Offers For You: textbox "Have a promocode? Redeem here", and offer radios named by code, one already applied;
  - Fare Summary;
  - Traveller Details: saved travellers as checkboxes, or a new one (name, date of birth "DD/MM/YYYY", passport fields
    abroad);
  - Contact Details, prefilled from the account;
  - GST (optional);
  - Billing Address (mandatory: a pincode spinbutton fills the address);
  - button "priceLock Lock Price @₹…" and button "Continue".
- **Go never presses past Add-ons into Payment.** Paying happens only through the group's approved path.

**Price lock:** each fare can be held for a fee ("Lock Price @₹1,239" on London to Delhi), on the results card and on the
review page. Map next: the hold time and what the fee buys.

**Box limit:** ixigo answers flight pages with 403 from the boxes' shared egress, so flights stay a link card. The link's
airport codes come from ixigo's suggestion when it can be reached, or from the model's own airport knowledge, checked as a
3-letter code.

**London to Delhi, 20 Oct, non-stop, cheapest (seen live):** Air India at ₹1,44,653, three Heathrow departures: AI162
09:45, AI2018 20:35, AI2016 21:45, about 10 h 15 m. The cheapest with stops was ₹72,531 (Emirates, 1 stop).

### Hotels (/hotels)

| Step | Control | Notes |
|---|---|---|
| Where | textbox "Enter city, area or property name" | type the person's words |
| Suggestions | button "Manali City • Manali, Himachal Pradesh • 942 Properties" | the types are City, Region ("Manali and Nearby"), Area ("Old Manali"), Property |
| Dates | the calendar opens by itself: button "6 November 2026", then button "9 November 2026" | check-in, then check-out; no fares shown |
| Rooms & Guests | textbox "Rooms & Guests" ("1 Room, 2 Guests") opens steppers for Rooms, Adults, Children | the minus and plus buttons have NO names. Set guests on the results address instead (adultCount, roomCount, childCount) |
| Search | button "Search" | lands on /hotels/search/result?locationId=184&locationName=Manali&locationType=C&masterLocationId=9425&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=2&roomCount=1&childCount=0&cityId=184&stateId=8 |

- **Data calls:** suggestions come from `hotels-autocompleter/api/v2/results?query=…`; results from
  `accommodation-search/api/v3/accommodations/search`, with `/search/metadata` and `/search/static-metadata` beside it.
- **Filters:**
  - "Best Price Guarantee";
  - textbox "Enter area, locality or hotel" ("Search within Manali"). This is the way to an area: type it, as a person
    would;
  - Most Popular: Free Cancellation, Couple Friendly, Free Breakfast, Rated Exceptional (9+), each with a count;
  - Price range;
  - User Rating radios (9+, 8+, 7+, 6+, 5+);
  - Facilities (Parking, Internet, Restaurants, Room Service, and more);
  - Star Rating;
  - Accommodation Type (Homestay, Hotel, Resort, Hostel, B&B, Lodge, Entire house and more);
  - **Popular Areas**, from the page with counts (Old Manali, Siyal…), which replaces our area list;
  - Payment Mode: Prepaid, Book with ₹0 payment, Pay At Hotel;
  - Hotel Chain.
- **Sort:** "Sort by: Popularity" opens Popularity, Price Low to High, Price High to Low, and User Rating Highest First.
- **A hotel card** is a link: name, area and distance from a landmark, rating and count, badges (Free Cancellation, Book
  with ₹0 payment, Breakfast Included), rooms left, the struck price, the price plus taxes per night per room, the coupon
  applied (IXIFIRST), and "Book Now".
- **Popup:** a Best Price Guarantee modal on the first visit of the day (close: "Close modal").

### Trains (/trains)

| Step | Control | Notes |
|---|---|---|
| From | searchbox "Enter Origin" | suggestions are paragraphs "Name (CODE)", including "Jaipur - All stations(JP)" |
| To | focus moves to searchbox "Enter Destination" | pick the city's main station by meaning (Udaipur City (UDZ)) |
| Date | the calendar opens by itself: button "20 October 2026"; quick chips Tomorrow and Day After ("Tatkal Open") | |
| Search | button "Search" | lands on /trains/search-pwa/from/JP/to/UDZ/20-10-2026 |

- **Data call:** suggestions come from `/action/content/trainstation?searchFor=trainstationsLatLon&value=…`.
- **Results:**
  - listbox "Available dates", a date strip;
  - checkboxes "Best Available", "AC Only", and the full-refund add-on ("Get a full train fare refund");
  - each train: number and name ("12992 Jp Udz Superfast"), rating, departure time and station, duration, arrival time and
    station, button "Schedule";
  - class tiles such as "2S ₹185 AVL 100 Available" or "SL ₹275 WL 23 38% Chance", which is ixigo's confirmation chance
    for a waitlist.
- **Booking:** a class tile, then IRCTC login and booking.
- **Train extras** (links on /trains): PNR Status, Train by Name/No. (running status), Seat Availability, Station Status,
  Platform Locator, Coach Position, and the Alternate Travel Plan (up to 3x refund if the ticket stays waitlisted).

### Buses (/buses, run by AbhiBus)

| Step | Control | Notes |
|---|---|---|
| From | textbox "Leaving From" | suggestions: "Bangalore (All boarding points) Bengaluru, Karnataka", then boarding points |
| To | textbox "Going To" | "Hampi Karnataka", "Sanapur (Hampi) Karnataka"… |
| Date | textbox "Onward Journey Date" opens a calendar: month text plus day buttons named only "20" | later months need the next-month arrow |
| Search | button "Search" | lands on /buses/bus_search/Bengaluru/7/Hampi/1579/20-10-2026/O |

- **Data call:** results come from `/buslist/v3/services`.
- **Filters:** AC, Sleeper, Non AC, Seater, Bus Track, New Buses, Price Range, Departure Time, boarding points (Majestic,
  Marathahalli…), PriceDrop.
- **Sort:** Price, Ratings, Departure Time.
- **A bus card:** seats left, operator, bus type ("AC Sleeper (2 + 1)"), departure time and point, button "Select Seats",
  which opens the seat map.

### Still to map
- Price lock: the hold time and terms.
- ixigo money.
- My Trips: changes and cancellations.
- Offers.
- Plan (/plan).
- Book Visa and Group Booking.
- The train extras listed above.
- The hotel flow after "Book Now", up to payment.
- Seat selection on buses, up to payment.

### Logged-in corners (walked as Keshav; no personal data copied)

**Flight booking, end to end** (stopped on the payment page, nothing paid)
1. Review & Traveller Details:
   - "Offers For You": a code applied by default (SALE, INTFLY…), other codes as radios, and "View All Offers";
   - the Free Cancellation choice is three radios: "Assured" @₹1,299 per traveller, "Assured Flex" (cancel and reschedule) @₹1,599, or "I don't want Free Cancellation" (₹3,999 fee if you cancel);
   - saved travellers as checkboxes;
   - Continue opens the dialog "Review Details" (Edit / Confirm), then an upsell dialog "Free Cancellation" (No, Thanks / Secure My Trip).
2. Add-ons:
   - tabs "Seat" and "Meal";
   - the seat map is UNNAMED images with a price legend (Free, ₹622 to ₹988, ₹1404 to ₹1460), so seats need the data call or coordinates;
   - button "Skip to Payment".
3. Payment (/payments/view/home/…):
   - a 10-minute countdown and "Amount To Be Paid";
   - methods: Recommended, UPI (QR), Credit/Debit/ATM Card, Pay Later & EMI, Apps (CRED, Apple Pay), EMI, Wallets, Net Banking;
   - card offers show at this step. Per Keshav they apply when a card is chosen; the eligibility call is `POST /payments/v4/payment-method-eligibility`, and EMI is `/payments/v1/emi-option`.
   - **DANGER:** a saved card comes pre-selected with "This card does not require a CVV", next to "Securely Pay ₹…". One click pays. Bash must hard-block /payments/ in Go's browser (asked of p5); recipes never go there.
4. Walking to Payment created an unpaid trip id on the account. It lapses on its own.

**Price Lock:** "Lock this fare for 2 days, Covering up to ₹8,000", plus ixigo's own forecast ("93% chance of a price increase in next 2 days"). Durations: 2 days ₹1,239 or 3 days ₹1,359 (London to Delhi), ₹639 on a ₹7.8k domestic fare. If the price rises, ixigo pays the difference up to ₹8,000 per traveller; if it falls, you pay the lower fare. The fee is non-refundable and not adjusted against the fare. "Complete your booking by <date>". It's ideal for a group: lock while the group votes. It changes state, so it needs the group's yes.

**Plan (/plan):** a where-to-go explorer.
- Inputs: From city, travel month, budget (₹0 to ₹1L+), travel time (0 to 12 h+), weather and AQI (Rain, No Rain, Snow, Pollution Free, Colder, Warmer), themes (Religious, Cultural, Nature, Food, Festivals, Historical, Shopping, Beaches, Mountains, Outdoors, Nightlife, Luxury, Wellness, Romance, Night Skies, Sports, Offbeat), and International / Domestic / Visa-free.
- Each result shows the destination, its region, the travel cost and a per-night price.
- There's also "Create trip with AI".

**Data calls seen** (fast-path candidates; shapes to fill in the recipe files):
- flights search: `GET /flights/v2/search/stream` (a stream);
- fare calendar: `GET /outlook/v1/onward/ranged` (the cheapest fare per day);
- airport suggestions: `GET /action/content/city?searchFor=airportSuggestions`;
- fare-mapper widget: `/api/v2/widgets/flight/faremapper`;
- deals: `/upahaar-inventory/api/deals`;
- hotels: `accommodation-search/api/v3/accommodations/search`, plus metadata;
- buses: `/buslist/v3/services`;
- trains: station lookup `trainstationsLatLon`.

**Train tools:**
- /trains/pnr-status: textbox "PNR Number", button "Check PNR Status";
- /trains/name-number: searchbox "Search trains by name or number", which opens /trains/<number> (schedule, route, coach position, ticket prices, BOOK);
- /trains/train-seat-availability: Origin and Destination plus "Check Availability".

**Offers (/offers):** buttons "Domestic 49 Offers" and "International 48 Offers"; each offer is a heading such as "Up to ₹2,000 Off on Domestic Flights with HDFC Bank Credit Card + Interest Free EMI".

**Hotel booking, logged in:**
- The details page has "Reserve 1 Room" per room type ("Select your room": Queen Room, Royal Suite, Deluxe…), "View All Rooms", reviews, the map, and "About"/"Popular Facilities".
- "Reserve 1 Room" opens /hotels/<id>/review?…&blockId=…&roomId=…&rOption=Room Only.
- On 7 Oct that review page showed "Oops! An error has occurred" (Retry didn't help) for two different hotels (providers 2022 and 3001) in this browser, so the hotel review step is not mapped yet. Retry once on the trip's box before building `hotels.book_review`; until then Go stops at the details page and hands over the room link.
