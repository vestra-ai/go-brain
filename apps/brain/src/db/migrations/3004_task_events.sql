-- Lane C (P4): the /v1 events Go has applied (webhooks and the events poll dedupe on the evt_ id), where the events
-- poll is up to, and each conversation stream's resume point.

create table v1_events_seen (
  evt_id text primary key,
  type text not null,
  received_at timestamptz not null
);

create table v1_cursor (
  name text primary key,
  evt_id text not null,
  updated_at timestamptz not null
);

create table task_streams (
  conversation_id text primary key,
  last_seq integer not null,
  updated_at timestamptz not null
);
