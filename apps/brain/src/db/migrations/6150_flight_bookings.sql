-- A flight Go books on ixigo for one traveller (travel/booking/flight-booking.ts), up to ixigo's pay button: its fare,
-- fare type and ixigo's coupon, then the traveller's ready card. One row a tap; no traveller's details are kept here.
create table if not exists flight_bookings (
  run_id text primary key,
  trip_id text not null,
  person_id text not null,
  option_id text not null,
  title text not null,
  -- The day it flies (YYYY-MM-DD), for the card and the payment's purpose.
  day text,
  choice text not null check (choice in ('basic', 'assured', 'flex')),
  state text not null check (state in ('fare', 'fare_type', 'coupon', 'travellers', 'ready_to_pay', 'paid', 'failed')),
  total_minor bigint,
  coupon_code text,
  coupon_minor bigint,
  review_url text,
  card_id text,
  -- The Server's approval the traveller's Pay asked for (money's ticket approval), matched when the vault says paid.
  approval_id text,
  why text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists flight_bookings_trip on flight_bookings (trip_id, person_id);
