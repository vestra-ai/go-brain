-- The Server's own name (the socket's ?server=), the same on every replica of one Server. A person's browser is keyed by it
-- and the organizer, so all of one Server's replicas share one browser and one ixigo login (tasks/browsers.ts). A trip
-- whose socket named none keeps the instance as before. On browsers it is set once the browser serves a named Server.
alter table trips add column server_name text;
alter table browsers add column server_name text;
