-- Each person's own ticket pick (travel/picks.ts): a flight, train or bus they tapped "I'll take this" on, one per way
-- they travel (origin to destination). A later pick of the same way replaces it. It feeds their booking, and a flight's
-- lets the watches give them the heads-up when it runs late (watches/plan.ts).
create table if not exists picks (
  trip_id text not null,
  person_id text not null,
  kind text not null check (kind in ('flight', 'train', 'bus')),
  way text not null,
  option_id text not null,
  title text not null,
  journey jsonb,
  picked_at timestamptz not null,
  primary key (trip_id, person_id, kind, way)
);
create index if not exists picks_person on picks (person_id);
