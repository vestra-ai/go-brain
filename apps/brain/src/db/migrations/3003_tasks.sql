-- Lane C (P4): one row per job Go hands to the trip's computer, the asks a job raised, and the task starts /v1 announced.

create table tasks (
  id text primary key,
  trip_id text not null,
  title text not null,
  goal text not null,
  returns_kind text not null,
  returns jsonb not null,
  context jsonb not null default '{}'::jsonb,
  success_criteria text,
  asked_by text,
  state text not null check (state in ('queued', 'starting', 'running', 'needs_you', 'done', 'failed', 'stopped')),
  card_id text not null unique,
  message_id text,
  steps jsonb not null default '[]'::jsonb,
  screenshot_url text,
  needs_person_id text,
  conversation_id text,
  v1_turn_id text,
  v1_task_id text unique,
  deadline_at timestamptz,
  result jsonb,
  results_id text,
  error text,
  end_reason text,
  created_at timestamptz not null,
  started_at timestamptz,
  ended_at timestamptz,
  stop_requested_at timestamptz,
  todos_at timestamptz,
  cost_usd numeric
);
create index tasks_trip_state on tasks (trip_id, state);
create index tasks_conversation on tasks (conversation_id) where conversation_id is not null;
create index tasks_turn on tasks (v1_turn_id) where v1_turn_id is not null;

create table task_interactions (
  interaction_id text primary key,
  task_id text not null references tasks (id),
  trip_id text not null,
  type text not null,
  summary text,
  questions jsonb not null default '[]'::jsonb,
  for_person_ids text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'answered', 'cancelled', 'resolved', 'expired')),
  created_at timestamptz not null,
  settled_at timestamptz
);
create index task_interactions_open on task_interactions (task_id) where status = 'open';

create table v1_task_starts (
  turn_id text primary key,
  v1_task_id text not null,
  title text,
  seen_at timestamptz not null default now()
);
