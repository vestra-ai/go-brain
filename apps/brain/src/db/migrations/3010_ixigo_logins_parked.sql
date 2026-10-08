-- A booking ask that waits on the trip's ixigo login (travel/login.ts Parked, travel/web-stays.ts): what it books and the
-- set_mandate call the composer makes once the login is in. Null when nothing waits.
alter table ixigo_logins add column parked jsonb;
