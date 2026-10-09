-- The person's browser (tasks/browsers.ts): one Vestra /v1 user per Server instance and trip organizer, whose Chrome every
-- trip of theirs reads ixigo.com in, so one ixigo login serves all of their trips. Jobs stay on the trip's own user
-- (trip_computers). A trip's browser is fixed the first time the trip uses one (trip_browsers). Whether the browser is
-- logged in to ixigo is kept here, by status only: nothing of the account.
alter table trips add column server_instance text;

create table browsers (
  v1_user_id text primary key,
  server_instance text not null,
  person_id text not null,
  user_ready_at timestamptz,
  warm_at timestamptz,
  login text check (login in ('in', 'out')),
  login_at timestamptz,
  logged_in_at timestamptz,
  created_at timestamptz not null default now()
);

create table trip_browsers (
  trip_id text primary key,
  v1_user_id text not null references browsers (v1_user_id),
  created_at timestamptz not null default now()
);
create index trip_browsers_by_user on trip_browsers (v1_user_id);
