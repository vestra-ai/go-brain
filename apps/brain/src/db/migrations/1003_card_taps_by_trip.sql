-- A tap's answer is kept per trip. A tap id from one trip must never return another trip's answer (an "open" link
-- included), even when a Server's counter restarts and reuses ids: the same id in another trip is another tap.
alter table card_taps drop constraint card_taps_pkey;
alter table card_taps add primary key (trip_id, tap_id);
