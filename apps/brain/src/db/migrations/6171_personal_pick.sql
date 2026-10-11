-- Contract 1.3 (G3): a person's own payment is asked for with their pick, not their name alone: the card of Go's they
-- tapped and the option on it. The Server grants it only for an option its person tapped on their own card.
alter table payments add column if not exists pick_card_id text;
alter table payments add column if not exists pick_option_id text;
-- The options card a flight booking's pick came from (option_id is already kept).
alter table flight_bookings add column if not exists pick_card_id text;
