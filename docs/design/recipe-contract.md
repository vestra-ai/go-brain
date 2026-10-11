# The recipe contract

What every ixigo recipe must do. A recipe is Go's knowledge of how a person uses ixigo.com (one YAML file in
`apps/brain/recipes/`, run by the engine in `apps/brain/src/travel/book/`). The site is the source of what is there; the
recipe only knows how to get to it. Each rule says what to do, why, and where it lives in the code. The design itself is
in [ixigo-recipes.md](ixigo-recipes.md).

## 1. Search the way a person does

Open ixigo's own pages through its own flow: the results page a person reaches, with the place, the dates and the
number of people a person would enter. Places come from ixigo's own search box (a lookup recipe, such as
`flights.airport_lookup`), and Go keeps what it resolved. A recipe never carries a list of cities, airports, stations,
hotels or areas.

## 2. Use the site's own filters, found at run time

What the site can filter and sort on is read from the site while the recipe runs: the filters and sorts its page lists
(a recipe's `offers`), kept per place. The model maps the group's ask onto them by the site's own names (`site_filters`,
`site_sort`). Nobody writes a list of filter codes by hand: a new ask that ixigo has a filter for ("pet friendly",
"beachfront") must work with no change to the recipe.

## 3. Never fail a search on a filter

A filter is a refinement, never a reason to come back empty-handed.

- A filtered page that catches nothing is read again without the filter, at once (`backend.ts`, `NothingCaughtError`).
- What the site can't filter, the model picks from the results (`wants`), using each option's own details.
- The answer says plainly what ixigo filtered, what Go picked, and what was left off ("ixigo's pool filter didn't load in
  time, so these aren't filtered for a pool": `answer.ts`, `leftOff`).

## 4. Honest, dated fallbacks

When ixigo won't give a page, say so honestly and give the group the next best thing. Never make something up.

- Never "no flights" when the page didn't answer: the group gets ixigo's own results page, set as they asked (the link
  card, `flights.search`).
- A kept answer says how old it is ("2 min ago", `tools.ts`, `ageText`), and a kept search lasts only its recipe's
  `ttl_minutes`.
- A page ixigo refuses under load is paced (`pace`: flights load one page every 20 s across all trips, and none for 10
  minutes after a refusal) and answers with its link meanwhile.
- Cloudflare's check is never ticked by Go and never solved by a service. Go reloads it, and otherwise the search fails
  honestly (planned in #313: the organizer may tick it on Go's screen).
- A search that outlives its turn still posts its card when it lands, and says if it failed. It is never dropped
  quietly.

## 5. Run where people can see it: the stage

A search a person is waiting on runs on the stage: one front tab of the person's browser that the room's live view
follows. Its steps happen there, page by page: open the results, close the popup, scroll for page 2, open a detail page.

- No hidden page calls for a watched run: it never takes the fast speed (`engine.ts`, `watched`).
- The card stays running through every step and ends with a picture of the results (or the detail page) as ixigo drew it.
- The page stays on the stage after the answer, until the next action takes it (`STAGE_MS`).
- Checks nobody waits on, lookups and warm-ups run behind the stage; so does a search while a login hand-off is open.
- A recipe's steps are written to look right on screen: the popup closed before the scrolls, a settle before the last
  picture.

## 6. Tolerant readers that say why a read failed

ixigo's pages change. A reader takes every reasonable shape the site sends, and when it still can't read, it says why.

- Read what is there: extra fields are ignored, missing ones skip that row, never the whole answer. A stream may come
  as one event or several, its value on one line or split over many (`bodies.ts`, `eventValues`); the rows of every
  part merge, each once.
- A capture is kept up to Bash's most (1 MB), so a long route is never cut short.
- When a page answered and its answer didn't read, the log says which check failed (`not_sent`, `status`, `truncated`
  or `shape`), each capture's status, size and cut, and for a shape what the reader found, in counts. Never a body
  (`engine.ts`, `read.ts`).
- Each recipe has a test that reads a real saved response, trimmed and with no person's details in it.

## 7. Logged-in aware

The person's browser is usually logged in to ixigo, one login for all their trips. A recipe must work there.

- Logged-in pages can differ: a header with the person's name, other prices, another stream shape. A recipe reads them
  as well as it reads a logged-out page, and its tests include a logged-in sample where one can be saved safely.
- Go never reads, logs or keeps the person's name, number, email or saved travellers. The stage shows ixigo's own
  header to the group, as ixigo draws it; nothing records it.
- A recipe that needs the login says so (`auth: login`), and Go asks the person once. A page that answers 401 or 403 for
  the login's calls means the login is gone: Go asks again, once.
- Nothing books, pays, locks or cancels without the group's yes. Payment pages are never opened (Bash's
  `browser.blocked_paths` and Go's `refusePayments`).

## Before a new recipe ships

1. A real saved response for its test, trimmed, with no person's details.
2. A test for each way it can fail: refused, empty, cut, a filter that catches nothing.
3. Its steps tried on the stage on a drill trip, watched in the live view: the popup closed, the scroll seen, the last
   picture the results.
4. Its `measured` timings filled in from that run.
