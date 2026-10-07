-- Lane C: the places ixigo's own search forms resolved, by kind of search and the words people used. A cache of
-- ixigo's public codes, the same for every trip: loaded at boot, so the next search for the same words goes straight
-- to its results page. page_url is the results page the place was read from.

create table travel_places (
  kind text not null check (kind in ('flights', 'trains', 'buses', 'stays')),
  words text not null,
  place jsonb not null,
  page_url text not null,
  learned_at timestamptz not null default now(),
  primary key (kind, words)
);
