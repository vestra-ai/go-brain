# ixigo.com: hotels, and everything that isn't flights, trains or buses

This page maps every corner of ixigo.com outside flights, trains and buses (those are in
[`ixigo-web-map.md`](ixigo-web-map.md) and the flights, trains and buses maps). For each corner it says what it does for a
group, how to get in (a URL, or the control to press), the page's own data call and the fields that matter, whether it
needs a login, whether it costs money, how people in a group chat ask for it, and a recipe Go can follow.

How this was mapped (7 Oct 2026): a local headless Chromium (Playwright 1.58), a fresh logged-out profile for every load
(locale en-IN, Asia/Kolkata, a desktop Chrome user agent), a few seconds between loads. Read only: searches, filters,
sorts, scrolling and typing in search boxes. Never a login, a wishlist, a booking, a "Book Now", a lead form or a
payment. 21 page loads in all. Times are from the start of navigation, on one Mac on one evening, so treat them as
rough. Where a recipe "waits for a call", it means `page.waitForResponse` on that path inside the page, as in the web
map: the calls carry page-made ids and a static web key, so Go reads them in the page and never replays them.

## The corners, by value to a group

| Corner | Group value | Needs login | Costs money | Fast recipe |
|---|---|---|---|---|
| [Hotel search, with filters and sort](#hotel-search-filters-and-sort) | high | no | no (booking does) | yes: filters and sort go in the URL |
| [Hotel place lookup (area, beach, villa name)](#hotel-place-lookup) | high | no | no | yes |
| [Hotel details: rooms, sleeps how many, amenities, reviews, policies](#hotel-details) | high | no | no | yes |
| ["Load more" (paging)](#paging) | high | no | no | yes: scroll |
| [Hotel offers and coupons, and the offers hub](#offers-and-coupons) | high | no | no | yes |
| [Group booking (flights for a big group)](#group-booking) | high | no (it's a lead form) | the trip does | entry only: never submit |
| [Collaborative wishlists](#wishlists) | high | yes | no | entry only |
| [Destination planner: things to do, best time, places](#destination-planner-things-to-do) | med | no | no | yes: read the page |
| [Trip planner explorer ("where should we go")](#trip-planner-explorer) | med | no ("Create trip with AI" not tried) | no | partly |
| [Airport cabs](#airport-cabs) | med | not reached | yes | partly: place lookup only |
| [Assured (free cancellation add-on)](#assured-and-insurance) | med | no | yes, at booking | yes (rules only) |
| [ixigo money (wallet) and Hotel Cash](#ixigo-money) | low | yes | no | entry only |
| [Customer support, cancel and refund status](#customer-support) | low (high when something breaks) | yes, for your bookings | no | entry only |
| [Visa (Visa2Fly)](#visa) | low for Goa, med abroad | no to browse | yes | partly |
| [Travel stories (guides)](#travel-stories) | low | no | no | read the page |
| [Holiday packages](#holiday-packages) | none on the web | | | no web entry |
| [Credit card, metro tickets, fare alerts, flight tracker](#the-rest) | low | some | some | entry only |

Top five for fast recipes: hotel search with filters in the URL, the hotel place lookup, hotel details, the offers list,
and the destination planner page.

## Hotel search, filters and sort

**What it does.** Lists stays for a place and dates, with prices per night per room. A group cares because this is where
"pool villa near the beach, under 8k a head" gets answered. Group value: high.

**Entry.** The results URL from the web map, plus two parameters the page itself writes when you tick a filter or pick
a sort:

```
https://www.ixigo.com/hotels/search/result?locationId={id}&locationName={name}&locationType={S|C}&masterLocationId={id}&countryId=1&checkinDate={DDMMYYYY}&checkoutDate={DDMMYYYY}&adultCount={n}&roomCount={n}&childCount={n}&filters={code},{code}&sort={code}
```

Loaded straight from the URL, both of these came back filtered and sorted, with no clicking:

- Goa, private pool, in Vagator, cheapest first: `...&locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&...&filters=FL_HF_23%2CPA_C_78528&sort=SC_P_LH`.
  Two villas, both in Vagator, both with a private pool.
- Anjuna, swimming pool, best rated first: `...&locationId=1026&locationName=Anjuna&locationType=C&masterLocationId=50347&...&filters=FL_HF_29&sort=SC_UR`.
  296 stays. Anjuna itself has only 7, so the search takes in the stays around it (Morjim, Vagator, Assagao).

The URL keeps the codes comma separated (`%2C`). Ticking boxes in the page writes the same `filters=` and `sort=` to the
address bar, so a URL Go builds and a URL a person copies look the same.

**Data calls.**

- `POST /accommodation-search/api/v3/accommodations/search`: the hotels, 10 a page. The URL's codes arrive in the body
  as `"filterCriteria": ["FL_HF_23", "PA_C_78528"]` and `"sortCriteria": "SC_P_LH"`.
- `POST /accommodation-search/api/v2/accommodations/search/metadata`, same body: the filter codes with live counts, and
  `metaData.totalCount`, the number of stays that match.
- `POST /accommodation-search/api/v3/accommodations/search/static-metadata`, body `{"locationType":"S","locationId":"32"}`:
  every filter code with its name, without counts. It answers first (0.8 to 1.5 s).

**The codes** (from the two metadata calls; the counts are Goa, 6 to 9 Nov, 4 adults):

| Group | Codes |
|---|---|
| Sort | `SC_P` popularity (default), `SC_P_LH` price low to high, `SC_P_HL` price high to low, `SC_UR` user rating, highest first |
| Most popular | `MP_FC` free cancellation (510), `MP_CF` couple friendly (69), `MP_FB` free breakfast (234), `MP_RE` rated 9+ (167), `MP_BPG` best price guarantee, `MP_PA` parking |
| Facilities (31) | `FL_HF_29` swimming pool (366), `FL_HF_23` private pool, `FL_HF_22` private beach, `FL_HF_21` pet-friendly, `FL_HF_14` kitchen, `FL_HF_17` nightclub or bar, `FL_HF_3` barbecue, `FL_HF_9` facilities for kids, `FL_HF_20` parking, `FL_HF_31` transfers, `FL_HF_28` spa, and more |
| Stay type | `AT_HOTEL`, `AT_RESORT`, `AT_HMSTY` homestay, `AT_EH` entire house, `AT_SAPRT` serviced apartment, `AT_BAB` bed and breakfast, `AT_HOSTEL`, `AT_LDG` lodge, `AT_FS` farm stay, `AT_COH` country house, `AT_TENT` |
| Area | `PA_C_1459` Candolim, `PA_C_1047` Calangute, `PA_C_78528` Vagator, `PA_C_1067` Morjim, `PA_L_154858` Palolem, `PA_C_77993` Arpora, `PA_C_1169` Mandrem, `PA_C_79088` Agonda, `PA_C_1096` Arambol, `PA_C_1091` Panaji (20 in all, with counts, in the metadata call) |
| Stars, rating | `SR_1` to `SR_5`; `UR_9.0`, `UR_8.0`, `UR_7.0`, `UR_6.0`, `UR_5.0` |
| Price per night | `DP_{min}_{max}` bands, such as `DP_5000_6000` (42 bands, in the metadata call) |
| Meals, payment | `ML_BR` breakfast, `ML_LU` lunch, `ML_DI` dinner; `PT_PAY_AT_HOTEL`, `PT_BOOK_WITH_ZERO_PAYMENT`, `PT_PAY_NOW` |
| Hotel chain | `HC_{id}`, such as `HC_17` Marriott (in the metadata call) |

There is no "villa" type. Villas come back as `accommodationType: "Hotel"` with "Villa" in the name (Lohono Stays,
Elivaas, StayVista), so "villa" means `FL_HF_23` (private pool), `AT_EH` (entire house) or a name match. "Couple
friendly" is `MP_CF`, and each hotel carries `coupleFriendly: true|false`.

**Fields**, under `data.result.inventoryInfoList[]` (the web map lists id, name, area, price and quality):

| Need | Field | Example |
|---|---|---|
| what's special | `topOfferings`, `summary` | `["Breakfast Included", "Free Wifi", "Swimming pool at the property"]`, `Secluded villa with spa and private pool` |
| rooms left | `roomsCountLeft`, `fomoTags[].data` | `1`, `Only 1 room left` |
| couple friendly | `coupleFriendly` | `false` |
| coupon already in the price | `fareDetail.couponCode`, `fareDetail.offerMessage`, `fareDetail.totalDiscount` | `IXIFIRST`, `Discount of ₹1666 included. Coupon code IXIFIRST applied!` |
| ixigo money | `fareDetail.burnMoneyInfo`, `fareDetail.earnInfo.text` | `You'll earn ₹1000 Hotel Cash on this booking` |
| photos | `imageInfoList[].url`, `.imageCategory` | `Swimming Pool`, `Rooms` |

**Logged in or not:** no. **Money:** searching is free; the card's "Book Now" starts a booking (never).

**How a group asks** (slots: place or area, dates, guests and rooms, filters, sort, budget):

- "pool wala villa dikhao Anjuna mein, 6 se 9 Nov" (area, dates, private pool)
- "Vagator ke paas sasta hotel, 4 log ek room" (area, cheapest first, guests)
- "free cancellation wale hotels Goa mein under 5k" (`MP_FC`, a price band)
- "best rated resort in Candolim, breakfast included" (`AT_RESORT`, `ML_BR`, sort by rating)
- "koi homestay hai Palolem mein? pet friendly chahiye" (`AT_HMSTY`, `FL_HF_21`, area)
- "beach ke paas party wala place, bar hona chahiye" (`FL_HF_17`, area by beach)

**Recipe.** Build the URL with `filters=` and `sort=` → open it → wait for `POST .../api/v3/accommodations/search` →
return name, area, `fareDetail.displayedBaseFare` + `taxesAndFees` per night per room, rating, `topOfferings`,
`roomsCountLeft`, and the hotel link. For "how many match", wait for the metadata call's `totalCount` too.

| Search | Page ready | First 10 hotels | Total count |
|---|---|---|---|
| Goa, no filter (4 loads) | 253 to 617 ms | 0.98 to 1.6 s | 0.96 to 1.5 s |
| Goa, private pool, Vagator, cheapest | 382 ms | 986 ms | 3.2 s |
| Anjuna and around, pool, best rated | 255 ms | 6.5 s | 2.4 s |

A popup ("Best Price Guarantee", `data-testid="bpg-home-modal"`) covers the results page on load and swallows every
click, which is why filter clicks timed out until the codes went in the URL instead. Go never needs to click a filter.

## Hotel place lookup

**What it does.** Turns "Anjuna", "Baga Beach" or a villa's name into the ids the results URL needs. Group value: high,
because nobody says "locationId 1026".

**Entry.** The hotels home page, `https://www.ixigo.com/hotels`, textbox "Enter city, area or property name". Type the
place; the suggestions are buttons named like "Anjuna City • Anjuna, Goa • 7 Properties".

**Data call.** `GET /hotels-autocompleter/api/v2/results?query={text}&size=10&v=3`, under `data.suggestions[]`:

| Field | Example (query "Anjuna") |
|---|---|
| `name`, `region` | `Anjuna`, `Anjuna, Goa` |
| `locationType` | `C` city, `S` state, `SL` area inside a city (`Anjuna Junction, Montero Waddo`, 72 stays), `POI` landmark (`Anjuna Beach`), `H` a single property (`3BHK Villa with Private Pool near Anjuna`) |
| `locationId`, `masterLocationId` | `1026`, `50347` |
| `hotelsCount` | `7` |
| `cityId`, `stateId`, `latitude`, `longitude` | `1026`, `32` |

`C` and `S` results drop straight into the results URL (Anjuna above). An `SL` or `POI` result was not tried in the
results URL; inside a Goa search, the `PA_...` area codes from the metadata call do the same job and are tested.

**Logged in or not:** no. **Money:** no.

**How a group asks** (slot: a place in words): "Anjuna mein kahan rukein?", "Baga beach ke paas hotels",
"North Goa mein stay", "near Mopa airport hotel", "StayVista ka koi villa hai Anjuna mein?".

**Recipe.** Open `/hotels` → type the place into the textbox → wait for `GET /hotels-autocompleter/api/v2/results` →
take the first `C`, `S` or `H` suggestion (or ask which one when the top two are close) → build the results URL.
The suggestions call answered 150 ms after it went out.

## Hotel details

**What it does.** One stay in full: its rooms and how many each sleeps, room amenities, meal and cancellation rules
per room option, all facilities, photos, reviews and house rules. A group cares because "sleeps 12" and "non-refundable"
decide a villa. Group value: high.

**Entry.** The card's link, which the search call also gives (`hotelId`, the hotel's own `locationId`,
`hotelInfoToken`):

```
https://www.ixigo.com/hotels/{hotelId}/details?locationId={hotel locationId}&locationName={search name}&locationType={S|C}&masterLocationId={id}&countryId=1&checkinDate={DDMMYYYY}&checkoutDate={DDMMYYYY}&adultCount={n}&roomCount={n}&childCount={n}&searchLocationId={search locationId}&hotelInfoToken={URL-encoded}&hName={name}
```

This shape, without the card's tracking parameters (`cp`, `searchId`, `usid`), loaded the full page.

**Data calls**, all `POST`, all answered by 1.3 s:

| Call | What it holds |
|---|---|
| `/accommodation-search/api/v1/accommodations/details` (1.1 s) | `data.hotelDetailResponse`: `address`, `locationDetail` (lat, lon), `aboutSection.data`, `amenityDetails.amenities[]` (`name`, `categoryName`; 37 here), `houseRulesAndPolicies` (`checkinTime`, `checkoutTime`, `rules[].heading` and `.subRules[].details[]`), `newImageInfo.imageList[]`, `ratingView.ratingCount`, `persona` (`GROUP` for 4 adults), `fareDetail` |
| `/accommodation-search/api/v1/accommodations/details/{hotelId}/rooms` (1.3 s) | `data.rooms[]`: `name` (`Villa`), `properties[]` (`{"code":"OCCUPANCY","data":"Sleeps 12"}`, `{"code":"VIEW","data":"Pool view"}`), `roomLevelAmenities[]`, and `roomOptions[]`: `name`, `mealBenefits`, `cancellationBenefits` (`code` such as `NON_REFUNDABLE`, with each `policy[]` window's dates and amount), `paymentType`, `fomoTag`, `fareDetail` |
| `/accommodation-search/api/v1/accommodations/reviews/aiReviews/{hotelId}` (1.3 s), body `{"pageNumber":0,"pageSize":10,"sortBy":"MOST_RECENT","category":"All Reviews",...}` | `data.reviewList[]`: `reviewComment`, `avgRating`, `reviewDate`; `moreResultsAvailable` |
| `/accommodation-search/api/v1/accommodations/recommendation/similar/{hotelId}` | similar stays nearby |

**Logged in or not:** no. **Money:** no; "Book Now" and a room's select start a booking (never).

**How a group asks** (slot: which hotel, by name or by its number in the last list): "Sobreda villa mein kitne log so
sakte hain?", "is it refundable?", "breakfast included hai?", "reviews kaise hain uske?", "pool private hai ya shared?",
"check-in kitne baje?".

**Recipe.** Build the details URL from the search's fields → open it → wait for the `.../details` and `.../rooms`
calls (and `aiReviews` when asked) → return sleeps, room name, meal, cancellation code and window, price, check-in
and check-out, and the facilities that were asked about. About 1.3 s.

## Paging

**What it does.** More stays. There is no "Load more" button: the results page asks for the next 10 as you scroll.

**Data call.** The same search call with `"pageNumber": 2`, `"receivedResults": 10` and the last page's hotel ids in
`lastViewedHotelIDs`. Six pages came back, 10 each, in 0.2 to 0.6 s each after the scroll. The web map saw 3 and 4 a
page; this time every page held 10.

**Recipe.** Scroll the page (`window.scrollBy`) and wait for the next search call. For a group, the first page or two
after a good filter and sort is usually enough.

## Offers and coupons

**What it does.** Bank card offers and coupon codes, per product. A group cares about the code and the bank before
someone pays. Group value: high.

**Entry.** `https://www.ixigo.com/offers` (all), `https://www.ixigo.com/offers/tag/hotels`, `/offers/tag/trains`;
one offer is `https://www.ixigo.com/offers/{slug}`. The hotel results page also shows the hotel offers as buttons (for
example "Flat 15% Off up to ₹1,500 on Domestic Hotels with AU Bank Credit Cards"), and each hotel card already includes
a coupon (`fareDetail.couponCode`).

**Data call.** `GET /upahaar-inventory/api/offers/v2/list?page={n}&limit=9`. The first page is in the page itself; pages
2 onward come as you scroll (50 to 150 ms each). Under `data.offers[]`:

| Field | Example |
|---|---|
| `offerTitle` | `Get up to 50% Off on your first Hotel booking` |
| `product` | `HOTELS` |
| `offerCode` | `IXIFIRST` |
| `paymentType` | `ICICI Bank` (null when any payment works) |
| `startDate`, `endDate` | ISO times; `endDate` null means open-ended |
| `journeyType` | `DOMESTIC`, `BOTH` |
| `slug` | `IXIFIRST-HOTEL` (the offer page) |

**Logged in or not:** no. **Money:** no.

**How a group asks** (slots: product, bank): "koi offer hai kya hotels pe?", "HDFC card pe discount milega?",
"coupon code batao", "first booking offer hai?", "Axis card se EMI pe kuch?".

**Recipe.** Open `/offers/tag/hotels` → read the offer cards (links named "Expiry: ... {title} HOTELS ...") or scroll
for the list call → return title, code, bank and expiry. For a hotel already found, quote its own
`fareDetail.offerMessage`.

## Group booking

**What it does.** A form for group flight bookings ("Discount for Group Bookings, All Airlines Supported"); a person
from ixigo calls back within an hour. Group value: high for a big group flying together.

**Entry.** The home page's "Group Booking" (`https://rocket.ixigo.com/group/index.html?p=app_search_form`, which
redirects to `https://www.ixigo.com/support/group?p=app_search_form`). Controls: buttons "One Way", "Round Trip";
textboxes "Enter origin", "Enter destination", "Departure"; a spinbutton (travellers); textbox "Enter email"; button
"Select country code"; textbox "Enter phone number"; a notes box; button "Submit".

**Data call.** None before submitting. **Logged in or not:** no. **Money:** the form is free; the booking it leads to
is not.

**Never submit it.** It sends a person's email and phone number to ixigo's sales team. Go hands the link to the group
and says what to fill in.

**How a group asks** (slots: from, to, date, how many): "hum 12 log hain, group booking ho sakti hai?", "group discount
milega flights pe?", "poori gang ke liye ek saath ticket", "bulk booking for 15 people Delhi to Goa", "group fare kaise
milta hai?".

**Recipe.** Entry only: reply with the link and the fields it asks for.

## Wishlists

**What it does.** The hotels home page promises "Collaborative wishlists: Plan your dream vacation together". Each hotel
card has "Add to wishlist". Group value: high (a shared shortlist), but it lives behind a login.

**Entry.** Button "Add to wishlist" on a card (needs login, never pressed). The metadata call carries
`userWishlistSummary` (`lastWishlistId`, `lastWishlistName`, both null when logged out). **Needs login.** **Money:** no.

**How a group asks:** "isko shortlist mein daal do", "sab ek list banate hain hotels ki", "wishlist share karo", "jo
pasand aaye save kar lo".

**Recipe.** None: Go keeps the group's shortlist itself (its own vote and options cards).

## Destination planner: things to do

**What it does.** One page per place: what it's popular for, weather by month, best time to visit, trip ideas, places
to visit with ratings, places to eat, and FAQs. Group value: med ("what is there to do in Goa?").

**Entry.** `https://www.ixigo.com/plan/{slug}`, for example `https://www.ixigo.com/plan/goa` ("Explore Goa, India -
Things To Do, Best time to Visit, How to Reach and more"). The home page links 20 of these (Udaipur, Goa, Leh Ladakh,
Rishikesh, Pondicherry...).

**Data call.** None: the content is in the page. Read it from the accessibility tree:

- tablist: "Overview" (selected), "Places to Stay", "Things to do", "How to Reach", "More" (the other tabs were not
  opened)
- heading "Goa is popular for", then plain text items ("Pristine Shores", "Vibrant Parties", "Goan Seafood", ...)
- heading "Weather in Goa"; button "Best time to visit November - March"
- heading "Ideas To Plan Your Trip", then level-3 headings ("Water Sports Extravaganza", "Heritage Village Exploration")
- heading "Places To Visit": category buttons ("beach", "nature", "scenic", "market", "historical", "religious",
  "museum"), then each place as a level-3 heading with a rating button ("4.5" Baga Beach, "4.6" Dudhsagar Falls,
  "4.0" Anjuna Flea Market, ...)
- heading "Places To Eat"; heading "Frequently Asked Questions About Goa Tourism"

**Logged in or not:** no. **Money:** no.

**How a group asks** (slot: place): "Goa mein kya kya karein?", "best time to go Goa?", "Anjuna flea market kab lagta
hai?", "beaches ke alawa kya hai?", "khaane ke liye acchi jagah batao North Goa".

**Recipe.** Open `/plan/{slug}` → wait for page ready (1.9 s) → read headings and the text under them → return the
best time, the top places (name and rating) and two or three ideas.

## Trip planner explorer

**What it does.** "Where should we go?": pick where from and the month, then filter by Domestic, International,
Visa-free, budget, travel time, weather ("No Rain", "Pollution Free", "Warmer") and interests ("Beaches", "Nightlife",
"Mountains", "Offbeat"). Each place card shows a travel cost and a stay price per night ("Denpasar Bali • Indonesia ₹26K
₹4,900/night"). Group value: med, before the place is decided.

**Entry.** `https://www.ixigo.com/plan`. Controls: text "From {city} Travel month {month} Search"; buttons
"International", "Domestic", "Visa-free", "Rain", "No Rain", "Snow", "Pollution Free", "Colder", "Warmer"; sliders
"Minimum" and "Maximum" for budget and travel time; button "Create trip with AI" (not pressed). Cards link to
`/plan/{slug}?origin={city}`. The "From" city is guessed from the visitor's network location.

**Data call.** `GET /itinerary-planner/api/itinerary/getTopLocations?country=IN` (top places: `slug`, `displayname`).
The cards on the first view are in the page; the filter buttons were not pressed, so the filtered list's call is not
mapped.

**Logged in or not:** browsing no; "Create trip with AI" not tried. **Money:** no.

**How a group asks** (slots: from, month, budget, kind of trip): "December mein kahan jaayein?", "Delhi se 2 din ka
trip, beach wala", "visa-free international trip under 50k", "monsoon mein kahan jaayein jahan baarish na ho",
"pahadon mein offbeat jagah batao".

**Recipe.** Open `/plan` → read the place cards (name, region, trip cost, stay per night) → for one place, open its
`/plan/{slug}`. Filtering by budget or weather needs the page's controls, which were not tried.

## Airport cabs

**What it does.** Cabs to or from an airport, booked ahead ("Free cancellation is available up to 30 minutes before
pickup; charges apply after that"). Group value: med (getting six people from Mopa to the villa).

**Entry.** `https://www.ixigo.com/cabs`. Controls: radiogroup "Cab type" with radios "To Airport" and "From Airport";
buttons "Pickup Location", "Airport Location" ("Drop-off Location" when from the airport), "Pickup Date & Time",
"Book a Cab".

**Data call.** `POST /cabs/api/v1/autocomplete` for both boxes. With "Goa" it returned `data.suggestions[]`:
`id` `GOX:T1` (Mopa) and `GOI:T1` (Dabolim), `code`, `terminalId`, `formattedAddress`, `lat`, `lng`, `type: "airport"`.
Opening the airport box first lists nearby airports by the visitor's location.

Choosing the airport worked; the drop-off button then ignored clicks (something sat over it), so the cab list and its
prices were not reached. Only two loads were spent here.

**Logged in or not:** not reached. **Money:** yes, the ride; stop at the list.

**How a group asks** (slots: airport, drop-off or pickup place, date and time, how many people): "airport se villa tak
cab chahiye", "Mopa se Anjuna taxi kitne ki?", "6 log hain, badi gaadi chahiye airport pe", "flight 5 baje land
karegi, cab book kar do", "Dabolim drop kal subah 6 baje".

**Recipe.** Not ready: the place lookup is mapped, the list isn't.

## Assured and insurance

**What it does.** Assured is a paid add-on at flight booking: cancel and get a full refund, no questions, instant.
Its claim windows, as the page's own call gives them: domestic flights booked 10 to 26 hours ahead have an 8-hour
window, 26 hours to 121 days ahead a 24-hour window; international flights booked 3 to 120 days ahead a 2-day window
(the page's table explains which end of the trip the window counts from; it wasn't read here). The home page also shows "Travel Stress-Free with
Travel Insurance" and links "Assured Flex Flight" and visa rejection protection (`/vas/visa-rejection-protection`).
These are choices inside a booking, not things to buy on their own. Group value: med ("what if someone drops out?").

**Entry.** `https://www.ixigo.com/ixigo-assured` (rules), `https://www.ixigo.com/assured-flex-flight`. The choice itself
is made while booking (never).

**Data call.** `GET /api/v1/free-cancellation/claimWindows` (0.66 s): `data[]` with `bookingApdText` ("26 hours - 121
days"), `claimWindowText` ("24 hours"), `isInternational`.

**Logged in or not:** no for the rules. **Money:** yes, at booking.

**How a group asks:** "agar koi cancel kare toh paisa wapas milega?", "free cancellation wala option hai flights mein?",
"insurance lena chahiye kya?", "refund kitne time mein aata hai?", "Assured kya hota hai?".

**Recipe.** Open `/ixigo-assured` → wait for `claimWindows` → answer with the window that fits the trip's dates.

## ixigo money

**What it does.** ixigo's wallet: money that can pay for bookings, plus "Hotel Cash" earned on hotel stays. Group value:
low (it's one person's balance).

**Entry.** Needs login. The help centre's link for the web is `/account/ixigomoney`. Logged out, the hotel calls show
only what a booking would earn and burn: `fareDetail.earnInfo` ("You'll earn ₹1000 Hotel Cash on this booking",
credited within 24 hours of check-out) and `fareDetail.burnMoneyInfo` ("Redeem your entire ixigo money balance (upto
100% of the hotel fare)").

**Money:** it is money; never spend it. **How a group asks:** "mere ixigo money mein kitna hai?", "hotel cash use ho
sakta hai?", "wallet se pay karein?", "cashback kab aayega?", "ixigo money kya hai?".

**Recipe.** Entry only: tell the person to check it in the app, and quote the earn line from a hotel when asked.

## Customer support

**What it does.** FAQs, contact options, and help with a booking (cancel, refund status). Group value: low until a
booking goes wrong.

**Entry.** `https://www.ixigo.com/help-center` redirects to `https://www.ixigo.com/support`. Quick guide topics: Account
Settings, ixigo money, Pre-booking Queries, ixigo money max ("Seamless instant refunds"), ixigo assured, ixigo AU Credit
Card, Manage Payment Methods, Metro Ticket Booking, Holiday Packages. Each topic page is
`https://www.ixigo.com/support/services/{slug}` (for example `ixigo-assured`). "Need help with your recent booking?"
with button "Log in Now": a booking's cancel and refund status **needs login**.

**Data calls.** `GET /support/helpcenter/api/v1/service` (the topics), `GET /support/helpcenter/api/v1/questions/general?tags=about-ixigo`
(FAQ list), `GET /support/helpcenter/api/v1/downtime?ongoing=true` (outages).

**Money:** no. **How a group asks:** "refund kab aayega?", "booking cancel kaise karein?", "ixigo customer care number?",
"payment cut gaya par booking nahi hui", "ixigo down hai kya?".

**Recipe.** Entry only for bookings. For general questions, open `/support` and read the topic list; for "is it down",
wait for the `downtime` call.

## Visa

**What it does.** "Book Visa" goes to a partner, Visa2Fly, white-labelled for ixigo. Group value: low for Goa, med for a
trip abroad.

**Entry.** `https://ixigo.visa2fly.com/`: textbox "Search Destination", button "Explore", country cards ("UAE",
"Vietnam", "Thailand"...). ixigo's own guides are at `https://www.ixigo.com/visa-for-indians` (not loaded).

**Data calls** (on the partner's API): `GET https://api.visa2fly.com/api/fetch/country/list` (country names) and
`GET https://api.visa2fly.com/api/fetch/specific/country/category/detail/V3` (trending countries with `basePrice`,
`feeAndGst`, `processingTime`).

**Logged in or not:** no to browse; applying needs an account and documents (never). **Money:** yes.

**How a group asks:** "Thailand ke liye visa chahiye kya?", "Dubai visa kitne din mein milta hai?", "visa ka kharcha
kitna?", "visa on arrival wali jagah batao", "Vietnam e-visa kaise?".

**Recipe.** Open `ixigo.visa2fly.com` → wait for the category call → return the country's price and processing time.

## Travel stories

**What it does.** ixigo's travel blog: lists, guides and booking tips ("15 best places to visit in October in India").
Group value: low.

**Entry.** `https://www.ixigo.com/travel-stories`; one story is `https://www.ixigo.com/travel-stories/{slug}-story-{id}`.
No data call: the list is in the page (level-2 headings, one per story). **Login:** no. **Money:** no.

**How a group asks:** "October mein kahan ghoomein?", "flight kab book karna sasta padta hai?", "Bali ya Vietnam?",
"baggage rules kya hain?", "trip ke liye packing list".

**Recipe.** Open `/travel-stories` → read the headings → open the one that matches.

## Holiday packages

The help centre lists "Holiday Packages" as a topic, but the web has no page for them: `https://www.ixigo.com/holidays`
is "Oops! You seem to have reached the wrong destination", and nothing on the home page links to packages. Treat them
as not on the website.

## The rest

| Corner | Entry | Login | Money | Group value |
|---|---|---|---|---|
| ixigo AU travel credit card | `https://www.ixigo.com/travel-credit-card` | applying, yes | a card | low |
| Metro tickets | `https://www.ixigo.com/metro/delhi`, `/metro/mumbai` (and route maps) | to buy | yes | low |
| Fare alerts | `https://www.ixigo.com/account/farealerts/` | yes | no | belongs with flights |
| Flight tracker | `https://www.ixigo.com/flight-status` | no | no | belongs with flights |
| The app | Play Store `com.ixigo`, App Store `id418128294`; the home page and help centre point there for wallet pages and some flows | | | |

## Bot protection

Same as the web map: no challenge page, no captcha to solve, no 403 and no 429 in 21 loads. Almost every page loads
Google reCAPTCHA in the background (the request headers weren't recorded, so whether a call carried a token isn't
known). The group booking page made one Cloudflare challenge-platform request in the background that answered 401; the
page itself loaded normally. One page call (`plan-cf.ixigo.com/hit`) reports the visitor's network location and a bot
score back to the page; it blocked nothing, and it is how the planner guesses the "From" city. Other errors were the
A/B test call the web map saw (400) and one hotel widget (424), neither of which affects results.
