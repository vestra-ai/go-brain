# ixigo recipes: Go searches ixigo.com in the trip's browser

Design for Friday. Built so far: the recipes (section 1), the runners (section 2), the travel layer with the "See on ixigo" card (section 3), and all of section 4: the early start, the warm, the 10-minute cache and the one-call prompt.

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
  slotsFrom(q: TravelQuery, trip: { people: number }): S;   // what the URL needs, in ixigo's codes; throws TravelError('unknown_place') when a place has no code
  url(s: S): string;
  capture: Array<{ match: string; required: boolean; max_bytes?: number }>;
  steps?: Step[];                         // page controls, only when the URL can't do it (none for Friday's four)
  extract(captures: Capture[], s: S): RecipeOption[];   // pure; tested on fixtures
  agentExtractor: string;                 // the fallback runner's in-page script (section 2)
  fromAgent(rows: unknown, s: S): RecipeOption[];         // that script's rows, checked with a schema
  ttlMs: number;                          // how long a result is reused (section 4c)
}
```

A `RecipeOption` is a `TravelOption` with no offer id (booking stays on ixigo) and a `sourceUrl`, the option's own page on ixigo.com.

Go's constraints stay in code, as today. These are times, price caps, non-stop, pool and rating: the travel layer applies them to the extracted options (`applyConstraints`). So a recipe fetches the whole list once, and "after 6 pm" or "under 8k" never needs a second page load.

| Recipe | Slots | URL | Capture (path match) | Price and what it covers | Area or route | Deep link | TTL |
|---|---|---|---|---|---|---|---|
| ixigo.flights | from, to (IATA), date, adults | `/search/result/flight?from=…&to=…&date=DDMMYYYY&adults=…&children=0&infants=0&class=e` | `/flights/v2/search/stream` (one event, all fares, ~290 KB) | `fares[0].fareDetails.displayFare`, per person, taxes in, before coupons (4 adults saw 7,896 for 6E 5341; ixigo's review page charged 4 × 7,896) | origin to destination, stops, times from `flightDetails[0]` | none per flight: the results URL, with the flight named by `flightKeys` | 10 min |
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
  run<S>(tripId: string, recipe: Recipe<S>, slots: S, o?: { signal?: AbortSignal }): Promise<{ options: RecipeOption[]; checkedAt: string; ms: number }>;
}
```

**BrowserFetchRunner.** This is Bash's model-free call:

```
POST /v1/users/{v1UserIdFor(tripId)}/browser/fetch
{ url: recipe.url(slots), capture: [{ match, max_bytes? }], steps: recipe.steps, timeout_ms: 8000 }
```

- It answers once every step is done and every capture has matched a finished response: `{ final_url, elapsed_ms, woke, captures: [{ match, url, status, content_type, body, truncated, at_ms }] }`.
- Then `recipe.extract(captures, slots)` returns the options. A warm search takes about 3.5 s.
- A capture's `match` is a part of the response URL. A match ending in `$` must end the URL's path. Stays and buses need that, because a longer URL on the same path answers first (`.../services/meta/105`, `.../search/static-metadata`). It has been asked of Bash (section 8).
- `required` stays in Go. Bash waits for every capture; Go uses it to decide what a timed-out fetch can still answer.

Its errors:

| Bash says | Go does |
|---|---|
| `404 user_not_found` | Makes the trip user (`computer.ensureUser`) and asks once more. |
| `409 browser_in_use` | A person used the browser in the last 4 s. Go waits 4 s and asks once more, then says so. Each fetch has its own background tab, so Go's own searches don't wait on each other. |
| `504 timeout`, with partial captures | Uses them when every required capture is there; otherwise `TravelError('unreachable')`. |
| `503 box_unavailable` | `TravelError('unreachable')`: the computer did not wake in time. |
| `402 wallet_empty` or `spend_cap_reached` | `TravelError('refused')`, with the jobs lane's words: the account is out of credit. |
| `403 domain_not_allowed`, `400 invalid_request` | `TravelError('refused')`. That is Go's own setup or request, so the details go in the admin log, not the room. |

The search tool already turns each of these into a plain line.

**AgentJobRunner**, the fallback until Bash ships, is a /v1 job on the trip's computer:
- It runs on a deployment pinned to a fast model (`go-recipe`, created by `setup-v1.ts` like `go-trip-task`), so a recipe never runs on the trip job's model.
- Go sends one message, straight to work (`hand_off: 'always'`), with an `output_schema` of rows. Its instructions: call `computer_navigate(url)`, then `computer_wait` for the recipe's `readyText`, then `computer_eval` with the recipe's script as its `expression` argument, and return what the script returns, unchanged.
- The script scrolls a few screens so the page draws more results, then reads the page text (`document.body.innerText`) and links with the recipe's reader. It keeps at most 15 rows, under 8 KB (what `computer_eval` answers).
- Go waits for the job (`GET /v1/tasks/{id}` once a second, up to 90 s), then `recipe.fromAgent` checks every row with a schema. Rows that don't check out give no options, never wrong ones. A job that isn't done in 90 s, or stops to ask something, is stopped through its own conversation (`POST /v1/conversations/{id}/stop`). On staging a job took 25 to 53 s, so it never answers inline: see "Waiting" below.
- If `computer_eval` is ever refused or held for a person's yes (Bash's approvals gate), the job calls `computer_snapshot` with `full` instead and returns its text as `snapshot`. Go reads the snapshot's text nodes (`snapshotText`) with the recipe's own reader (`readPage`), and checks the rows the same way. go-recipe keeps its default approvals: the money guard is never loosened for speed.
- The job's id is on Bash's line of the turn in `GET /v1/conversations/{id}/messages` (the list holds lines, matched by `turn_id`).
- The script reads the page because a finished response body can't be read back from inside the page later, and the map says never to replay the page's calls.
- The readers are tested on the page text saved by the mapping runs, cross-checked against the data calls for the same flights, hotels and buses.

**One setting switches them.** That's an admin switch `TRAVEL_RUNNER` (`agent_job` | `browser_fetch`), read on every search like `TRAVEL_MODE`. It defaults to `agent_job` until Bash's call is live on staging. A recipe whose list loads only in a drawn tab (`fetchable: false`: buses) always runs on the agent job.

**Waiting.** A search may hold up the turn for `TRAVEL_WAIT_MS` (12 s) from its start, and only through the browser fetch (a train search on a sleeping box took about 8 s); the search tools may take 14 s in the composer's loop. Past that, and always for the agent job, the tool answers that the search is running, and the live card covers the wait. When the run finishes, Go saves its options and wakes on a `search` desk item to show them (`travel/search-wake.ts`). Searches that shared a run wake Go once.

**The live card.** On a cache miss, the backend starts p1-b's live search card ("On it." with its steps), passes the run's `onProgress` to the runner, and marks the card done (`finish`) before the search answers, so it is done before the options card. A joined search shares the card.

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
- When the slots are complete, the hook calls `travel.search(kind, query, { tripId })` without waiting for it (`travel/recipes/early.ts`, the parser in `ask.ts`). The fetch starts about 0.2 s after the message lands. It runs only under `ixigo_web`.
- The search tool later calls `travel.search` with its own arguments and gets the same in-flight search.
- The parser's query and the tool's arguments go through one function, `recipe.slotsFrom`, so "Delhi" and "DEL" make the same key.
- A complete search ask also skips the 2 s wait for more lines: a hook can answer `{ dueNow: true }` (P1's `trips/hooks.ts` and `intake.ts`). A follow-up line ("after 6 pm") still joins the turn through its arrived-meanwhile round, and the time filter is applied to the same captured list.

**(b) Warm the box when travel talk starts.**
- A sleeping box takes about 5.5 s to wake, and goes back to sleep about 7 s after a warm.
- Go warms it on the first line of travel talk: any travel word with a place or a date, to Go or not (`travelTalk` in `ask.ts`). That one warm asks Bash to hold the box awake for 2 minutes once it is up (`keep_ms: 120000`, Bash #4574).
- A travel line that comes when the hold has under 20 s left extends it with one more warm (`tasks/keep-warm.ts`): about one call per 100 s per trip, inside /v1's rate. Each counts as one wake toward `WARM_LIMIT`; a hold is never skipped by Go's 60 s repeat check.

**(c) Reuse results for 10 minutes**, keyed by recipe and normalized slots, in the ixigo_web backend; the layer's own three-minute cache stays for the other backends. The in-flight promise is shared, so two people asking the same thing at once cause one page load. A failed search is not kept.

**(d) One model call per search ask.**
- When the turn was woken by a message the parser recognized, it waits for that search, as long as the search may hold up the turn (see "Waiting" in section 2), before building its prompt.
- The prompt then carries a right-now block, "travel search" (`travel/recipes/now.ts`): "Already searched for #57", with the `results_id`, the summary and the compact results, the same answer the search tool gives (`searchAnswer` in `tools.ts`). The results sit inside a data fence; what to do with them sits outside it.
- The model's first and only call is `show_options` plus its line. The card ends the turn (#86). When people gave a condition the early search did not read (a time, a price cap), the block says to call the search tool with it first; it answers at once from the same search.
- If the search isn't back in time, the block says it is still running, and the model calls the search tool, which joins it, answers at once and hands it over to wake Go when it finishes. A failed early search says nothing, and the composer searches again. The live card already said "On it.", so neither the block nor the wake line lets the model say it again.
- A turn that runs again for the same message shows the same `results_id`: the answer is built once per message.

## 5. Tests, no live calls in CI

- **Fixtures:** one real response body per recipe, trimmed to the fields Go reads, under `travel/recipes/__fixtures__/`:
  - `flights-del-goi.json`;
  - `stays-goa-page1.json` and `stays-goa-page2.json`;
  - `trains-ndls-mao.json` (train list and availability);
  - `buses-mumbai-goa.json`.
  
  They're captured once by hand, through Bash's call when it's on staging, or by the mapper's browser run until then. The bodies hold no keys: the static web key and the page's ids are request headers, never in a body.
- **Per recipe:** `url()` for the map's examples; `extract()` on each fixture (count, title, price and note, times, area, deep link); one test that the fallback script's output passes the same schema.
- **Parser:** every phrasing in the 50-line test set's travel lines, Hinglish included. A place not in the tables gives no slots.
- **Runners:** BrowserFetchRunner against a fake /v1 (each error code, partial captures on 504, one wait on 409); AgentJobRunner against a fake /v1 (rows that fail the schema, a job that doesn't finish, a job that stops to ask).
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
- **Fallback runner:** 25 to 53 s for the job on staging, so the options come on a later wake, with the live card showing meanwhile.
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

Bash's browser fetch has these already:
- it returns as soon as every capture has matched, not at page idle;
- `max_bytes` is 1 MB a capture by default, up to 4 MB, and 8 MB in all;
- each fetch gets its own background tab;
- the allow list comes from the trip user's default deployment. `setup-v1 --browser-fetch` adds `browser: { allowed_domains: ["ixigo.com"] }` to go-trip-task.

Still asked:
1. **A match that ends the path** (`$`), so stays and buses keep their search call, not the longer URL that answers first. Blocking for those two.
2. **`min_count` on a capture,** so stays get pages 1 and 2 in one call.
3. **A `type` step,** for p4's T17 train lookup by name. Not part of Friday's four searches.
4. **Timings in the answer** (wake, navigation, capture), so the live bench can split a slow search into box, page and model.

## 9. Risks

- **Bot protection:** nine loads from one Mac met no challenge. A datacentre IP at volume is untested, so the cache and the shared in-flight promise also keep the load low.
- **Trains** wait about 2 s for ixigo's own reCAPTCHA token on every search, so a train search lands about 2 s after a flight search.
- **Hotel paging:** 3 hotels on page 1. Without `min_count` (section 8), a stays search through the browser fetch shows few options.
- **The fallback's script reads the rendered page,** so a redesign of ixigo's cards breaks it before it breaks the capture recipes. Its schema check fails closed: no options, never wrong ones.
