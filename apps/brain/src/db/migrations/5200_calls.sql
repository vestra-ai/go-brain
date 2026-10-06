-- Phone calls Go makes for a trip. Only Go's own lines are kept as the transcript; audio never is.
create table calls (
  call_id text primary key,
  trip_id text not null,
  business text not null,
  phone text not null,
  goal text not null,
  facts_allowed text[] not null default '{}',
  for_whom text not null,
  state text not null check (state in ('waiting', 'cancelled', 'dialing', 'talking', 'ended', 'failed')),
  asked_by_person_id text,
  asked_message_id text,
  announce_message_id text,
  announce_seq integer,
  card_id text not null,
  card_message_id text,
  dial_at timestamptz not null,
  media_token_hash text,
  media_token_used boolean not null default false,
  twilio_sid text,
  started_at timestamptz,
  ended_at timestamptz,
  outcome text,
  reported boolean not null default false,
  record jsonb,
  transcript jsonb not null default '[]',
  end_reason text,
  record_line_id text,
  closed_out_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, card_id)
);
create index calls_live on calls (trip_id) where state in ('waiting', 'dialing', 'talking');
create index calls_due on calls (dial_at) where state = 'waiting';
