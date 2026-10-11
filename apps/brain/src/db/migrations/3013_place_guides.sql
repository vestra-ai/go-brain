-- Places ixigo's place box can't settle on (Kerala, Ladakh: many of its entries fit the words), known by ixigo's guide for
-- the words alone: the guide's name for the place, its photos and its best months, for place_info only
-- (travel/place-info.ts). Kept apart from place_details, so a trip's destination never resolves to one: it has no id and
-- no map position.

create table place_guides (
  words text primary key,
  place jsonb not null,
  best_months int[] not null default '{}',
  learned_at timestamptz not null default now()
);
