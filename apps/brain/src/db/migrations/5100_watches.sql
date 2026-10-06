-- Cheap scheduled checks through P4's Travel.status, for things a trip has booked: a flight by its number,
-- a train ticket by its PNR. `query` is the StatusQuery sent as it is; `last_reading` is the last StatusResult.
create table watches (
  watch_id text primary key,
  trip_id text not null,
  kind text not null check (kind in ('flight', 'pnr')),
  query jsonb not null,
  person_ids text[] not null default '{}',
  label text not null,
  last_reading jsonb,
  last_change_key text,
  next_check_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  errors integer not null default 0,
  last_error text,
  notice_card_id text,
  created_at timestamptz not null default now()
);
create index watches_due on watches (next_check_at) where active;
create index watches_trip on watches (trip_id);
