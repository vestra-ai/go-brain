-- Watches the group asked Go to keep on ixigo ("tell us when 12608's waitlist confirms", "if a pool stay under ₹4k opens
-- up"): a recipe from the book, checked every so often until its flip comes true once, its date passes, or someone
-- stops it. inputs and conditions are the recipe's as the ask gave them; baseline is the first check's cheapest price
-- (for drops); flip_limit is the ask's number (rupees for under, a percent for drops).
create table recipe_watches (
  watch_id text primary key,
  trip_id text not null,
  recipe_id text not null,
  inputs jsonb not null,
  conditions text[] not null default '{}',
  flip text not null,
  flip_limit numeric,
  label text not null,
  asked_by text,
  baseline jsonb,
  every_min integer not null,
  next_check_at timestamptz not null,
  until timestamptz not null,
  active boolean not null default true,
  fired_at timestamptz,
  stopped text,
  errors integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index recipe_watches_due on recipe_watches (next_check_at) where active;
create index recipe_watches_trip on recipe_watches (trip_id) where active;
