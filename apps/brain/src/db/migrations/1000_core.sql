-- Lane A: Go's core tables. Other lanes add their own tables in their own range and only ever
-- add columns to these, in their own migrations.

create table trips (
  trip_id text primary key,
  last_seq int not null default 0,            -- the highest change number written to trip_events
  processed_seq int not null default 0,       -- the highest change number whose processing finished
  composer_seen_seq int not null default 0,   -- the newest message number the composer has already seen
  tz text not null default 'Asia/Kolkata',
  active_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table trip_setup (
  trip_id text not null references trips (trip_id) on delete cascade,
  step text not null,
  done_at timestamptz,
  error text,
  tried_at timestamptz not null default now(),
  primary key (trip_id, step)
);

create table trip_events (
  event_id text primary key,
  trip_id text not null,
  seq int not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create index trip_events_by_trip on trip_events (trip_id, seq);

create table messages (
  trip_id text not null,
  message_id text not null,
  seq int not null,
  updated_seq int not null,
  person_id text,                             -- null for Go's and the system's messages
  text text,                                  -- null when deleted or withheld
  reply_to text,
  deleted_at timestamptz,
  payload jsonb not null,                     -- the Message as the Server sent it
  primary key (trip_id, message_id)
);
create index messages_by_seq on messages (trip_id, seq);

create table go_requests (
  request_id text primary key,
  rpc_id text not null,
  trip_id text not null,
  turn_id text,                               -- set for writes made inside a composer turn
  method text not null,
  params jsonb not null,
  result jsonb,
  error jsonb,
  attempts int not null default 0,
  sent_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create index go_requests_open on go_requests (created_at) where answered_at is null;
create index go_requests_by_turn on go_requests (turn_id) where turn_id is not null;

create table desk_items (
  id text primary key,
  trip_id text not null,
  kind text not null,
  ref text not null,
  due_at timestamptz not null,
  payload jsonb not null default '{}',
  turn_id text,                               -- set when a turn takes the item; a crashed turn's items keep it
  attempts int not null default 0,
  done_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index desk_due on desk_items (due_at) where done_at is null;
create index desk_by_trip on desk_items (trip_id, due_at) where done_at is null;

create table trip_leases (
  trip_id text primary key,
  holder text not null,
  until timestamptz not null
);

create table turns (
  turn_id text primary key,
  trip_id text not null,
  woke_for text[] not null,                   -- the desk item kinds, e.g. {message,message}
  attempt int not null default 1,
  started_at timestamptz not null,
  typing_at timestamptz,
  first_token_at timestamptz,
  posted_at timestamptz,
  ended_at timestamptz,
  model text not null,
  rounds int not null default 0,
  input_tokens int not null default 0,        -- input not read from or written to the cache
  cached_tokens int not null default 0,       -- input read from the cache
  cache_write_tokens int not null default 0,  -- input written to the cache
  output_tokens int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  outcome text,                               -- spoke | acted | silent | failed
  error text
);
create index turns_by_trip on turns (trip_id, started_at);

create table seen_signatures (
  v1 text primary key,                          -- the HMAC: it already binds t and the target, so it alone names a signature
  t bigint not null,
  seen_at timestamptz not null default now()
);

create table switches (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Go's own room cards (options, working, call, pay, notice, vote...). Never payment card details.
create table cards (
  trip_id text not null,
  card_id text not null,
  kind text not null,
  message_id text,
  card jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (trip_id, card_id)
);

create table card_taps (
  tap_id text primary key,
  trip_id text not null,
  card_id text not null,
  action_id text not null,
  person_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
