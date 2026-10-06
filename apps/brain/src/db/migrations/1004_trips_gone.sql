-- A trip the Server no longer has: it answered 404 not_found when Go read it. Every sweep leaves a gone trip alone (its
-- timers, watches, notes and setup); a later successful read clears it.
alter table trips add column gone_at timestamptz;
