-- A card Go has sent the Server and has no answer for yet. The Server only sends a tap for a card it has, so a tap for
-- a pending card is valid; the Server's answer or that first tap makes it live. A post that failed for sure (never sent,
-- or refused) deletes it; one sent with no answer stays pending, because the Server may have posted it.
alter table cards add column pending boolean not null default false;
