-- What Go noticed on its own, held until the bar lets it act, and how chatty Go has been per trip.
create table proactive_candidates (
  trip_id text not null,
  dedupe_key text not null,
  source text not null check (source in ('timer', 'watch', 'opening')),
  topic text not null,
  due_at timestamptz not null,
  expires_at timestamptz,
  importance double precision not null check (importance between 0 and 1),
  confidence double precision not null check (confidence between 0 and 1),
  urgency double precision not null check (urgency between 0 and 1),
  useful text[] not null,
  person_ids text[] not null default '{}',
  facts jsonb not null default '{}',
  simulated boolean not null default false,
  small boolean not null default false,
  -- Only the stage's fire with force: true sets it (Task 8).
  forced boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'promoted', 'dropped')),
  reason text,
  allowed text[],
  for_person_ids text[],
  counted boolean not null default false,
  decided_at timestamptz,
  local_day text,
  ignore_checked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (trip_id, dedupe_key)
);
create index proactive_candidates_due on proactive_candidates (due_at) where status = 'pending';
create index proactive_candidates_counted on proactive_candidates (trip_id, local_day) where counted;

create table proactive_trips (
  trip_id text primary key,
  hush_count integer not null default 0,
  last_hush_at timestamptz,
  ignored_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table proactive_notices (
  trip_id text not null,
  card_id text not null,
  -- Null while the card rides with the turn's message (P1 posts it); kept for the record only.
  message_id text,
  card jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, card_id)
);
