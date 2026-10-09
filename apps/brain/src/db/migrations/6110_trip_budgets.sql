-- The budget a trip's group decided in the chat (travel/trip-budget.ts): per person, in paise, and what it is for. One
-- per trip; it holds until the group changes or drops it.
create table if not exists trip_budgets (
  trip_id text primary key,
  per_person_minor bigint not null check (per_person_minor > 0),
  covers text not null check (covers in ('stay', 'travel', 'whole_trip')),
  message_id text not null,
  set_at timestamptz not null default now()
);
