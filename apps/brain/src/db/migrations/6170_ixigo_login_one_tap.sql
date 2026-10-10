-- One-tap ixigo login (travel/login.ts): what must outlive a restart of Go while a person logs in on Watch.
-- watch_sessions: every Watch session opened for the login, ended with it (Bash's page then closes itself).
-- one_tap: a login Go watches land by itself: when Log in was tapped, and the browser's `at` cookie as last read (by its
-- expiry alone, never a value), so the read after a restart still tells a new login from the one before. Null otherwise.
alter table ixigo_logins add column watch_sessions text[] not null default '{}';
alter table ixigo_logins add column one_tap jsonb;
