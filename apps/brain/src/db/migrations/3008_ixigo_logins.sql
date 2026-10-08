-- One person's ixigo login on a trip's computer (travel/login.ts): who was asked, where the login stands (asked,
-- logging_in, logged_in, skipped, logged_out), the job that hands them the browser, and when ixigo last said the browser
-- is logged in. Nothing of the account itself: the card names the trip member.
create table ixigo_logins (
  trip_id text primary key,
  person_id text not null,
  state text not null check (state in ('asked', 'logging_in', 'logged_in', 'skipped', 'logged_out')),
  attempt integer not null default 0,
  task_id text,
  asked_at timestamptz not null,
  logged_in_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz not null default now()
);
