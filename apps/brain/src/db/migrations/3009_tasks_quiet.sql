-- A job whose end wakes no one (tasks.ts TaskBrief.quiet): its card still says it is done, and the lane that started it
-- speaks for it. The ixigo login is one: its own card says who is logged in, so the composer never posts on its end.
alter table tasks add column quiet boolean not null default false;
