# ixigo recipes: Go searches ixigo.com in the trip's browser

Design for Friday. Nothing here is built yet.

"@Go flights Delhi to Goa Friday" should get "Go is typing..." at once and an options card from ixigo.com in under 5 seconds. Each option opens on ixigo.com; booking stays there.

Go does it with recipes: data that says, for each kind of search, which ixigo.com page to open, which of the page's own data calls to read, and how to turn that data into Go's options. A runner opens the page in the trip's own browser and brings the data back.

This page builds on [recipes/ixigo-web-map.md](../../recipes/ixigo-web-map.md): URLs, data calls, fields and timings. Three more maps are on the way:
- `ixigo-flights.md`, from p1-b;
- `ixigo-trains-buses.md`, from p4;
- `ixigo-hotels-and-more.md`, from p1-a.

When each lands, its recipe takes the exact fields from it. The shapes below don't change.

## 1. Recipes are data

A recipe is a typed object, one per kind of search, in `apps/brain/src/travel/recipes/`. Each has its own file, and a shared `places.ts` holds the lookup tables.

```ts
interface Recipe<S> {
  id: 'ixigo.flights' | 'ixigo.stays' | 'ixigo.trains' | 'ixigo.buses';
  kind: TravelKind;                      // flights | stays | trains | buses
  slots: z.ZodType<S>;                    // what the URL needs, already resolved to ixigo's codes
  slotsFrom(q: TravelQuery, trip: { people: number }): S;   // throws TravelError('unknown_place') when a place has no code
  url(s: S): string;
  capture: Array<{ match: string; required: boolean; max_bytes?: number }>;
  steps?: Step[];                         // page controls, only when the URL can't do it (none for Friday's four)
  extract(captures: Capture[], s: S): TravelOption[];   // pure; tested on fixtures
  agentExtractor: string;                 // the fallback runner's in-page script (section 2)
  ttlMs: number;                          // how long a result is reused (section 4c)
}
```

Go's constraints stay in code, as today. These are times, price caps, non-stop, pool and rating: the travel layer applies them to the extracted options (`applyConstraints`). So a recipe fetches the whole list once, and "after 6 pm" or "under 8k" never needs a second page load.

| Recipe | Slots | URL | Capture (path match) | Price and what it covers | Area or route | Deep link | TTL |
|---|---|---|---|---|---|---|---|
| ixigo.flights | from, to (IATA), date, adults | `/search/result/flight?from=…&to=…&date=DDMMYYYY&adults=…&children=0&infants=0&class=e` | `/flights/v2/search/stream` (one event, all fares, ~290 KB) | `fares[0].fareDetails.displayFare`, per person (the map thinks so; the page doesn't say: confirm before Friday) | origin to destination, stops, times from `flightDetails[0]` | none per flight: the results URL, with the flight named by `flightKeys` | 10 min |
| ixigo.stays | location (Goa: 32 / 48569 / S), check-in, check-out, adults, rooms | `/hotels/search/result?locationId=…&checkinDate=…&checkoutDate=…&adultCount=…&roomCount=…` | `/accommodation-search/api/v3/accommodations/search` (paged: 3, then 4) | `displayedBaseFare + taxesAndFees`, per night, per room | `locality` as the option's own area (#104) | `/hotels/{hotelId}/details?…&hotelInfoToken=…` | 10 min |
| ixigo.trains | from, to (station codes), date | `/search/result/train/{FROM}/{TO}/{DDMMYYYY}//1/0/0/0/ALL` | `/trains/v1/search/between/` and `/api/v3/trains/availability` | `fares.{class}.baseFare` per class, with the availability (`WL 11`, `RAC 70`, `Regret`) | the boarding station the train reports | `/trains/{number}?orgn=…&dstn=…&departDate=…&quota=GN` | 10 min |
| ixigo.buses | from, to (name and AbhiBus id), date | `/buses/bus_search/{From}/{fromId}/{To}/{toId}/{DD-MM-YYYY}/O` | `/buslist/v3/services` (all buses, ~170 KB) | `fares.fare`, from price per seat | operator, bus type, seats left | none: the results URL | 10 min |

Places resolve through small tables in `places.ts`, covering this week's trips:
- airports: Delhi DEL; Goa GOI and GOX; Mumbai BOM; Bengaluru BLR;
- stations: NDLS, NZM, MAO, CSMT and others;
- bus city ids: Mumbai 4, Goa 102;
- the Goa hotel location, with the area tags as data for the summary.

A place missing from the tables is refused with a plain message ("Go can search ixigo for these places: ..."), never guessed. Live lookups (ixigo's place and city search) come later.

Stays need two captures, pages 1 and 2, because page 1 holds only 3 hotels. That needs a Bash change (section 8). Until then the stays recipe takes page 1 alone and says so in its summary.

## 2. Runners: one interface, two ways to run it

```ts
interface RecipeRunner {
  name: 'browser_fetch' | 'agent_job';
  run<S>(tripId: string, recipe: Recipe<S>, slots: S, o: { signal: AbortSignal }): Promise<{ options: TravelOption[]; checkedAt: string; ms: number }>;
}
```

**BrowserFetchRunner.** This is Bash's model-free call:

```
POST /v1/users/{v1UserIdFor(tripId)}/browser/fetch
{ url: recipe.url(slots), capture: recipe.capture, steps: recipe.steps, timeout_ms: 8000 }
```

It answers with the captures. Then `recipe.extract(captures, slots)` returns the options. About 3.5 s warm. Its errors:

| Bash says | Go does |
|---|---|
| `403 domain_not_allowed` | `TravelError('blocked')`. That is a setup fault, so Go says it in the admin log, not the room. |
| `409 browser_in_use` | Waits its turn. Go keeps one queue per trip box, so two searches in one reply run back to back (section 8 asks for tabs). |
| `504 timeout` with partial captures | Uses them when every required capture is there; otherwise `TravelError('timeout')`. |
| `503 box_unavailable` | `TravelError('unavailable')`. The search tool already turns that into a plain line. |

**AgentJobRunner**, the fallback until Bash ships, is a /v1 job on the trip's computer:
- It runs on a deployment pinned to a fast model (`go-recipe`, created by `setup-v1.ts` like `go-trip-task`), so a recipe never runs on the trip job's model.
- Go sends one message with an `output_schema` (an array of options). Its instructions: call `computer_navigate(url)`, then `computer_eval(recipe.agentExtractor)`, and return what the script returns, unchanged.
- The script reads the rendered results from the page, keeps the fields the summary needs and caps the list at 15, staying under 8 KB.
- Go waits for the job to finish (`GET /v1/tasks/{id}` every 500 ms, up to 25 s) and checks the output against the schema. It takes about 12 to 18 s.
- The script reads the page because a finished response body can't be read back from inside the page later, and the map says never to replay the page's calls.

**One setting switches them.** That's an admin switch `TRAVEL_RUNNER` (`agent_job` | `browser_fetch`), read on every search like `TRAVEL_MODE`. It defaults to `agent_job` until Bash's call is live on staging.

## 3. The travel layer

- `TRAVEL_MODE` gains `ixigo_web`, in the env enum, the switch's allowed values and the admin page. The four search tools (`search_flights`, `search_stays`, `search_trains`, `search_buses`) keep their names and arguments.
- `IxigoWebBackend implements TravelBackend`:
  - its `search` picks the recipe for the kind, fills the slots and calls the runner;
  - `TravelBackend.search` gains an optional third argument, `{ tripId }`, because a recipe runs in that trip's browser. The layer already has the trip id and passes it on.
- Results are saved in `travel_offers` as today, with:
  - `offer_id` null, so booking is link only, as #94 already treats it: no mandate for what Go can't book, and `hold()` refuses an option without an offer id;
  - `TravelOption.offerId` made optional for this backend;
  - `sourceUrl` holding the deep link.
- The options card gets one per-option action, "See on ixigo". A tap answers `ActionOpen` with the option's link, expiring with its TTL. No "Book" button.
- The tool's answer is #103's summary, unchanged. It's built from the options, their prices and areas, so it can't misstate a count, a price or an area. The price notes come from the recipe: "per person" for flights, "per night, per room" for hotels, "per seat, from" for buses, "per person, {class}" for trains.

## 4. Speed

**(a) Start on intake.**
- A travel message hook runs after the reflex on every person's message that names Go, or that Jev reads as for Go.
- A cheap parser, regexes and the place tables in English and Hinglish, looks for a kind and its slots. "flights Delhi to Goa Friday" gives flights, DEL, GOI, the next Friday, and the trip's head count as adults.
- When the slots are complete, the hook calls `travel.prefetch(kind, query, { tripId })` without waiting for it. The fetch starts about 0.2 s after the message lands.
- The search tool later calls `travel.search` with the same normalized query and gets the same in-flight promise.
- The parser's slots and the tool's arguments go through one function, `recipe.slotsFrom`, so they make the same key.
- A complete search ask also skips the 2 s wait for more lines. This needs a small change to P1's intake: a hook can answer `due: 'now'`. A follow-up line ("after 6 pm") still joins the turn through its arrived-meanwhile round, and the time filter is applied to the same captured list.

**(b) Warm the box when travel talk starts.**
- A sleeping box takes about 5.5 s to wake, and goes back to sleep about 7 s after a warm.
- Go warms it on the first line of travel talk: any travel word with a place or a date, to Go or not. It warms again every 5 s while travel talk goes on, for at most 2 minutes after the last such line, inside Go's warm limit (`WARM_LIMIT` 8 per org).
- Section 8 asks Bash for a warm with a duration instead.

**(c) Reuse results for 10 minutes**, keyed by recipe and normalized slots. The in-flight promise is shared, so two people asking the same thing at once cause one page load.

**(d) One model call per search ask.**
- When the turn was woken by a message the parser recognized, it waits up to 4 s for that search before building its prompt.
- The prompt then carries a right-now block: "Already searched for #57", with the `results_id`, the summary and the compact results.
- The model's first and only call is `show_options` plus its line. The card ends the turn (#86).
- If the search isn't back in 4 s, the turn goes on without it and the tool awaits it as usual: two calls, as today.

## 5. Tests, no live calls in CI

- **Fixtures:** one real response body per recipe, trimmed to the fields Go reads, under `travel/recipes/__fixtures__/`:
  - `flights-del-goi.json`;
  - `stays-goa-page1.json` and `stays-goa-page2.json`;
  - `trains-ndls-mao.json` (train list and availability);
  - `buses-mumbai-goa.json`.
  
  They're captured once by hand, through Bash's call when it's on staging, or by the mapper's browser run until then. The bodies hold no keys: the static web key and the page's ids are request headers, never in a body.
- **Per recipe:** `url()` for the map's examples; `extract()` on each fixture (count, title, price and note, times, area, deep link); one test that the fallback script's output passes the same schema.
- **Parser:** every phrasing in the 50-line test set's travel lines, Hinglish included. A place not in the tables gives no slots.
- **Runners:** BrowserFetchRunner against a fake /v1 (each error code, partial captures on 504, the per-trip queue on 409); AgentJobRunner against the jobs lane's fake /v1 (output that fails the schema, a job that doesn't finish).
- **Layer and turn:**
  - the prefetch and the tool share one fetch;
  - the 10-minute cache;
  - a recognized ask builds a prompt with the ready results;
  - the scripted model makes one call, `show_options`;
  - offer ids are null, and no mandate is set.

## 6. Where the time goes: "@Go flights Delhi to Goa Friday"

Warm box, Bash's call, `claude-sonnet-5-5`. Times are from the message reaching Go.

| Step | Start | Takes | Ready at |
|---|---|---|---|
| Typing on (names Go) | 0 ms | 5 ms | 0.01 s |
| Jev reads it (p50 95 to 160 ms on the live runs) | 0 | 150 ms | 0.15 s |
| Parser, prefetch started, the ask marked complete | 0.15 s | 5 ms | 0.16 s |
| Turn starts (no 2 s wait) | 0.16 s | 100 ms | 0.26 s |
| Bash's call: page loads, ixigo's stream answers (1.2 to 2.1 s on the map), body back | 0.16 s | about 3.5 s now; about 2.3 s if it returns on the capture (section 8) | 3.7 s; 2.5 s |
| Turn waits for it, then builds its prompt | 0.26 s | until the search is back, +20 ms | 3.7 s; 2.5 s |
| One model call: `show_options` and a one-line answer (first word about 1.1 s, a short answer) | 3.7 s; 2.5 s | about 1.6 s | 5.3 s; 4.1 s |
| Post with the card | | 5 ms | **5.3 s; 4.1 s** |

- **Warm box:** under 5 s only once Bash returns as soon as the capture matches. At today's "about 3.5 s warm" the reply lands near 5.3 s.
- **Sleeping box:** add about 5.5 s, which is why (b) matters.
- **Fallback runner:** 12 to 18 s for the job, so the reply lands at 14 to 20 s, with the working card showing meanwhile.
- **Without (a) and (d):** the 2 s wait plus two model calls add about 4 s to any of these.

## 7. Friday scope

**In:** the four recipes for one-way searches; the tables for this week's trips; the two runners and the switch; `ixigo_web`; the link-only card; (a), (c) and (d) as above; (b) with Go's keep-warm.

**Out:**
- round trips;
- booking on ixigo;
- hotel filters sent to ixigo (`filterCriteria`): pool and area are filtered in code on what came back;
- live place lookups;
- seat maps;
- anything behind a login.

## 8. What Bash's call should add

1. **Return as soon as every required capture has matched,** not at page idle. Flights answer at 1.2 to 2.1 s, so this is about 1 s per search, the difference between 5.3 s and 4.1 s above.
2. **Capture every response that matches, up to a count** (`max_count`), so stays get pages 1 and 2 in one call. Better still, a step that scrolls until N matches arrive.
3. **`max_bytes` of at least 512 KB** (flights ~290 KB, buses ~170 KB), or a server-side shrink (a list of JSON paths to keep) so less crosses the wire.
4. **Two tabs per box,** or a `retry_after_ms` on 409, so a reply that searches flights and stays doesn't wait on itself.
5. **A warm that lasts:** `POST /v1/users/{id}/warm { keep_ms }`, so Go doesn't ping every 5 s to hold a box up through a planning chat.
6. **Timings in the answer** (wake, navigation, capture), so the live bench can split a slow search into box, page and model.
7. **`www.ixigo.com` on the allow list** of every trip user Go makes, set through `PATCH /v1/users/{id}` or the deployment, so a new trip never meets `domain_not_allowed`.

## 9. Risks

- **Price per person for flights is unconfirmed:** the page doesn't label `displayFare`. Before Friday, one search for 1 adult and one for 4 settle it. Until then the summary says "per person, as ixigo shows it", never a group total.
- **Bot protection:** nine loads from one Mac met no challenge. A datacentre IP at volume is untested, so the cache and the shared in-flight promise also keep the load low.
- **Trains** wait about 2 s for ixigo's own reCAPTCHA token on every search, so a train search lands about 2 s after a flight search.
- **Hotel paging:** 3 hotels on page 1. Without item 2 above, a stays search shows few options.
- **The fallback's script reads the rendered page,** so a redesign of ixigo's cards breaks it before it breaks the capture recipes. Its schema check fails closed: no options, never wrong ones.
