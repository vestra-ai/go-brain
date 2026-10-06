-- Lane C (P4): Go's image cache, travel result sets, the options cards Go posted and the offers on them.

create table go_images (
  id text primary key,
  source_url text,
  mime text,
  bytes bytea,
  created_at timestamptz not null default now()
);

create table travel_results (
  results_id text primary key,
  trip_id text not null,
  option_kind text not null,
  source text not null check (source in ('search', 'task')),
  query jsonb not null default '{}'::jsonb,
  options jsonb not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index travel_results_trip on travel_results (trip_id, created_at desc);

create table options_cards (
  card_id text primary key,
  trip_id text not null,
  results_id text not null,
  title text not null,
  option_kind text not null,
  card jsonb not null,
  decision_id text,
  vote_key text,
  created_at timestamptz not null default now()
);

create table travel_offers (
  option_id text primary key,
  trip_id text not null,
  card_id text not null references options_cards (card_id),
  results_id text not null,
  n integer not null,
  offer_id text,
  kind text not null,
  title text not null,
  price_minor bigint,
  total_minor bigint,
  currency text,
  price_note text,
  option jsonb not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index travel_offers_card on travel_offers (card_id, n);
